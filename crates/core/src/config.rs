//! Safe OpenCode JSON/JSONC configuration reading and editing.
//!
//! Design rules implemented here:
//! * DTOs never contain raw credential values, raw credential-bearing
//!   structures, or credentials embedded in URLs.
//! * Edits are restricted to provider/model/default-model fields.
//! * Edits are applied to exact byte ranges from the parsed AST, so comments,
//!   trailing commas, indentation, BOM bytes, line endings and unknown fields
//!   outside edited ranges remain byte-for-byte unchanged.
//! * Hash conflicts, duplicate keys, unsafe dialect mixtures, symlinks and
//!   managed configuration are rejected before any write.
//! * Writes use a restrictive backup plus a temporary sibling and platform-safe
//!   replacement; failures after replacement are rolled back from the backup.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use jsonc_parser::ast::{
    Array as JArray, Object as JObject, ObjectProp as JObjectProp, Value as JValue,
};
use jsonc_parser::{parse_to_ast, CollectOptions, ParseOptions, ParseResult};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    ChangePreview, CredentialStatus, Dialect, Edit, EditOp, ModelEntry, ProviderEntry,
    SourceDocument, WorkspaceSnapshot,
};

const MAX_CONFIG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EDITS: usize = 64;
const MAX_PATH_DEPTH: usize = 8;
const MAX_EDIT_VALUE_NODES: usize = 20_000;
const MAX_EDIT_VALUE_DEPTH: usize = 32;
const MAX_REASONING_EFFORTS: usize = 32;
const MAX_REASONING_STRING: usize = 64;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const CONFIG_NAMES: [&str; 2] = ["opencode.json", "opencode.jsonc"];
const REDACTION_MARKERS: [&str; 5] = [
    "[redacted]",
    "[redacted-",
    "[reference]",
    "<redacted>",
    "***redacted***",
];
const ENV_CONFIG_DIR: &str = "OC_PROVIDERS_CTL_CONFIG_DIR";
const ENV_MANAGED_DIR: &str = "OC_PROVIDERS_CTL_MANAGED_DIR";
const ENV_BACKUP_DIR: &str = "OC_PROVIDERS_CTL_BACKUP_DIR";

/// A prepared, validated change. The replacement bytes and source snapshot are
/// private so callers cannot bypass the hash or validation checks.
pub struct PreparedChange {
    pub preview: ChangePreview,
    path: PathBuf,
    source_bytes: Vec<u8>,
    source_hash: String,
    replacement_bytes: Vec<u8>,
    replacement_hash: String,
}

impl std::fmt::Debug for PreparedChange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedChange")
            .field("preview", &self.preview)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct LoadedFile {
    canonical: PathBuf,
    display: String,
    bytes: Vec<u8>,
    text: String,
    has_bom: bool,
    is_symlink: bool,
    readonly: bool,
    managed: bool,
    hash: String,
}

#[derive(Debug)]
struct Analysis {
    dialect: Dialect,
    providers: Vec<ProviderEntry>,
    default_model: Option<String>,
    warnings: Vec<String>,
    duplicate_keys: bool,
    unsafe_nesting: bool,
    parsed: bool,
}

#[derive(Debug, Clone)]
struct BackupRecord {
    backup_path: PathBuf,
    original_hash: String,
    current_hash: String,
}

static BACKUPS: OnceLock<Mutex<HashMap<String, BackupRecord>>> = OnceLock::new();
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Read a single explicitly selected OpenCode JSON/JSONC configuration file.
pub fn read_document(path: &Path) -> Result<SourceDocument, String> {
    let loaded = load_file(path)?;
    let analysis = analyze_file(&loaded);
    let writable = is_writable(&loaded, &analysis);
    Ok(SourceDocument {
        path: loaded.display.clone(),
        hash: loaded.hash.clone(),
        dialect: analysis.dialect,
        writable,
        warnings: analysis.warnings.clone(),
        providers: analysis.providers,
        default_model: analysis.default_model,
    })
}

/// Discover OpenCode configuration sources for the optional project directory.
///
/// Order follows OpenCode's merge order: global user configuration, project
/// direct files from the farthest ancestor to the project directory, then
/// project `.opencode` files in the same order, then machine/managed
/// configuration (highest precedence, always read-only).
pub fn discover_configs(project: Option<&Path>) -> WorkspaceSnapshot {
    let mut warnings = Vec::new();
    let mut sources = Vec::new();
    let mut seen = HashSet::new();

    warnings.push(
        "Only discovered global, managed and selected-project files are shown; remote, environment-configured and legacy V1 sources are not verified by this app."
            .to_string(),
    );
    if env_nonempty("OPENCODE_CONFIG")
        || env_nonempty("OPENCODE_CONFIG_CONTENT")
        || env_nonempty("OPENCODE_CONFIG_DIR")
    {
        warnings.push(
            "OPENCODE_CONFIG/OPENCODE_CONFIG_CONTENT/OPENCODE_CONFIG_DIR is set; that source is not inspected or verified."
                .to_string(),
        );
    }

    for dir in global_config_dirs() {
        add_dir_sources(&dir, &mut sources, &mut warnings, &mut seen);
    }

    let (project_path, project_dirs) = match project {
        Some(raw) => {
            let canonical = match fs::canonicalize(raw) {
                Ok(p) => p,
                Err(_) => match std::path::absolute(raw) {
                    Ok(p) => p,
                    Err(_) => raw.to_path_buf(),
                },
            };
            if !canonical.is_dir() {
                warnings.push("The selected project path is not a directory; project configuration was not scanned.".to_string());
                (Some(display_path(&canonical)), Vec::new())
            } else {
                let dirs = ancestor_dirs(&canonical);
                (Some(display_path(&canonical)), dirs)
            }
        }
        None => (None, Vec::new()),
    };

    // Direct project files: farthest ancestor first, closest last.
    for dir in &project_dirs {
        add_dir_sources(dir, &mut sources, &mut warnings, &mut seen);
    }
    // `.opencode` project files merge after every direct project file.
    for dir in &project_dirs {
        add_dir_sources(
            &dir.join(".opencode"),
            &mut sources,
            &mut warnings,
            &mut seen,
        );
    }

    for dir in managed_config_dirs() {
        add_dir_sources(&dir, &mut sources, &mut warnings, &mut seen);
    }

    if sources.iter().any(|doc| {
        doc.dialect == Dialect::V1 || doc.providers.iter().any(|p| p.dialect == Dialect::V1)
    }) {
        warnings.push(
            "Legacy V1 provider format detected; environment and remote V1 provider sources are not verified."
                .to_string(),
        );
    }

    dedupe_warnings(&mut warnings);

    WorkspaceSnapshot {
        sources,
        warnings,
        project_path,
    }
}

/// Validate and prepare a batch of edits for one file.
pub fn prepare_changes(
    path: &Path,
    expected_hash: &str,
    edits: &[Edit],
) -> Result<PreparedChange, String> {
    let expected_hash = normalize_hash(expected_hash)?;
    if edits.is_empty() {
        return Err("No edits were provided.".to_string());
    }
    if edits.len() > MAX_EDITS {
        return Err(format!(
            "At most {MAX_EDITS} edits can be applied in one batch."
        ));
    }

    let loaded = load_file(path)?;
    ensure_editable(&loaded)?;
    if loaded.hash != expected_hash {
        return Err("The file changed after it was loaded; reload it before editing.".to_string());
    }

    let analysis = analyze_file(&loaded);
    if !analysis.parsed || analysis.dialect == Dialect::Invalid {
        return Err("This configuration cannot be parsed safely as JSONC.".to_string());
    }
    if analysis.duplicate_keys {
        return Err("Duplicate configuration keys make this file unsafe to edit.".to_string());
    }
    if analysis.unsafe_nesting {
        return Err(
            "This file contains an unsafe mixture of V1 and V2 provider syntax and is read-only."
                .to_string(),
        );
    }

    let root_ast = parse_root(&loaded.text)?;
    let root_obj = root_ast
        .as_object()
        .ok_or_else(|| "The configuration root must be an object.".to_string())?;
    let root_json: JsonValue = root_ast.clone().into();

    let facts = EditFacts {
        providers: &analysis.providers,
        ambiguous: analysis.dialect == Dialect::Ambiguous,
    };

    let mut warnings = analysis.warnings.clone();
    validate_edit_batch(root_obj, &facts, edits, &mut warnings)?;

    // Compute the expected semantic result independently of the text editor.
    let mut expected = root_json.clone();
    for edit in edits {
        apply_edit_to_json(&mut expected, edit)?;
    }

    let newline = detect_newline(&loaded.text);
    let unit = detect_indent_unit(&loaded.text);
    let pretty = loaded.text.contains('\n');

    let mut text = loaded.text.clone();
    for edit in edits {
        let before_comments = collect_comments(&text);
        let next = apply_one_edit(&text, edit, pretty, &newline, &unit)?;
        let after_comments = collect_comments(&next);
        if edit_removes_whole_entry(edit) {
            // A whole-entry deletion may only drop comments. It must never
            // rewrite or introduce one, and comments outside the entry are
            // still present in `after`.
            if after_comments
                .iter()
                .any(|comment| !before_comments.iter().any(|old| old == comment))
            {
                return Err(
                    "Deleting this entry would alter a comment outside its own range; no file was modified."
                        .to_string(),
                );
            }
            let missing = before_comments.len() - after_comments.len();
            let inside = comment_delta_inside_removed_entry(&text, edit);
            if missing > inside {
                return Err(
                    "Deleting this entry would remove a comment outside its own range; no file was modified."
                        .to_string(),
                );
            }
        } else if after_comments != before_comments {
            return Err(
                "The requested change cannot preserve existing comments safely.".to_string(),
            );
        }
        text = next;
    }

    let final_ast = parse_root(&text)?;
    let actual: JsonValue = final_ast.clone().into();
    if actual != expected {
        return Err(
            "The generated change did not match the requested semantic edits; no file was modified."
                .to_string(),
        );
    }

    let replacement_text = if loaded.has_bom {
        format!("\u{feff}{text}")
    } else {
        text
    };
    let replacement_bytes = replacement_text.into_bytes();
    let replacement_hash = hash_bytes(&replacement_bytes);

    if edits
        .iter()
        .any(|edit| edit.op == EditOp::Remove && edit.path.len() <= 4)
    {
        warnings.push(
            "Comments or non-provider fields inside a deleted provider/model entry are removed with that entry."
                .to_string(),
        );
    }
    warnings.push(
        "Preview content is a semantic edit summary and masks credential values, references and custom headers."
            .to_string(),
    );
    dedupe_warnings(&mut warnings);

    let preview = ChangePreview {
        preview_id: Uuid::new_v4().to_string(),
        path: loaded.display.clone(),
        diff: render_change_summary(&loaded.display, edits),
        warnings,
        edit_count: edits.len(),
    };

    Ok(PreparedChange {
        preview,
        path: loaded.canonical,
        source_bytes: loaded.bytes,
        source_hash: loaded.hash,
        replacement_bytes,
        replacement_hash,
    })
}

/// Commit a validated prepared change with a hash check, restrictive backup,
/// temporary sibling and platform-safe replacement. On a post-write failure the
/// original bytes are restored from the backup.
pub fn commit_changes(change: &PreparedChange) -> Result<SourceDocument, String> {
    let _write_guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "The configuration write lock is unavailable.".to_string())?;
    let loaded = load_file(&change.path)?;
    ensure_editable(&loaded)?;
    if loaded.hash != change.source_hash {
        return Err(
            "The file changed after the change was prepared; no file was modified.".to_string(),
        );
    }
    if loaded.bytes != change.source_bytes {
        return Err(
            "The file changed after the change was prepared; no file was modified.".to_string(),
        );
    }

    let analysis = analyze_file(&loaded);
    if !analysis.parsed || analysis.dialect == Dialect::Invalid {
        return Err("The current configuration is no longer valid JSONC.".to_string());
    }

    let record = create_backup(&loaded.bytes, &loaded.hash, &loaded.canonical)?;

    // Final hash check immediately before touching the destination. The process
    // write lock already serializes this app's writers; this check catches
    // external changes since the backup was created.
    let current_hash = read_hash(&change.path);
    if current_hash.as_deref() != Some(loaded.hash.as_str()) {
        let _ = fs::remove_file(&record.backup_path);
        return Err(
            "The file changed immediately before replacement; no file was modified.".to_string(),
        );
    }

    if let Err(err) =
        replace_file_safely(&change.path, &change.replacement_bytes, Some(&loaded.hash))
    {
        let state = read_hash(&change.path);
        let message = format!("Could not replace the configuration file: {err}");
        return Err(match state.as_deref() {
            Some(hash) if hash == loaded.hash => {
                let _ = fs::remove_file(&record.backup_path);
                format!("{message} The original file is unchanged.")
            }
            Some(hash) if hash == change.replacement_hash => {
                let rollback =
                    rollback_if_current(&change.path, &change.replacement_hash, &loaded.bytes);
                if rollback.is_ok() {
                    let _ = fs::remove_file(&record.backup_path);
                }
                rollback_error_message(&message, rollback, &record.backup_path)
            }
            _ => rollback_error_message(
                &format!("{message} The file state is uncertain; rollback was not attempted."),
                Err("the destination changed or could not be verified".to_string()),
                &record.backup_path,
            ),
        });
    }

    let readback_hash = read_hash(&change.path);
    if readback_hash.as_deref() != Some(change.replacement_hash.as_str()) {
        let rollback = match readback_hash.as_deref() {
            Some(hash) if hash == change.replacement_hash => {
                rollback_if_current(&change.path, &change.replacement_hash, &loaded.bytes)
            }
            _ => Err("the destination changed externally; rollback was skipped".to_string()),
        };
        if rollback.is_ok() {
            let _ = fs::remove_file(&record.backup_path);
        }
        return Err(rollback_error_message(
            "Written configuration failed verification.",
            rollback,
            &record.backup_path,
        ));
    }

    let next = match read_document(&change.path) {
        Ok(doc) => doc,
        Err(err) => {
            let rollback =
                rollback_if_current(&change.path, &change.replacement_hash, &loaded.bytes);
            if rollback.is_ok() {
                let _ = fs::remove_file(&record.backup_path);
            }
            return Err(rollback_error_message(
                &format!("Could not re-read the written configuration: {err}"),
                rollback,
                &record.backup_path,
            ));
        }
    };

    let key = path_key(&change.path);
    let mut registry = backups()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let previous = registry.insert(
        key,
        BackupRecord {
            backup_path: record.backup_path,
            original_hash: loaded.hash,
            current_hash: next.hash.clone(),
        },
    );
    drop(registry);
    if let Some(previous) = previous {
        let _ = fs::remove_file(previous.backup_path);
    }

    Ok(next)
}

