//! Real native repositories and preferences; no windows or user data.
use super::*;
use std::fs;
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    preferences: PathBuf,
    private_storage: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        // macOS /var is a symlink; Repository rejects symlinked roots.
        let root = temp.path().canonicalize().unwrap();
        Self {
            preferences: root.join("preferences/recents.json"),
            private_storage: root.join("private-auth"),
            root,
            _temp: temp,
        }
    }
    fn state(&self) -> BrowserState {
        BrowserState {
            recents: Mutex::new(load_recents(&self.preferences)),
            ..BrowserState::default()
        }
    }
    fn repository(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        fs::create_dir(&path).unwrap();
        fs::write(path.join("scene.md"), b"Synthetic manuscript.\n").unwrap();
        path
    }
    fn select(&self, state: &BrowserState, path: &Path) -> Result<Session, String> {
        select_repository(
            state,
            path.to_path_buf(),
            &self.preferences,
            &self.private_storage,
        )
    }
}
fn recents_json(state: &BrowserState) -> serde_json::Value {
    serde_json::to_value(&*state.recents.lock().unwrap()).unwrap()
}
#[test]
fn restart_reloads_recents_then_reopens_only_by_opaque_id() {
    let fixture = Fixture::new();
    let repository = fixture.repository("稿件 — manuscript");
    let state = fixture.state();
    let first = fixture.select(&state, &repository).unwrap();
    let recent_id = state.recents.lock().unwrap().folders[0].id.clone();
    let saved = recents_json(&state);
    drop(state);
    let restarted = BrowserState {
        recents: Mutex::new(load_recents(&fixture.preferences)),
        ..BrowserState::default()
    };
    assert!(restarted.selected.lock().unwrap().is_none());
    assert_eq!(recents_json(&restarted), saved);
    for unknown in [
        "unknown",
        "",
        "../manuscript",
        repository.to_str().unwrap(),
        &first.id,
    ] {
        assert!(recent_repository_path(&restarted, unknown).is_err());
    }
    assert!(restarted.selected.lock().unwrap().is_none());
    let path = recent_repository_path(&restarted, &recent_id).unwrap();
    assert_eq!(path, repository);
    let second = fixture.select(&restarted, &path).unwrap();
    assert_eq!(first.project_key, second.project_key);
    assert_ne!(first.id, second.id);
    let selected = restarted.selected.lock().unwrap();
    assert_eq!(selected.as_ref().unwrap().id, second.id);
    assert_eq!(selected.as_ref().unwrap().repo.root(), repository);
    assert!(recent_repository_path(&restarted, &recent_id).is_err());
    assert_eq!(
        fs::read(repository.join("scene.md")).unwrap(),
        b"Synthetic manuscript.\n"
    );
    assert!(!fixture.private_storage.exists());
}
#[test]
fn repeated_selection_deduplicates_moves_to_front_and_caps_persisted_recents() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let mut paths = Vec::new();
    for i in 0..12 {
        let path = fixture.repository(&format!("repository-{i}"));
        fixture.select(&state, &path).unwrap();
        paths.push(path);
    }
    fixture.select(&state, &paths[5]).unwrap();
    let store = load_recents(&fixture.preferences);
    assert_eq!(store.folders.len(), 10);
    assert_eq!(store.folders[0].path, paths[5]);
    assert_eq!(
        store.folders.iter().filter(|r| r.path == paths[5]).count(),
        1
    );
    assert!(!store.folders.iter().any(|r| r.path == paths[0]));
    assert_eq!(serde_json::to_value(store).unwrap(), recents_json(&state));
}
#[test]
fn persist_failure_leaves_selected_root_session_recents_and_disk_unchanged() {
    let fixture = Fixture::new();
    let old_root = fixture.repository("old-root");
    let new_root = fixture.repository("new-root");
    let state = fixture.state();
    let old_session = fixture.select(&state, &old_root).unwrap();
    let old_recents = recents_json(&state);
    let old_disk = fs::read(&fixture.preferences).unwrap();
    let blocked = fixture.root.join("blocked.json");
    fs::create_dir(&blocked).unwrap();
    fs::write(blocked.join("sentinel"), b"keep").unwrap();
    assert!(select_repository(&state, new_root, &blocked, &fixture.private_storage).is_err());
    let selected = state.selected.lock().unwrap();
    assert_eq!(selected.as_ref().unwrap().id, old_session.id);
    assert_eq!(selected.as_ref().unwrap().repo.root(), old_root);
    assert_eq!(recents_json(&state), old_recents);
    assert_eq!(fs::read(&fixture.preferences).unwrap(), old_disk);
    assert_eq!(fs::read(blocked.join("sentinel")).unwrap(), b"keep");
}
#[test]
fn initial_persist_failure_does_not_select_a_root() {
    let fixture = Fixture::new();
    let repository = fixture.repository("new-root");
    let state = fixture.state();
    let blocker = fixture.root.join("file");
    fs::write(&blocker, b"keep").unwrap();
    assert!(select_repository(
        &state,
        repository,
        &blocker.join("recents.json"),
        &fixture.private_storage
    )
    .is_err());
    assert!(state.selected.lock().unwrap().is_none());
    assert!(state.recents.lock().unwrap().folders.is_empty());
    assert_eq!(fs::read(blocker).unwrap(), b"keep");
}
#[test]
fn vanished_recent_root_does_not_replace_existing_selection_or_preferences() {
    let fixture = Fixture::new();
    let old_root = fixture.repository("old-root");
    let vanished = fixture.repository("vanished");
    let state = fixture.state();
    fixture.select(&state, &vanished).unwrap();
    let recent_id = state.recents.lock().unwrap().folders[0].id.clone();
    let old_session = fixture.select(&state, &old_root).unwrap();
    let old_recents = recents_json(&state);
    let old_disk = fs::read(&fixture.preferences).unwrap();
    fs::remove_dir_all(&vanished).unwrap();
    let path = recent_repository_path(&state, &recent_id).unwrap();
    assert!(fixture.select(&state, &path).is_err());
    assert_eq!(
        state.selected.lock().unwrap().as_ref().unwrap().id,
        old_session.id
    );
    assert_eq!(recents_json(&state), old_recents);
    assert_eq!(fs::read(&fixture.preferences).unwrap(), old_disk);
}

