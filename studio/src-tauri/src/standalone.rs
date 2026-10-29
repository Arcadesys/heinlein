//! Standalone documents use only host-private storage. No repository or provider is opened by typing.
use super::{check_window, id, BrowserState};
use repository_core::{
    standalone::{DraftLease, DraftStore, PlacementIntent},
    standalone_placement::{verify_scene, DraftDestination},
    DraftingPlan, LiteralScene, Repository,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
#[derive(Default)]
pub(crate) struct Host {
    store: Option<DraftStore>,
    leases: HashMap<String, DraftLease>,
    plans: HashMap<String, Plan>,
}
struct Plan {
    handle: String,
    intent: PlacementIntent,
    text: String,
    epoch: u64,
    target: Target,
}
enum Target {
    File(DraftDestination),
    Existing(Arc<Repository>, DraftingPlan, String),
    New(DraftDestination, String, String, String),
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Request {
    List,
    Create {
        text: String,
    },
    Open {
        id: String,
    },
    Release {
        handle: String,
    },
    Save {
        handle: String,
        revision: u64,
        hash: String,
        text: String,
    },
    Discard {
        handle: String,
        revision: u64,
        hash: String,
    },
    Restore {
        handle: String,
        revision: u64,
        hash: String,
    },
    Repair {
        handle: String,
        revision: u64,
        hash: String,
    },
    Preview {
        handle: String,
        revision: u64,
        hash: String,
        destination: String,
        name: String,
        title: String,
        project: String,
    },
    Place {
        token: String,
    },
    Reconcile {
        handle: String,
    },
    OpenPlaced {
        handle: String,
        operation: String,
    },
    CancelPreview {
        token: String,
    },
}
fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Local draft storage unavailable")?
        .join("standalone-drafts-v1"))
}
fn managed_destination(app: &tauri::AppHandle, path: &Path) -> Result<Option<PathBuf>, String> {
    let private = app
        .path()
        .app_data_dir()
        .map_err(|_| "Private storage unavailable")?;
    let sources = super::resolved_future_path(&private.join("github-sources-v1"))?;
    if !path.starts_with(&sources) {
        return Ok(None);
    }
    let state = app.state::<BrowserState>();
    let selected = state.selected.lock().map_err(|_| "Project unavailable")?;
    let root=selected.as_ref().map(|s|s.repo.root().to_path_buf()).filter(|root|path.starts_with(root)).ok_or("Open this managed project from GitHub projects first, then choose it as the destination.")?;
    drop(selected);
    if super::github::selection(app, &root)?.is_none() {
        return Err("Managed project authority unavailable".into());
    }
    Ok(Some(root))
}
fn safe_destination(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let path = super::resolved_future_path(path)?;
    let private = super::resolved_future_path(
        &app.path()
            .app_data_dir()
            .map_err(|_| "Private storage unavailable")?,
    )?;
    let managed = managed_destination(app, &path)?;
    if (path.starts_with(&private) || private.starts_with(&path)) && managed.is_none() {
        return Err("Choose a destination outside Heinlein's private storage.".into());
    }
    #[cfg(target_os = "macos")]
    {
        #[cfg(feature = "standalone-native-acceptance")]
        let home = super::standalone_native_acceptance::picker_guard_home(app)?;
        #[cfg(not(feature = "standalone-native-acceptance"))]
        let home = app.path().home_dir().map_err(|_| "Home unavailable")?;
        super::update::guard_repository(&path, &home)?;
    }
    Ok(())
}
fn confirm(app: &tauri::AppHandle, message: &str) -> bool {
    app.dialog()
        .message(message)
        .title("Standalone draft")
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}
// The command's exact window and selection/close-exclusion guard live through this call.
// The off-main parent helper caches both fallible handles; plugin setters cannot silently drop it.
fn confirm_placement(
    app: &tauri::AppHandle,
    _window: &tauri::WebviewWindow,
    message: &str,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    let parent = super::proposals::parent::ValidatedConfirmationParent::capture(app, _window)?;
    let builder = app
        .dialog()
        .message(message)
        .title("Standalone draft")
        .buttons(MessageDialogButtons::OkCancel);
    #[cfg(target_os = "macos")]
    let builder = builder.parent(&parent);
    #[cfg(all(feature = "standalone-native-acceptance", target_os = "macos"))]
    super::standalone_picker_acceptance::arm_confirmation(message)?;
    #[cfg(target_os = "macos")]
    parent.check_on_main(app)?;
    let confirmed = builder.blocking_show();
    #[cfg(target_os = "macos")]
    let _keep_owner_through_completion = &parent;
    Ok(confirmed)
}
fn lease<'a>(host: &'a Host, handle: &str) -> Result<&'a DraftLease, String> {
    host.leases.get(handle).ok_or(
        "Draft writer expired. Reopen it from Drafts; your visible text is unchanged.".into(),
    )
}
fn value<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|_| "Local draft response unavailable".into())
}
fn validate_capture(
    host: &Host,
    handle: &str,
    revision: u64,
    hash: &str,
    dirty: bool,
) -> Result<(), String> {
    let loaded = host
        .store
        .as_ref()
        .ok_or("Draft storage unavailable")?
        .read(lease(host, handle)?.id())?;
    if dirty
        || loaded.recovery_required
        || loaded.draft.state != "active"
        || loaded.draft.revision != revision
        || loaded.draft.text_hash != hash
    {
        return Err("Keep the latest draft and preview it again.".into());
    }
    Ok(())
}
fn opened(host: &mut Host, id: &str) -> Result<Value, String> {
    let store = host
        .store
        .as_ref()
        .ok_or("Local draft storage unavailable")?;
    let (handle, reason) = match store.acquire(id) {
        Ok(lease) => {
            let key = super::id();
            host.leases.insert(key.clone(), lease);
            (Some(key), None)
        }
        Err(e) => (None, Some(e)),
    };
    let loaded = match store.read(id) {
        Ok(loaded) => loaded,
        Err(e) => {
            if let Some(h) = &handle {
                host.leases.remove(h);
            }
            return Err(e);
        }
    };
    Ok(
        json!({"loaded":loaded,"handle":handle,"readOnlyReason":reason,"pending":store.pending(id)?}),
    )
}
// Capture only native-retained destination data, never renderer-supplied roots.
fn placement_intent(
    draft: &repository_core::standalone::Draft,
    target: &Target,
    scene_id: String,
) -> PlacementIntent {
    let (kind, path) = match target {
        Target::File(t) => ("file", t.path()),
        Target::Existing(repo, _, relative) => ("existingProject", repo.root().join(relative)),
        Target::New(t, _, _, name) => ("newProject", t.path().join("ms").join(name)),
    };
    let (project_root, scene_path) = match target {
        Target::File(_) => (None, None),
        Target::Existing(repo, _, relative) => (
            Some(repo.root().to_string_lossy().into_owned()),
            Some(relative.clone()),
        ),
        Target::New(t, _, _, name) => (
            Some(t.path().to_string_lossy().into_owned()),
            Some(format!("ms/{name}")),
        ),
    };
    PlacementIntent {
        schema_version: 1,
        id: id(),
        draft_id: draft.id.clone(),
        source_revision: draft.revision,
        source_hash: draft.text_hash.clone(),
        kind: kind.into(),
        destination: path.to_string_lossy().into(),
        scene_id: Some(scene_id),
        project_key: None,
        project_root,
        scene_path,
    }
}
fn verify_intent(intent: &PlacementIntent) -> Result<(), String> {
    if intent.kind == "file" {
        DraftDestination::open(Path::new(&intent.destination))?.verify_file(&intent.source_hash)
    } else {
        let (root, relative) = intent.scene_location()?;
        let repo = Repository::open(root).map_err(|e| e.to_string())?;
        verify_scene(
            &repo,
            &relative,
            intent
                .scene_id
                .as_deref()
                .ok_or("Placement scene unavailable")?,
            &intent.source_hash,
        )
    }
}
/// Reopening is not a replay: independent destination edits remain current.
fn current_placed_copy(intent: &PlacementIntent) -> Result<(PathBuf, String, bool), String> {
    let path = Path::new(&intent.destination);
    let (root, relative) = if intent.kind == "file" {
        (
            path.parent()
                .ok_or("Destination unavailable")?
                .to_path_buf(),
            path.file_name()
                .and_then(|s| s.to_str())
                .ok_or("Destination unavailable")?
                .to_string(),
        )
    } else {
        intent.scene_location()?
    };
    let repo = Repository::open(&root).map_err(|e| e.to_string())?;
    let doc = repo.read(&relative).map_err(|e| e.to_string())?;
    if doc.generated_compatibility {
        return Err("Open the source scene instead of generated output.".into());
    }
    if intent.kind == "file" {
        DraftDestination::open(path)?.verify_file(&doc.content_hash)?;
    } else {
        verify_scene(
            &repo,
            &relative,
            intent.scene_id.as_deref().ok_or("Scene unavailable")?,
            &doc.content_hash,
        )?;
    }
    Ok((root, relative, doc.content_hash != intent.source_hash))
}
#[tauri::command]
pub(crate) async fn standalone_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<Value, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || execute(&app, &window, request))
        .await
        .map_err(|_| {
            "Local draft operation interrupted; keep your visible text and retry.".to_string()
        })?
}
fn execute(
    app: &tauri::AppHandle,
    _window: &tauri::WebviewWindow,
    request: Request,
) -> Result<Value, String> {
    let state = app.state::<BrowserState>();
    let _selection = if matches!(
        &request,
        Request::Preview { .. } | Request::Place { .. } | Request::OpenPlaced { .. }
    ) {
        Some(
            state
                .selection_gate
                .try_lock()
                .map_err(|_| "Another destination selection is in progress")?,
        )
    } else {
        None
    };
    let _gate = state.mutation_gate.author_operation()?;
    let mut host = state
        .standalone
        .lock()
        .map_err(|_| "Local draft storage unavailable")?;
    if host.store.is_none() {
        host.store = Some(DraftStore::open(store_path(app)?)?);
    }
    match request {
        Request::List => value(host.store.as_ref().unwrap().list()?),
        Request::Create { text } => {
            let (lease, draft) = host.store.as_ref().unwrap().create(&text)?;
            let handle = id();
            host.leases.insert(handle.clone(), lease);
            Ok(
                json!({"handle":handle,"loaded":{"draft":draft,"warning":null,"recoveryRequired":false},"pending":[]}),
            )
        }
        Request::Open { id } => opened(&mut host, &id),
        Request::Release { handle } => {
            host.plans.retain(|_, p| p.handle != handle);
            host.leases.remove(&handle);
            Ok(Value::Null)
        }
        Request::CancelPreview { token } => {
            host.plans.remove(&token);
            Ok(Value::Null)
        }
        Request::Save {
            handle,
            revision,
            hash,
            text,
        } => value(host.store.as_ref().unwrap().save(
            lease(&host, &handle)?,
            revision,
            &hash,
            &text,
        )?),
        Request::Discard {
            handle,
            revision,
            hash,
        } => {
            if state
                .unsaved_changes
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err("Keep the latest text on this Mac before removing the draft.".into());
            }
            if !confirm(app,"Remove this draft from Drafts? You can restore it from Discarded drafts. Copies already placed elsewhere remain."){return Ok(Value::Null);}
            if state
                .unsaved_changes
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(
                    "The draft changed during confirmation. Keep the latest text and try again."
                        .into(),
                );
            }
            value(host.store.as_ref().unwrap().transition(
                lease(&host, &handle)?,
                revision,
                &hash,
                "discarded",
            )?)
        }
        Request::Restore {
            handle,
            revision,
            hash,
        } => value(host.store.as_ref().unwrap().transition(
            lease(&host, &handle)?,
            revision,
            &hash,
            "active",
        )?),
        Request::Repair {
            handle,
            revision,
            hash,
        } => {
            if !confirm(app,"Use the recoverable last kept version? The uncertain current record will be replaced. Review this text first."){return Ok(Value::Null);}
            value(host.store.as_ref().unwrap().restore_last_good(
                lease(&host, &handle)?,
                revision,
                &hash,
            )?)
        }
        Request::Preview {
            handle,
            revision,
            hash,
            destination,
            name,
            title,
            project,
        } => {
            validate_capture(
                &host,
                &handle,
                revision,
                &hash,
                state
                    .unsaved_changes
                    .load(std::sync::atomic::Ordering::SeqCst),
            )?;
            let loaded = host
                .store
                .as_ref()
                .unwrap()
                .read(lease(&host, &handle)?.id())?;
            let draft = loaded.draft;
            if loaded.recovery_required
                || draft.state != "active"
                || draft.revision != revision
                || draft.text_hash != hash
                || state
                    .unsaved_changes
                    .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err("Keep the latest draft before choosing a destination.".into());
            }
            if !host.store.as_ref().unwrap().pending(&draft.id)?.is_empty() {
                return Err("Check the previous placement before creating another copy.".into());
            }
            let epoch = state.mutation_gate.generation();
            #[cfg(target_os = "macos")]
            let parent =
                super::proposals::parent::ValidatedConfirmationParent::capture(app, _window)?;
            let picker = app.dialog().file();
            #[cfg(target_os = "macos")]
            let picker = picker.set_parent(&parent);
            #[cfg(all(feature = "standalone-native-acceptance", target_os = "macos"))]
            let picker = picker.set_directory(super::standalone_picker_acceptance::arm_picker()?);
            #[cfg(target_os = "macos")]
            parent.check_on_main(app)?;
            let picked = if destination == "file" {
                let picker = picker.set_title("Choose a NEW file for this copy");
                #[cfg(all(feature = "standalone-native-acceptance", target_os = "macos"))]
                let suggested = super::standalone_picker_acceptance::suggested_filename();
                #[cfg(not(all(feature = "standalone-native-acceptance", target_os = "macos")))]
                let suggested = Some("draft.md");
                let picker = if let Some(name) = suggested {
                    picker.set_file_name(name)
                } else {
                    picker
                };
                picker.blocking_save_file()
            } else {
                picker
                    .set_title(if destination == "existingProject" {
                        "Choose an existing Heinlein project"
                    } else {
                        "Choose the parent folder for a NEW project"
                    })
                    .blocking_pick_folder()
            };
            #[cfg(target_os = "macos")]
            let _keep_owner_through_completion = &parent;
            let Some(picked) = picked else {
                return Ok(Value::Null);
            };
            let chosen = picked
                .into_path()
                .map_err(|_| "Choose a local destination")?;
            #[cfg(all(feature = "standalone-native-acceptance", target_os = "macos"))]
            super::standalone_picker_acceptance::validate_returned_picker_path(&chosen)?;
            let chosen = super::resolved_future_path(&chosen)?;
            safe_destination(app, &chosen)?;
            if state
                .unsaved_changes
                .load(std::sync::atomic::Ordering::SeqCst)
                || epoch != state.mutation_gate.generation()
            {
                return Err(
                    "Your draft changed while choosing. Keep the latest text and choose again."
                        .into(),
                );
            }
            if destination != "file" && draft.text.len() as u64 > repository_core::MAX_FILE_BYTES {
                return Err("This draft is larger than the project scene limit. It is retained in full on this Mac; choose a new local file instead.".into());
            }
            let scene_id = id();
            let recovery = super::recovery_store(app)?;
            let (target, path) = match destination.as_str() {
                "file" => (Target::File(DraftDestination::open(&chosen)?), chosen),
                "existingProject" => {
                    let repo = Arc::new(Repository::open(&chosen).map_err(|e| e.to_string())?);
                    let before = repo.load_drafting().map_err(|e| e.to_string())?;
                    let revision = before
                        .revision
                        .as_deref()
                        .ok_or("Choose an existing Heinlein ms project, or choose New project.")?;
                    let relative = format!("ms/{name}");
                    let plan = repo
                        .preview_literal_scene(
                            Some(revision),
                            None,
                            LiteralScene {
                                id: scene_id.clone(),
                                title: title.clone(),
                                path: relative.clone(),
                                text: draft.text.clone(),
                            },
                            &recovery,
                        )
                        .map_err(|e| e.to_string())?;
                    let path = chosen.join(&relative);
                    (Target::Existing(repo, plan, relative), path)
                }
                "newProject" => {
                    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
                        return Err("Choose a plain new project folder name.".into());
                    }
                    let root = chosen.join(&name);
                    safe_destination(app, &root)?;
                    let target = DraftDestination::open(&root)?;
                    (
                        Target::New(target, project, title, "draft.md".into()),
                        root.join("ms/draft.md"),
                    )
                }
                _ => return Err("Choose File, Existing project, or New project.".into()),
            };
            safe_destination(app, &path)?;
            let intent = placement_intent(&draft, &target, scene_id);
            let token = id();
            let preview = json!({"token":token,"destination":intent.destination,"revision":revision,"text":draft.text,"hash":intent.source_hash});
            host.plans.clear();
            host.plans.insert(
                token,
                Plan {
                    handle,
                    intent,
                    text: draft.text,
                    epoch,
                    target,
                },
            );
            Ok(preview)
        }
        Request::Place { token } => {
            let p = host
                .plans
                .remove(&token)
                .ok_or("Preview expired. Choose the destination again.")?;
            let guard = || {
                if state
                    .unsaved_changes
                    .load(std::sync::atomic::Ordering::SeqCst)
                    || state.mutation_gate.generation() != p.epoch
                {
                    Err("Your draft changed. Keep the latest text and preview again.".into())
                } else {
                    Ok(())
                }
            };
            guard()?;
            let store = host.store.as_ref().unwrap();
            let lease = lease(&host, &p.handle)?;
            validate_capture(
                &host,
                &p.handle,
                p.intent.source_revision,
                &p.intent.source_hash,
                state
                    .unsaved_changes
                    .load(std::sync::atomic::Ordering::SeqCst),
            )?;
            let current = store.read(lease.id())?;
            if current.recovery_required
                || current.draft.revision != p.intent.source_revision
                || current.draft.text_hash != p.intent.source_hash
            {
                return Err("The captured draft changed. Preview again.".into());
            }
            if !confirm_placement(app,_window,&format!("Place an independent copy at {}? This destination may be shared by its sync tools. Your standalone draft stays here; later edits are not synchronized.",p.intent.destination))?{return Ok(Value::Null);}
            guard()?;
            safe_destination(app, Path::new(&p.intent.destination))?;
            store.intent(lease, &p.intent)?;
            let managed = managed_destination(app, Path::new(&p.intent.destination))?;
            let _managed_lock = match managed {
                Some(root) => super::github::edit_lock(app, &root)?,
                None => None,
            };
            let recovery = super::recovery_store(app)?;
            match p.target {
                Target::File(t) => t.write_file(&p.text, guard)?,
                Target::Existing(repo, plan, relative) => {
                    guard()?;
                    repo.apply_drafting(&plan, &recovery)
                        .map_err(|e| e.to_string())?;
                    verify_scene(
                        &repo,
                        &relative,
                        p.intent.scene_id.as_deref().unwrap(),
                        &p.intent.source_hash,
                    )?;
                }
                Target::New(t, project, title, name) => t.write_project(
                    &project,
                    &title,
                    &name,
                    &p.text,
                    p.intent.scene_id.as_deref().unwrap(),
                    &recovery,
                    guard,
                )?,
            };
            verify_intent(&p.intent)?;
            value(store.finish_placement(lease, &p.intent)?)
        }
        Request::Reconcile { handle } => {
            let store = host.store.as_ref().unwrap();
            let lease = lease(&host, &handle)?;
            for intent in store.pending(lease.id())? {
                safe_destination(app, Path::new(&intent.destination))?;
                match verify_intent(&intent) {
                    Ok(()) => {
                        store.finish_placement(lease, &intent)?;
                    }
                    Err(e) => {
                        // Absence proves no final destination was published, but a project transaction
                        // may still have an interrupted manifest: only plain files can be cleared.
                        if intent.kind == "file"
                            && matches!(std::fs::symlink_metadata(&intent.destination),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
                        {
                            store.cancel_intent(lease, &intent.id)?;
                        } else {
                            return Err(format!("Placement is uncertain: {e} The original is retained; no new copy was made."));
                        }
                    }
                }
            }
            value(store.read(lease.id())?.draft)
        }
        Request::OpenPlaced { handle, operation } => {
            if state
                .unsaved_changes
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(
                    "Keep your latest original draft before opening its independent copy.".into(),
                );
            }
            let draft = host
                .store
                .as_ref()
                .unwrap()
                .read(lease(&host, &handle)?.id())?
                .draft;
            let receipt = draft
                .placements
                .iter()
                .find(|r| r.id == operation)
                .ok_or("Placement receipt unavailable")?;
            let intent = PlacementIntent {
                schema_version: 1,
                id: receipt.id.clone(),
                draft_id: draft.id.clone(),
                source_revision: receipt.source_revision,
                source_hash: receipt.source_hash.clone(),
                kind: receipt.kind.clone(),
                destination: receipt.destination.clone(),
                scene_id: receipt.scene_id.clone(),
                project_key: None,
                project_root: receipt.project_root.clone(),
                scene_path: receipt.scene_path.clone(),
            };
            safe_destination(app, Path::new(&intent.destination))?;
            let (parent, relative, changed) = current_placed_copy(&intent)?;
            let session = super::select(app, parent)?;
            Ok(json!({"session":session,"path":relative,"changed":changed}))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (
        tempfile::TempDir,
        Host,
        String,
        repository_core::standalone::Draft,
    ) {
        let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let store = DraftStore::open(t.path().join("isolated-drafts")).unwrap();
        let (lease, d) = store.create("Synthetic — text\r\n").unwrap();
        let handle = id();
        let mut host = Host {
            store: Some(store),
            ..Host::default()
        };
        host.leases.insert(handle.clone(), lease);
        (t, host, handle, d)
    }
    #[test]
    fn only_live_opaque_writer_and_exact_kept_revision_can_prepare_or_place() {
        let (_t, host, h, d) = fixture();
        assert!(validate_capture(&host, &h, d.revision, &d.text_hash, false).is_ok());
        assert!(validate_capture(&host, &d.id, d.revision, &d.text_hash, false).is_err());
        assert!(validate_capture(&host, &h, d.revision, &d.text_hash, true).is_err());
        assert!(validate_capture(&host, &h, d.revision, "wrong", false).is_err());
    }
    #[test]
    fn later_save_discard_and_corruption_invalidate_prepared_authority() {
        let (t, host, h, d) = fixture();
        let store = host.store.as_ref().unwrap();
        let lease = lease(&host, &h).unwrap();
        let next = store
            .save(lease, d.revision, &d.text_hash, "new source")
            .unwrap();
        assert!(validate_capture(&host, &h, d.revision, &d.text_hash, false).is_err());
        let removed = store
            .transition(lease, next.revision, &next.text_hash, "discarded")
            .unwrap();
        assert!(validate_capture(&host, &h, removed.revision, &removed.text_hash, false).is_err());
        std::fs::write(
            t.path()
                .join("isolated-drafts")
                .join(format!("{}.json", d.id)),
            b"bad",
        )
        .unwrap();
        assert!(validate_capture(&host, &h, next.revision, &next.text_hash, false).is_err());
    }
    #[test]
    fn reopening_retains_text_but_never_grants_a_second_writer_or_reuses_prior_handle() {
        let (_t, mut host, h, d) = fixture();
        let second = opened(&mut host, &d.id).unwrap();
        assert!(second["handle"].is_null());
        assert!(second["readOnlyReason"].is_string());
        assert_eq!(second["loaded"]["draft"]["text"], d.text);
        host.leases.remove(&h);
        let next = opened(&mut host, &d.id).unwrap();
        assert!(next["handle"].is_string());
        assert_ne!(next["handle"], h);
        assert!(validate_capture(&host, &h, d.revision, &d.text_hash, false).is_err());
    }
    #[test]
    fn renderer_cannot_supply_private_paths_or_a_literal_destination_to_place() {
        assert!(serde_json::from_value::<Request>(
            json!({"kind":"save","path":"/tmp/arbitrary","text":"bad"})
        )
        .is_err());
        assert!(serde_json::from_value::<Request>(
            json!({"kind":"place","token":"bad","destination":"/tmp/arbitrary"})
        )
        .is_err());
    }
    #[test]
    fn explicitly_reopened_copy_preserves_its_later_text_without_rewriting_original_receipt() {
        let (t, mut host, h, d) = fixture();
        let path = t.path().join("copy.txt");
        DraftDestination::open(&path)
            .unwrap()
            .write_file(&d.text, || Ok(()))
            .unwrap();
        let intent = PlacementIntent {
            schema_version: 1,
            id: id(),
            draft_id: d.id.clone(),
            source_revision: d.revision,
            source_hash: d.text_hash.clone(),
            kind: "file".into(),
            destination: path.to_string_lossy().into(),
            scene_id: None,
            project_key: None,
            project_root: None,
            scene_path: None,
        };
        let store = host.store.as_ref().unwrap();
        store.intent(lease(&host, &h).unwrap(), &intent).unwrap();
        store
            .finish_placement(lease(&host, &h).unwrap(), &intent)
            .unwrap();
        assert!(!current_placed_copy(&intent).unwrap().2);
        std::fs::write(&path, "independent later — text").unwrap();
        assert!(current_placed_copy(&intent).unwrap().2);
        assert_eq!(
            host.store.as_ref().unwrap().read(&d.id).unwrap().draft.text,
            d.text
        );
        assert_eq!(
            host.store
                .as_ref()
                .unwrap()
                .read(&d.id)
                .unwrap()
                .draft
                .placements[0]
                .source_hash,
            d.text_hash
        );
        host.leases.clear();
    }
    #[test]
    fn reopening_a_copy_never_follows_a_replaced_symlink() {
        let (t, _host, _h, d) = fixture();
        let actual = t.path().join("other.txt");
        std::fs::write(&actual, "outside bytes").unwrap();
        let link = t.path().join("copy.txt");
        std::os::unix::fs::symlink(&actual, &link).unwrap();
        let intent = PlacementIntent {
            schema_version: 1,
            id: id(),
            draft_id: d.id,
            source_revision: d.revision,
            source_hash: d.text_hash,
            kind: "file".into(),
            destination: link.to_string_lossy().into(),
            scene_id: None,
            project_key: None,
            project_root: None,
            scene_path: None,
        };
        assert!(current_placed_copy(&intent).is_err());
        assert_eq!(std::fs::read_to_string(actual).unwrap(), "outside bytes");
    }
    #[test]
    fn nested_scene_placement_reconciles_after_restart_and_reopens_from_selected_root() {
        let (t, host, h, d) = fixture();
        let recovery = repository_core::RecoveryStore::open(t.path().join("recovery")).unwrap();
        let root = t.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let repo = Arc::new(Repository::open(&root).unwrap());
        let initial = repo
            .preview_literal_scene(
                None,
                Some("Project".into()),
                LiteralScene {
                    id: id(),
                    title: "First".into(),
                    path: "ms/first.md".into(),
                    text: "First unchanged".into(),
                },
                &recovery,
            )
            .unwrap();
        repo.apply_drafting(&initial, &recovery).unwrap();
        let before = repo.load_drafting().unwrap();
        let scene_id = id();
        let relative = "ms/chapter/scene.md";
        let plan = repo
            .preview_literal_scene(
                before.revision.as_deref(),
                None,
                LiteralScene {
                    id: scene_id.clone(),
                    title: "Nested".into(),
                    path: relative.into(),
                    text: d.text.clone(),
                },
                &recovery,
            )
            .unwrap();
        let target = Target::Existing(repo.clone(), plan.clone(), relative.into());
        let intent = placement_intent(&d, &target, scene_id);
        let store = host.store.as_ref().unwrap();
        store.intent(lease(&host, &h).unwrap(), &intent).unwrap();
        repo.apply_drafting(&plan, &recovery).unwrap();
        verify_intent(&intent).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join(relative)).unwrap(),
            d.text
        );
        drop(host);
        let store = DraftStore::open(t.path().join("isolated-drafts")).unwrap();
        let lease = store.acquire(&d.id).unwrap();
        let intents = store.pending(&d.id).unwrap();
        assert_eq!(intents.len(), 1);
        verify_intent(&intents[0]).unwrap();
        let kept = store.finish_placement(&lease, &intents[0]).unwrap();
        assert_eq!(kept.text, d.text);
        assert_eq!(kept.placements[0].project_root.as_deref(), root.to_str());
        assert_eq!(kept.placements[0].scene_path.as_deref(), Some(relative));
        assert_eq!(store.read(&d.id).unwrap().draft.placements, kept.placements);
        assert!(store.pending(&d.id).unwrap().is_empty());
        let location = current_placed_copy(&intents[0]).unwrap();
        assert_eq!(location.0, root);
        assert_eq!(location.1, relative);
        assert!(!location.2);
        assert_eq!(repo.load_drafting().unwrap().scenes.len(), 2);
        assert_eq!(
            std::fs::read_to_string(root.join("ms/first.md")).unwrap(),
            "First unchanged"
        );
    }
}
