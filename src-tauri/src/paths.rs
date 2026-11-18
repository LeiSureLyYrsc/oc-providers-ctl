//! Canonical path checks shared by the IPC commands.

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::state::AppState;

const MAX_PATH_LEN: usize = 4096;
const MAX_PROVIDER_ID_LEN: usize = 200;
const MAX_HASH_LEN: usize = 128;

/// Validate that a string names an existing, absolute OpenCode configuration file.
pub fn canonical_config_file(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("No configuration path was selected.".to_string());
    }
    if raw.len() > MAX_PATH_LEN || raw.contains('\0') {
        return Err("That configuration path is not valid.".to_string());
    }
    canonical_config_path(Path::new(raw))
}

/// Validate an already-constructed path. The returned path is canonical and
/// suitable for comparison against the Rust-owned authorization set.
pub fn canonical_config_path(raw: &Path) -> Result<PathBuf, String> {
    if !raw.is_absolute() {
        return Err("The configuration path must be an absolute path.".to_string());
    }

    let canonical = fs::canonicalize(raw)
        .map_err(|_| "That configuration file is no longer available.".to_string())?;

    if !canonical.is_file() {
        return Err("That path is not an existing OpenCode configuration file.".to_string());
    }

    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if file_name != "opencode.json" && file_name != "opencode.jsonc" {
        return Err(
            "Only existing opencode.json or opencode.jsonc files can be loaded.".to_string(),
        );
    }

    Ok(canonical)
}

/// Validate an existing project directory used only to discover configuration.
pub fn canonical_project_dir(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("No project folder was selected.".to_string());
    }
    if raw.len() > MAX_PATH_LEN || raw.contains('\0') {
        return Err("That project folder path is not valid.".to_string());
    }

    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("The project folder path must be an absolute path.".to_string());
    }

    let canonical = fs::canonicalize(path)
        .map_err(|_| "That project folder is no longer available.".to_string())?;

    if !canonical.is_dir() {
        return Err("The selected project path is not a folder.".to_string());
    }

    Ok(canonical)
}

/// Canonicalize a path only if it is a discoverable configuration, for granting
/// scan results permission to be read and edited later.
pub fn authorize_discovered_source(raw: &str) -> Option<PathBuf> {
    canonical_config_file(raw).ok()
}

/// Re-resolve the incoming path and require that Rust previously authorized it.
pub fn revalidate_allowed_config(state: &AppState, raw: &str) -> Result<PathBuf, String> {
    revalidate_allowed_path(state, &canonical_config_file(raw)?)
}

/// Re-resolve an already canonical path and require that it remains authorized.
pub fn revalidate_allowed_path(state: &AppState, path: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_config_path(path)?;
    if !state.is_allowed(&canonical)? {
        return Err(
            "This file was not discovered or selected in this session. Scan or choose it again."
                .to_string(),
        );
    }
    Ok(canonical)
}

pub fn validate_expected_hash(raw: &str) -> Result<(), String> {
    if raw.is_empty() || raw.len() > MAX_HASH_LEN || raw.chars().any(char::is_control) {
        return Err(
            "The source file hash is not valid. Reload the file and try again.".to_string(),
        );
    }
    Ok(())
}

pub fn validate_provider_id(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Err("A provider must be selected.".to_string());
    }
    if raw != raw.trim() || raw.len() > MAX_PROVIDER_ID_LEN || raw.chars().any(char::is_control) {
        return Err("That provider identifier is not valid.".to_string());
    }
    Ok(raw.to_string())
}

pub fn validate_preview_id(raw: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(raw)
        .map(|_| ())
        .map_err(|_| "Unknown change preview. Prepare the change again.".to_string())
}