#[test]
fn size_limit_failure_does_not_commit_new_selection_or_in_memory_recents() {
    let fixture = Fixture::new();
    let old_root = fixture.repository("old-root");
    let new_root = fixture.repository("new-root");
    let state = fixture.state();
    let old_session = fixture.select(&state, &old_root).unwrap();
    // Valid v1 preferences at the loader limit leave no room for another entry.
    {
        let mut recents = state.recents.lock().unwrap();
        let length = serde_json::to_vec(&*recents).unwrap().len();
        recents.folders[0]
            .name
            .push_str(&"x".repeat(65535 - length));
        save_recents(&fixture.preferences, &recents).unwrap();
    }
    let old_recents = recents_json(&state);
    let old_disk = fs::read(&fixture.preferences).unwrap();
    assert_eq!(old_disk.len(), 65535);
    let error = fixture.select(&state, &new_root).err().unwrap();
    assert!(error.contains("size limit"));
    let selected = state.selected.lock().unwrap();
    assert_eq!(selected.as_ref().unwrap().id, old_session.id);
    assert_eq!(selected.as_ref().unwrap().repo.root(), old_root);
    assert_eq!(recents_json(&state), old_recents);
    assert_eq!(fs::read(&fixture.preferences).unwrap(), old_disk);
    assert_eq!(
        serde_json::to_value(load_recents(&fixture.preferences)).unwrap(),
        old_recents
    );
}
