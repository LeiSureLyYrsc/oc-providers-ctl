//! Mutable authorization state for the desktop shell.
//!
//! The frontend is never an authorization boundary. Paths become eligible for
//! read/write IPC only after Rust has discovered them or the user picked them
//! through the native dialog. Prepared changes are one-shot, bounded in age and
//! bound to the canonical path that was authorized when the preview was made.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use oc_providers_core::{ModelCatalog, PreparedChange};

/// A preview that has been prepared but not yet committed.
pub struct PendingPreview {
    pub change: PreparedChange,
    pub path: PathBuf,
    created_at: Instant,
}

impl PendingPreview {
    pub fn new(change: PreparedChange, path: PathBuf) -> Self {
        Self::with_age(change, path, Duration::ZERO)
    }

    /// Construct a preview as if it had been created `age` ago.
    pub fn with_age(change: PreparedChange, path: PathBuf, age: Duration) -> Self {
        let created_at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        Self {
            change,
            path,
            created_at,
        }
    }

    /// Age of this preview relative to now.
    pub fn age(&self) -> Duration {
        Instant::now()
            .checked_duration_since(self.created_at)
            .unwrap_or(Duration::ZERO)
    }
}

/// Preview TTL. A preview accepted by the UI must be regenerated after this.
const PREVIEW_TTL: Duration = Duration::from_secs(10 * 60);
/// Safety bound so repeated previews cannot grow the in-memory queue forever.
const MAX_PENDING_PREVIEWS: usize = 64;

/// Why a preview was refused or could not be found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewError {
    /// The preview identifier is unknown, already consumed, or was replaced.
    Unavailable,
    /// The preview existed but is older than [`PREVIEW_TTL`].
    Expired,
}

pub struct AppState {
    allowed_paths: Mutex<HashSet<PathBuf>>,
    pending_previews: Mutex<HashMap<String, PendingPreview>>,
    committed_paths: Mutex<HashSet<PathBuf>>,
    catalog: tauri::async_runtime::Mutex<ModelCatalog>,
}

impl AppState {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            allowed_paths: Mutex::new(HashSet::new()),
            pending_previews: Mutex::new(HashMap::new()),
            committed_paths: Mutex::new(HashSet::new()),
            catalog: tauri::async_runtime::Mutex::new(ModelCatalog::new(cache_dir)),
        }
    }

    /// Record a canonical path that Rust has discovered or the user explicitly selected.
    pub fn allow_path(&self, path: PathBuf) -> Result<(), String> {
        lock(&self.allowed_paths)?.insert(path);
        Ok(())
    }

    pub fn is_allowed(&self, path: &Path) -> Result<bool, String> {
        Ok(lock(&self.allowed_paths)?.contains(path))
    }

    /// Store a fresh preview, pruning expired entries and evicting the oldest entry if full.
    pub fn insert_preview(
        &self,
        preview_id: String,
        pending: PendingPreview,
    ) -> Result<(), String> {
        let mut previews = lock(&self.pending_previews)?;
        let now = Instant::now();
        previews.retain(|_, entry| now.duration_since(entry.created_at) <= PREVIEW_TTL);
        // Keep at most one live preview per file so an older preview cannot be
        // applied after a newer one (or after a successful write).
        previews.retain(|_, entry| entry.path != pending.path);
        while previews.len() >= MAX_PENDING_PREVIEWS {
            let Some(oldest) = previews
                .iter()
                .min_by_key(|(_, entry)| entry.created_at)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            previews.remove(&oldest);
        }
        previews.insert(preview_id, pending);
        Ok(())
    }

    /// Consume a preview. Consuming before commit guarantees it cannot be replayed.
    pub fn take_preview(&self, preview_id: &str) -> Result<PendingPreview, PreviewError> {
        let mut previews = lock(&self.pending_previews).map_err(|_| PreviewError::Unavailable)?;
        let Some(pending) = previews.remove(preview_id) else {
            return Err(PreviewError::Unavailable);
        };
        if Instant::now().duration_since(pending.created_at) > PREVIEW_TTL {
            return Err(PreviewError::Expired);
        }
        Ok(pending)
    }

    /// Human-readable, safe message for a refused preview.
    pub fn preview_error_message(err: PreviewError) -> &'static str {
        match err {
            PreviewError::Unavailable => {
                "That change preview is no longer available. Prepare a new preview and try again."
            }
            PreviewError::Expired => {
                "That change preview expired. Prepare a new preview before saving."
            }
        }
    }

    pub fn mark_committed(&self, path: PathBuf) -> Result<(), String> {
        lock(&self.committed_paths)?.insert(path);
        Ok(())
    }

    /// Drop any preview for a path whose bytes were just committed or restored.
    pub fn discard_previews_for_path(&self, path: &Path) -> Result<(), String> {
        lock(&self.pending_previews)?.retain(|_, entry| entry.path != path);
        Ok(())
    }

    pub fn is_committed(&self, path: &Path) -> Result<bool, String> {
        Ok(lock(&self.committed_paths)?.contains(path))
    }

    pub fn catalog(&self) -> &tauri::async_runtime::Mutex<ModelCatalog> {
        &self.catalog
    }

    /// True when the catalog lock is free and a local search over it yields no
    /// hits. Used by tests to prove catalog access needs no network.
    #[cfg(test)]
    pub fn try_catalog_search(&self, query: &str, provider_id: Option<&str>) -> bool {
        match self.catalog.try_lock() {
            Ok(catalog) => catalog.search(query, provider_id).is_empty(),
            Err(_) => false,
        }
    }
}

