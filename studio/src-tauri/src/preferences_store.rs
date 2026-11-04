//! Fixed-location, versioned preferences. No manuscript, credential or arbitrary-path API.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub const MAX_BYTES: u64 = 4 * 1024 * 1024;
pub const KEYS: &[&str] = &[
    "heinlein-studio-appearance-v1",
    "heinlein-studio-fonts-v1",
    "heinlein-studio-zoom-v1",
    "heinlein-studio-navigation-v1",
    "heinlein-studio-collapsed-v1",
    "heinlein-studio-custom-theme-v1",
    "heinlein-studio-writing-v1",
    "heinlein-studio-sound-v1",
];
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u32,
    pub revision: u64,
    pub migrated: bool,
    pub values: BTreeMap<String, String>,
    // Preserve the original allowlisted payloads, including unreadable values, for recovery.
    pub legacy: BTreeMap<String, String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            migrated: false,
            values: BTreeMap::new(),
            legacy: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Load,
    Import {
        values: BTreeMap<String, String>,
    },
    Set {
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
        key: String,
        value: String,
    },
}
fn bounded(values: &BTreeMap<String, String>) -> Result<(), String> {
    if values.len() > KEYS.len()
        || values
            .iter()
            .any(|(k, v)| !KEYS.contains(&k.as_str()) || v.len() as u64 > MAX_BYTES / 2)
    {
        return Err("Unsupported or oversized preference. Existing settings are unchanged.".into());
    }
    Ok(())
}
fn load(root: &Path) -> Result<Snapshot, String> {
    let path = root.join("preferences-v1.json");
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Snapshot::default()),
        Ok(m) if m.is_file() && m.len() <= MAX_BYTES => (),
        _ => {
            return Err(
                "Saved preferences are unavailable or too large; they have not been replaced."
                    .into(),
            )
        }
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .and_then(|f| f.take(MAX_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| "Could not read saved preferences.")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Saved preferences exceed the limit.".into());
    }
    let value: Snapshot = serde_json::from_slice(&bytes)
        .map_err(|_| "Saved preferences need recovery; the original file is unchanged.")?;
    if value.schema_version != 1 {
        return Err(
            "These preferences were saved by a newer app. The original file is unchanged.".into(),
        );
    }
    Ok(value)
}
fn atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        File::open(path.parent().unwrap())?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
fn save(root: &Path, next: &Snapshot) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(next).map_err(|_| "Could not encode preferences.")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Preferences exceed the limit. Previous settings are unchanged.".into());
    }
    let path = root.join("preferences-v1.json");
    if path.exists() {
        let old = fs::read(&path).map_err(|_| "Could not back up preferences.")?;
        atomic(&root.join("preferences-v1.previous.json"), &old)
            .map_err(|_| "Could not back up preferences. Previous settings are unchanged.")?;
    }
    atomic(&path,&bytes).map_err(|_|"Could not save preferences. Keep this window open and retry; the last saved copy is retained.".into())
}
pub fn request(root: &Path, request: Request) -> Result<Snapshot, String> {
    fs::create_dir_all(root).map_err(|_| "Preference storage is unavailable.")?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    }
    let lock = options
        .open(root.join("preferences-v1.lock"))
        .map_err(|_| "Could not lock preferences.")?;
    // OS locks release on crash/restart; no stale lock-file deletion or reset is needed.
    lock.lock().map_err(|_| "Could not lock preferences.")?;
    let mut snapshot = load(root)?;
    match request {
        Request::Load => return Ok(snapshot),
        Request::Import { values } => {
            bounded(&values)?;
            if snapshot.migrated {
                return Ok(snapshot);
            }
            snapshot.legacy = values.clone();
            for (key, value) in values {
                snapshot.values.entry(key).or_insert(value);
            }
            snapshot.migrated = true;
        }
        Request::Set {
            expected_revision,
            key,
            value,
        } => {
            bounded(&BTreeMap::from([(key.clone(), value.clone())]))?;
            if expected_revision.checked_add(1) == Some(snapshot.revision)
                && snapshot.values.get(&key) == Some(&value)
            {
                return Ok(snapshot);
            }
            if expected_revision != snapshot.revision {
                return Err("Settings changed in another window. Reopen the app before changing settings again.".into());
            }
            snapshot.values.insert(key, value);
        }
    }
    snapshot.revision = snapshot
        .revision
        .checked_add(1)
        .ok_or("Preference revision exhausted.")?;
    save(root, &snapshot)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "heinlein-studio-zoom-v1";
    fn set(root: &Path, revision: u64, value: &str) -> Result<Snapshot, String> {
        request(
            root,
            Request::Set {
                expected_revision: revision,
                key: KEY.into(),
                value: value.into(),
            },
        )
    }
    #[test]
    fn migration_is_atomic_idempotent_and_native_values_win() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        let one = set(r, 0, "175").unwrap();
        let imported = request(
            r,
            Request::Import {
                values: BTreeMap::from([
                    (KEY.into(), "150".into()),
                    ("heinlein-studio-writing-v1".into(), "{broken legacy".into()),
                ]),
            },
        )
        .unwrap();
        assert_eq!(imported.values[KEY], "175");
        assert_eq!(imported.legacy[KEY], "150");
        assert_eq!(
            request(
                r,
                Request::Import {
                    values: BTreeMap::new()
                }
            )
            .unwrap(),
            imported
        );
        assert_eq!(request(r, Request::Load).unwrap(), imported);
        assert_eq!(
            serde_json::from_slice::<Snapshot>(
                &fs::read(r.join("preferences-v1.previous.json")).unwrap()
            )
            .unwrap(),
            one
        );
    }
    #[test]
    fn app_replacement_and_missing_webkit_profile_keep_choices_and_progress() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path().join("profile");
        let app = t.path().join("App.app");
        fs::create_dir(&app).unwrap();
        let initial = request(
            &r,
            Request::Import {
                values: BTreeMap::from([
                    (KEY.into(), "150".into()),
                    (
                        "heinlein-studio-writing-v1".into(),
                        r#"{"version":1,"goal":1000,"days":{}}"#.into(),
                    ),
                ]),
            },
        )
        .unwrap();
        fs::remove_dir(&app).unwrap();
        fs::create_dir(&app).unwrap();
        assert_eq!(request(&r, Request::Load).unwrap(), initial);
        assert_eq!(
            request(
                &r,
                Request::Import {
                    values: BTreeMap::new()
                }
            )
            .unwrap(),
            initial
        );
    }
    #[test]
    fn conflicts_corruption_future_versions_and_unknown_keys_preserve_disk() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        let one = set(r, 0, "150").unwrap();
        assert!(set(r, 0, "200").is_err());
        assert_eq!(request(r, Request::Load).unwrap(), one);
        assert!(request(
            r,
            Request::Set {
                expected_revision: 1,
                key: "chatgpt-auth".into(),
                value: "secret".into()
            }
        )
        .is_err());
        for raw in [
            "broken",
            r#"{"schemaVersion":2,"revision":1,"migrated":true,"values":{},"legacy":{}}"#,
        ] {
            fs::write(r.join("preferences-v1.json"), raw).unwrap();
            assert!(set(r, 1, "200").is_err());
            assert_eq!(
                fs::read_to_string(r.join("preferences-v1.json")).unwrap(),
                raw
            );
        }
    }
    #[test]
    fn backup_failure_and_oversized_write_preserve_last_good_settings() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        set(r, 0, "150").unwrap();
        let before = fs::read(r.join("preferences-v1.json")).unwrap();
        assert!(set(r, 1, &"x".repeat(MAX_BYTES as usize)).is_err());
        fs::create_dir(r.join("preferences-v1.previous.json")).unwrap();
        assert!(set(r, 1, "200").is_err());
        assert_eq!(fs::read(r.join("preferences-v1.json")).unwrap(), before);
        assert!(!fs::read_dir(r).unwrap().any(|p| p
            .unwrap()
            .path()
            .extension()
            .is_some_and(|x| x == "tmp")));
    }
    #[test]
    fn unknown_fields_survive_supported_schema_updates() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        let mut one = set(r, 0, "150").unwrap();
        one.extra
            .insert("futureChoice".into(), serde_json::json!({"keep":true}));
        save(r, &one).unwrap();
        assert_eq!(set(r, 1, "200").unwrap().extra, one.extra);
    }
    #[test]
    fn retry_after_an_uncertain_response_is_idempotent_and_concurrent_writes_do_not_clobber() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        let first = set(r, 0, "150").unwrap();
        assert_eq!(set(r, 0, "150").unwrap(), first);
        let threads: Vec<_> = ["175", "200"]
            .into_iter()
            .map(|value| {
                let root = r.to_path_buf();
                std::thread::spawn(move || set(&root, 1, value))
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(request(r, Request::Load).unwrap().revision, 2);
    }
}
