#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod drafting;
mod first_story;
mod github;
#[cfg(all(test, unix))]
mod persistence_tests;
mod proposals;
mod questions;
mod quit;
#[cfg(target_os = "macos")]
mod quit_macos;
mod recents;
mod review_state;
mod update;

use recents::{load_recents, save_recents, Recent, RecentStore};
use repository_core::{Document, Entry, Manuscript, RecoveryDraft, RecoveryStore, Repository};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

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
    github_workspace_id: Option<String>,
}
struct Selected {
    id: String,
    repo: Arc<Repository>,
}
#[derive(Default)]
struct BrowserState {
    unsaved_changes: AtomicBool,
    close_authorized: quit::Gate,
    quitting: AtomicBool,
    selection_gate: Mutex<()>,
    mutation_gate: proposals::authority::MutationGate,
    proposals: Mutex<proposals::ProposalHost>,
    selected: Mutex<Option<Selected>>,
    recents: Mutex<RecentStore>,
    recovery: Mutex<Option<Arc<RecoveryStore>>>,
    drafting: Mutex<drafting::DraftingHost>,
    first_story: Mutex<first_story::Host>,
    github: github::Host,
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn check_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window
        .state::<BrowserState>()
        .quitting
        .load(Ordering::SeqCst)
    {
        return Err("Heinlein is quitting".into());
    }
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
/// Compare private auth storage with repository roots even before the auth
/// directory exists. This does not create it or read any credential contents.
fn resolved_future_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Private account storage requires an absolute path".into());
    }
    let mut existing = path.to_path_buf();
    let mut suffix = Vec::new();
    while !existing
        .try_exists()
        .map_err(|_| "Private account storage is unavailable")?
    {
        suffix.push(
            existing
                .file_name()
                .ok_or("Private account storage is unavailable")?
                .to_os_string(),
        );
        if !existing.pop() {
            return Err("Private account storage is unavailable".into());
        }
    }
    let mut resolved = existing
        .canonicalize()
        .map_err(|_| "Private account storage is unavailable")?;
    for name in suffix.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}
