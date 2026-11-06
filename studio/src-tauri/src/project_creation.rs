//! Explicit local project creation. Parent paths come only from the native picker.
use repository_core::{standalone_placement::DraftDestination, RecoveryStore};
use std::{path::Path, sync::atomic::Ordering};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
type Result<T> = std::result::Result<T, String>;

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.trim() != name
        || name.len() > 240
        || name.starts_with('.')
        || name.contains(['/', '\\', ':'])
        || name.chars().any(char::is_control)
    {
        return Err("Use a plain project name of up to 240 bytes, without slashes, colons, control characters, or a leading dot.".into());
    }
    Ok(())
}

pub(crate) fn open_error(error: repository_core::Error) -> String {
    use repository_core::Error;
    match error {
        Error::Io => "Could not read the selected folder. Check that it is available and Heinlein has permission to open it, then choose the folder again.".into(),
        Error::NotFound => "The selected folder no longer exists. Choose an existing folder, or use New project to create one.".into(),
        Error::NotDirectory => "Choose a folder rather than a file.".into(),
        Error::Denied => "The selected folder is excluded or uses a symbolic link. Choose its original writing folder.".into(),
        _ => error.to_string(),
    }
}

fn write_new_project(
    destination: &DraftDestination,
    name: &str,
    recovery: &RecoveryStore,
    guard: impl Fn() -> Result<()>,
) -> Result<()> {
    validate_name(name)?;
    guard()?;
    destination.write_project(
        name,
        "First scene",
        "first-scene.md",
        "",
        &crate::id(),
        recovery,
        guard,
    )
}

fn guard_destination(root: &Path, private: &Path) -> Result<()> {
    let private = crate::resolved_future_path(private)?;
    if root.starts_with(&private) || private.starts_with(root) {
        return Err("Choose a project location outside Heinlein's private app storage.".into());
    }
    Ok(())
}

fn creation_error(root: &Path, error: &str) -> String {
    format!("Could not confirm completion at {}: {error} The project may already have been created. Check this location before retrying; if the project exists, use Open an existing folder.", root.display())
}

