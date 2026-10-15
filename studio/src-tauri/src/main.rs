#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod drafting;
mod proposals;

use repository_core::{Document, Entry, Manuscript, RecoveryDraft, RecoveryStore, Repository};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, State};
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
    project_key: String,
    name: String,
    manifests: Vec<String>,
    warning: Option<String>,
}
struct Selected {
    id: String,
    repo: Arc<Repository>,
}
#[derive(Default)]
struct BrowserState {
    unsaved_changes: AtomicBool,
    close_authorized: AtomicBool,
    selection_gate: Mutex<()>,
    mutation_gate: proposals::authority::MutationGate,
    proposals: Mutex<proposals::ProposalHost>,
    selected: Mutex<Option<Selected>>,
    recents: Mutex<RecentStore>,
    recovery: Mutex<Option<Arc<RecoveryStore>>>,
    drafting: Mutex<drafting::DraftingHost>,
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
        project_key: repo.project_key(),
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
        repo: Arc::new(repo),
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
    let repo = {
        let guard = state
            .selected
            .lock()
            .map_err(|_| "Repository unavailable")?;
        let selected = guard.as_ref().ok_or("Open a repository first")?;
        if selected.id != repository_id {
            return Err("Repository changed; refresh the view".into());
        }
        Arc::clone(&selected.repo)
    };
    // Keep authorization/root bound to this operation, but release selection state
    // before filesystem I/O. A slow manuscript fsync cannot block recovery staging.
    operation(&repo)
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
async fn save_document(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    relative_path: String,
    expected_hash: String,
    text: String,
) -> Result<Document, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _mutation = state.mutation_gate.edit()?;
        state.mutation_gate.invalidate();
        with_repository(&app, &repository_id, |r| {
            with_recovery(&app, |store| {
                r.save_with_recovery(&relative_path, &expected_hash, &text, store)
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn with_recovery<T>(
    app: &tauri::AppHandle,
    operation: impl FnOnce(&RecoveryStore) -> Result<T, repository_core::Error>,
) -> Result<T, String> {
    let store = recovery_store(app)?;
    operation(&store).map_err(|e| e.to_string())
}
fn recovery_store(app: &tauri::AppHandle) -> Result<Arc<RecoveryStore>, String> {
    let state = app.state::<BrowserState>();
    let mut recovery = state
        .recovery
        .lock()
        .map_err(|_| "Recovery storage unavailable")?;
    if recovery.is_none() {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| "Recovery storage unavailable")?;
        *recovery = Some(Arc::new(
            RecoveryStore::open(path.join("draft-recovery-v1")).map_err(|e| e.to_string())?,
        ));
    }
    let store = Arc::clone(recovery.as_ref().ok_or("Recovery storage unavailable")?);
    drop(recovery);
    Ok(store)
}
#[tauri::command]
async fn read_recovery(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    relative_path: String,
) -> Result<Option<RecoveryDraft>, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_repository(&app, &repository_id, |repo| {
            with_recovery(&app, |store| store.read(repo, &relative_path))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn stage_recovery(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    relative_path: String,
    expected_hash: String,
    text: String,
) -> Result<RecoveryDraft, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _mutation = state.mutation_gate.edit()?;
        state.mutation_gate.invalidate();
        with_repository(&app, &repository_id, |repo| {
            with_recovery(&app, |store| {
                store.stage(repo, &relative_path, &expected_hash, &text)
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn discard_recovery(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    relative_path: String,
    recovery_id: String,
) -> Result<(), String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _mutation = state.mutation_gate.edit()?;
        state.mutation_gate.invalidate();
        with_repository(&app, &repository_id, |repo| {
            with_recovery(&app, |store| {
                store.discard(repo, &relative_path, &recovery_id)
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn set_unsaved_changes(
    window: tauri::WebviewWindow,
    state: State<'_, BrowserState>,
    dirty: bool,
) -> Result<(), String> {
    check_window(&window)?;
    state.unsaved_changes.store(dirty, Ordering::SeqCst);
    if dirty {
        state.mutation_gate.invalidate();
    }
    Ok(())
}
#[tauri::command]
fn request_close(
    window: tauri::WebviewWindow,
    state: State<'_, BrowserState>,
    discard: bool,
) -> Result<(), String> {
    check_window(&window)?;
    if discard {
        state.unsaved_changes.store(false, Ordering::SeqCst);
    }
    if state.unsaved_changes.load(Ordering::SeqCst) {
        return Err("Save or discard changes before closing".into());
    }
    state.close_authorized.store(true, Ordering::SeqCst);
    if let Err(error) = window.close() {
        state.close_authorized.store(false, Ordering::SeqCst);
        return Err(error.to_string());
    }
    Ok(())
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
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) =
                    event
                {
                    drafting::handle_drop(window.app_handle().clone(), paths.clone());
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Every OS close goes through the renderer guard, even if its most
                // recent dirty notification is still queued. Only request_close
                // grants a one-shot bypass after that guard completes.
                if !window
                    .state::<BrowserState>()
                    .close_authorized
                    .swap(false, Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            proposals::list_proposals,
            proposals::review_proposal,
            proposals::review_proposal_revert,
            proposals::apply_proposal_review,
            proposals::cancel_proposal_review,
            drafting::load_drafting,
            drafting::preview_drafting_change,
            drafting::apply_drafting_change,
            drafting::undo_drafting_change,
            drafting::pick_drafting_import,
            pick_repository,
            recent_repositories,
            open_recent_repository,
            list_directory,
            read_document,
            save_document,
            read_recovery,
            stage_recovery,
            discard_recovery,
            set_unsaved_changes,
            request_close,
            load_manuscript,
            list_system_fonts
        ])
        .run(tauri::generate_context!())
        .expect("Heinlein Studio failed to start");
}
