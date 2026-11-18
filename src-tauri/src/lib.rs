mod commands;
mod paths;
mod state;

use tauri::Manager;

pub use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The catalog cache is app-owned and never contains user credentials.
            let cache_dir = app.path().app_cache_dir()?.join("model-catalog");
            std::fs::create_dir_all(&cache_dir)?;
            app.manage(AppState::new(cache_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_configs,
            commands::load_config,
            commands::preview_changes,
            commands::apply_changes,
            commands::restore_backup,
            commands::fetch_catalog,
            commands::match_models,
            commands::fetch_provider_models,
            commands::pick_config_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running oc-providers-ctl");
}
