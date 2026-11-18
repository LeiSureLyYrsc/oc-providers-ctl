fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "scan_configs",
                "load_config",
                "preview_changes",
                "apply_changes",
                "restore_backup",
                "fetch_catalog",
                "match_models",
                "fetch_provider_models",
                "pick_config_path",
            ]))
            .windows_attributes(
                tauri_build::WindowsAttributes::new().window_icon_path("icons/icon.ico"),
            ),
    )
    .expect("failed to run tauri-build");
}