fn auth_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Private account storage is unavailable")?
        .join("chatgpt-auth"))
}
fn guard_auth_repository_separation(
    repository: &Path,
    private_storage: &Path,
) -> Result<(), String> {
    let storage = resolved_future_path(private_storage)?;
    if repository.starts_with(&storage) || storage.starts_with(repository) {
        return Err("Choose a manuscript folder outside Heinlein's private account storage".into());
    }
    Ok(())
}
fn private_question_auth_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = auth_path(app)?;
    let state = app.state::<BrowserState>();
    let selected = state
        .selected
        .lock()
        .map_err(|_| "Repository unavailable")?;
    if let Some(selected) = selected.as_ref() {
        guard_auth_repository_separation(selected.repo.root(), &path)?;
    }
    Ok(path)
}
fn select(app: &tauri::AppHandle, path: PathBuf) -> Result<Session, String> {
    #[cfg(target_os = "macos")]
    update::guard_repository(
        &resolved_future_path(&path)?,
        &app.path().home_dir().map_err(|_| "Home unavailable")?,
    )?;
    let workspace = github::selection(app, &path)?;
    let mut session = select_repository(
        &app.state::<BrowserState>(),
        path,
        &recent_file(app)?,
        &auth_path(app)?,
    )?;
    if let Some(w) = workspace {
        session.github_workspace_id = Some(w.id);
        session.name = format!("{}/{}", w.repo.owner, w.repo.name);
    }
    Ok(session)
}
// Keep the native selection transaction testable without a window or real preferences.
fn select_repository(
    state: &BrowserState,
    path: PathBuf,
    preferences: &Path,
    private_storage: &Path,
) -> Result<Session, String> {
    if state.quitting.load(Ordering::SeqCst) {
        return Err("Heinlein is quitting".into());
    }
    state.mutation_gate.note_activity();
    let repo = Repository::open(&path).map_err(|e| e.to_string())?;
    guard_auth_repository_separation(repo.root(), private_storage)?;
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
    let session = Session {
        id: id(),
        project_key: repo.project_key(),
        name: name.clone(),
        manifests,
        warning,
        github_workspace_id: None,
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
    save_recents(preferences, &recents)?;
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
    let path = recent_repository_path(&app.state::<BrowserState>(), &id)?;
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
// Renderer input is an opaque persisted ID, never a root path.
fn recent_repository_path(state: &BrowserState, id: &str) -> Result<PathBuf, String> {
    state
        .recents
        .lock()
        .map_err(|_| "Preferences unavailable")?
        .folders
        .iter()
        .find(|r| r.id == id)
        .map(|r| r.path.clone())
        .ok_or_else(|| "Unknown recent folder; use Open folder".into())
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
    let _workspace = github::edit_lock(app, repo.root())?;
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
        state.mutation_gate.note_activity();
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
    let _selection = state
        .selection_gate
        .try_lock()
        .map_err(|_| "Finish opening the project before quitting")?;
    let _github = state.github.close_guard()?;
    let _mutation = state.mutation_gate.close_guard()?;
    let runtime = window.state::<update::Runtime>();
    let _update = runtime.idle()?;
    if discard {
        state.unsaved_changes.store(false, Ordering::SeqCst);
    }
    if state.unsaved_changes.load(Ordering::SeqCst) {
        return Err("Save or discard changes before closing".into());
    }
    quit::authorize(
        &state.close_authorized,
        state.mutation_gate.activity(),
        || Ok(()),
    )?;
    // The application event loop rechecks all guards when exit is delivered.
    window.app_handle().exit(0);
    Ok(())
}
#[tauri::command]
fn quit_request_finished(
    window: tauri::WebviewWindow,
    state: State<'_, BrowserState>,
) -> Result<(), String> {
    check_window(&window)?;
    quit::cancel(&state.close_authorized);
    #[cfg(target_os = "macos")]
    quit_macos::finished();
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
    let runtime = match update::Runtime::acquire() {
        Ok(Some(runtime)) => runtime,
        Ok(None) => return,
        Err(_) => {
            eprintln!(
                "Heinlein startup safety gate is unavailable; writing and accounts are unchanged."
            );
            return;
        }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(runtime)
        .manage(BrowserState::default())
        .manage(questions::QuestionHost::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                quit_macos::install(move || {
                    let window = handle.get_webview_window("main").ok_or("Quit window unavailable")?;
                    window.emit("close-requested", ()).map_err(|_| String::from("Quit request unavailable"))
                }).map_err(std::io::Error::other)?;
            }

            let path = recent_file(app.handle()).map_err(std::io::Error::other)?;
            *app.state::<BrowserState>()
                .recents
                .lock()
                .map_err(|_| std::io::Error::other("Preferences unavailable"))? =
                load_recents(&path);
            app.state::<update::Runtime>()
                .ready(app.handle())
                .map_err(std::io::Error::other)?;
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
            quit::handle_window_close(event, || {
                let _ = window.emit("close-requested", ());
            });
        })
        .invoke_handler(tauri::generate_handler![
            github::github_request,
            update::update_request,
            questions::question_status,
            questions::request_review,
            questions::prepare_review_edit,
            questions::reject_review_edit,
            questions::get_review,
            questions::ask_question,
            questions::suggest_question_revision,
            questions::cancel_question,
            questions::connect_question_account,
            questions::cancel_question_sign_in,
            questions::select_question_account,
            questions::select_question_model,
            questions::refresh_question_connection,
            questions::sign_out_question_account,
            questions::open_question_usage,
            proposals::list_proposals,
            proposals::reject_proposal,
            proposals::review_proposal,
            proposals::review_proposal_revert,
            proposals::apply_proposal_review,
            proposals::cancel_proposal_review,
            first_story::load_first_story,
            first_story::save_first_story,
            first_story::reset_first_story,
            first_story::preview_publishing_copy,
            first_story::confirm_publishing_copy,
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
            quit_request_finished,
            load_manuscript,
            list_system_fonts
        ])
        .build(tauri::generate_context!())
        .expect("Heinlein Studio failed to start")
        .run(|app, event| {
            let state = app.state::<BrowserState>();
            let activity = state.mutation_gate.activity();
            quit::handle(
                &event,
                &state.close_authorized,
                activity,
                || {
                    let _selection = state
                        .selection_gate
                        .try_lock()
                        .map_err(|_| "Finish opening the project before quitting")?;
                    let _github = state.github.close_guard()?;
                    let _mutation = state.mutation_gate.close_guard()?;
                    let runtime = app.state::<update::Runtime>();
                    let _update = runtime.idle()?;
                    if state.unsaved_changes.load(Ordering::SeqCst) {
                        return Err("Save or discard changes before closing".into());
                    }
                    if state.mutation_gate.activity() != activity {
                        return Err("Work changed before quitting".into());
                    }
                    // All mutation/auth/update entry locks are held. Seal before
                    // releasing them so queued or new work cannot race actual exit.
                    state.quitting.store(true, Ordering::SeqCst);
                    state.mutation_gate.seal_for_exit();
                    runtime.seal_for_exit();
                    Ok(())
                },
                |granted| {
                    #[cfg(target_os = "macos")]
                    quit_macos::finished();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        if granted {
                            let _ = window.emit("quit-refused", "Heinlein stayed open because work changed or a save/connection still needs attention. Finish or retry it, then choose Quit again.");
                        } else {
                            let _ = window.emit("close-requested", ());
                        }
                    }
                },
            );
        });
}
