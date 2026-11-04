use tauri::Manager;
#[tauri::command]
pub async fn preferences_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: super::preferences_store::Request,
) -> Result<super::preferences_store::Snapshot, String> {
    super::check_window(&window)?;
    let root = app
        .path()
        .app_config_dir()
        .map_err(|_| "Preference storage unavailable.")?;
    tauri::async_runtime::spawn_blocking(move || super::preferences_store::request(&root, request))
        .await
        .map_err(|_| "Preference storage stopped unexpectedly.")?
}