/// Restore the last backup this process created for `path`. The current file
/// must still match `expected_hash`, otherwise the restore is refused.
pub fn restore_last_backup(path: &Path, expected_hash: &str) -> Result<SourceDocument, String> {
    let _write_guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "The configuration write lock is unavailable.".to_string())?;
    let expected_hash = normalize_hash(expected_hash)?;
    let loaded = load_file(path)?;
    ensure_editable(&loaded)?;
    if loaded.hash != expected_hash {
        return Err(
            "The file changed since the last committed change; restore was refused.".to_string(),
        );
    }

    let key = path_key(&loaded.canonical);
    let record = {
        let registry = backups()
            .lock()
            .map_err(|_| "Internal backup registry is unavailable.".to_string())?;
        registry.get(&key).cloned()
    }
    .ok_or_else(|| "No backup created by this process is available for this file.".to_string())?;

    if record.current_hash != expected_hash {
        return Err(
            "The last backup does not match the current file state; restore was refused."
                .to_string(),
        );
    }

    let backup_bytes = fs::read(&record.backup_path)
        .map_err(|_| "The internal backup could not be read.".to_string())?;
    if hash_bytes(&backup_bytes) != record.original_hash {
        return Err(
            "The internal backup failed its integrity check; restore was refused.".to_string(),
        );
    }

    let current_bytes = loaded.bytes.clone();
    if let Err(err) = replace_file_safely(&loaded.canonical, &backup_bytes, Some(&loaded.hash)) {
        let state = read_hash(&loaded.canonical);
        let message = format!("Could not restore the backup: {err}");
        return Err(match state.as_deref() {
            Some(hash) if hash == loaded.hash => {
                format!("{message} The current file is unchanged.")
            }
            Some(hash) if hash == record.original_hash => {
                let rollback =
                    rollback_if_current(&loaded.canonical, &record.original_hash, &current_bytes);
                rollback_error_message(&message, rollback, &record.backup_path)
            }
            _ => rollback_error_message(
                &format!("{message} The file state is uncertain; rollback was not attempted."),
                Err("the destination changed or could not be verified".to_string()),
                &record.backup_path,
            ),
        });
    }

    let readback_hash = read_hash(&loaded.canonical);
    if readback_hash.as_deref() != Some(record.original_hash.as_str()) {
        let rollback = match readback_hash.as_deref() {
            Some(hash) if hash == record.original_hash => {
                rollback_if_current(&loaded.canonical, &record.original_hash, &current_bytes)
            }
            _ => Err("the destination changed externally; rollback was skipped".to_string()),
        };
        return Err(rollback_error_message(
            "Restored configuration failed verification.",
            rollback,
            &record.backup_path,
        ));
    }

    let next = match read_document(&loaded.canonical) {
        Ok(doc) => doc,
        Err(err) => {
            let rollback =
                rollback_if_current(&loaded.canonical, &record.original_hash, &current_bytes);
            return Err(rollback_error_message(
                &format!("Could not re-read the restored configuration: {err}"),
                rollback,
                &record.backup_path,
            ));
        }
    };

    {
        let mut registry = backups()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.remove(&key);
    }
    let _ = fs::remove_file(&record.backup_path);

    Ok(next)
}

// ---------------------------------------------------------------------------
// Loading and analysis
// ---------------------------------------------------------------------------

fn load_file(path: &Path) -> Result<LoadedFile, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if !matches!(ext.as_deref(), Some("json") | Some("jsonc")) {
        return Err("Only OpenCode .json or .jsonc configuration files are supported.".to_string());
    }

    let link_meta = fs::symlink_metadata(path)
        .map_err(|_| "The configuration file does not exist or cannot be accessed.".to_string())?;
    let is_symlink = link_meta.file_type().is_symlink();
    let metadata = if is_symlink {
        fs::metadata(path)
            .map_err(|_| "The configuration file symlink target cannot be accessed.".to_string())?
    } else {
        link_meta
    };
    if !metadata.is_file() {
        return Err("The selected configuration path is not a regular file.".to_string());
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(format!(
            "The configuration file is larger than the {} MiB safety limit.",
            MAX_CONFIG_BYTES / (1024 * 1024)
        ));
    }

    let bytes =
        fs::read(path).map_err(|_| "The configuration file could not be read.".to_string())?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err("The configuration file is too large to read safely.".to_string());
    }

    let (has_bom, body) = match bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        Some(rest) => (true, rest),
        None => (false, bytes.as_slice()),
    };
    let text = std::str::from_utf8(body)
        .map_err(|_| "The configuration file is not valid UTF-8.".to_string())?
        .to_string();

    let canonical = fs::canonicalize(path)
        .map_err(|_| "The configuration path could not be resolved.".to_string())?;
    let managed = is_managed_path(&canonical);
    let readonly = metadata.permissions().readonly();

    Ok(LoadedFile {
        display: display_path(&canonical),
        canonical,
        hash: hash_bytes(&bytes),
        bytes,
        text,
        has_bom,
        is_symlink,
        readonly,
        managed,
    })
}

fn analyze_file(loaded: &LoadedFile) -> Analysis {
    let mut warnings = Vec::new();
    let mut unsafe_nesting = false;
    let mut duplicate_keys = false;

    if loaded.managed {
        warnings.push(
            "This is a machine-managed OpenCode configuration and is read-only in this app."
                .to_string(),
        );
    }
    if loaded.is_symlink {
        warnings.push("This configuration is a symlink and is read-only in this app.".to_string());
    }
    if loaded.readonly {
        warnings.push("The file is marked read-only on disk.".to_string());
    }

    let root = match parse_root(&loaded.text) {
        Ok(value) => value,
        Err(_) => {
            warnings.push("This file is not valid JSONC and is read-only.".to_string());
            return Analysis {
                dialect: Dialect::Invalid,
                providers: Vec::new(),
                default_model: None,
                warnings,
                duplicate_keys: false,
                unsafe_nesting: false,
                parsed: false,
            };
        }
    };
    let Some(root_obj) = root.as_object() else {
        warnings.push("The configuration root is not an object and is read-only.".to_string());
        return Analysis {
            dialect: Dialect::Invalid,
            providers: Vec::new(),
            default_model: None,
            warnings,
            duplicate_keys: false,
            unsafe_nesting: false,
            parsed: false,
        };
    };

    let mut dup_paths = Vec::new();
    scan_duplicate_keys(root_obj, &mut Vec::new(), &mut dup_paths);
    if !dup_paths.is_empty() {
        duplicate_keys = true;
        warnings.push(
            "Duplicate keys make this configuration ambiguous and unsafe to edit.".to_string(),
        );
        for p in dup_paths.iter().take(5) {
            warnings.push(format!("Duplicate key at {p}."));
        }
    }

    let provider_prop = root_obj.get("provider");
    let providers_prop = root_obj.get("providers");
    let provider_obj = provider_prop.and_then(|p| p.value.as_object());
    let providers_obj = providers_prop.and_then(|p| p.value.as_object());

    let dialect = match (
        provider_prop.is_some(),
        providers_prop.is_some(),
        provider_obj,
        providers_obj,
    ) {
        (true, true, Some(_), Some(_)) => Dialect::Mixed,
        (true, false, Some(_), _) => Dialect::V1,
        (false, true, _, Some(_)) => Dialect::V2,
        (false, false, _, _) => Dialect::Ambiguous,
        _ => Dialect::Invalid,
    };

    if dialect == Dialect::Invalid {
        warnings.push("A provider map has an invalid shape and is read-only.".to_string());
        return Analysis {
            dialect,
            providers: Vec::new(),
            default_model: None,
            warnings,
            duplicate_keys,
            unsafe_nesting,
            parsed: true,
        };
    }
    if dialect == Dialect::Ambiguous {
        warnings.push(
            "No provider map is present. Create either a V1 `provider` entry or a V2 `providers` entry to choose the format explicitly."
                .to_string(),
        );
    }
    if dialect == Dialect::Mixed {
        warnings.push(
            "Both V1 `provider` and V2 `providers` maps are present; entries retain their original nested dialect."
                .to_string(),
        );
    }

    let mut providers = Vec::new();
    if let Some(obj) = provider_obj {
        collect_providers(
            obj,
            Dialect::V1,
            &mut providers,
            &mut warnings,
            &mut unsafe_nesting,
        );
    }
    if let Some(obj) = providers_obj {
        collect_providers(
            obj,
            Dialect::V2,
            &mut providers,
            &mut warnings,
            &mut unsafe_nesting,
        );
    }

    let default_model = match root_obj.get("model") {
        Some(prop) => match &prop.value {
            JValue::StringLit(s) => {
                let value = s.value.to_string();
                if value.chars().any(|c| c.is_control()) {
                    warnings.push(
                        "The default model value contains control characters and is hidden."
                            .to_string(),
                    );
                    None
                } else {
                    Some(value)
                }
            }
            JValue::Object(obj) => {
                let provider = obj.get_string("providerID").map(|s| s.value.to_string());
                let model = obj.get_string("model").map(|s| s.value.to_string());
                match (provider, model) {
                    (Some(p), Some(m)) if !p.is_empty() && !m.is_empty() => {
                        warnings.push(
                            "The default model uses an object selector; it is shown but cannot be edited in this version."
                                .to_string(),
                        );
                        Some(format!("{p}/{m}"))
                    }
                    _ => {
                        warnings.push("The default model selector is not recognized.".to_string());
                        None
                    }
                }
            }
            _ => {
                warnings.push(
                    "The root `model` value is not a string or selector and is ignored."
                        .to_string(),
                );
                None
            }
        },
        None => None,
    };

    if dialect == Dialect::V1 || providers.iter().any(|p| p.dialect == Dialect::V1) {
        warnings.push(
            "Legacy V1 provider format detected; environment and remote V1 provider sources are not verified."
                .to_string(),
        );
    }

    if unsafe_nesting {
        warnings.push(
            "Nested V1/V2 provider syntax is unsafe to edit; this file is read-only.".to_string(),
        );
    }

    Analysis {
        dialect,
        providers,
        default_model,
        warnings,
        duplicate_keys,
        unsafe_nesting,
        parsed: true,
    }
}

fn is_writable(loaded: &LoadedFile, analysis: &Analysis) -> bool {
    analysis.parsed
        && analysis.dialect != Dialect::Invalid
        && !analysis.duplicate_keys
        && !analysis.unsafe_nesting
        && !loaded.managed
        && !loaded.is_symlink
        && !loaded.readonly
}

fn ensure_editable(loaded: &LoadedFile) -> Result<(), String> {
    if loaded.managed {
        return Err("Machine-managed configuration is read-only.".to_string());
    }
    if loaded.is_symlink {
        return Err("Symlinked configuration is read-only.".to_string());
    }
    if loaded.readonly {
        return Err("The configuration file is marked read-only on disk.".to_string());
    }
    Ok(())
}

