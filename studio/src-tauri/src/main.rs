#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use repository_core::{Document, Entry, Manuscript, Repository};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Recent {
    id: String,
    name: String,
    path: PathBuf,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentStore {
    schema_version: u32,
    folders: Vec<Recent>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentView {
    id: String,
    name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    name: String,
    manifests: Vec<String>,
    warning: Option<String>,
}
struct Selected {
    id: String,
    repo: Repository,
}
#[derive(Default)]
struct BrowserState {
    selection_gate: Mutex<()>,
    selected: Mutex<Option<Selected>>,
    recents: Mutex<RecentStore>,
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn check_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Unsupported window".into());
    }
    Ok(())
}
fn recent_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recent-folders-v1.json"))
}
fn load_recents(path: &Path) -> RecentStore {
    // Recent paths are convenience preferences, never arbitrary renderer-supplied paths.
    let result = fs::metadata(path)
        .ok()
        .filter(|m| m.len() < 65536)
        .and_then(|_| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<RecentStore>(&bytes).ok());
    match result {
        Some(mut value) if value.schema_version == 1 => {
            value.folders.truncate(10);
            value
        }
        _ => RecentStore {
            schema_version: 1,
            folders: vec![],
        },
    }
}
fn save_recents(path: &Path, store: &RecentStore) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Missing preferences directory")?)
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", id()));
    let content = serde_json::to_vec(store).map_err(|e| e.to_string())?;
    fs::write(&temporary, content).map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}
fn select(app: &tauri::AppHandle, path: PathBuf) -> Result<Session, String> {
    let repo = Repository::open(&path).map_err(|e| e.to_string())?;
    let (manifests, warning) = match repo.discover() {
        Ok(paths) => (paths, None),
        Err(error) => (
            vec![],
            Some(format!(
                "Manuscript discovery incomplete: {error}. Use the file tree to browse."
            )),
        ),
    };
    let canonical = repo.root().to_path_buf();
    let name = canonical
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let state = app.state::<BrowserState>();
    let session = Session {
        id: id(),
        name: name.clone(),
        manifests,
        warning,
    };
    // Don't commit a new selected root if its recent-folder persistence failed.
    let mut recent_guard = state
        .recents
        .lock()
        .map_err(|_| "Preferences unavailable")?;
    let mut recents = recent_guard.clone();
    recents.folders.retain(|folder| folder.path != canonical);
    recents.folders.insert(
        0,
        Recent {
            id: id(),
            name,
            path: canonical,
        },
    );
    recents.folders.truncate(10);
    save_recents(&recent_file(app)?, &recents)?;
    *recent_guard = recents;
    *state
        .selected
        .lock()
        .map_err(|_| "Repository unavailable")? = Some(Selected {
        id: session.id.clone(),
        repo,
    });
    Ok(session)
}
#[tauri::command]
async fn pick_repository(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<Session>, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder selection is in progress")?;
        let Some(folder) = app
            .dialog()
            .file()
            .set_title("Open local manuscript repository")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = folder
            .into_path()
            .map_err(|_| "Select a local filesystem folder")?;
        select(&app, path).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn recent_repositories(
    window: tauri::WebviewWindow,
    state: State<'_, BrowserState>,
) -> Result<Vec<RecentView>, String> {
    check_window(&window)?;
    Ok(state
        .recents
        .lock()
        .map_err(|_| "Preferences unavailable")?
        .folders
        .iter()
        .map(|r| RecentView {
            id: r.id.clone(),
            name: r.name.clone(),
        })
        .collect())
}
#[tauri::command]
async fn open_recent_repository(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<Session, String> {
    check_window(&window)?;
    let path = app
        .state::<BrowserState>()
        .recents
        .lock()
        .map_err(|_| "Preferences unavailable")?
        .folders
        .iter()
        .find(|r| r.id == id)
        .map(|r| r.path.clone())
        .ok_or("Unknown recent folder; use Open folder")?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder selection is in progress")?;
        select(&app, path)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn with_repository<T>(
    app: &tauri::AppHandle,
    repository_id: &str,
    operation: impl FnOnce(&Repository) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<BrowserState>();
    let guard = state
        .selected
        .lock()
        .map_err(|_| "Repository unavailable")?;
    let selected = guard.as_ref().ok_or("Open a repository first")?;
    if selected.id != repository_id {
        return Err("Repository changed; refresh the view".into());
    }
    operation(&selected.repo)
}
#[tauri::command]
async fn list_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    relative_path: String,
) -> Result<Vec<Entry>, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_repository(&app, &repository_id, |r| {
            r.list(&relative_path).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_document(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    relative_path: String,
) -> Result<Document, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_repository(&app, &repository_id, |r| {
            r.read(&relative_path).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn load_manuscript(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    relative_path: String,
) -> Result<Manuscript, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_repository(&app, &repository_id, |r| {
            r.manuscript(&relative_path).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn list_system_fonts(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    check_window(&window)?;
    // Family names only, for the appearance pickers; no font files cross the bridge.
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let families: std::collections::BTreeSet<String> = db
            .faces()
            .flat_map(|face| face.families.iter().map(|(name, _)| name.clone()))
            .filter(|name| !name.is_empty() && name.len() <= 100 && !name.starts_with('.'))
            .collect();
        families.into_iter().collect()
    })
    .await
    .map_err(|e| e.to_string())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(BrowserState::default())
        .setup(|app| {
            let path = recent_file(app.handle()).map_err(std::io::Error::other)?;
            *app.state::<BrowserState>()
                .recents
                .lock()
                .map_err(|_| std::io::Error::other("Preferences unavailable"))? =
                load_recents(&path);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_repository,
            recent_repositories,
            open_recent_repository,
            list_directory,
            read_document,
            load_manuscript,
            list_system_fonts
        ])
        .run(tauri::generate_context!())
        .expect("Heinlein Studio failed to start");
}
