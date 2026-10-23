use crate::id;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_PREFERENCES_BYTES: usize = 65536;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recent {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: PathBuf,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentStore {
    pub(crate) schema_version: u32,
    pub(crate) folders: Vec<Recent>,
}
pub(crate) fn load_recents(path: &Path) -> RecentStore {
    // Recent paths are convenience preferences, never arbitrary renderer-supplied paths.
    let result = fs::metadata(path)
        .ok()
        .filter(|m| m.len() < MAX_PREFERENCES_BYTES as u64)
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
pub(crate) fn save_recents(path: &Path, store: &RecentStore) -> Result<(), String> {
    save_recents_with(path, store, |path, content| fs::write(path, content))
}

// Permit deterministic partial-write failures without platform permission assumptions.
fn save_recents_with(
    path: &Path,
    store: &RecentStore,
    write: impl FnOnce(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), String> {
    let content = serde_json::to_vec(store).map_err(|e| e.to_string())?;
    // Never replace preferences with data that the next startup would discard.
    if content.len() >= MAX_PREFERENCES_BYTES {
        return Err("Recent-folder preferences exceed the size limit".into());
    }
    fs::create_dir_all(path.parent().ok_or("Missing preferences directory")?)
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", id()));
    let result = write(&temporary, &content).and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        // A failed write may have left partial data; a failed rename leaves the whole file.
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn store(name: &str) -> RecentStore {
        RecentStore {
            schema_version: 1,
            folders: vec![Recent {
                id: "opaque-folder-id".into(),
                name: name.into(),
                path: PathBuf::from("/synthetic/稿件 manuscript"),
            }],
        }
    }
    fn snapshot(store: &RecentStore) -> serde_json::Value {
        serde_json::to_value(store).unwrap()
    }
    fn assert_empty(store: RecentStore) {
        assert_eq!(store.schema_version, 1);
        assert!(store.folders.is_empty());
    }
    #[test]
    fn missing_or_non_file_preferences_are_empty_without_creating_files() {
        let temp = TempDir::new().unwrap();
        let missing = temp.path().join("missing/preferences.json");
        assert_empty(load_recents(&missing));
        assert!(!missing.parent().unwrap().exists());
        assert_empty(load_recents(temp.path()));
    }
    #[test]
    fn malformed_or_unsupported_preferences_are_empty_and_unchanged() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("recents.json");
        for content in [
            vec![],
            b"{".to_vec(),
            vec![0xff],
            b"null".to_vec(),
            b"[]".to_vec(),
            br#"{"schemaVersion":1}"#.to_vec(),
            br#"{"schemaVersion":"1","folders":[]}"#.to_vec(),
            br#"{"schemaVersion":1,"folders":[{"id":"x","name":"x"}]}"#.to_vec(),
            br#"{"schemaVersion":0,"folders":[]}"#.to_vec(),
            br#"{"schemaVersion":2,"folders":[]}"#.to_vec(),
        ] {
            fs::write(&path, &content).unwrap();
            assert_empty(load_recents(&path));
            assert_eq!(fs::read(&path).unwrap(), content);
        }
    }
    #[test]
    fn version_one_accepts_unknown_fields_and_caps_folders_in_order() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("recents.json");
        let folders: Vec<_> = (0..12)
            .map(|i| {
                json!({
                    "id": format!("opaque-{i}"), "name": format!("Folder {i}"),
                    "path": format!("/synthetic/{i}"), "futureField": true,
                })
            })
            .collect();
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schemaVersion": 1, "folders": folders, "futureField": true,
            }))
            .unwrap(),
        )
        .unwrap();
        let loaded = load_recents(&path);
        assert_eq!(loaded.schema_version, 1);
        assert_eq!(loaded.folders.len(), 10);
        assert_eq!(loaded.folders.first().unwrap().id, "opaque-0");
        assert_eq!(loaded.folders.last().unwrap().id, "opaque-9");
    }
    #[test]
    fn loader_enforces_existing_exclusive_64k_limit() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("recents.json");
        let expected = store("A valid saved folder");
        let mut bytes = serde_json::to_vec(&expected).unwrap();
        bytes.resize(65535, b' ');
        fs::write(&path, &bytes).unwrap();
        assert_eq!(snapshot(&load_recents(&path)), snapshot(&expected));
        for size in [65536, 70000] {
            bytes.resize(size, b' ');
            fs::write(&path, &bytes).unwrap();
            assert_empty(load_recents(&path));
            assert_eq!(fs::metadata(&path).unwrap().len(), size as u64);
        }
    }
    #[test]
    fn round_trip_creates_parents_then_replaces_existing_preferences() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("private/nested/recents.json");
        for name in ["First manuscript", "稿件 — revised title"] {
            let expected = store(name);
            save_recents(&path, &expected).unwrap();
            assert_eq!(snapshot(&load_recents(&path)), snapshot(&expected));
            assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        }
    }
    #[test]
    fn readers_see_complete_old_preferences_until_successful_rename() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("recents.json");
        let old = store("old");
        let new = store("new");
        save_recents(&path, &old).unwrap();
        save_recents_with(&path, &new, |temporary, content| {
            fs::write(temporary, content)?;
            assert_eq!(snapshot(&load_recents(&path)), snapshot(&old));
            Ok(())
        })
        .unwrap();
        assert_eq!(snapshot(&load_recents(&path)), snapshot(&new));
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
    #[test]
    fn save_and_load_share_the_exact_size_boundary() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("recents.json");
        let mut expected = store("");
        let overhead = serde_json::to_vec(&expected).unwrap().len();
        expected.folders[0].name = "x".repeat(65535 - overhead);
        save_recents(&path, &expected).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), 65535);
        assert_eq!(snapshot(&load_recents(&path)), snapshot(&expected));
        expected.folders[0].name.push('x');
        assert!(save_recents(&path, &expected).is_err());
        expected.folders[0].name.pop();
        assert_eq!(snapshot(&load_recents(&path)), snapshot(&expected));
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
    #[test]
    fn parent_creation_failure_does_not_change_existing_data() {
        let temp = TempDir::new().unwrap();
        let blocker = temp.path().join("not-a-directory");
        fs::write(&blocker, b"keep this file").unwrap();
        assert!(save_recents(&blocker.join("recents.json"), &store("new")).is_err());
        assert_eq!(fs::read(&blocker).unwrap(), b"keep this file");
    }
    #[test]
    fn partial_write_failure_preserves_old_file_and_removes_temporary() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("recents.json");
        save_recents(&path, &store("old")).unwrap();
        let old = fs::read(&path).unwrap();
        let result = save_recents_with(&path, &store("new"), |temporary, content| {
            fs::write(temporary, &content[..content.len() / 2])?;
            // Readers still see the complete old data until rename.
            assert_eq!(fs::read(&path).unwrap(), old);
            Err(std::io::Error::other("injected partial write failure"))
        });
        assert!(result.unwrap_err().contains("injected partial write"));
        assert_eq!(fs::read(&path).unwrap(), old);
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
    #[test]
    fn rename_failure_preserves_destination_and_removes_temporary() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("recents.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("sentinel"), b"keep directory").unwrap();
        assert!(save_recents(&path, &store("new")).is_err());
        assert_eq!(fs::read(path.join("sentinel")).unwrap(), b"keep directory");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
    #[test]
    fn oversized_save_is_rejected_without_destroying_reloadable_preferences() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("recents.json");
        save_recents(&path, &store("old")).unwrap();
        let old = fs::read(&path).unwrap();
        assert!(save_recents(&path, &store(&"x".repeat(65536))).is_err());
        assert_eq!(fs::read(&path).unwrap(), old);
        assert_eq!(load_recents(&path).folders[0].name, "old");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
}