fn collect_providers(
    map: &JObject,
    map_dialect: Dialect,
    output: &mut Vec<ProviderEntry>,
    warnings: &mut Vec<String>,
    unsafe_nesting: &mut bool,
) {
    for prop in &map.properties {
        let id = prop.name.as_str().to_string();
        let Some(obj) = prop.value.as_object() else {
            *unsafe_nesting = true;
            warnings.push(format!(
                "Provider '{id}' is not an object and is read-only."
            ));
            output.push(ProviderEntry {
                id,
                name: None,
                dialect: Dialect::Invalid,
                base_url: None,
                credential_status: CredentialStatus::None,
                models: Vec::new(),
            });
            continue;
        };

        let (entry_dialect, entry_unsafe) = provider_dialect(obj, map_dialect);
        if entry_unsafe {
            *unsafe_nesting = true;
            warnings.push(format!(
                "Provider '{id}' mixes V1 and V2 syntax or has invalid field types and is read-only."
            ));
        }
        if entry_dialect == Dialect::Mixed {
            *unsafe_nesting = true;
        }

        let json: JsonValue = prop.value.clone().into();
        let credential_status = credential_status(&json);

        let mut base_url_warning = false;
        let base_url_raw = match entry_dialect {
            Dialect::V1 => {
                let options_url = obj
                    .get_object("options")
                    .and_then(|o| o.get_string("baseURL"))
                    .map(|s| s.value.to_string());
                let api_url = obj
                    .get_string("api")
                    .map(|s| s.value.to_string())
                    .filter(|s| !s.trim().is_empty());
                match (options_url, api_url) {
                    (Some(options_url), Some(_)) => {
                        warnings.push(format!(
                            "Provider '{id}' has both options.baseURL and provider.api; options.baseURL is the effective base URL."
                        ));
                        Some(options_url)
                    }
                    (None, Some(api_url)) => {
                        warnings.push(format!(
                            "Provider '{id}' base URL comes from legacy provider.api; editing options.baseURL will override it."
                        ));
                        Some(api_url)
                    }
                    (options_url, None) => options_url,
                }
            }
            Dialect::V2 => obj
                .get_object("settings")
                .and_then(|o| o.get_string("baseURL"))
                .map(|s| s.value.to_string()),
            Dialect::Mixed | Dialect::Ambiguous | Dialect::Invalid => obj
                .get_object("settings")
                .and_then(|o| o.get_string("baseURL"))
                .or_else(|| {
                    obj.get_object("options")
                        .and_then(|o| o.get_string("baseURL"))
                })
                .map(|s| s.value.to_string()),
        };
        let base_url = base_url_raw.and_then(|raw| match sanitize_base_url(&raw) {
            Ok(Some(safe)) if safe != raw.trim() => {
                base_url_warning = true;
                Some(safe)
            }
            Ok(Some(safe)) => Some(safe),
            Ok(None) => None,
            Err(()) => {
                base_url_warning = true;
                None
            }
        });
        if base_url_warning {
            warnings.push(format!(
                "Provider '{id}' has a base URL containing credentials or secret URL parameters; those values are hidden."
            ));
        }

        let name = obj
            .get_string("name")
            .map(|s| s.value.to_string())
            .filter(|s| !s.chars().any(|c| c.is_control()));

        let mut models = Vec::new();
        if let Some(models_obj) = obj.get_object("models") {
            for model_prop in &models_obj.properties {
                let model_id = model_prop.name.as_str().to_string();
                let model_obj = model_prop.value.as_object();
                if model_obj.is_none() {
                    *unsafe_nesting = true;
                    warnings.push(format!(
                        "Model '{model_id}' in provider '{id}' is not an object and is read-only."
                    ));
                }
                let (model_dialect, model_unsafe) = model_dialect(model_obj, entry_dialect);
                if model_unsafe {
                    *unsafe_nesting = true;
                    warnings.push(format!(
                        "Model '{model_id}' in provider '{id}' mixes V1 and V2 syntax and is read-only."
                    ));
                }
                models.push(model_entry(model_id, model_obj, model_dialect));
            }
        } else if obj.get("models").is_some() {
            *unsafe_nesting = true;
            warnings.push(format!(
                "Provider '{id}' has a non-object `models` field and is read-only."
            ));
        }

        output.push(ProviderEntry {
            id,
            name,
            dialect: entry_dialect,
            base_url,
            credential_status,
            models,
        });
    }
}

fn provider_dialect(obj: &JObject, map_dialect: Dialect) -> (Dialect, bool) {
    let v1_provider =
        obj.get("npm").is_some() || obj.get("api").is_some() || obj.get("options").is_some();
    let v2_provider = obj.get("package").is_some()
        || obj.get("settings").is_some()
        || obj.get("headers").is_some()
        || obj.get("body").is_some()
        || obj.get("canonical").is_some()
        || obj.get("compatibility").is_some();

    let mut v1_model = false;
    let mut v2_model = false;
    if let Some(models) = obj.get_object("models") {
        for prop in &models.properties {
            if let Some(model) = prop.value.as_object() {
                if model.get("id").is_some()
                    || model.get("reasoning").is_some()
                    || model.get("options").is_some()
                    || model
                        .get_object("provider")
                        .is_some_and(|p| p.get("npm").is_some() || p.get("api").is_some())
                    || model
                        .get("variants")
                        .is_some_and(|p| p.value.as_object().is_some())
                {
                    v1_model = true;
                }
                if model.get("modelID").is_some()
                    || model.get("capabilities").is_some()
                    || model.get("package").is_some()
                    || model.get("settings").is_some()
                    || model.get("headers").is_some()
                    || model.get("body").is_some()
                    || model
                        .get("variants")
                        .is_some_and(|p| p.value.as_array().is_some())
                {
                    v2_model = true;
                }
            }
        }
    }

    let has_v1 = v1_provider || v1_model;
    let has_v2 = v2_provider || v2_model;
    if has_v1 && has_v2 {
        return (Dialect::Mixed, true);
    }
    if has_v1 && map_dialect == Dialect::V2 {
        return (Dialect::Mixed, true);
    }
    if has_v2 && map_dialect == Dialect::V1 {
        return (Dialect::Mixed, true);
    }

    let invalid_types = provider_has_invalid_types(obj, map_dialect);
    (map_dialect, invalid_types)
}