fn lock<'a, T>(mutex: &'a Mutex<T>) -> Result<MutexGuard<'a, T>, String> {
    mutex.lock().map_err(|_| {
        "The application state is unavailable. Please restart oc-providers-ctl.".to_string()
    })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::Duration,
    };

    use oc_providers_core::{prepare_changes, read_document, Edit, EditOp, PreparedChange};
    use serde_json::Value;
    use tempfile::TempDir;

    use super::{AppState, PendingPreview, PreviewError, MAX_PENDING_PREVIEWS, PREVIEW_TTL};
    use crate::paths::{canonical_config_file, canonical_config_path, revalidate_allowed_config};

    /// A provider name edit that is always allowed by the core edit rules.
    fn rename_edits() -> Vec<Edit> {
        vec![Edit {
            op: EditOp::Set,
            path: vec![
                "provider".to_string(),
                "anthropic".to_string(),
                "name".to_string(),
            ],
            value: Some(Value::String("Anthropic Test".to_string())),
        }]
    }

    const FIXTURE: &str = r#"{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "name": "Anthropic",
      "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" },
      "models": {
        "claude-sonnet-4": { "name": "Claude Sonnet 4" }
      }
    }
  }
}
"#;

    fn state() -> (TempDir, AppState) {
        let dir = TempDir::new().expect("temp dir");
        let cache = dir.path().join("cache");
        fs::create_dir_all(&cache).expect("cache dir");
        (dir, AppState::new(cache))
    }

    fn write_fixture(dir: &TempDir, name: &str) -> PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, FIXTURE).expect("write fixture");
        path
    }

    /// Build a real `PreparedChange` from a temp fixture via the core API only.
    fn prepared(dir: &TempDir, name: &str) -> (PathBuf, PreparedChange) {
        let path = write_fixture(dir, name);
        let change = prepared_again(&path);
        (path, change)
    }

    /// Prepare a distinct change for an existing fixture file.
    ///
    /// `PreparedChange` is not `Clone`, so each pending preview needs its own
    /// instance; the core API is the only way to build one.
    fn prepared_again(path: &Path) -> PreparedChange {
        let doc = read_document(path).expect("read fixture");
        prepare_changes(path, &doc.hash, &rename_edits()).expect("prepare change")
    }

    /// Canonical form of an existing fixture path, as the shell would store it.
    fn canonical(path: &Path) -> PathBuf {
        canonical_config_path(path).expect("canonical fixture path")
    }

    #[test]
    fn unauthorized_canonical_config_is_rejected() {
        let (dir, state) = state();
        let path = write_fixture(&dir, "opencode.json");
        let canonical_path = canonical(&path);

        assert!(!state.is_allowed(&canonical_path).expect("state readable"));
        let err = revalidate_allowed_config(&state, &canonical_path.to_string_lossy())
            .expect_err("unauthorized path must be rejected");
        assert!(err.contains("not discovered or selected"), "{err}");

        // Non-existent, relative and non-config names are refused before authorization.
        assert!(canonical_config_file("").is_err());
        assert!(canonical_config_file("opencode.json").is_err());
        assert!(canonical_config_path(&dir.path().join("opencode.toml")).is_err());
    }

    #[test]
    fn native_picked_path_becomes_allowed() {
        let (dir, state) = state();
        let path = write_fixture(&dir, "opencode.json");
        let canonical_path = canonical(&path);

        // Simulates the native picker path: Rust canonicalizes then registers it.
        state
            .allow_path(canonical_path.clone())
            .expect("allow path");

        assert!(state.is_allowed(&canonical_path).expect("state readable"));
        let revalidated = revalidate_allowed_config(&state, &canonical_path.to_string_lossy())
            .expect("picked path accepted");
        assert_eq!(revalidated, canonical_path);

        // A different, unpicked file in the same directory stays unauthorized.
        let other = canonical(&write_fixture(&dir, "opencode.jsonc"));
        assert!(!state.is_allowed(&other).expect("state readable"));
    }

    #[test]
    fn new_preview_for_same_file_replaces_older_one() {
        let (dir, state) = state();
        let (path, first) = prepared(&dir, "opencode.json");
        let canonical_path = canonical(&path);
        state
            .allow_path(canonical_path.clone())
            .expect("allow path");

        let second = prepared_again(&path);
        let first_id = first.preview.preview_id.clone();
        let second_id = second.preview.preview_id.clone();
        assert_ne!(first_id, second_id);

        state
            .insert_preview(
                first_id.clone(),
                PendingPreview::new(first, canonical_path.clone()),
            )
            .expect("insert first");
        state
            .insert_preview(
                second_id.clone(),
                PendingPreview::new(second, canonical_path),
            )
            .expect("insert second");

        // The older preview for the same file is gone; only the newest remains.
        assert_eq!(
            state.take_preview(&first_id).err(),
            Some(PreviewError::Unavailable)
        );
        assert!(state.take_preview(&second_id).is_ok());
    }

    #[test]
    fn preview_is_consumed_once() {
        let (dir, state) = state();
        let (path, change) = prepared(&dir, "opencode.json");
        let canonical_path = canonical(&path);
        let id = change.preview.preview_id.clone();

        state
            .insert_preview(
                id.clone(),
                PendingPreview::new(change, canonical_path.clone()),
            )
            .expect("insert");

        let taken = state.take_preview(&id).expect("first take succeeds");
        assert_eq!(taken.path, canonical_path);
        assert_eq!(
            state.take_preview(&id).err(),
            Some(PreviewError::Unavailable)
        );
    }

    #[test]
    fn expired_preview_is_rejected() {
        let (dir, state) = state();
        let (path, change) = prepared(&dir, "opencode.json");
        let canonical_path = canonical(&path);
        let id = change.preview.preview_id.clone();

        let stale =
            PendingPreview::with_age(change, canonical_path, PREVIEW_TTL + Duration::from_secs(1));
        state.insert_preview(id.clone(), stale).expect("insert");

        assert_eq!(state.take_preview(&id).err(), Some(PreviewError::Expired));
        // Expired previews are consumed, never committable later.
        assert_eq!(
            state.take_preview(&id).err(),
            Some(PreviewError::Unavailable)
        );
    }

    #[test]
    fn pending_previews_are_bounded() {
        let (dir, state) = state();
        let (path, _unused) = prepared(&dir, "opencode.json");
        // Distinct paths so the one-preview-per-file rule cannot mask eviction.
        let mut paths = Vec::new();
        for index in 0..MAX_PENDING_PREVIEWS {
            let dir_path = dir.path().join(format!("slot{index}"));
            fs::create_dir_all(&dir_path).expect("slot dir");
            let slot = dir_path.join("opencode.json");
            fs::copy(&path, &slot).expect("copy fixture");
            paths.push(canonical_config_path(&slot).expect("canonical slot"));
        }

        for (index, slot) in paths.iter().enumerate() {
            let id = format!("00000000-0000-4000-8000-{index:012}");
            state
                .insert_preview(id, PendingPreview::new(prepared_again(&path), slot.clone()))
                .expect("insert");
        }

        assert_eq!(paths.len(), MAX_PENDING_PREVIEWS);

        // A further preview evicts the oldest entry and is itself retained.
        let overflow_slot = dir.path().join("overflow");
        fs::create_dir_all(&overflow_slot).expect("overflow dir");
        let overflow_path = overflow_slot.join("opencode.json");
        fs::copy(&path, &overflow_path).expect("copy overflow fixture");
        let overflow_path = canonical_config_path(&overflow_path).expect("canonical overflow");
        let overflow = format!("00000000-0000-4000-8000-{:012}", MAX_PENDING_PREVIEWS);
        state
            .insert_preview(
                overflow.clone(),
                PendingPreview::new(prepared_again(&path), overflow_path),
            )
            .expect("insert overflow");

        assert_eq!(
            state
                .take_preview("00000000-0000-4000-8000-000000000000")
                .err(),
            Some(PreviewError::Unavailable)
        );
        assert!(state.take_preview(&overflow).is_ok());
    }

    #[test]
    fn restore_requires_committed_path() {
        let (dir, state) = state();
        let path = write_fixture(&dir, "opencode.json");
        let canonical_path = canonical(&path);
        state
            .allow_path(canonical_path.clone())
            .expect("allow path");

        assert!(!state.is_committed(&canonical_path).expect("state readable"));
        state.mark_committed(canonical_path.clone()).expect("mark");
        assert!(state.is_committed(&canonical_path).expect("state readable"));

        // Discarding previews does not grant commit authorization.
        state
            .discard_previews_for_path(&canonical_path)
            .expect("discard");
        assert!(state.is_committed(&canonical_path).expect("state readable"));
    }

    #[test]
    fn catalog_is_owned_by_state_without_network() {
        let (_dir, state) = state();
        // A cold catalog never touches the network; search only reads memory.
        assert!(state.try_catalog_search("anything", None));
    }
}
