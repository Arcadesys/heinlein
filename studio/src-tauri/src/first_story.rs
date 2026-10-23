//! Host-private optional guide progress, plus explicit one-way publisher handoff.
use super::{check_window, id, with_repository, BrowserState};
use repository_core::{PublishingMetadata, PublishingPlan, PublishingPreview, Repository};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Default)]
pub(crate) struct Host {
    pending: Option<(String, PublishingPlan, PathBuf, u64)>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Guide {
    schema_version: u32,
    manuscript_path: String,
    revision: String,
    enabled: bool,
    stage: usize,
    steps: Vec<String>,
    idea: Vec<String>,
    approach: String,
    plan: String,
    structure_reviewed: bool,
    sentence_reviewed: bool,
    source_revision: Option<String>,
    proof_revision: Option<String>,
    release_checks: Vec<bool>,
    publishing: Option<PublishingMetadata>,
}
impl Default for Guide {
    fn default() -> Self {
        Self {
            schema_version: 1,
            manuscript_path: "ms/manuscript.json".into(),
            revision: "new".into(),
            enabled: false,
            stage: 0,
            steps: vec!["todo".into(); 6],
            idea: vec![String::new(); 4],
            approach: "discovery".into(),
            plan: String::new(),
            structure_reviewed: false,
            sentence_reviewed: false,
            source_revision: None,
            proof_revision: None,
            release_checks: vec![false; 4],
            publishing: None,
        }
    }
}
impl Guide {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || self.manuscript_path != "ms/manuscript.json"
            || self.stage >= 6
            || self.steps.len() != 6
            || self
                .steps
                .iter()
                .any(|s| !["todo", "done", "skipped"].contains(&s.as_str()))
            || self.idea.len() != 4
            || self.idea.iter().any(|s| s.len() > 4000)
            || self.plan.len() > 8000
            || !["discovery", "plan"].contains(&self.approach.as_str())
            || self.release_checks.len() != 4
            || self.revision.len() > 100
            || self.source_revision.as_ref().is_some_and(|r| r.len() > 100)
            || self.proof_revision.as_ref().is_some_and(|r| r.len() > 100)
        {
            return Err("Guide progress is malformed or from an unsupported version. Reset only the guide to start again; your story is unchanged.".into());
        }
        Ok(())
    }
    fn observe(&mut self, revision: Option<String>) {
        if self.source_revision != revision {
            self.proof_revision = None;
            if self.steps[4] == "done" {
                self.steps[4] = "todo".into();
            }
            if self.steps[5] == "done" {
                self.steps[5] = "todo".into();
            }
            self.release_checks.fill(false);
            self.source_revision = revision;
        }
    }
}
fn load(path: &Path) -> Result<Guide, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Guide::default()),
        Ok(meta) if meta.is_file() && meta.len() < 65536 => {}
        _ => {
            return Err(
                "Guide progress cannot be read safely. Reset only the guide to start again.".into(),
            )
        }
    }
    let guide: Guide = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| {
            "Guide progress is malformed. Reset only the guide; your story is unchanged."
        })?;
    guide.validate()?;
    Ok(guide)
}
fn save(path: &Path, expected: &str, guide: &mut Guide) -> Result<(), String> {
    if load(path)?.revision != expected {
        return Err("Guide changed in another view. Reopen it before saving.".into());
    }
    guide.validate()?;
    guide.revision = id();
    let bytes = serde_json::to_vec(guide).map_err(|e| e.to_string())?;
    if bytes.len() >= 65536 {
        return Err(
            "Guide notes exceed the size limit. Shorten the guide notes; story text is unchanged."
                .into(),
        );
    }
    fs::create_dir_all(path.parent().ok_or("Guide storage unavailable")?)
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e: std::io::Error| e.to_string())
}
fn path(app: &tauri::AppHandle, repo: &Repository) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("first-story-v1")
        .join(format!("{}.json", repo.project_key())))
}
fn clean(state: &BrowserState) -> Result<(), String> {
    if state.unsaved_changes.load(Ordering::SeqCst) {
        return Err("Save your story and resolve recovery drafts before proofing or preparing a publishing copy.".into());
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn load_first_story(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
) -> Result<Guide, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _host = state.first_story.lock().map_err(|_| "Guide unavailable")?;
        with_repository(&app, &repository_id, |repo| {
            let mut guide = load(&path(&app, repo)?)?;
            guide.observe(if state.unsaved_changes.load(Ordering::SeqCst) {
                None
            } else {
                repo.story_revision().ok()
            });
            Ok(guide)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn save_first_story(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    mut guide: Guide,
    mark_proof: bool,
) -> Result<Guide, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder operation is in progress")?;
        let _mutation = state.mutation_gate.author_operation()?;
        let _host = state.first_story.lock().map_err(|_| "Guide unavailable")?;
        with_repository(&app, &repository_id, |repo| {
            let storage = path(&app, repo)?;
            let old = load(&storage)?;
            let expected = guide.revision.clone();
            guide.proof_revision = old.proof_revision;
            guide.source_revision = old.source_revision;
            guide.validate()?;
            guide.observe(if state.unsaved_changes.load(Ordering::SeqCst) {
                None
            } else {
                repo.story_revision().ok()
            });
            if mark_proof {
                clean(&state)?;
                let revision = repo
                    .clean_story_revision(super::recovery_store(&app)?.as_ref())
                    .map_err(|e| e.to_string())?;
                guide.proof_revision = Some(revision.clone());
                guide.source_revision = Some(revision);
                guide.steps[4] = "done".into();
            } else if guide.proof_revision.is_none() && guide.steps[4] == "done" {
                guide.steps[4] = "todo".into();
            }
            save(&storage, &expected, &mut guide)?;
            Ok(guide)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn reset_first_story(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
) -> Result<Option<Guide>, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !app.dialog().message("Clear this story guide and its planning answers? Your story files remain unchanged.").title("Reset first-story guide").buttons(MessageDialogButtons::OkCancel).blocking_show() { return Ok(None); }
        let state = app.state::<BrowserState>(); let _host = state.first_story.lock().map_err(|_| "Guide unavailable")?;
        with_repository(&app, &repository_id, |repo| {
            let storage = path(&app, repo)?;
            // An author-confirmed reset also recovers malformed progress; no source is touched.
            let mut fresh = Guide { enabled: true, ..Guide::default() };
            let backup = storage.with_extension(format!("reset-{}", id()));
            let existed = match fs::rename(&storage, &backup) { Ok(()) => true, Err(e) if e.kind() == std::io::ErrorKind::NotFound => false, Err(e) => return Err(e.to_string()) };
            if let Err(error) = save(&storage, "new", &mut fresh) { if existed { let _ = fs::rename(&backup, &storage); } return Err(error); }
            if existed { let _ = fs::remove_file(backup); }
            fresh.observe(repo.story_revision().ok()); Ok(Some(fresh))
        })
    }).await.map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyPreview {
    preview: PublishingPreview,
    destination: String,
}
#[tauri::command]
pub(crate) async fn preview_publishing_copy(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    metadata: PublishingMetadata,
) -> Result<Option<CopyPreview>, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        clean(&state)?;
        state
            .first_story
            .lock()
            .map_err(|_| "Guide unavailable")?
            .pending = None;
        let epoch = state.mutation_gate.generation();
        let plan = with_repository(&app, &repository_id, |repo| {
            repo.preview_publishing_copy(metadata, super::recovery_store(&app)?.as_ref())
                .map_err(|e| e.to_string())
        })?;
        let Some(folder) = app
            .dialog()
            .file()
            .set_title("Choose the parent folder for a NEW publishing copy")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let parent = folder.into_path().map_err(|_| "Choose a local folder")?;
        let resolved = super::resolved_future_path(&parent)?;
        let private = app.path().app_data_dir().map_err(|e| e.to_string())?;
        if resolved.starts_with(super::resolved_future_path(&private)?) {
            return Err("Choose a destination outside Heinlein's private app storage".into());
        }
        let destination = format!(
            "{} / {}",
            parent.file_name().unwrap_or_default().to_string_lossy(),
            plan.preview.folder_name
        );
        let preview = plan.preview.clone();
        state
            .first_story
            .lock()
            .map_err(|_| "Guide unavailable")?
            .pending = Some((repository_id, plan, parent, epoch));
        Ok(Some(CopyPreview {
            preview,
            destination,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}
fn take_copy(
    host: &mut Host,
    session: &str,
    token: &str,
) -> Result<(PublishingPlan, PathBuf, u64), String> {
    let (owner, plan, parent, epoch) = host
        .pending
        .take()
        .ok_or("Preview this publishing copy again before confirming")?;
    if owner != session || plan.preview.id != token {
        return Err("Publishing preview expired".into());
    }
    Ok((plan, parent, epoch))
}
fn confirmation_current(state: &BrowserState, epoch: u64) -> Result<(), String> {
    clean(state)?;
    if state.mutation_gate.generation() != epoch {
        return Err("Your story changed during publishing confirmation. Preview it again.".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn confirm_publishing_copy(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    preview_id: String,
) -> Result<bool, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let (plan, parent, epoch) = take_copy(&mut *state.first_story.lock().map_err(|_| "Guide unavailable")?, &repository_id, &preview_id)?;
        let metadata_summary = plan.confirmation_summary();
        let message = format!("{metadata_summary}\n\nCreate a NEW publishing copy at {}?\n{} scenes, {}\nFREE PLAY branding; no cover. Source remains canonical. No overwrite or reverse sync.\nSource revision: {}", parent.join(&plan.preview.folder_name).display(), plan.preview.sources.len(), plan.preview.folder_name, plan.preview.source_revision);
        if !app.dialog().message(message).title("Create publishing copy").buttons(MessageDialogButtons::OkCancel).blocking_show() { return Ok(false); }
        let _selection = state.selection_gate.try_lock().map_err(|_| "Another folder operation is in progress")?;
        let _mutation = state.mutation_gate.author_operation()?; confirmation_current(&state, epoch)?;
        with_repository(&app, &repository_id, |repo| repo.write_publishing_copy(&plan, &parent, super::recovery_store(&app)?.as_ref(), || {
            if state.unsaved_changes.load(Ordering::SeqCst) || state.mutation_gate.generation() != epoch { Err(repository_core::Error::EditorChanged) } else { Ok(()) }
        }).map_err(|e| e.to_string()))?;
        Ok(true)
    }).await.map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guide_round_trip_and_scope_validation() {
        let t = tempfile::TempDir::new().unwrap();
        let p = t.path().join("guide.json");
        let mut g = load(&p).unwrap();
        assert!(!g.enabled);
        g.enabled = true;
        g.idea[0] = "A synthetic character".into();
        save(&p, "new", &mut g).unwrap();
        assert_eq!(load(&p).unwrap().idea[0], g.idea[0]);
        assert!(save(&p, "new", &mut g).is_err());
        g.manuscript_path = "other.json".into();
        assert!(g.validate().is_err());
    }
    #[test]
    fn malformed_versioned_and_oversized_guide_is_preserved() {
        let t = tempfile::TempDir::new().unwrap();
        let p = t.path().join("guide.json");
        for bytes in [
            b"{".to_vec(),
            vec![b'x'; 65536],
            serde_json::to_vec(&Guide {
                schema_version: 2,
                ..Guide::default()
            })
            .unwrap(),
        ] {
            fs::write(&p, &bytes).unwrap();
            assert!(load(&p).is_err());
            assert_eq!(fs::read(&p).unwrap(), bytes);
        }
    }
    #[test]
    fn source_changes_invalidate_only_proof_and_release_checks() {
        let mut g = Guide {
            source_revision: Some("old".into()),
            proof_revision: Some("old".into()),
            ..Guide::default()
        };
        g.steps.fill("done".into());
        g.release_checks.fill(true);
        g.observe(Some("new".into()));
        assert_eq!(g.steps[0], "done");
        assert_eq!(g.steps[4], "todo");
        assert_eq!(g.steps[5], "todo");
        assert!(g.proof_revision.is_none());
        assert!(!g.release_checks.iter().any(|c| *c));
    }
    #[test]
    fn failed_guide_save_preserves_old_progress_and_removes_temp() {
        let t = tempfile::TempDir::new().unwrap();
        let p = t.path().join("guide.json");
        let mut g = Guide::default();
        save(&p, "new", &mut g).unwrap();
        let old = fs::read(&p).unwrap();
        let expected = g.revision.clone();
        g.plan = "x".repeat(8001);
        assert!(save(&p, &expected, &mut g).is_err());
        assert_eq!(fs::read(&p).unwrap(), old);
        assert_eq!(fs::read_dir(t.path()).unwrap().count(), 1);
    }
    #[test]
    fn native_confirmation_rejects_dirty_and_changed_edit_epoch() {
        let state = BrowserState::default();
        let epoch = state.mutation_gate.generation();
        assert!(confirmation_current(&state, epoch).is_ok());
        state.unsaved_changes.store(true, Ordering::SeqCst);
        assert!(confirmation_current(&state, epoch).is_err());
        state.unsaved_changes.store(false, Ordering::SeqCst);
        state.mutation_gate.invalidate();
        assert!(confirmation_current(&state, epoch).is_err());
        assert!(take_copy(&mut Host::default(), "session", "forged-token").is_err());
    }

    #[test]
    fn native_preview_is_session_bound_single_use_and_cancel_does_not_write() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let source = root.join("source");
        fs::create_dir_all(source.join("ms")).unwrap();
        fs::write(source.join("ms/scene.md"), "Synthetic scene.").unwrap();
        fs::write(source.join("ms/manuscript.json"), serde_json::to_vec(&serde_json::json!({"schemaVersion":2,"id":id(),"project":"Synthetic","groups":[],"scenes":[{"id":id(),"title":"Opening","path":"ms/scene.md","groupId":null}]})).unwrap()).unwrap();
        let repo = Repository::open(&source).unwrap();
        let recovery = repository_core::RecoveryStore::open(root.join("recovery")).unwrap();
        let plan = repo
            .preview_publishing_copy(
                PublishingMetadata {
                    title: "Synthetic".into(),
                    author: "Example".into(),
                    rights: "Example retains rights".into(),
                    language: "en-US".into(),
                    formats: vec!["html".into()],
                    folder_name: "copy".into(),
                    free_play_approved: true,
                    no_cover_approved: true,
                },
                &recovery,
            )
            .unwrap();
        let parent = root.join("copies");
        fs::create_dir(&parent).unwrap();
        for (session, token) in [
            ("wrong-session", plan.preview.id.as_str()),
            ("session", "forged-token"),
        ] {
            let mut host = Host {
                pending: Some(("session".into(), plan.clone(), parent.clone(), 0)),
            };
            assert!(take_copy(&mut host, session, token).is_err());
            assert!(host.pending.is_none());
        }
        let mut host = Host {
            pending: Some(("session".into(), plan.clone(), parent.clone(), 0)),
        };
        // Taking the retained plan is not approval. Dropping it models native Cancel;
        // a second renderer confirmation cannot reuse its token or create a folder.
        drop(take_copy(&mut host, "session", &plan.preview.id).unwrap());
        assert!(take_copy(&mut host, "session", &plan.preview.id).is_err());
        assert_eq!(fs::read_dir(parent).unwrap().count(), 0);
        let mut guide = Guide {
            source_revision: Some(repo.story_revision().unwrap()),
            proof_revision: Some(repo.story_revision().unwrap()),
            ..Guide::default()
        };
        guide.steps.fill("done".into());
        fs::write(
            source.join("ms/scene.md"),
            "Author changed the saved scene.",
        )
        .unwrap();
        guide.observe(Some(repo.story_revision().unwrap()));
        assert_eq!(guide.steps[4], "todo");
        assert_eq!(guide.steps[0], "done");
        assert_eq!(
            fs::read_to_string(source.join("ms/scene.md")).unwrap(),
            "Author changed the saved scene."
        );
    }
}