fn provider_has_invalid_types(obj: &JObject, dialect: Dialect) -> bool {
    let string_fields = ["name", "npm", "api", "package"];
    for f in string_fields {
        if obj
            .get(f)
            .is_some_and(|p| p.value.as_string_lit().is_none())
        {
            return true;
        }
    }
    for f in ["options", "settings", "headers", "body"] {
        if obj.get(f).is_some_and(|p| p.value.as_object().is_none()) {
            return true;
        }
    }
    if obj.get("env").is_some_and(|p| p.value.as_array().is_none()) {
        return true;
    }
    if let Some(models) = obj.get_object("models") {
        for prop in &models.properties {
            let Some(model) = prop.value.as_object() else {
                return true;
            };
            if model
                .get("name")
                .is_some_and(|p| p.value.as_string_lit().is_none())
                || model
                    .get("id")
                    .is_some_and(|p| p.value.as_string_lit().is_none())
                || model
                    .get("modelID")
                    .is_some_and(|p| p.value.as_string_lit().is_none())
            {
                return true;
            }
            if model
                .get("limit")
                .is_some_and(|p| p.value.as_object().is_none())
            {
                return true;
            }
            if let Some(limit) = model.get_object("limit") {
                for leaf in ["context", "input", "output"] {
                    match limit.get(leaf) {
                        None => {}
                        Some(prop) if prop.value.as_number_lit().is_some() => {
                            if limit_number_is_invalid(&prop.value) {
                                return true;
                            }
                        }
                        Some(_) => return true,
                    }
                }
            }
            if model
                .get("reasoning")
                .is_some_and(|p| p.value.as_boolean_lit().is_none())
            {
                return true;
            }
            if model
                .get("capabilities")
                .is_some_and(|p| p.value.as_object().is_none())
            {
                return true;
            }
            if dialect == Dialect::V1
                && model
                    .get("variants")
                    .is_some_and(|p| p.value.as_object().is_none())
            {
                return true;
            }
            if dialect == Dialect::V2
                && model
                    .get("variants")
                    .is_some_and(|p| p.value.as_array().is_none())
            {
                return true;
            }
            if dialect == Dialect::V2 {
                if let Some(reasoning) = model
                    .get_object("capabilities")
                    .and_then(|capabilities| capabilities.get("reasoning"))
                {
                    let reasoning: JsonValue = reasoning.value.clone().into();
                    if validate_v2_reasoning(&reasoning).is_err() {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn limit_number_is_invalid(value: &JValue) -> bool {
    let Some(number) = value.as_number_lit() else {
        return true;
    };
    match number.value.parse::<i64>() {
        Ok(parsed) => parsed < 0,
        Err(_) => true,
    }
}

fn model_dialect(obj: Option<&JObject>, entry_dialect: Dialect) -> (Dialect, bool) {
    let Some(obj) = obj else {
        return (entry_dialect, true);
    };
    let v1 = obj.get("id").is_some()
        || obj.get("reasoning").is_some()
        || obj.get("options").is_some()
        || obj
            .get_object("provider")
            .is_some_and(|p| p.get("npm").is_some() || p.get("api").is_some())
        || obj
            .get("variants")
            .is_some_and(|p| p.value.as_object().is_some());
    let v2 = obj.get("modelID").is_some()
        || obj.get("capabilities").is_some()
        || obj.get("package").is_some()
        || obj.get("settings").is_some()
        || obj.get("headers").is_some()
        || obj.get("body").is_some()
        || obj
            .get("variants")
            .is_some_and(|p| p.value.as_array().is_some());
    if v1 && v2 {
        return (Dialect::Mixed, true);
    }
    if v1 && entry_dialect == Dialect::V2 {
        return (Dialect::Mixed, true);
    }
    if v2 && entry_dialect == Dialect::V1 {
        return (Dialect::Mixed, true);
    }
    (entry_dialect, false)
}

fn model_entry(id: String, obj: Option<&JObject>, dialect: Dialect) -> ModelEntry {
    let mut entry = ModelEntry {
        id,
        request_id: None,
        name: None,
        context: None,
        input: None,
        output: None,
        reasoning: None,
        variants: None,
    };
    let Some(obj) = obj else {
        return entry;
    };

    entry.request_id = match dialect {
        Dialect::V2 => obj.get_string("modelID").map(|s| s.value.to_string()),
        Dialect::V1 => obj.get_string("id").map(|s| s.value.to_string()),
        _ => obj
            .get_string("modelID")
            .or_else(|| obj.get_string("id"))
            .map(|s| s.value.to_string()),
    };
    entry.name = obj.get_string("name").map(|s| s.value.to_string());

    if let Some(limit) = obj.get_object("limit") {
        entry.context = limit.get_number("context").and_then(number_to_i64);
        entry.input = limit.get_number("input").and_then(number_to_i64);
        entry.output = limit.get_number("output").and_then(number_to_i64);
    }

    entry.reasoning = match dialect {
        Dialect::V2 => obj
            .get_object("capabilities")
            .and_then(|c| c.get("reasoning"))
            .map(|p| sanitize_nested(&JsonValue::from(p.value.clone()))),
        Dialect::V1 => obj
            .get("reasoning")
            .map(|p| sanitize_nested(&JsonValue::from(p.value.clone()))),
        _ => obj
            .get_object("capabilities")
            .and_then(|c| c.get("reasoning"))
            .or_else(|| obj.get("reasoning"))
            .map(|p| sanitize_nested(&JsonValue::from(p.value.clone()))),
    };

    entry.variants = match dialect {
        Dialect::V2 => obj
            .get("variants")
            .filter(|p| p.value.as_array().is_some())
            .map(|p| sanitize_nested(&JsonValue::from(p.value.clone()))),
        Dialect::V1 => obj
            .get("variants")
            .filter(|p| p.value.as_object().is_some())
            .map(|p| sanitize_nested(&JsonValue::from(p.value.clone()))),
        _ => obj
            .get("variants")
            .map(|p| sanitize_nested(&JsonValue::from(p.value.clone()))),
    };

    entry
}

fn number_to_i64(number: &jsonc_parser::ast::NumberLit) -> Option<i64> {
    number.value.parse::<i64>().ok().or_else(|| {
        number
            .value
            .parse::<u64>()
            .ok()
            .and_then(|n| i64::try_from(n).ok())
    })
}

fn scan_duplicate_keys(obj: &JObject, path: &mut Vec<String>, output: &mut Vec<String>) {
    let mut seen = HashSet::new();
    for prop in &obj.properties {
        let name = prop.name.as_str().to_string();
        if !seen.insert(name.clone()) {
            let where_path = if path.is_empty() {
                "$".to_string()
            } else {
                format!("$.{}", path.join("."))
            };
            output.push(format!("{where_path}.{name}"));
        }
        path.push(name);
        match &prop.value {
            JValue::Object(child) => scan_duplicate_keys(child, path, output),
            JValue::Array(array) => scan_array_duplicates(array, path, output),
            _ => {}
        }
        path.pop();
    }
}

fn scan_array_duplicates(array: &JArray, path: &mut Vec<String>, output: &mut Vec<String>) {
    for (index, value) in array.elements.iter().enumerate() {
        path.push(index.to_string());
        match value {
            JValue::Object(child) => scan_duplicate_keys(child, path, output),
            JValue::Array(child) => scan_array_duplicates(child, path, output),
            _ => {}
        }
        path.pop();
    }
}

fn parse_root(text: &str) -> Result<JValue<'_>, String> {
    let result = parse_jsonc(text)?;
    result
        .value
        .ok_or_else(|| "The configuration file is empty or has no JSON value.".to_string())
}

fn parse_jsonc(text: &str) -> Result<ParseResult<'_>, String> {
    parse_to_ast(text, &CollectOptions::default(), &strict_jsonc_options())
        .map_err(|_| "The configuration file is not valid JSONC.".to_string())
}

fn strict_jsonc_options() -> ParseOptions {
    ParseOptions {
        allow_comments: true,
        allow_trailing_commas: true,
        allow_loose_object_property_names: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
        allow_bare_decimal_point_numbers: false,
        allow_non_finite_numbers: false,
        allow_extended_string_escapes: false,
    }
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

fn sanitize_nested(value: &JsonValue) -> JsonValue {
    sanitize_nested_inner(value, 0, &mut 0)
}

fn sanitize_nested_inner(value: &JsonValue, depth: usize, nodes: &mut usize) -> JsonValue {
    *nodes += 1;
    if depth > MAX_EDIT_VALUE_DEPTH || *nodes > MAX_EDIT_VALUE_NODES {
        return JsonValue::String("[REDACTED]".to_string());
    }
    match value {
        JsonValue::Object(map) => {
            let mut out = JsonMap::new();
            for (key, child) in map {
                if is_secret_key(key) || is_sensitive_container_key(key) {
                    out.insert(key.clone(), JsonValue::String("[REDACTED]".to_string()));
                } else {
                    out.insert(key.clone(), sanitize_nested_inner(child, depth + 1, nodes));
                }
            }
            JsonValue::Object(out)
        }
        JsonValue::Array(items) => JsonValue::Array(
            items
                .iter()
                .map(|item| sanitize_nested_inner(item, depth + 1, nodes))
                .collect(),
        ),
        JsonValue::String(s) => match sanitize_url_text(s) {
            Ok(Some(safe)) => JsonValue::String(safe),
            Ok(None) => JsonValue::String(s.clone()),
            Err(()) => JsonValue::String("[REDACTED]".to_string()),
        },
        other => other.clone(),
    }
}

fn credential_status(value: &JsonValue) -> CredentialStatus {
    let mut saw_reference = false;
    if scan_credentials(value, &mut saw_reference, false) {
        CredentialStatus::Inline
    } else if saw_reference {
        CredentialStatus::Reference
    } else {
        CredentialStatus::None
    }
}

/// Returns true when an inline credential value was found.
fn scan_credentials(value: &JsonValue, saw_reference: &mut bool, under_headers: bool) -> bool {
    match value {
        JsonValue::Object(map) => {
            for (key, child) in map {
                if is_secret_key(key) {
                    match child {
                        JsonValue::String(s) if s.trim().is_empty() => {}
                        JsonValue::String(s) if is_reference(s) => *saw_reference = true,
                        JsonValue::Null => {}
                        _ => return true,
                    }
                } else if key.eq_ignore_ascii_case("headers") || under_headers {
                    match child {
                        JsonValue::Object(headers) => {
                            for header in headers.values() {
                                match header {
                                    JsonValue::String(s) if s.trim().is_empty() => {}
                                    JsonValue::String(s) if is_reference(s) => {
                                        *saw_reference = true
                                    }
                                    JsonValue::Null => {}
                                    _ => return true,
                                }
                            }
                        }
                        _ => return true,
                    }
                } else if key.eq_ignore_ascii_case("env") {
                    if let JsonValue::Array(items) = child {
                        if items
                            .iter()
                            .any(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                        {
                            *saw_reference = true;
                        }
                    }
                } else if scan_credentials(child, saw_reference, false) {
                    return true;
                }
            }
            false
        }
        JsonValue::Array(items) => items
            .iter()
            .any(|item| scan_credentials(item, saw_reference, under_headers)),
        _ => false,
    }
}

fn is_secret_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    let compact: String = lowered
        .chars()
        .filter(|c| *c != '-' && *c != '_' && !c.is_whitespace())
        .collect();
    matches!(
        compact.as_str(),
        "apikey"
            | "token"
            | "accesstoken"
            | "accesskey"
            | "refreshtoken"
            | "idtoken"
            | "authtoken"
            | "bearertoken"
            | "password"
            | "passwd"
            | "secret"
            | "clientsecret"
            | "privatekey"
            | "credential"
            | "credentials"
            | "authorization"
            | "proxyauthorization"
            | "cookie"
            | "setcookie"
            | "xapikey"
            | "xauthtoken"
            | "auth"
    ) || compact.contains("apikey")
        || compact.contains("secret")
        || compact.contains("password")
        || compact.contains("authorization")
        || compact.contains("credential")
        || compact.contains("privatekey")
        || compact.ends_with("token")
        || compact.ends_with("accesskey")
}

/// URL-query credential keys. Broader than [`is_secret_key`] because query
/// parameters named `key`, `sig` or `signature` are credentials in a URL while
/// the same names can be innocent metadata elsewhere in the document.
fn is_sensitive_query_key(key: &str) -> bool {
    let compact: String = key
        .to_ascii_lowercase()
        .chars()
        .filter(|c| *c != '-' && *c != '_' && !c.is_whitespace())
        .collect();
    is_secret_key(key)
        || matches!(
            compact.as_str(),
            "key" | "sig" | "signature" | "sigv4" | "xamzsignature" | "xamzcredential"
        )
}

fn is_sensitive_container_key(key: &str) -> bool {
    let compact: String = key
        .to_ascii_lowercase()
        .chars()
        .filter(|c| *c != '-' && *c != '_' && !c.is_whitespace())
        .collect();
    compact == "headers"
        || compact == "header"
        || compact.contains("headers")
        || compact == "body"
        || compact.ends_with("body")
}

fn is_reference(value: &str) -> bool {
    let trimmed = value.trim_start();
    trimmed.starts_with("{env:") || trimmed.starts_with("{file:")
}

fn is_redacted_value(value: &JsonValue) -> bool {
    match value {
        JsonValue::String(s) => {
            let lowered = s.to_ascii_lowercase();
            REDACTION_MARKERS.iter().any(|m| lowered.contains(m))
                || lowered == "redacted"
                || lowered == "[redacted]"
        }
        JsonValue::Array(items) => items.iter().any(is_redacted_value),
        JsonValue::Object(map) => map.values().any(is_redacted_value),
        _ => false,
    }
}

fn sanitize_base_url(raw: &str) -> Result<Option<String>, ()> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if is_reference(trimmed) {
        return Ok(Some(trimmed.to_string()));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(());
    }
    // Fail closed: a URL-shaped value that cannot be parsed never reaches the
    // DTO as-is, and its fragments (which can carry tokens) are never shown.
    let mut url = url::Url::parse(trimmed).map_err(|_| ())?;
    let mut had_userinfo = false;
    if !url.username().is_empty() || url.password().is_some() {
        had_userinfo = true;
        url.set_username("").map_err(|_| ())?;
        url.set_password(None).map_err(|_| ())?;
    }
    let mut stripped_secret_query = false;
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if pairs.iter().any(|(k, _)| is_sensitive_query_key(k)) {
        stripped_secret_query = true;
        let retained: Vec<(String, String)> = pairs
            .into_iter()
            .filter(|(k, _)| !is_sensitive_query_key(k))
            .collect();
        if retained.is_empty() {
            url.set_query(None);
        } else {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            for (k, v) in retained {
                query.append_pair(&k, &v);
            }
            url.set_query(Some(&query.finish()));
        }
    }
    let had_fragment = url.fragment().is_some();
    if had_fragment {
        url.set_fragment(None);
    }
    if had_userinfo || stripped_secret_query || had_fragment {
        Ok(Some(url.to_string()))
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

fn sanitize_url_text(s: &str) -> Result<Option<String>, ()> {
    if is_reference(s) {
        return Ok(None);
    }
    let trimmed = s.trim();
    if looks_like_url_with_userinfo(trimmed) || looks_like_url_with_secret_query(trimmed) {
        return Err(());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Ok(None);
    }
    match sanitize_base_url(trimmed)? {
        Some(safe) if safe != trimmed => Ok(Some(safe)),
        _ => Ok(None),
    }
}

fn looks_like_url_with_userinfo(s: &str) -> bool {
    let Some(scheme_end) = s.find("://") else {
        return false;
    };
    let authority_start = scheme_end + 3;
    let authority_end = s[authority_start..]
        .find(['/', '?', '#'])
        .map(|i| authority_start + i)
        .unwrap_or(s.len());
    s[authority_start..authority_end].contains('@')
}

fn looks_like_url_with_secret_query(s: &str) -> bool {
    let Some(query_start) = s.find('?') else {
        return false;
    };
    let query = &s[query_start + 1..];
    query.split('&').any(|pair| {
        let key = pair.split('=').next().unwrap_or("");
        is_sensitive_query_key(key)
    })
}

fn looks_like_url_with_fragment(s: &str) -> bool {
    match s.find('#') {
        Some(index) => !s[index + 1..].trim().is_empty(),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Edit validation
// ---------------------------------------------------------------------------

struct EditFacts<'a> {
    providers: &'a [ProviderEntry],
    ambiguous: bool,
}

fn validate_edit_batch(
    root: &JObject,
    facts: &EditFacts,
    edits: &[Edit],
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let mut seen_paths: Vec<Vec<String>> = Vec::new();
    for edit in edits {
        validate_edit_path_shape(&edit.path)?;
        if let EditOp::Set = edit.op {
            if edit.value.is_none() {
                return Err("A `set` edit requires a value.".to_string());
            }
        } else if edit.value.is_some() {
            return Err("A `remove` edit must not include a value.".to_string());
        }
        for other in &seen_paths {
            if other == &edit.path {
                return Err("The same path appears in more than one edit.".to_string());
            }
            if is_prefix(other, &edit.path) || is_prefix(&edit.path, other) {
                return Err(
                    "A batch cannot contain both a path and one of its ancestors.".to_string(),
                );
            }
        }
        seen_paths.push(edit.path.clone());
    }

    for edit in edits {
        validate_single_edit(root, facts, edit, warnings)?;
    }
    Ok(())
}

fn validate_edit_path_shape(path: &[String]) -> Result<(), String> {
    if path.is_empty() || path.len() > MAX_PATH_DEPTH {
        return Err("The edit path is empty or too deep.".to_string());
    }
    for segment in path {
        if segment.is_empty() || segment.len() > 512 {
            return Err("The edit path contains an empty or overlong segment.".to_string());
        }
        if segment.chars().any(|c| c.is_control()) {
            return Err("The edit path contains control characters.".to_string());
        }
    }
    Ok(())
}

fn is_prefix(a: &[String], b: &[String]) -> bool {
    a.len() < b.len() && b.starts_with(a)
}

fn validate_single_edit(
    root: &JObject,
    facts: &EditFacts,
    edit: &Edit,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if path_eq(&edit.path, &["model"]) {
        if facts.ambiguous {
            return Err(
                "Ambiguous files require an explicit provider format choice before editing the default model."
                    .to_string(),
            );
        }
        return validate_default_model_edit(root, edit);
    }

    let (map_key, target_dialect) = match edit.path[0].as_str() {
        "provider" => ("provider", Dialect::V1),
        "providers" => ("providers", Dialect::V2),
        _ => return Err("Only provider, model and default-model paths may be edited.".to_string()),
    };
    if edit.path.len() < 2 {
        return Err("Whole provider-map replacement is not permitted.".to_string());
    }
    if facts.ambiguous && !(edit.op == EditOp::Set && edit.path.len() == 2) {
        return Err(
            "Ambiguous files require creating an explicit provider map entry first.".to_string(),
        );
    }

    let map_value = root.get(map_key).map(|p| &p.value);
    let map_obj = match map_value {
        None => None,
        Some(JValue::Object(obj)) => Some(obj),
        Some(_) => return Err("The provider map has an invalid shape.".to_string()),
    };
    let provider_id = edit.path[1].as_str();
    validate_identifier(provider_id, "provider")?;

    let existing_provider = map_obj.and_then(|m| m.get(provider_id)).map(|p| &p.value);
    if edit.path.len() == 2 {
        return match edit.op {
            EditOp::Set => {
                if existing_provider.is_some() {
                    return Err(
                        "Replacing an existing provider is not permitted; edit fields or create a new provider."
                            .to_string(),
                    );
                }
                let Some(value) = &edit.value else {
                    return Err("A provider creation requires an object value.".to_string());
                };
                validate_provider_creation(value, target_dialect)?;
                Ok(())
            }
            EditOp::Remove => {
                let Some(value) = existing_provider else {
                    return Err("The provider to remove does not exist.".to_string());
                };
                if value.as_object().is_none() {
                    return Err("The existing provider has an invalid shape.".to_string());
                }
                if credential_status(&JsonValue::from(value.clone())) != CredentialStatus::None {
                    warnings.push(format!(
                        "Removing provider '{provider_id}' also removes its credential configuration (values are not shown)."
                    ));
                }
                Ok(())
            }
        };
    }

    let Some(provider_value) = existing_provider else {
        return Err(
            "The provider does not exist; create it before editing nested fields.".to_string(),
        );
    };
    let Some(provider_obj) = provider_value.as_object() else {
        return Err("The existing provider has an invalid shape.".to_string());
    };
    let entry_dialect = facts
        .providers
        .iter()
        .find(|p| {
            p.id == provider_id && (p.dialect == target_dialect || p.dialect == Dialect::Ambiguous)
        })
        .map(|p| p.dialect)
        .unwrap_or(target_dialect);
    if entry_dialect != target_dialect && entry_dialect != Dialect::Ambiguous {
        return Err("The existing provider dialect does not match this edit path.".to_string());
    }

    let field = edit.path[2].as_str();
    match edit.path.len() {
        3 => {
            let allowed_v1 = ["name", "npm", "api"];
            let allowed_v2 = ["name", "package"];
            if !(target_dialect == Dialect::V1 && allowed_v1.contains(&field))
                && !(target_dialect == Dialect::V2 && allowed_v2.contains(&field))
            {
                return Err("That provider field cannot be edited in this version.".to_string());
            }
            apply_string_leaf(provider_obj, field, edit, "provider field")
        }
        4 if field == "options" && target_dialect == Dialect::V1 => {
            let key = edit.path[3].as_str();
            if key != "baseURL" {
                return Err(
                    "Only `options.baseURL` can be edited; credential and header options are protected."
                        .to_string(),
                );
            }
            validate_container_parent(provider_obj, "options")?;
            apply_base_url_leaf(provider_obj.get_object("options"), key, edit)
        }
        4 if field == "settings" && target_dialect == Dialect::V2 => {
            let key = edit.path[3].as_str();
            if key != "baseURL" {
                return Err(
                    "Only `settings.baseURL` can be edited; credential and header settings are protected."
                        .to_string(),
                );
            }
            validate_container_parent(provider_obj, "settings")?;
            apply_base_url_leaf(provider_obj.get_object("settings"), key, edit)
        }
        4 if field == "models" => {
            let model_id = edit.path[3].as_str();
            validate_model_identifier(model_id)?;
            let existing_model = provider_obj
                .get_object("models")
                .and_then(|m| m.get(model_id))
                .map(|p| &p.value);
            match edit.op {
                EditOp::Set => {
                    if existing_model.is_some() {
                        return Err(
                            "Replacing an existing model entry is not permitted; edit fields or create a new model."
                                .to_string(),
                        );
                    }
                    let Some(value) = &edit.value else {
                        return Err("A model creation requires an object value.".to_string());
                    };
                    validate_model_creation(value, target_dialect)?;
                    Ok(())
                }
                EditOp::Remove => {
                    let Some(value) = existing_model else {
                        return Err("The model to remove does not exist.".to_string());
                    };
                    if value.as_object().is_none() {
                        return Err("The existing model has an invalid shape.".to_string());
                    }
                    if credential_status(&JsonValue::from(value.clone())) != CredentialStatus::None
                    {
                        warnings.push(format!(
                            "Removing model '{model_id}' also removes its credential/header configuration (values are not shown)."
                        ));
                    }
                    Ok(())
                }
            }
        }
        _ => validate_model_field_edit(provider_obj, target_dialect, edit, warnings),
    }
}

fn validate_default_model_edit(root: &JObject, edit: &Edit) -> Result<(), String> {
    let existing = root.get("model").map(|p| &p.value);
    match edit.op {
        EditOp::Set => {
            let Some(value) = edit.value.as_ref().and_then(|v| v.as_str()) else {
                return Err("The default model must be a string.".to_string());
            };
            validate_default_model_string(value)?;
            if existing.is_some_and(|v| v.as_object().is_some()) {
                return Err(
                    "The existing default model uses an object selector and cannot be replaced in this version."
                        .to_string(),
                );
            }
            Ok(())
        }
        EditOp::Remove => {
            let Some(value) = existing else {
                return Err("No default model is set.".to_string());
            };
            if value.as_string_lit().is_none() {
                return Err(
                    "The existing default model is not a string and cannot be removed in this version."
                        .to_string(),
                );
            }
            Ok(())
        }
    }
}

fn validate_provider_creation(value: &JsonValue, dialect: Dialect) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "A new provider must be an object.".to_string())?;
    let allowed: &[&str] = match dialect {
        Dialect::V1 => &["name", "npm", "api", "options", "models"],
        Dialect::V2 => &["name", "package", "settings", "models"],
        _ => return Err("A new provider must have an explicit V1 or V2 format.".to_string()),
    };
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "Field `{key}` cannot be added to a new provider in this version."
            ));
        }
    }
    if let Some(name) = obj.get("name") {
        let s = name
            .as_str()
            .ok_or_else(|| "Provider name must be a string.".to_string())?;
        validate_safe_string(s, 4096, "provider name")?;
    }
    for key in ["npm", "api", "package"] {
        if let Some(v) = obj.get(key) {
            let s = v
                .as_str()
                .ok_or_else(|| format!("Provider `{key}` must be a string."))?;
            validate_safe_string(s, 4096, key)?;
        }
    }
    if dialect == Dialect::V1 && obj.contains_key("package")
        || dialect == Dialect::V2 && (obj.contains_key("npm") || obj.contains_key("api"))
    {
        return Err("The new provider mixes V1 and V2 fields.".to_string());
    }

    if let Some(container) = obj.get("options").or_else(|| obj.get("settings")) {
        let container_obj = container
            .as_object()
            .ok_or_else(|| "The provider options/settings field must be an object.".to_string())?;
        for key in container_obj.keys() {
            if key != "baseURL" {
                return Err(
                    "Only `baseURL` may be set in a new provider options/settings object."
                        .to_string(),
                );
            }
        }
        if let Some(base_url) = container_obj.get("baseURL") {
            let s = base_url
                .as_str()
                .ok_or_else(|| "baseURL must be a string.".to_string())?;
            validate_base_url_value(s)?;
        }
    }

    if let Some(models) = obj.get("models") {
        let model_map = models
            .as_object()
            .ok_or_else(|| "Provider models must be an object.".to_string())?;
        for (model_id, model_value) in model_map {
            validate_model_identifier(model_id)?;
            validate_model_creation(model_value, dialect)?;
        }
    }
    Ok(())
}

fn validate_model_creation(value: &JsonValue, dialect: Dialect) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "A new model must be an object.".to_string())?;
    let allowed: &[&str] = match dialect {
        Dialect::V1 => &["name", "id", "limit", "reasoning", "variants"],
        Dialect::V2 => &["name", "modelID", "limit", "capabilities", "variants"],
        _ => return Err("A new model must have an explicit V1 or V2 format.".to_string()),
    };
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "Field `{key}` cannot be added to a new model in this version."
            ));
        }
    }
    if dialect == Dialect::V1 && (obj.contains_key("modelID") || obj.contains_key("capabilities")) {
        return Err("The new model mixes V1 and V2 fields.".to_string());
    }
    if dialect == Dialect::V2 && (obj.contains_key("id") || obj.contains_key("reasoning")) {
        return Err("The new model mixes V1 and V2 fields.".to_string());
    }

    for key in ["name", "id", "modelID"] {
        if let Some(v) = obj.get(key) {
            let s = v
                .as_str()
                .ok_or_else(|| format!("Model `{key}` must be a string."))?;
            if key == "name" {
                validate_safe_string(s, 4096, "model name")?;
            } else {
                validate_safe_string(s, 4096, "model identifier")?;
            }
        }
    }
    if let Some(limit) = obj.get("limit") {
        validate_limit_object(limit)?;
    }
    if let Some(reasoning) = obj.get("reasoning") {
        if reasoning.as_bool().is_none() {
            return Err("V1 model reasoning must be a boolean.".to_string());
        }
    }
    if let Some(capabilities) = obj.get("capabilities") {
        let cap = capabilities
            .as_object()
            .ok_or_else(|| "Model capabilities must be an object.".to_string())?;
        for key in cap.keys() {
            if key != "reasoning" {
                return Err(
                    "Only `capabilities.reasoning` may be added in this version.".to_string(),
                );
            }
        }
        if let Some(reasoning) = cap.get("reasoning") {
            validate_v2_reasoning(reasoning)?;
        }
    }
    if let Some(variants) = obj.get("variants") {
        validate_variants_value(variants, dialect, false)?;
    }
    Ok(())
}

