//! Narrow native authority for ms/ structure and OS-selected external Markdown files.
use super::{check_window, id, with_recovery, with_repository, BrowserState};
use repository_core::{
    DraftingChange, DraftingExternalFile, DraftingPlan, DraftingPreview, DraftingState,
    DraftingUndo,
};
use serde::Serialize;
use std::{path::PathBuf, sync::atomic::Ordering};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub(crate) struct DraftingHost {
    preview: Option<(String, DraftingPlan)>,
    undo: Option<(String, DraftingUndo)>,
    selection: Option<(String, String, Vec<DraftingExternalFile>)>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Selection {
    id: String,
    files: Vec<SelectedFile>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectedFile {
    name: String,
    size_bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Applied {
    state: DraftingState,
    undo_id: Option<String>,
}
fn clean_editor(state: &BrowserState) -> Result<(), String> {
    if state.unsaved_changes.load(Ordering::SeqCst) {
        return Err(
            "Save or discard the current scene before changing manuscript structure".into(),
        );
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn load_drafting(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
) -> Result<DraftingState, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_repository(&app, &repository_id, |repo| {
            repo.load_drafting().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn preview_drafting_change(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    expected_revision: Option<String>,
    change: DraftingChange,
) -> Result<DraftingPreview, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder or structure change is in progress")?;
        let _mutation = state.mutation_gate.author_operation()?;
        state.mutation_gate.invalidate();
        clean_editor(&state)?;
        let mut host = state
            .drafting
            .lock()
            .map_err(|_| "Manuscript operations unavailable")?;
        // A newer request invalidates the prior preview, including failed selection lookup.
        host.preview = None;
        let files = match &change {
            DraftingChange::ImportExternal { selection_id, .. } => {
                let (session, token, files) = host
                    .selection
                    .as_ref()
                    .ok_or("Choose files with the native picker or drop them again")?;
                if session != &repository_id || token != selection_id {
                    return Err("File selection expired; choose the files again".into());
                }
                files.clone()
            }
            _ => vec![],
        };
        let plan = with_repository(&app, &repository_id, |repo| {
            with_recovery(&app, |recovery| {
                repo.preview_drafting(expected_revision.as_deref(), change, &files, recovery)
            })
        })?;
        let preview = plan.preview.clone();
        host.preview = Some((repository_id, plan));
        Ok(preview)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn apply_drafting_change(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    preview_id: String,
) -> Result<Applied, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder or structure change is in progress")?;
        let _mutation = state.mutation_gate.author_operation()?;
        state.mutation_gate.invalidate();
        clean_editor(&state)?;
        let mut host = state
            .drafting
            .lock()
            .map_err(|_| "Manuscript operations unavailable")?;
        let (session, plan) = host
            .preview
            .as_ref()
            .ok_or("Preview this change before applying it")?;
        if session != &repository_id || plan.preview.id != preview_id {
            return Err("Preview expired; preview the change again".into());
        }
        let plan = plan.clone();
        host.preview = None;
        let undo = with_repository(&app, &repository_id, |repo| {
            with_recovery(&app, |recovery| repo.apply_drafting(&plan, recovery))
        })?;
        let undo_id = undo.is_available().then(|| undo.id.clone());
        host.undo = if undo.is_available() {
            Some((repository_id.clone(), undo))
        } else {
            None
        };
        host.selection = None;
        let snapshot = with_repository(&app, &repository_id, |repo| {
            repo.load_drafting().map_err(|e| e.to_string())
        })
        .map_err(|error| {
            format!("Change applied locally, but refresh failed: {error}. Reload before retrying")
        })?;
        Ok(Applied {
            state: snapshot,
            undo_id,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn undo_drafting_change(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    undo_id: String,
) -> Result<DraftingState, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder or structure change is in progress")?;
        let _mutation = state.mutation_gate.author_operation()?;
        state.mutation_gate.invalidate();
        clean_editor(&state)?;
        let mut host = state
            .drafting
            .lock()
            .map_err(|_| "Manuscript operations unavailable")?;
        let (session, undo) = host
            .undo
            .as_ref()
            .ok_or("No manuscript change is available to undo")?;
        if session != &repository_id || undo.id != undo_id {
            return Err("Undo expired; refresh the manuscript".into());
        }
        let snapshot = with_repository(&app, &repository_id, |repo| {
            with_recovery(&app, |recovery| repo.undo_drafting(undo, recovery))
        })?;
        host.undo = None;
        host.preview = None;
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn authorize_selection(
    app: &tauri::AppHandle,
    repository_id: &str,
    paths: Vec<PathBuf>,
) -> Result<Selection, String> {
    if paths.is_empty() || paths.len() > 256 {
        return Err("Choose between 1 and 256 Markdown files".into());
    }
    // Verify the session before reading OS-selected files; never accept renderer paths.
    with_repository(app, repository_id, |_| Ok(()))?;
    let mut files = vec![];
    let mut bytes = 0;
    for path in paths {
        let file = DraftingExternalFile::read_selected(&path).map_err(|e| e.to_string())?;
        bytes += file.size_bytes();
        if bytes > 32 * 1024 * 1024 {
            return Err("Selected files exceed the 32 MiB import limit".into());
        }
        files.push(file);
    }
    let selection = Selection {
        id: id(),
        files: files
            .iter()
            .map(|f| SelectedFile {
                name: f.name().into(),
                size_bytes: f.size_bytes(),
            })
            .collect(),
    };
    app.state::<BrowserState>()
        .drafting
        .lock()
        .map_err(|_| "Manuscript operations unavailable")?
        .selection = Some((repository_id.into(), selection.id.clone(), files));
    Ok(selection)
}
#[tauri::command]
pub(crate) async fn pick_drafting_import(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
) -> Result<Option<Selection>, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder or file selection is in progress")?;
        with_repository(&app, &repository_id, |_| Ok(()))?;
        let Some(files) = app
            .dialog()
            .file()
            .set_title("Copy Markdown files into manuscript")
            .add_filter("Markdown scenes", &["md", "markdown"])
            .blocking_pick_files()
        else {
            return Ok(None);
        };
        let paths = files
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map_err(|_| "Choose local Markdown files".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        authorize_selection(&app, &repository_id, paths).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Called only for native OS Drop events on the trusted main window.
pub(crate) fn handle_drop(app: tauri::AppHandle, paths: Vec<PathBuf>) {
    let _task = tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let state = app.state::<BrowserState>();
            let _selection = state
                .selection_gate
                .try_lock()
                .map_err(|_| "Another folder or file selection is in progress")?;
            let repository_id = state
                .selected
                .lock()
                .map_err(|_| "Repository unavailable")?
                .as_ref()
                .ok_or("Open a repository before dropping Markdown files")?
                .id
                .clone();
            authorize_selection(&app, &repository_id, paths)
        })();
        if let Some(window) = app.get_webview_window("main") {
            match result {
                Ok(selection) => {
                    let _ = window.emit("drafting-files-dropped", selection);
                }
                Err(error) => {
                    let _ = window.emit("drafting-import-error", error);
                }
            }
        }
    });
}
