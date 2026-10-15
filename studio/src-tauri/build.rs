fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_repository",
            "recent_repositories",
            "open_recent_repository",
            "list_directory",
            "read_document",
            "save_document",
            "set_unsaved_changes",
            "request_close",
            "load_manuscript",
            "list_system_fonts",
        ]),
    ))
    .expect("Tauri configuration must be valid");
}