fn validate_model_field_edit(
    provider_obj: &JObject,
    dialect: Dialect,
    edit: &Edit,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if edit.path.len() < 5 || edit.path[2] != "models" {
        return Err("That provider/model path cannot be edited.".to_string());
    }
    let model_id = edit.path[3].as_str();
    let Some(model_value) = provider_obj
        .get_object("models")
        .and_then(|m| m.get(model_id))
        .map(|p| &p.value)
    else {
        return Err(
            "The model does not exist; create it before editing nested fields.".to_string(),
        );
    };
    let Some(model_obj) = model_value.as_object() else {
        return Err("The existing model has an invalid shape.".to_string());
    };

    let field = edit.path[4].as_str();
    if edit.path.len() == 5 {
        let allowed_v1 = ["name", "id", "reasoning", "variants"];
        let allowed_v2 = ["name", "modelID", "variants", "limit", "capabilities"];
        let allowed = if dialect == Dialect::V1 {
            allowed_v1.contains(&field)
        } else {
            allowed_v2.contains(&field)
        };
        if !allowed {
            return Err("That model field cannot be edited in this version.".to_string());
        }
        match field {
            "name" | "id" | "modelID" => {
                if let Some(value) = edit.value.as_ref() {
                    let s = value
                        .as_str()
                        .ok_or_else(|| "This field requires a string value.".to_string())?;
                    if field == "name" {
                        validate_safe_string(s, 4096, "model name")?;
                    } else {
                        validate_safe_string(s, 4096, "model identifier")?;
                    }
                }
                Ok(())
            }
            "reasoning" => {
                if let Some(value) = edit.value.as_ref() {
                    if value.as_bool().is_none() {
                        return Err("V1 reasoning must be a boolean.".to_string());
                    }
                }
                Ok(())
            }
            "variants" => {
                let existing = model_obj.get("variants").map(|p| &p.value);
                if existing.is_some_and(|v| {
                    credential_status(&JsonValue::from(v.clone())) != CredentialStatus::None
                }) {
                    return Err(
                        "These variants contain credential or custom-header configuration and cannot be edited."
                            .to_string(),
                    );
                }
                if let Some(value) = edit.value.as_ref() {
                    validate_variants_value(value, dialect, true)?;
                } else {
                    warnings.push(
                        "Removing model variants also removes their provider-specific settings."
                            .to_string(),
                    );
                }
                Ok(())
            }
            "limit" | "capabilities" => {
                Err("Replace this field through its leaf paths instead.".to_string())
            }
            _ => Err("That model field cannot be edited.".to_string()),
        }
    } else if edit.path.len() == 6 {
        let leaf = edit.path[5].as_str();
        if field == "limit" {
            if !matches!(leaf, "context" | "input" | "output") {
                return Err(
                    "Only limit.context, limit.input and limit.output can be edited.".to_string(),
                );
            }
            if let Some(value) = edit.value.as_ref() {
                validate_limit_number(value)?;
            }
            if edit.op == EditOp::Remove {
                validate_leaf_exists(model_obj.get_object("limit"), leaf)?;
            } else {
                // Unreachable from the edit entry point while
                // `provider_has_invalid_types` treats a non-object `limit` as making
                // the whole file read-only: `prepare_changes` rejects the file before
                // this runs. The message is kept because it is what the user should
                // see once that gate names the offending field instead of the file.
                validate_creatable_block(model_obj.get("limit"), || {
                    "The `limit` field must be an object.".to_string()
                })?;
            }
            Ok(())
        } else if field == "capabilities" && leaf == "reasoning" && dialect == Dialect::V2 {
            if let Some(value) = edit.value.as_ref() {
                validate_v2_reasoning(value)?;
            }
            if edit.op == EditOp::Remove {
                validate_leaf_exists(model_obj.get_object("capabilities"), leaf)?;
            } else {
                // Same reachability boundary as the `limit` block above: the file-level
                // gate rejects a non-object `capabilities` before this validation runs.
                validate_creatable_block(model_obj.get("capabilities"), || {
                    "The `capabilities` field must be an object.".to_string()
                })?;
            }
            Ok(())
        } else {
            Err("That model field cannot be edited in this version.".to_string())
        }
    } else {
        Err("Model variants must be replaced as a whole object/array or through supported leaf fields.".to_string())
    }
}

fn apply_string_leaf(parent: &JObject, key: &str, edit: &Edit, label: &str) -> Result<(), String> {
    match edit.op {
        EditOp::Set => {
            let Some(value) = edit.value.as_ref() else {
                return Err("A string value is required.".to_string());
            };
            let s = value
                .as_str()
                .ok_or_else(|| format!("The {label} must be a string."))?;
            validate_safe_string(s, 4096, label)?;
            Ok(())
        }
        EditOp::Remove => {
            if parent.get(key).is_none() {
                return Err(format!("The {label} does not exist."));
            }
            Ok(())
        }
    }
}

fn apply_base_url_leaf(container: Option<&JObject>, key: &str, edit: &Edit) -> Result<(), String> {
    match edit.op {
        EditOp::Set => {
            let Some(value) = edit.value.as_ref() else {
                return Err("A baseURL string is required.".to_string());
            };
            let s = value
                .as_str()
                .ok_or_else(|| "baseURL must be a string.".to_string())?;
            validate_base_url_value(s)?;
            Ok(())
        }
        EditOp::Remove => {
            let Some(container) = container else {
                return Err("The options/settings object does not exist.".to_string());
            };
            if container.get(key).is_none() {
                return Err("The baseURL field does not exist.".to_string());
            }
            Ok(())
        }
    }
}

fn validate_container_parent(provider: &JObject, key: &str) -> Result<(), String> {
    validate_creatable_block(provider.get(key), || {
        format!("The provider `{key}` field has an invalid shape.")
    })
}

fn validate_leaf_exists(parent: Option<&JObject>, key: &str) -> Result<(), String> {
    let parent = parent.ok_or_else(|| "The parent object does not exist.".to_string())?;
    if parent.get(key).is_none() {
        return Err("The requested leaf field does not exist.".to_string());
    }
    Ok(())
}