pub(crate) fn create(
    app: &tauri::AppHandle,
    _window: &tauri::WebviewWindow,
    name: &str,
) -> Result<serde_json::Value> {
    validate_name(name)?;
    let state = app.state::<crate::BrowserState>();
    let _selection = state
        .selection_gate
        .try_lock()
        .map_err(|_| "Another project selection is in progress")?;
    let _mutation = state.mutation_gate.author_operation()?;
    let epoch = state.mutation_gate.generation();
    let guard = || {
        if state.quitting.load(Ordering::SeqCst)
            || state.unsaved_changes.load(Ordering::SeqCst)
            || state.mutation_gate.generation() != epoch
        {
            Err("Writing changed. Keep it on this Mac and choose New project again.".into())
        } else {
            Ok(())
        }
    };
    guard()?;
    #[cfg(target_os = "macos")]
    let parent = crate::proposals::parent::ValidatedConfirmationParent::capture(app, _window)?;
    let picker = app
        .dialog()
        .file()
        .set_title("Choose where to create the new project");
    #[cfg(target_os = "macos")]
    let picker = picker.set_parent(&parent);
    #[cfg(target_os = "macos")]
    parent.check_on_main(app)?;
    let Some(folder) = picker.blocking_pick_folder() else {
        return Ok(serde_json::Value::Null);
    };
    guard()?;
    let chosen = folder.into_path().map_err(|_| "Choose a local folder")?;
    let chosen = crate::resolved_future_path(&chosen)?;
    let root = chosen.join(name);
    let private = app
        .path()
        .app_data_dir()
        .map_err(|_| "Private storage unavailable")?;
    guard_destination(&root, &private)?;
    #[cfg(target_os = "macos")]
    crate::update::guard_repository(
        &root,
        &app.path().home_dir().map_err(|_| "Home unavailable")?,
    )?;
    // Capture the parent inode before confirmation. The writer checks it again
    // and publishes the complete scene+index with no-replace semantics.
    let destination = DraftDestination::open(&root)?;
    match std::fs::symlink_metadata(&root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Ok(_) => return Err("A file or folder with that name already exists. Choose another name, or open the existing folder. Nothing was overwritten.".into()),
        Err(_) => return Err("The project location cannot be checked. Choose an accessible parent folder.".into()),
    }
    let confirmation = app.dialog().message(format!("Create ‘{name}’ at {}?\n\nA new local folder with an empty first scene will be created. Your current writing stays in its original project. Nothing is sent to GitHub.", root.display())).title("New project").buttons(MessageDialogButtons::OkCancel);
    #[cfg(target_os = "macos")]
    let confirmation = confirmation.parent(&parent);
    #[cfg(target_os = "macos")]
    parent.check_on_main(app)?;
    if !confirmation.blocking_show() {
        return Ok(serde_json::Value::Null);
    }
    guard()?;
    let recovery = crate::recovery_store(app)?;
    write_new_project(&destination, name, &recovery, guard)
        .map_err(|error| creation_error(&root, &error))?;
    // A post-write activation error must say that creation already succeeded;
    // never encourage repeating the create operation or silently remove files.
    let session = guard().and_then(|()| crate::select(app, root.clone())).map_err(|error| format!("The project was created at {}, but could not be opened: {error} Use Open an existing folder to open it; do not create another copy.", root.display()))?;
    serde_json::to_value(session).map_err(|_| "The project was created, but its session could not be returned. Open its existing folder instead of creating another copy.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_plain_bounded_folder_names() {
        for name in [
            "",
            "..",
            ".hidden",
            "../escape",
            "a/b",
            "a\\b",
            "a:b",
            " a",
            "a ",
            "a\n",
            "a\u{85}",
        ] {
            assert!(validate_name(name).is_err(), "{name:?}");
        }
        assert!(validate_name(&"🦊".repeat(61)).is_err());
        for name in ["Novel", "稿件 — story", &"x".repeat(240)] {
            validate_name(name).unwrap();
        }
    }
    #[test]
    fn create_is_complete_empty_no_overwrite_and_cancellable() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        let recovery = RecoveryStore::open(parent.join("private-recovery")).unwrap();
        let target = DraftDestination::open(&parent.join("New story")).unwrap();
        assert!(
            write_new_project(&target, "New story", &recovery, || Err("canceled".into())).is_err()
        );
        assert!(!target.path().exists());
        write_new_project(&target, "New story", &recovery, || Ok(())).unwrap();
        let repo = repository_core::Repository::open(target.path()).unwrap();
        let state = repo.load_drafting().unwrap();
        assert!(!state.recovery_required);
        assert_eq!(state.scenes.len(), 1);
        assert_eq!(state.scenes[0].path, "ms/first-scene.md");
        assert_eq!(repo.read("ms/first-scene.md").unwrap().text, "");
        let manifest = std::fs::read(target.path().join("ms/manuscript.json")).unwrap();
        assert!(write_new_project(&target, "New story", &recovery, || Ok(())).is_err());
        assert_eq!(
            std::fs::read(target.path().join("ms/manuscript.json")).unwrap(),
            manifest
        );
    }
    #[test]
    fn private_and_symlink_destinations_are_not_adopted() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let private = root.join("private");
        std::fs::create_dir(&private).unwrap();
        assert!(guard_destination(&private.join("project"), &private).is_err());
        assert!(guard_destination(&root, &private).is_err());
        guard_destination(&root.join("writing"), &private).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&private, root.join("link")).unwrap();
            assert!(DraftDestination::open(&root.join("link/project")).is_err());
            let destination = DraftDestination::open(&root.join("link")).unwrap();
            let recovery = RecoveryStore::open(root.join("recovery")).unwrap();
            assert!(write_new_project(&destination, "link", &recovery, || Ok(())).is_err());
            assert_eq!(std::fs::read_dir(private).unwrap().count(), 0);
        }
    }
    #[test]
    fn uncertain_creation_names_the_destination_and_prevents_blind_retries() {
        let error = creation_error(Path::new("/synthetic/New story"), "Repository I/O failed");
        assert!(error.contains("/synthetic/New story"));
        assert!(error.contains("may already have been created"));
        assert!(error.contains("Check this location before retrying"));
        assert!(error.contains("Open an existing folder"));
    }
    #[test]
    fn opening_errors_do_not_claim_a_save_failed() {
        for error in [
            repository_core::Error::Io,
            repository_core::Error::NotFound,
            repository_core::Error::NotDirectory,
            repository_core::Error::Denied,
        ] {
            assert!(!open_error(error).contains("draft was not saved"));
        }
    }
}
