//! Tauri IPC commands. Every filesystem mutation is resolved against Rust-owned
//! authorization state and delegated to `oc-providers-core` off the UI thread.

use std::path::Path;

use oc_providers_core::{
    commit_changes, discover_configs, fetch_inventory, prepare_changes, read_document,
    restore_last_backup, CatalogResult, ChangePreview, Edit, ModelCandidate, ProviderInventory,
    SourceDocument, WorkspaceSnapshot,
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::{
    paths::{
        authorize_discovered_source, canonical_config_file, canonical_project_dir,
        revalidate_allowed_config, revalidate_allowed_path, validate_expected_hash,
        validate_preview_id, validate_provider_id,
    },
    state::{AppState, PendingPreview},
};

async fn run_blocking<T, E, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: Into<String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "The background operation could not be completed.".to_string())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn scan_configs(
    project_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    let project = match project_path.as_deref() {
        Some(raw) if !raw.trim().is_empty() => Some(canonical_project_dir(raw)?),
        _ => None,
    };

    let snapshot =
        run_blocking(move || Ok::<_, String>(discover_configs(project.as_deref()))).await?;

    // Only Rust-discovered source paths become readable/writable in this session.
    for source in &snapshot.sources {
        if let Some(path) = authorize_discovered_source(&source.path) {
            state.allow_path(path)?;
        }
    }

    Ok(snapshot)
}

#[tauri::command]
pub async fn load_config(
    path: String,
    state: State<'_, AppState>,
) -> Result<SourceDocument, String> {
    let canonical = canonical_config_file(&path)?;
    if !state.is_allowed(&canonical)? {
        return Err(
            "This configuration was not discovered or selected in this session. Scan or choose it with the native picker first."
                .to_string(),
        );
    }

    let path_for_read = canonical.clone();
    let document = run_blocking(move || read_document(&path_for_read)).await?;
    state.allow_path(canonical)?;
    Ok(document)
}

#[tauri::command]
pub async fn preview_changes(
    path: String,
    expected_hash: String,
    edits: Vec<Edit>,
    state: State<'_, AppState>,
) -> Result<ChangePreview, String> {
    validate_expected_hash(&expected_hash)?;
    if edits.is_empty() {
        return Err("No edits were provided.".to_string());
    }
    let canonical = revalidate_allowed_config(&state, &path)?;

    let path_for_prepare = canonical.clone();
    let change =
        run_blocking(move || prepare_changes(&path_for_prepare, &expected_hash, &edits)).await?;

    // The shell owns preview identifiers and the map the frontend refers to.
    let preview_id = Uuid::new_v4().to_string();
    let mut change = change;
    change.preview.preview_id = preview_id.clone();
    let preview = change.preview.clone();

    let preview_path = revalidate_allowed_path(&state, Path::new(&preview.path))?;
    if preview_path != canonical {
        return Err("The prepared change targeted an unexpected file.".to_string());
    }

    state.insert_preview(preview_id, PendingPreview::new(change, canonical))?;

    Ok(preview)
}

#[tauri::command]
pub async fn apply_changes(
    preview_id: String,
    state: State<'_, AppState>,
) -> Result<SourceDocument, String> {
    validate_preview_id(&preview_id)?;
    let pending = state
        .take_preview(&preview_id)
        .map_err(AppState::preview_error_message)?;
    let path = pending.path.clone();
    let revalidated = revalidate_allowed_path(&state, &path)?;
    if revalidated != path {
        return Err("The file path changed after the preview was prepared.".to_string());
    }

    let document = run_blocking(move || commit_changes(&pending.change)).await?;
    state.discard_previews_for_path(&path)?;
    state.mark_committed(path)?;
    Ok(document)
}

#[tauri::command]
pub async fn restore_backup(
    path: String,
    expected_hash: String,
    state: State<'_, AppState>,
) -> Result<SourceDocument, String> {
    validate_expected_hash(&expected_hash)?;
    let canonical = revalidate_allowed_config(&state, &path)?;
    if !state.is_committed(&canonical)? {
        return Err(
            "Only a file changed successfully in this session can be restored from its recovery backup."
                .to_string(),
        );
    }

    let path_for_restore = canonical.clone();
    let document =
        run_blocking(move || restore_last_backup(&path_for_restore, &expected_hash)).await?;
    state.discard_previews_for_path(&canonical)?;
    Ok(document)
}

#[tauri::command]
pub async fn fetch_catalog(state: State<'_, AppState>) -> Result<CatalogResult, String> {
    let mut catalog = state.catalog().lock().await;
    catalog.refresh().await
}

#[tauri::command]
pub async fn match_models(
    query: String,
    provider_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ModelCandidate>, String> {
    let provider = provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let catalog = state.catalog().lock().await;
    Ok(catalog.search(&query, provider))
}

#[tauri::command]
pub async fn fetch_provider_models(
    path: String,
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<ProviderInventory, String> {
    let canonical = revalidate_allowed_config(&state, &path)?;
    let provider_id = validate_provider_id(&provider_id)?;
    fetch_inventory(&canonical, &provider_id).await
}

/// Extra shell helper: the native picker is the only way to authorize an
/// explicit configuration outside the discovered set. It does not read the file.
#[tauri::command]
pub async fn pick_config_path(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let app_for_dialog = app.clone();
    let picked = run_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .set_title("Select an OpenCode configuration")
            .add_filter("OpenCode configuration", &["json", "jsonc"])
            .blocking_pick_file()
            .map(|file| {
                file.into_path()
                    .map_err(|_| "The selected path is not a local file.".to_string())
            })
            .transpose()
    })
    .await?;

    let Some(path) = picked else {
        return Ok(None);
    };
    let picked_display = path.to_string_lossy().into_owned();
    let canonical = canonical_config_file(&picked_display)?;
    state.allow_path(canonical)?;
    // Return the user-visible path (already validated as absolute and canonical
    // when re-checked by load_config) rather than leaking a Windows `\\?\`
    // extended-length prefix into the UI.
    Ok(Some(picked_display))
}