/// Shared shape rule for a block that a `Set` is allowed to create.
///
/// An absent block is creatable: the write path scaffolds missing intermediate
/// objects for supported creation paths, and validation must not be stricter
/// than the writer. A block that exists with the wrong shape is a malformed
/// file, and stays a separate outcome that is refused rather than silently
/// replaced -- otherwise "I left it out" and "my file is broken" would report
/// the same thing and the user could not tell them apart.
fn validate_creatable_block(
    parent: Option<&JObjectProp>,
    invalid_shape: impl FnOnce() -> String,
) -> Result<(), String> {
    match parent {
        None => Ok(()),
        Some(prop) if prop.value.as_object().is_some() => Ok(()),
        Some(_) => Err(invalid_shape()),
    }
}

fn validate_default_model_string(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 {
        return Err("The default model is empty or too long.".to_string());
    }
    if value.chars().any(|c| c.is_control()) {
        return Err("The default model contains control characters.".to_string());
    }
    if is_reference(value) {
        return Ok(());
    }
    let Some((provider, model)) = value.split_once('/') else {
        return Err("The default model must use `provider/model` format.".to_string());
    };
    if provider.is_empty() || model.is_empty() {
        return Err("The default model must use `provider/model` format.".to_string());
    }
    if provider.contains('#') || model.contains('#') {
        // `#variant` on the model part is accepted by OpenCode; more than one
        // separator is ambiguous.
        let hashes = value.matches('#').count();
        if hashes > 1 {
            return Err("The default model has too many variant separators.".to_string());
        }
    }
    if value.chars().any(char::is_whitespace) {
        return Err("The default model cannot contain whitespace.".to_string());
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 256 {
        return Err(format!("The {label} identifier is empty or too long."));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(format!(
            "The {label} identifier contains control characters."
        ));
    }
    if value.contains('/') || value.contains('#') {
        return Err(format!(
            "The {label} identifier contains a reserved character."
        ));
    }
    Ok(())
}

fn validate_model_identifier(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 {
        return Err("The model identifier is empty or too long.".to_string());
    }
    if value.chars().any(|c| c.is_control()) {
        return Err("The model identifier contains control characters.".to_string());
    }
    Ok(())
}

fn validate_safe_string(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.len() > max {
        return Err(format!("The {label} is too long."));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(format!("The {label} contains control characters."));
    }
    if is_redacted_value(&JsonValue::String(value.to_string())) {
        return Err(
            "Redacted preview values cannot be written back to the configuration.".to_string(),
        );
    }
    if !is_reference(value)
        && (looks_like_url_with_userinfo(value)
            || looks_like_url_with_secret_query(value)
            || looks_like_url_with_fragment(value))
    {
        return Err(
            "Strings containing URL userinfo, secret query parameters or a fragment cannot be added."
                .to_string(),
        );
    }
    Ok(())
}

fn validate_base_url_value(value: &str) -> Result<(), String> {
    validate_safe_string(value, 8192, "baseURL")?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("The baseURL is empty.".to_string());
    }
    if is_reference(trimmed) {
        return Ok(());
    }
    if looks_like_url_with_userinfo(trimmed)
        || looks_like_url_with_secret_query(trimmed)
        || looks_like_url_with_fragment(trimmed)
    {
        return Err(
            "A baseURL containing URL userinfo, secret query parameters or a fragment cannot be added."
                .to_string(),
        );
    }
    if let Ok(url) = url::Url::parse(trimmed) {
        if !url.username().is_empty() || url.password().is_some() {
            return Err("A baseURL containing URL userinfo cannot be added.".to_string());
        }
        if url.query_pairs().any(|(k, _)| is_sensitive_query_key(&k)) {
            return Err(
                "A baseURL containing secret query parameters cannot be added.".to_string(),
            );
        }
        if url.fragment().is_some() {
            return Err("A baseURL containing a URL fragment cannot be added.".to_string());
        }
    }
    Ok(())
}

fn validate_limit_number(value: &JsonValue) -> Result<(), String> {
    let number = value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|n| i64::try_from(n).ok()))
        .ok_or_else(|| "Limit values must be non-negative integers.".to_string())?;
    if number < 0 {
        return Err("Limit values must be non-negative integers.".to_string());
    }
    Ok(())
}

fn validate_limit_object(value: &JsonValue) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "The limit field must be an object.".to_string())?;
    for key in obj.keys() {
        if !matches!(key.as_str(), "context" | "input" | "output") {
            return Err(format!("Unsupported limit field `{key}`."));
        }
    }
    for value in obj.values() {
        validate_limit_number(value)?;
    }
    Ok(())
}

fn validate_variants_value(
    value: &JsonValue,
    dialect: Dialect,
    editing_existing: bool,
) -> Result<(), String> {
    validate_safe_edit_value(value)?;
    match dialect {
        Dialect::V1 => {
            let obj = value
                .as_object()
                .ok_or_else(|| "V1 variants must be an object.".to_string())?;
            for (variant_id, config) in obj {
                validate_model_identifier(variant_id)?;
                if config.as_object().is_none() {
                    return Err("Each V1 variant must be an object.".to_string());
                }
            }
        }
        Dialect::V2 => {
            let array = value
                .as_array()
                .ok_or_else(|| "V2 variants must be an array.".to_string())?;
            let mut ids = HashSet::new();
            for config in array {
                let obj = config
                    .as_object()
                    .ok_or_else(|| "Each V2 variant must be an object.".to_string())?;
                let id = obj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Each V2 variant requires a string `id`.".to_string())?;
                validate_model_identifier(id)?;
                if !ids.insert(id.to_string()) {
                    return Err("V2 variant ids must be unique.".to_string());
                }
            }
        }
        _ => return Err("Variants require an explicit provider format.".to_string()),
    }
    let _ = editing_existing;
    Ok(())
}

fn validate_safe_edit_value(value: &JsonValue) -> Result<(), String> {
    let mut nodes = 0usize;
    validate_safe_edit_value_inner(value, 0, &mut nodes)
}

fn validate_safe_edit_value_inner(
    value: &JsonValue,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), String> {
    *nodes += 1;
    if depth > MAX_EDIT_VALUE_DEPTH || *nodes > MAX_EDIT_VALUE_NODES {
        return Err("The edit value is too large or too deeply nested.".to_string());
    }
    if is_redacted_value(value) {
        return Err(
            "Redacted preview values cannot be written back to the configuration.".to_string(),
        );
    }
    match value {
        JsonValue::String(s) => {
            if s.len() > 65_536 {
                return Err("An edit string value is too long.".to_string());
            }
            if s.chars().any(|c| c.is_control()) {
                return Err("An edit string value contains control characters.".to_string());
            }
            if !is_reference(s)
                && (looks_like_url_with_userinfo(s) || looks_like_url_with_secret_query(s))
            {
                return Err(
                    "URLs containing userinfo or secret query parameters cannot be added."
                        .to_string(),
                );
            }
            Ok(())
        }
        JsonValue::Array(items) => {
            for item in items {
                validate_safe_edit_value_inner(item, depth + 1, nodes)?;
            }
            Ok(())
        }
        JsonValue::Object(map) => {
            for (key, child) in map {
                if is_secret_key(key) || is_sensitive_container_key(key) {
                    return Err(format!(
                        "Field `{key}` is credential/header data and cannot be edited in this version."
                    ));
                }
                validate_safe_edit_value_inner(child, depth + 1, nodes)?;
            }
            Ok(())
        }
        JsonValue::Number(_) | JsonValue::Bool(_) | JsonValue::Null => Ok(()),
    }
}

fn validate_v2_reasoning(value: &JsonValue) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "V2 capabilities.reasoning must be an object.".to_string())?;
    for key in obj.keys() {
        if !matches!(key.as_str(), "supported" | "toggle" | "effort" | "budget") {
            return Err(format!("Unsupported capabilities.reasoning field `{key}`."));
        }
    }
    let supported = obj
        .get("supported")
        .and_then(|value| value.as_bool())
        .ok_or_else(|| {
            "V2 capabilities.reasoning requires a boolean `supported` field.".to_string()
        })?;
    if !supported {
        if obj.len() != 1 {
            return Err(
                "capabilities.reasoning with supported:false cannot include toggle, effort or budget."
                    .to_string(),
            );
        }
        return Ok(());
    }

    if let Some(toggle) = obj.get("toggle") {
        if toggle.as_bool().is_none() {
            return Err("capabilities.reasoning.toggle must be a boolean.".to_string());
        }
    }
    if let Some(effort) = obj.get("effort") {
        let efforts = effort.as_array().ok_or_else(|| {
            "capabilities.reasoning.effort must be an array of strings.".to_string()
        })?;
        if efforts.len() > MAX_REASONING_EFFORTS {
            return Err(format!(
                "capabilities.reasoning.effort may contain at most {MAX_REASONING_EFFORTS} entries."
            ));
        }
        let mut seen = HashSet::new();
        for entry in efforts {
            let label = entry.as_str().ok_or_else(|| {
                "capabilities.reasoning.effort entries must be strings.".to_string()
            })?;
            if label.trim().is_empty() || label.len() > MAX_REASONING_STRING {
                return Err("A reasoning effort label is empty or too long.".to_string());
            }
            validate_safe_string(label, MAX_REASONING_STRING, "reasoning effort")?;
            if !seen.insert(label.to_string()) {
                return Err("capabilities.reasoning.effort labels must be unique.".to_string());
            }
        }
    }
    if let Some(budget) = obj.get("budget") {
        let budget = budget
            .as_object()
            .ok_or_else(|| "capabilities.reasoning.budget must be an object.".to_string())?;
        for key in budget.keys() {
            if !matches!(key.as_str(), "min" | "max") {
                return Err(format!(
                    "Unsupported capabilities.reasoning.budget field `{key}`."
                ));
            }
        }
        let min = budget.get("min").map(reasoning_budget_number).transpose()?;
        let max = budget.get("max").map(reasoning_budget_number).transpose()?;
        if let (Some(min), Some(max)) = (min, max) {
            if min > max {
                return Err(
                    "capabilities.reasoning.budget.min cannot exceed budget.max.".to_string(),
                );
            }
        }
    }
    Ok(())
}

fn reasoning_budget_number(value: &JsonValue) -> Result<i64, String> {
    let number = value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .ok_or_else(|| "capabilities.reasoning.budget values must be safe integers.".to_string())?;
    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&number) {
        return Err(
            "capabilities.reasoning.budget values exceed the safe integer range.".to_string(),
        );
    }
    Ok(number)
}

fn path_eq(path: &[String], expected: &[&str]) -> bool {
    if path.len() != expected.len() {
        return false;
    }
    path.iter().zip(expected.iter()).all(|(a, b)| a == b)
}

// ---------------------------------------------------------------------------
// Text editing
// ---------------------------------------------------------------------------

fn edit_removes_whole_entry(edit: &Edit) -> bool {
    if edit.op != EditOp::Remove {
        return false;
    }
    let path = &edit.path;
    if path.len() == 2 && matches!(path[0].as_str(), "provider" | "providers") {
        return true;
    }
    path.len() == 4 && matches!(path[0].as_str(), "provider" | "providers") && path[2] == "models"
}

/// Count comments that live inside the byte range belonging to a whole-entry
/// deletion (the provider/model entry line range).
fn comment_delta_inside_removed_entry(text: &str, edit: &Edit) -> usize {
    let Ok(root) = parse_root(text) else {
        return 0;
    };
    let Some(root_obj) = root.as_object() else {
        return 0;
    };
    let Some(entry) = find_object_at(root_obj, &edit.path) else {
        return 0;
    };
    let range = entry.range;
    let start_line = text[..range.start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let end_line = text[range.end..]
        .find('\n')
        .map(|i| range.end + i + 1)
        .unwrap_or(text.len());
    let entry_text = &text[start_line..end_line];
    collect_comments(entry_text).len()
}

fn apply_one_edit(
    text: &str,
    edit: &Edit,
    pretty: bool,
    newline: &str,
    unit: &str,
) -> Result<String, String> {
    match edit.op {
        EditOp::Set => {
            let value = edit
                .value
                .as_ref()
                .ok_or_else(|| "A set edit requires a value.".to_string())?;
            apply_set_path(text.to_string(), &edit.path, value, pretty, newline, unit)
        }
        EditOp::Remove => apply_remove_path(text.to_string(), &edit.path),
    }
}

fn apply_set_path(
    mut text: String,
    path: &[String],
    value: &JsonValue,
    pretty: bool,
    newline: &str,
    unit: &str,
) -> Result<String, String> {
    for _ in 0..MAX_PATH_DEPTH + 2 {
        let parsed = parse_root(&text)?;
        let root = parsed
            .as_object()
            .ok_or_else(|| "The configuration root must be an object.".to_string())?;
        if let Some(parent) = find_object_at(root, &path[..path.len() - 1]) {
            let key = path.last().expect("non-empty path");
            if let Some(prop) = parent.get(key) {
                let property_indent = line_indent_at(&text, prop.name_start());
                let replacement = format_json_value(value, &property_indent, pretty, newline, unit);
                let start = prop.value_range().start;
                let end = prop.value_range().end;
                return Ok(replace_range(&text, start, end, &replacement));
            }
            return add_property(&text, parent, key, value, pretty, newline, unit);
        }

        // Auto-create missing intermediate objects for explicitly supported
        // creation paths. Validation already restricted the possible paths.
        let mut made_change = false;
        for i in 0..path.len() - 1 {
            let Some(obj) = find_object_at(root, &path[..i]) else {
                return Err(
                    "An intermediate configuration object has an invalid shape.".to_string()
                );
            };
            let key = &path[i];
            match obj.get(key) {
                Some(prop) if prop.value.as_object().is_none() => {
                    return Err(
                        "An intermediate configuration object has an invalid shape.".to_string()
                    );
                }
                Some(_) => continue,
                None => {
                    text = add_property(
                        &text,
                        obj,
                        key,
                        &JsonValue::Object(JsonMap::new()),
                        pretty,
                        newline,
                        unit,
                    )?;
                    made_change = true;
                    break;
                }
            }
        }
        if !made_change {
            return Err("The target object could not be located safely.".to_string());
        }
    }
    Err("The edit path could not be created safely.".to_string())
}

fn apply_remove_path(mut text: String, path: &[String]) -> Result<String, String> {
    let parsed = parse_root(&text)?;
    let root = parsed
        .as_object()
        .ok_or_else(|| "The configuration root must be an object.".to_string())?;
    let parent = find_object_at(root, &path[..path.len() - 1])
        .ok_or_else(|| "The parent object does not exist.".to_string())?;
    let key = path.last().expect("non-empty path");
    let prop = parent
        .get(key)
        .ok_or_else(|| "The edit target does not exist.".to_string())?;
    text = remove_property(&text, parent, prop)?;
    Ok(text)
}

fn find_object_at<'a, 'b>(root: &'a JObject<'b>, path: &[String]) -> Option<&'a JObject<'b>> {
    if path.is_empty() {
        return Some(root);
    }
    let prop = root.get(&path[0])?;
    let child = prop.value.as_object()?;
    find_object_at(child, &path[1..])
}

fn replace_range(text: &str, start: usize, end: usize, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len() + replacement.len());
    out.push_str(&text[..start]);
    out.push_str(replacement);
    out.push_str(&text[end..]);
    out
}

fn add_property(
    text: &str,
    object: &JObject,
    key: &str,
    value: &JsonValue,
    pretty: bool,
    newline: &str,
    unit: &str,
) -> Result<String, String> {
    let range = object.range;
    let bytes = text.as_bytes();
    if range.start >= range.end || range.end > bytes.len() || bytes[range.end - 1] != b'}' {
        return Err("The target object range is not safe to edit.".to_string());
    }
    let open = range.start;
    let close = range.end - 1;
    let body = &text[open + 1..close];
    let multiline = body.contains('\n');
    let line_indent = line_indent_at(text, open);
    let key_json = serde_json::to_string(key)
        .map_err(|_| "The new property name could not be serialized.".to_string())?;

    if object.properties.is_empty() {
        if pretty {
            let child_indent = format!("{line_indent}{unit}");
            let value_text = format_json_value(value, &child_indent, true, newline, unit);
            let replacement = format!(
                "{{{newline}{child_indent}{key_json}: {value_text}{newline}{line_indent}}}"
            );
            return Ok(replace_range(text, open, close + 1, &replacement));
        }
        let value_text = format_json_value(value, "", false, newline, unit);
        let replacement = format!("{{{key_json}: {value_text}}}");
        return Ok(replace_range(text, open, close + 1, &replacement));
    }

    if !multiline {
        if body_contains_comment(body) {
            return Err("A one-line object with comments cannot be extended safely.".to_string());
        }
        let last_prop = object.properties.last().expect("non-empty");
        let last_value_end = last_prop.value_range().end;
        let after_last = text[last_value_end..close].trim();
        let had_trailing_comma = after_last.starts_with(',');
        let value_text = format_json_value(value, "", false, newline, unit);
        let mut insert = String::new();
        if had_trailing_comma {
            insert.push(' ');
        } else {
            insert.push_str(", ");
        }
        insert.push_str(&key_json);
        insert.push_str(": ");
        insert.push_str(&value_text);
        if had_trailing_comma {
            insert.push(',');
        }
        return Ok(insert_at(text, close, &insert));
    }

    let close_line_start = text[..close]
        .rfind('\n')
        .map(|i| i + 1)
        .ok_or_else(|| "The object closing brace is not on its own line.".to_string())?;
    if !text[close_line_start..close].trim().is_empty() {
        return Err("The object closing brace shares a line with other content.".to_string());
    }

    let property_indent = object
        .properties
        .first()
        .map(|p| line_indent_at(text, p.name_start()).to_string())
        .unwrap_or_else(|| format!("{line_indent}{unit}"));
    let last_prop = object.properties.last().expect("non-empty");
    let last_value_end = last_prop.value_range().end;
    let after_last = text[last_value_end..close].trim_start();
    let had_trailing_comma = after_last.starts_with(',');

    let value_text = format_json_value(value, &property_indent, true, newline, unit);
    let insert = format!(
        "{property_indent}{key_json}: {value_text}{}{newline}",
        if had_trailing_comma { "," } else { "" }
    );

    if !had_trailing_comma {
        // Add the separator after the previous value, before any trailing
        // comment on that line. The new property itself starts on a fresh line.
        let comma_pos = last_value_end;
        let with_comma = insert_at(text, comma_pos, ",");
        return Ok(insert_at(&with_comma, close_line_start + 1, &insert));
    }

    Ok(insert_at(text, close_line_start, &insert))
}

fn remove_property(text: &str, parent: &JObject, prop: &JObjectProp) -> Result<String, String> {
    let start = prop.name_start();
    let value_end = prop.value_range().end;
    let line_start = text[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    if !text[line_start..start].trim().is_empty() {
        return Err("An inline property cannot be removed safely.".to_string());
    }
    let line_end = text[value_end..]
        .find('\n')
        .map(|i| value_end + i + 1)
        .unwrap_or(text.len());
    let tail_end = text[value_end..line_end].trim_end_matches(['\n', '\r']);
    let tail = tail_end.trim();
    if !(tail.is_empty() || tail == ",") {
        return Err(
            "A property with a trailing comment or extra content cannot be removed safely."
                .to_string(),
        );
    }
    let had_trailing_comma = tail == ",";
    let index = parent
        .properties
        .iter()
        .position(|candidate| candidate.name_start() == start)
        .ok_or_else(|| "The edit target could not be located safely.".to_string())?;
    let is_last = index + 1 == parent.properties.len();

    let mut out = remove_range(text, line_start, line_end);
    if is_last && !had_trailing_comma && index > 0 {
        // Removing the final property would turn the previous separator comma
        // into a trailing comma. Remove that separator so strict JSON input
        // remains strict JSON.
        let previous = &parent.properties[index - 1];
        let previous_end = previous.value_range().end;
        if text[previous_end..].starts_with(',') {
            out = remove_range(&out, previous_end, previous_end + 1);
        }
    }
    Ok(out)
}

fn remove_range(text: &str, start: usize, end: usize) -> String {
    let mut out = String::with_capacity(text.len().saturating_sub(end - start));
    out.push_str(&text[..start]);
    out.push_str(&text[end..]);
    out
}

fn insert_at(text: &str, pos: usize, insertion: &str) -> String {
    let mut out = String::with_capacity(text.len() + insertion.len());
    out.push_str(&text[..pos]);
    out.push_str(insertion);
    out.push_str(&text[pos..]);
    out
}

trait AstPropExt {
    fn name_start(&self) -> usize;
    fn value_range(&self) -> jsonc_parser::common::Range;
}

impl AstPropExt for JObjectProp<'_> {
    fn name_start(&self) -> usize {
        match &self.name {
            jsonc_parser::ast::ObjectPropName::String(s) => s.range.start,
            jsonc_parser::ast::ObjectPropName::Word(w) => w.range.start,
        }
    }

    fn value_range(&self) -> jsonc_parser::common::Range {
        match &self.value {
            JValue::StringLit(v) => v.range,
            JValue::NumberLit(v) => v.range,
            JValue::BooleanLit(v) => v.range,
            JValue::Object(v) => v.range,
            JValue::Array(v) => v.range,
            JValue::NullKeyword(v) => v.range,
        }
    }
}

fn body_contains_comment(body: &str) -> bool {
    let mut chars = body.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '/' => match chars.peek() {
                Some('/') | Some('*') => return true,
                _ => {}
            },
            _ => {}
        }
    }
    false
}

fn collect_comments(text: &str) -> Vec<String> {
    let mut comments = Vec::new();
    let mut chars = text.char_indices().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some((index, c)) = chars.next() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '/' => match chars.peek() {
                Some((_, '/')) => {
                    let start = index;
                    chars.next();
                    let mut end = text.len();
                    for (i, ch) in chars.by_ref() {
                        if ch == '\n' {
                            end = i;
                            break;
                        }
                    }
                    comments.push(text[start..end].to_string());
                }
                Some((_, '*')) => {
                    let start = index;
                    chars.next();
                    while let Some((i, ch)) = chars.next() {
                        if ch == '*' && chars.peek().is_some_and(|(_, next)| *next == '/') {
                            chars.next();
                            comments.push(text[start..i + 2].to_string());
                            break;
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    comments
}

fn format_json_value(
    value: &JsonValue,
    indent: &str,
    pretty: bool,
    newline: &str,
    unit: &str,
) -> String {
    if !pretty {
        return serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
    }
    match value {
        JsonValue::Object(map) if !map.is_empty() => {
            let inner = format!("{indent}{unit}");
            let mut out = String::from("{");
            out.push_str(newline);
            for (index, (key, child)) in map.iter().enumerate() {
                out.push_str(&inner);
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push_str(": ");
                out.push_str(&format_json_value(child, &inner, true, newline, unit));
                if index + 1 < map.len() {
                    out.push(',');
                }
                out.push_str(newline);
            }
            out.push_str(indent);
            out.push('}');
            out
        }
        JsonValue::Array(items) if !items.is_empty() => {
            let inner = format!("{indent}{unit}");
            let mut out = String::from("[");
            out.push_str(newline);
            for (index, child) in items.iter().enumerate() {
                out.push_str(&inner);
                out.push_str(&format_json_value(child, &inner, true, newline, unit));
                if index + 1 < items.len() {
                    out.push(',');
                }
                out.push_str(newline);
            }
            out.push_str(indent);
            out.push(']');
            out
        }
        JsonValue::Object(_) => "{}".to_string(),
        JsonValue::Array(_) => "[]".to_string(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
    }
}

fn line_indent_at(text: &str, pos: usize) -> String {
    let start = text[..pos.min(text.len())]
        .rfind('\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    text[start..]
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .collect()
}

fn detect_newline(text: &str) -> String {
    if text.contains("\r\n") {
        "\r\n".to_string()
    } else {
        "\n".to_string()
    }
}

fn detect_indent_unit(text: &str) -> String {
    for line in text.lines().skip(1) {
        let indent: String = line
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect();
        if !indent.is_empty() {
            return indent;
        }
    }
    "  ".to_string()
}

fn apply_edit_to_json(root: &mut JsonValue, edit: &Edit) -> Result<(), String> {
    let object = root
        .as_object_mut()
        .ok_or_else(|| "The configuration root must be an object.".to_string())?;
    match edit.op {
        EditOp::Set => {
            let value = edit
                .value
                .clone()
                .ok_or_else(|| "A set edit requires a value.".to_string())?;
            set_json_path(object, &edit.path, value)
        }
        EditOp::Remove => remove_json_path(object, &edit.path),
    }
}

fn set_json_path(
    object: &mut JsonMap<String, JsonValue>,
    path: &[String],
    value: JsonValue,
) -> Result<(), String> {
    let key = path
        .first()
        .ok_or_else(|| "The edit path is empty.".to_string())?;
    if path.len() == 1 {
        object.insert(key.clone(), value);
        return Ok(());
    }
    let child = object
        .entry(key.clone())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    let child_obj = child
        .as_object_mut()
        .ok_or_else(|| "An intermediate configuration object has an invalid shape.".to_string())?;
    set_json_path(child_obj, &path[1..], value)
}

fn remove_json_path(
    object: &mut JsonMap<String, JsonValue>,
    path: &[String],
) -> Result<(), String> {
    let key = path
        .first()
        .ok_or_else(|| "The edit path is empty.".to_string())?;
    if path.len() == 1 {
        if object.remove(key).is_none() {
            return Err("The edit target does not exist.".to_string());
        }
        return Ok(());
    }
    let child = object
        .get_mut(key)
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "The parent object does not exist.".to_string())?;
    remove_json_path(child, &path[1..])
}

// ---------------------------------------------------------------------------
// Preview summary
// ---------------------------------------------------------------------------

fn render_change_summary(path: &str, edits: &[Edit]) -> String {
    let mut output = String::new();
    output.push_str(&format!("--- {path}\n"));
    output.push_str("+++ semantic change preview (credential values are masked)\n");
    for edit in edits {
        let label = display_edit_path(&edit.path);
        match edit.op {
            EditOp::Set => {
                let value = edit.value.as_ref();
                let rendered = value
                    .map(|v| preview_value(v, &edit.path))
                    .unwrap_or_else(|| "(missing)".to_string());
                output.push_str(&format!("~ set {label} = {rendered}\n"));
            }
            EditOp::Remove => {
                output.push_str(&format!("- remove {label}\n"));
            }
        }
    }
    output
}

fn display_edit_path(path: &[String]) -> String {
    let mut out = String::new();
    for (index, segment) in path.iter().enumerate() {
        if index > 0 {
            out.push('.');
        }
        if segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | ':' | '@'))
        {
            out.push_str(segment);
        } else {
            out.push('"');
            out.push_str(&segment.replace('\\', "\\\\").replace('"', "\\\""));
            out.push('"');
        }
    }
    out
}

fn preview_value(value: &JsonValue, path: &[String]) -> String {
    let depth = path.len();
    let leaf = path.last().map(|s| s.as_str()).unwrap_or("");
    match value {
        JsonValue::String(s) => {
            if is_reference(s) {
                return "[reference]".to_string();
            }
            let sanitized = match sanitize_url_text(s) {
                Ok(Some(safe)) => safe,
                Ok(None) => s.clone(),
                Err(()) => "[REDACTED]".to_string(),
            };
            if sanitized.len() > 160 {
                let truncated: String = sanitized.chars().take(160).collect();
                format!("\"{truncated}…\"")
            } else {
                format!("{sanitized:?}")
            }
        }
        JsonValue::Number(_) | JsonValue::Bool(_) | JsonValue::Null => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
        }
        JsonValue::Object(map) => {
            if depth == 2 || depth == 4 {
                "(new object; shell scaffold)".to_string()
            } else {
                format!("(object with {} fields)", map.len())
            }
        }
        JsonValue::Array(items) => {
            let _ = leaf;
            format!("(array with {} items)", items.len())
        }
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

fn add_dir_sources(
    dir: &Path,
    sources: &mut Vec<SourceDocument>,
    warnings: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    for name in CONFIG_NAMES {
        let path = dir.join(name);
        if !path.is_file() && !path.is_symlink() {
            continue;
        }
        let key = dedupe_key(&path);
        if !seen.insert(key) {
            continue;
        }
        match read_document(&path) {
            Ok(doc) => sources.push(doc),
            Err(err) => warnings.push(format!(
                "Could not load configuration at {}: {err}",
                display_path(&path)
            )),
        }
    }
}

fn global_config_dirs() -> Vec<PathBuf> {
    if let Some(dir) = env_path(ENV_CONFIG_DIR) {
        return vec![dir];
    }
    let mut dirs = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.trim().is_empty() {
            dirs.push(PathBuf::from(xdg).join("opencode"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".config").join("opencode"));
    }
    if let Some(config) = dirs::config_dir() {
        dirs.push(config.join("opencode"));
    }
    dedupe_paths(dirs)
}

fn managed_config_dirs() -> Vec<PathBuf> {
    if let Some(dir) = env_path(ENV_MANAGED_DIR) {
        return vec![dir];
    }
    let mut dirs = Vec::new();
    if cfg!(windows) {
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        dirs.push(program_data.join("opencode"));
    } else if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/Library/Application Support/opencode"));
    } else {
        dirs.push(PathBuf::from("/etc/opencode"));
    }
    dirs
}

fn is_managed_path(path: &Path) -> bool {
    let roots = managed_config_dirs();
    let target = normalize_comparable(path);
    roots
        .iter()
        .any(|root| path_under_comparable(&target, &normalize_comparable(root)))
}

fn ancestor_dirs(project: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut current = Some(project);
    while let Some(dir) = current {
        dirs.push(dir.to_path_buf());
        current = dir.parent();
    }
    dirs.reverse();
    dirs
}

fn dedupe_key(path: &Path) -> String {
    normalize_comparable(path)
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        let key = normalize_comparable(&path);
        if seen.insert(key) {
            out.push(path);
        }
    }
    out
}

fn normalize_comparable(path: &Path) -> String {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = resolved
        .to_string_lossy()
        .replace('/', std::path::MAIN_SEPARATOR_STR);
    if cfg!(windows) {
        text.trim_start_matches(r"\\?\").to_ascii_lowercase()
    } else {
        text.trim_start_matches(r"\\?\").to_string()
    }
}

fn path_under_comparable(path: &str, root: &str) -> bool {
    if path == root {
        return true;
    }
    let separator = std::path::MAIN_SEPARATOR_STR;
    let prefix = if root.ends_with(separator) {
        root.to_string()
    } else {
        format!("{root}{separator}")
    };
    path.starts_with(&prefix)
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let stripped = text
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or_else(|| text.trim_start_matches(r"\\?\").to_string());
    stripped
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn env_nonempty(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|v| !v.is_empty())
}

fn dedupe_warnings(warnings: &mut Vec<String>) {
    let mut seen = HashSet::new();
    warnings.retain(|warning| seen.insert(warning.clone()));
    if warnings.len() > 32 {
        warnings.truncate(32);
    }
}

// ---------------------------------------------------------------------------
// Filesystem safety
// ---------------------------------------------------------------------------

fn normalize_hash(hash: &str) -> Result<String, String> {
    let trimmed = hash.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("The expected file hash is invalid.".to_string());
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex_digest(&Sha256::digest(bytes))
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn path_key(path: &Path) -> String {
    normalize_comparable(path)
}

fn backups() -> &'static Mutex<HashMap<String, BackupRecord>> {
    BACKUPS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn backup_root() -> PathBuf {
    if let Some(dir) = env_path(ENV_BACKUP_DIR) {
        return dir;
    }
    let base = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("oc-providers-ctl").join("backups")
}

fn read_hash(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => hasher.update(&buffer[..read]),
            Err(_) => return None,
        }
    }
    Some(hex_digest(&hasher.finalize()))
}

fn ensure_restrictive_backup_dir(root: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(root)
            .map_err(|_| "Could not create the restrictive backup directory.".to_string())?;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|_| {
            "Could not enforce restrictive backup directory permissions.".to_string()
        })?;
        Ok(())
    }
    #[cfg(windows)]
    {
        fs::create_dir_all(root)
            .map_err(|_| "Could not create the restrictive backup directory.".to_string())?;
        set_restrictive_directory_acl(root)
    }
    #[cfg(not(any(unix, windows)))]
    {
        fs::create_dir_all(root)
            .map_err(|_| "Could not create the restrictive backup directory.".to_string())?;
        Ok(())
    }
}

#[cfg(not(windows))]
fn create_private_file(path: &Path) -> Result<File, String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|_| "Could not create a restrictive private file.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file
            .set_permissions(fs::Permissions::from_mode(0o600))
            .is_err()
        {
            drop(file);
            let _ = fs::remove_file(path);
            return Err("Could not enforce restrictive private file permissions.".to_string());
        }
    }
    Ok(file)
}

#[cfg(windows)]
fn create_private_file(path: &Path) -> Result<File, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows_sys::Win32::Foundation::{LocalFree, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL};

    const PRIVATE_FILE_SDDL: &str = "D:P(A;;FA;;;OW)(A;;FA;;;SY)";

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let mut descriptor_size = 0u32;
    let sddl = wide(OsStr::new(PRIVATE_FILE_SDDL));
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            &mut descriptor_size,
        )
    };
    if converted == 0 || descriptor.is_null() {
        return Err("Could not build a restrictive Windows security descriptor.".to_string());
    }

    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let path_wide = wide(path.as_os_str());
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        LocalFree(descriptor);
    }
    if handle == INVALID_HANDLE_VALUE {
        return Err("Could not create a restrictive private file.".to_string());
    }
    Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
}

#[cfg(windows)]
fn set_restrictive_directory_acl(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR,
    };

    const PRIVATE_DIRECTORY_SDDL: &str = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)";

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let mut descriptor_size = 0u32;
    let sddl = wide(OsStr::new(PRIVATE_DIRECTORY_SDDL));
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            &mut descriptor_size,
        )
    };
    if converted == 0 || descriptor.is_null() {
        return Err(
            "Could not build a restrictive backup directory security descriptor.".to_string(),
        );
    }
    let path_wide = wide(path.as_os_str());
    let applied = unsafe {
        SetFileSecurityW(
            path_wide.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    unsafe {
        LocalFree(descriptor);
    }
    if applied == 0 {
        return Err("Could not enforce restrictive backup directory permissions.".to_string());
    }
    Ok(())
}

fn create_backup(bytes: &[u8], original_hash: &str, source: &Path) -> Result<BackupRecord, String> {
    let root = backup_root();
    ensure_restrictive_backup_dir(&root)?;

    let stem: String = source
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("config")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        .take(40)
        .collect();
    let name = format!(
        "{stem}-{}-{}.bak",
        &original_hash[..8.min(original_hash.len())],
        Uuid::new_v4()
    );
    let path = root.join(name);

    let mut file = create_private_file(&path)?;
    let result = (|| -> Result<(), String> {
        file.write_all(bytes)
            .map_err(|_| "Could not write the restrictive backup file.".to_string())?;
        file.sync_all()
            .map_err(|_| "Could not flush the restrictive backup file.".to_string())?;
        Ok(())
    })();

    if let Err(err) = result {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(err);
    }

    Ok(BackupRecord {
        backup_path: path,
        original_hash: original_hash.to_string(),
        current_hash: String::new(),
    })
}

fn replace_file_safely(
    path: &Path,
    bytes: &[u8],
    expected_current_hash: Option<&str>,
) -> Result<(), String> {
    let link_meta = fs::symlink_metadata(path)
        .map_err(|_| "The target configuration file cannot be accessed.".to_string())?;
    if link_meta.file_type().is_symlink() {
        return Err(
            "The target configuration file is a symlink and cannot be replaced.".to_string(),
        );
    }
    if !link_meta.is_file() {
        return Err("The target configuration path is not a regular file.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The configuration file has no parent directory.".to_string())?;
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "The configuration file name is invalid.".to_string())?;
    let temp_path = parent.join(format!(
        ".{file_name}.oc-providers-ctl-{}.tmp",
        Uuid::new_v4()
    ));

    let mut temp_created = false;
    let result = (|| -> Result<(), String> {
        let mut file = create_private_file(&temp_path)?;
        temp_created = true;
        file.write_all(bytes)
            .map_err(|_| "Could not write the temporary sibling file.".to_string())?;
        file.sync_all()
            .map_err(|_| "Could not flush the temporary sibling file.".to_string())?;
        drop(file);

        if let Some(expected) = expected_current_hash {
            match read_hash(path) {
                Some(current) if current == expected => {}
                _ => {
                    return Err(
                        "The file changed immediately before replacement; no replacement was performed."
                            .to_string(),
                    )
                }
            }
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let source_metadata = fs::metadata(path)
                .map_err(|_| "The destination file disappeared before replacement.".to_string())?;
            std::os::unix::fs::chown(
                &temp_path,
                Some(source_metadata.uid()),
                Some(source_metadata.gid()),
            )
            .map_err(|_| {
                "Could not preserve the source file owner/group on the temporary file.".to_string()
            })?;
            fs::set_permissions(&temp_path, source_metadata.permissions()).map_err(|_| {
                "Could not restore source file permissions on the temporary file.".to_string()
            })?;
            fs::rename(&temp_path, path)
                .map_err(|_| "Could not atomically replace the configuration file.".to_string())?;
            if let Ok(dir) = File::open(parent) {
                let _ = dir.sync_all();
            }
            Ok(())
        }

        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

            fn wide(path: &Path) -> Vec<u16> {
                path.as_os_str()
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect()
            }

            if !path.exists() {
                return Err(
                    "The destination file disappeared before replacement; no replacement was performed."
                        .to_string(),
                );
            }
            let target = wide(path);
            let replacement = wide(&temp_path);
            // Flag 0 makes Windows fail closed instead of ignoring security
            // descriptor merge errors. MoveFileEx is deliberately not used as
            // a fallback for an existing destination because it can replace the
            // destination DACL.
            let replaced = unsafe {
                ReplaceFileW(
                    target.as_ptr(),
                    replacement.as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            if replaced == 0 {
                return Err(
                    "Could not safely replace the configuration file on Windows.".to_string(),
                );
            }
            Ok(())
        }

        #[cfg(not(any(unix, windows)))]
        {
            fs::rename(&temp_path, path)
                .map_err(|_| "Could not atomically replace the configuration file.".to_string())?;
            Ok(())
        }
    })();

    if result.is_err() && temp_created {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn rollback_if_current(
    path: &Path,
    expected_current_hash: &str,
    restore_bytes: &[u8],
) -> Result<(), String> {
    match read_hash(path) {
        Some(current) if current == expected_current_hash => {}
        _ => {
            return Err("an external file change was detected, so rollback was skipped".to_string())
        }
    }
    replace_file_safely(path, restore_bytes, Some(expected_current_hash))?;
    match read_hash(path) {
        Some(current) if current == hash_bytes(restore_bytes) => Ok(()),
        _ => Err("rollback verification failed".to_string()),
    }
}

fn rollback_error_message(
    message: &str,
    rollback: Result<(), String>,
    backup_path: &Path,
) -> String {
    match rollback {
        Ok(()) => format!("{message} The original file was restored."),
        Err(reason) => format!(
            "{message} Automatic rollback was not completed ({reason}); the restrictive backup was retained at {}.",
            display_path(backup_path)
        ),
    }
}
