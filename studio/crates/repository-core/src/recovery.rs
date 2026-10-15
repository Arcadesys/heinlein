//! Host-private crash-recovery snapshots. This is not a manuscript revision ledger.
#[cfg(unix)]
use crate::{content_hash, MAX_FILE_BYTES};
use crate::{Error, Repository, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use {
    rustix::fs::{
        flock, mkdirat, open, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags,
    },
    std::{
        collections::HashMap,
        fs::File,
        io::{Read, Write},
        os::unix::fs::MetadataExt,
        sync::Mutex,
        time::{SystemTime, UNIX_EPOCH},
    },
};

// JSON can expand a byte to six escape bytes. The text itself remains bounded at 2 MiB.
#[cfg(unix)]
const MAX_RECORD_BYTES: u64 = MAX_FILE_BYTES * 6 + 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryDraft {
    pub id: String,
    pub path: String,
    pub base_hash: String,
    pub text: String,
    /// Unix milliseconds, not a revision ordering or conflict token.
    pub updated_at: u64,
    pub actor: String,
    pub client: String,
}
#[cfg(unix)]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u32,
    repository_key: String,
    draft: RecoveryDraft,
}

/// Only the trusted native host supplies this directory. No path crosses renderer IPC.
/// The directory must be private, outside the repository, and on a local Unix filesystem.
pub struct RecoveryStore {
    #[cfg(unix)]
    path: PathBuf,
    #[cfg(unix)]
    directory: File,
    #[cfg(unix)]
    gate: Mutex<()>,
    #[cfg(unix)]
    ownership: Mutex<HashMap<String, SceneOwnership>>,
}

#[cfg(unix)]
fn markdown(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|v| v.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown")
    )
}
#[cfg(unix)]
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[cfg(unix)]
fn valid_text(text: &str) -> Result<()> {
    if text.len() as u64 > MAX_FILE_BYTES {
        return Err(Error::TooLarge);
    }
    if text
        .bytes()
        .any(|b| b == 0 || (b < 32 && !matches!(b, 9 | 10 | 13)))
    {
        return Err(Error::UnsupportedText);
    }
    Ok(())
}

#[cfg(unix)]
struct SceneOwnership {
    // Retain the descriptor to keep the process-lifetime advisory lock held.
    _file: File,
    observed: bool,
}

#[cfg(unix)]
struct StoreLock<'a>(&'a File);
#[cfg(unix)]
impl Drop for StoreLock<'_> {
    fn drop(&mut self) {
        let _ = flock(self.0, FlockOperation::Unlock);
    }
}

impl RecoveryStore {
    #[cfg(unix)]
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path: PathBuf = path.as_ref().components().collect();
        let directory = open_directory(&path, true)?;
        private_metadata(&directory, true)?;
        let path = path.canonicalize().map_err(|_| Error::RecoveryIo)?;
        let store = Self {
            path,
            directory,
            gate: Mutex::new(()),
            ownership: Mutex::new(HashMap::new()),
        };
        // Incomplete temporary snapshots are never promoted. A crash before rename
        // leaves the previous complete record authoritative; clean only our temp names.
        let _gate = store.gate.lock().map_err(|_| Error::RecoveryIo)?;
        let _lock = store.lock()?;
        store.remove_abandoned_temporaries()?;
        drop(_lock);
        drop(_gate);
        Ok(store)
    }
    #[cfg(not(unix))]
    pub fn open(_path: impl AsRef<Path>) -> Result<Self> {
        Err(Error::UnsupportedPlatform)
    }

    #[cfg(unix)]
    fn lock(&self) -> Result<StoreLock<'_>> {
        flock(&self.directory, FlockOperation::LockExclusive).map_err(|_| Error::RecoveryIo)?;
        Ok(StoreLock(&self.directory))
    }
    #[cfg(unix)]
    fn check_directory(&self) -> Result<()> {
        private_metadata(&self.directory, true)?;
        let resolved = open_directory(&self.path, false)?;
        private_metadata(&resolved, true)?;
        let held = self.directory.metadata().map_err(|_| Error::RecoveryIo)?;
        let current = resolved.metadata().map_err(|_| Error::RecoveryIo)?;
        if (held.dev(), held.ino()) != (current.dev(), current.ino()) {
            return Err(Error::RecoveryIo);
        }
        Ok(())
    }
    #[cfg(unix)]
    fn key(&self, repo: &Repository, path: &str) -> Result<String> {
        repo.allowed(path, false)?;
        if !markdown(path) {
            return Err(Error::ReadOnly);
        }
        if self.path.starts_with(repo.root()) {
            return Err(Error::RecoveryIo);
        }
        // Root and path are independently bounded and separated unambiguously.
        Ok(format!(
            "{}.json",
            content_hash(&format!("{}\n{path}", repo.project_key()))
        ))
    }
    #[cfg(unix)]
    fn own_scene(&self, key: &str) -> Result<bool> {
        let mut ownership = self.ownership.lock().map_err(|_| Error::RecoveryIo)?;
        if let Some(owner) = ownership.get(key) {
            return Ok(owner.observed);
        }
        if ownership.len() >= crate::MAX_ENTRIES {
            return Err(Error::LimitExceeded);
        }
        // Keep these stable lock names even after deleting a snapshot: unlinking a
        // held lock would let a new inode create two simultaneous owners.
        let name = format!(".heinlein-owner-{key}.lock");
        let fd = openat(
            &self.directory,
            name.as_str(),
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| Error::RecoveryIo)?;
        let file = File::from(fd);
        private_metadata(&file, false)?;
        if file.metadata().map_err(|_| Error::RecoveryIo)?.len() != 0 {
            return Err(Error::RecoveryIo);
        }
        flock(&file, FlockOperation::NonBlockingLockExclusive).map_err(|error| {
            if error == rustix::io::Errno::WOULDBLOCK {
                Error::RecoveryBusy
            } else {
                Error::RecoveryIo
            }
        })?;
        ownership.insert(
            key.into(),
            SceneOwnership {
                _file: file,
                observed: false,
            },
        );
        Ok(false)
    }
    #[cfg(unix)]
    fn mark_observed(&self, key: &str) -> Result<()> {
        self.ownership
            .lock()
            .map_err(|_| Error::RecoveryIo)?
            .get_mut(key)
            .ok_or(Error::RecoveryIo)?
            .observed = true;
        Ok(())
    }
    #[cfg(unix)]
    fn validate_source(repo: &Repository, path: &str) -> Result<()> {
        repo.require_clean_structure()?;
        repo.check_write_manifests(path)?;
        let source = repo.read(path)?;
        if source.generated_compatibility {
            return Err(Error::ReadOnly);
        }
        Ok(())
    }

    // Native-private provenance for an exact structural transaction journal. The
    // repo-local journal alone never grants authority to restore arbitrary bytes.
    #[cfg(unix)]
    pub(crate) fn write_structure_receipt_locked(
        &self,
        repo: &Repository,
        hash: &str,
    ) -> Result<()> {
        self.check_directory()?;
        let name = format!(".heinlein-structure-{}.json", repo.project_key());
        let temporary = format!(".heinlein-recovery-{}.tmp", uuid::Uuid::new_v4());
        let fd = openat(
            &self.directory,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| Error::RecoveryIo)?;
        let mut file = File::from(fd);
        let result = (|| {
            file.write_all(hash.as_bytes())
                .map_err(|_| Error::RecoveryIo)?;
            file.sync_all().map_err(|_| Error::RecoveryIo)?;
            renameat(
                &self.directory,
                temporary.as_str(),
                &self.directory,
                name.as_str(),
            )
            .map_err(|_| Error::RecoveryIo)?;
            self.directory
                .sync_all()
                .map_err(|_| Error::RecoveryUncertain)
        })();
        let _ = unlinkat(&self.directory, temporary.as_str(), AtFlags::empty());
        result
    }
    #[cfg(unix)]
    pub(crate) fn verify_structure_receipt(&self, repo: &Repository, hash: &str) -> Result<()> {
        let _gate = self.gate.lock().map_err(|_| Error::RecoveryIo)?;
        let _lock = self.lock()?;
        self.verify_structure_receipt_locked(repo, hash)
    }
    #[cfg(unix)]
    pub(crate) fn verify_structure_receipt_locked(
        &self,
        repo: &Repository,
        hash: &str,
    ) -> Result<()> {
        self.check_directory()?;
        let name = format!(".heinlein-structure-{}.json", repo.project_key());
        let fd = openat(
            &self.directory,
            name.as_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| Error::UntrustedTransaction)?;
        let file = File::from(fd);
        private_metadata(&file, false).map_err(|_| Error::UntrustedTransaction)?;
        let mut bytes = String::new();
        file.take(65)
            .read_to_string(&mut bytes)
            .map_err(|_| Error::UntrustedTransaction)?;
        if !valid_hash(hash) || bytes != hash {
            return Err(Error::UntrustedTransaction);
        }
        Ok(())
    }
    #[cfg(not(unix))]
    pub(crate) fn verify_structure_receipt(&self, _repo: &Repository, _hash: &str) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
    #[cfg(unix)]
    pub(crate) fn clear_structure_receipt_locked(&self, repo: &Repository) -> Result<()> {
        let name = format!(".heinlein-structure-{}.json", repo.project_key());
        unlinkat(&self.directory, name.as_str(), AtFlags::empty())
            .map_err(|_| Error::RecoveryIo)?;
        self.directory
            .sync_all()
            .map_err(|_| Error::RecoveryUncertain)
    }

    #[cfg(unix)]
    pub(crate) fn with_owned_scene<T>(
        &self,
        repo: &Repository,
        path: &str,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let _gate = self.gate.lock().map_err(|_| Error::RecoveryIo)?;
        let _lock = self.lock()?;
        self.check_directory()?;
        let key = self.key(repo, path)?;
        let observed = self.own_scene(&key)?;
        if self.read_record(repo, path, &key)?.is_some() && !observed {
            return Err(Error::RecoveryChanged);
        }
        // Ownership remains held by the store; snapshot storage locks do not.
        // Newer recovery must be able to stage while manuscript fsync is pending.
        drop(_lock);
        drop(_gate);
        operation()
    }
    #[cfg(not(unix))]
    pub(crate) fn with_owned_scene<T>(
        &self,
        _repo: &Repository,
        _path: &str,
        _operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        Err(Error::UnsupportedPlatform)
    }

    /// Serialize structural changes with staging, claiming every old and new path.
    /// Pending snapshots are never silently moved, discarded, or orphaned.
    #[cfg(unix)]
    pub fn with_clean_paths<T>(
        &self,
        repo: &Repository,
        paths: &[String],
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let _gate = self.gate.lock().map_err(|_| Error::RecoveryIo)?;
        let _lock = self.lock()?;
        self.check_directory()?;
        for path in paths {
            let key = self.key(repo, path)?;
            self.own_scene(&key)?;
            if self.read_record(repo, path, &key)?.is_some() {
                return Err(Error::PendingRecovery);
            }
            self.mark_observed(&key)?;
        }
        operation()
    }
    #[cfg(not(unix))]
    pub fn with_clean_paths<T>(
        &self,
        _repo: &Repository,
        _paths: &[String],
        _operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        Err(Error::UnsupportedPlatform)
    }

    /// Claim the scene before returning recovery or absence, so only one Studio
    /// instance may expose editable text. Reading never applies the snapshot.
    #[cfg(unix)]
    pub fn read(&self, repo: &Repository, path: &str) -> Result<Option<RecoveryDraft>> {
        let _gate = self.gate.lock().map_err(|_| Error::RecoveryIo)?;
        let _lock = self.lock()?;
        self.check_directory()?;
        let key = self.key(repo, path)?;
        self.own_scene(&key)?;
        let draft = self.read_record(repo, path, &key)?;
        self.mark_observed(&key)?;
        Ok(draft)
    }
    #[cfg(not(unix))]
    pub fn read(&self, _repo: &Repository, _path: &str) -> Result<Option<RecoveryDraft>> {
        Err(Error::UnsupportedPlatform)
    }

    /// Preserve the exact buffer before save. A stale base hash is intentional: its
    /// mismatch must stop manuscript saving, not erase the author's recovery text.
    #[cfg(unix)]
    pub fn stage(
        &self,
        repo: &Repository,
        path: &str,
        expected_hash: &str,
        text: &str,
    ) -> Result<RecoveryDraft> {
        let _gate = self.gate.lock().map_err(|_| Error::RecoveryIo)?;
        let _lock = self.lock()?;
        self.stage_inner(repo, path, expected_hash, text, || Ok(()))
    }
    #[cfg(not(unix))]
    pub fn stage(
        &self,
        _repo: &Repository,
        _path: &str,
        _expected_hash: &str,
        _text: &str,
    ) -> Result<RecoveryDraft> {
        Err(Error::UnsupportedPlatform)
    }
    #[cfg(unix)]
    fn stage_inner(
        &self,
        repo: &Repository,
        path: &str,
        expected_hash: &str,
        text: &str,
        before_commit: impl FnOnce() -> Result<()>,
    ) -> Result<RecoveryDraft> {
        self.check_directory()?;
        let key = self.key(repo, path)?;
        valid_text(text)?;
        if !valid_hash(expected_hash) {
            return Err(Error::InvalidRecovery);
        }
        Self::validate_source(repo, path)?;
        let observed = self.own_scene(&key)?;
        // A newly available lock is not consent to replace an earlier owner's
        // recovery. Retry Save must first read/show that snapshot after a crash.
        // The flag stays false across failed retries until read succeeds.
        let previous = self.read_record(repo, path, &key)?;
        if previous.is_some() && !observed {
            return Err(Error::RecoveryChanged);
        }
        // Do not overwrite damaged/unrecognized recovery records silently.
        let draft = RecoveryDraft {
            id: uuid::Uuid::new_v4().to_string(),
            path: path.into(),
            base_hash: expected_hash.into(),
            text: text.into(),
            updated_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::RecoveryIo)?
                .as_millis()
                .try_into()
                .map_err(|_| Error::RecoveryIo)?,
            actor: "author".into(),
            client: "studio".into(),
        };
        let record = Record {
            schema_version: 1,
            repository_key: repo.project_key(),
            draft: draft.clone(),
        };
        let bytes = serde_json::to_vec(&record).map_err(|_| Error::InvalidRecovery)?;
        let temporary = format!(".heinlein-recovery-{}.tmp", uuid::Uuid::new_v4());
        let fd = openat(
            &self.directory,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| Error::RecoveryIo)?;
        let mut file = File::from(fd);
        let result = (|| {
            file.write_all(&bytes).map_err(|_| Error::RecoveryIo)?;
            file.sync_all().map_err(|_| Error::RecoveryIo)?;
            before_commit()?;
            self.check_directory()?;
            // Rechecking these guards does not compare the source hash.
            repo.allowed(path, false)?;
            Self::validate_source(repo, path)?;
            self.read_record(repo, path, &key)?;
            renameat(
                &self.directory,
                temporary.as_str(),
                &self.directory,
                key.as_str(),
            )
            .map_err(|_| Error::RecoveryIo)?;
            self.directory
                .sync_all()
                .map_err(|_| Error::RecoveryUncertain)?;
            Ok(draft)
        })();
        let _ = unlinkat(&self.directory, temporary.as_str(), AtFlags::empty());
        if result.is_ok() {
            self.mark_observed(&key)?;
        }
        result
    }

    /// Compare-and-delete. An old save completion cannot remove a newer snapshot.
    #[cfg(unix)]
    pub fn discard(&self, repo: &Repository, path: &str, recovery_id: &str) -> Result<()> {
        let _gate = self.gate.lock().map_err(|_| Error::RecoveryIo)?;
        let _lock = self.lock()?;
        self.check_directory()?;
        let key = self.key(repo, path)?;
        if uuid::Uuid::parse_str(recovery_id).is_err() {
            return Err(Error::InvalidRecovery);
        }
        let observed = self.own_scene(&key)?;
        let Some(current) = self.read_record(repo, path, &key)? else {
            return Ok(());
        };
        if !observed || current.id != recovery_id {
            return Err(Error::RecoveryChanged);
        }
        self.check_directory()?;
        unlinkat(&self.directory, key.as_str(), AtFlags::empty()).map_err(|_| Error::RecoveryIo)?;
        self.directory
            .sync_all()
            .map_err(|_| Error::RecoveryUncertain)
    }
    #[cfg(not(unix))]
    pub fn discard(&self, _repo: &Repository, _path: &str, _recovery_id: &str) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    #[cfg(unix)]
    fn read_record(
        &self,
        repo: &Repository,
        path: &str,
        key: &str,
    ) -> Result<Option<RecoveryDraft>> {
        let fd = match openat(
            &self.directory,
            key,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(_) => return Err(Error::RecoveryIo),
        };
        let file = File::from(fd);
        private_metadata(&file, false)?;
        if file.metadata().map_err(|_| Error::RecoveryIo)?.len() > MAX_RECORD_BYTES {
            return Err(Error::InvalidRecovery);
        }
        let mut bytes = Vec::new();
        file.take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::RecoveryIo)?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err(Error::InvalidRecovery);
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidRecovery)?;
        if record.schema_version != 1
            || record.repository_key != repo.project_key()
            || record.draft.path != path
            || !valid_hash(&record.draft.base_hash)
            || uuid::Uuid::parse_str(&record.draft.id).is_err()
            || record.draft.actor != "author"
            || record.draft.client != "studio"
            || record.draft.updated_at == 0
            || valid_text(&record.draft.text).is_err()
        {
            return Err(Error::InvalidRecovery);
        }
        Ok(Some(record.draft))
    }
    #[cfg(unix)]
    fn remove_abandoned_temporaries(&self) -> Result<()> {
        self.check_directory()?;
        let entries = rustix::fs::Dir::read_from(&self.directory).map_err(|_| Error::RecoveryIo)?;
        let mut removed = false;
        for entry in entries {
            let entry = entry.map_err(|_| Error::RecoveryIo)?;
            let Ok(name) = entry.file_name().to_str() else {
                continue;
            };
            let Some(id) = name
                .strip_prefix(".heinlein-recovery-")
                .and_then(|s| s.strip_suffix(".tmp"))
            else {
                continue;
            };
            if uuid::Uuid::parse_str(id).is_ok() {
                unlinkat(&self.directory, name, AtFlags::empty()).map_err(|_| Error::RecoveryIo)?;
                removed = true;
            }
        }
        if removed {
            self.directory
                .sync_all()
                .map_err(|_| Error::RecoveryUncertain)?;
        }
        Ok(())
    }
}

#[cfg(unix)]
fn private_metadata(file: &File, directory: bool) -> Result<()> {
    let metadata = file.metadata().map_err(|_| Error::RecoveryIo)?;
    let expected_mode = if directory { 0o700 } else { 0o600 };
    if metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o777 != expected_mode
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.nlink() != 1))
    {
        return Err(Error::RecoveryIo);
    }
    Ok(())
}

#[cfg(unix)]
fn open_directory(path: &Path, create: bool) -> Result<File> {
    if !path.is_absolute() || path == Path::new("/") {
        return Err(Error::RecoveryIo);
    }
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut directory = File::from(open("/", flags, Mode::empty()).map_err(|_| Error::RecoveryIo)?);
    for component in path.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                let fd = match openat(&directory, name, flags, Mode::empty()) {
                    Ok(fd) => fd,
                    Err(rustix::io::Errno::NOENT) if create => {
                        match mkdirat(&directory, name, Mode::from_bits_truncate(0o700)) {
                            Ok(()) => directory.sync_all().map_err(|_| Error::RecoveryIo)?,
                            Err(rustix::io::Errno::EXIST) => {}
                            Err(_) => return Err(Error::RecoveryIo),
                        }
                        openat(&directory, name, flags, Mode::empty())
                            .map_err(|_| Error::RecoveryIo)?
                    }
                    Err(_) => return Err(Error::RecoveryIo),
                };
                directory = File::from(fd);
            }
            _ => return Err(Error::RecoveryIo),
        }
    }
    Ok(directory)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn failed_staging_preserves_previous_snapshot_and_removes_temporary() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("repository");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("scene.md"), "Original").unwrap();
        let repo = Repository::open(&root).unwrap();
        let store = RecoveryStore::open(temp.path().join("recovery")).unwrap();
        let hash = repo.read("scene.md").unwrap().content_hash;
        let first = store
            .stage(&repo, "scene.md", &hash, "First draft")
            .unwrap();
        assert_eq!(
            store
                .stage_inner(&repo, "scene.md", &hash, "New draft", || Err(
                    Error::RecoveryIo
                ))
                .unwrap_err(),
            Error::RecoveryIo
        );
        assert_eq!(store.read(&repo, "scene.md").unwrap(), Some(first));
        assert_eq!(
            fs::read_dir(temp.path().join("recovery")).unwrap().count(),
            2
        );
        assert_eq!(repo.read("scene.md").unwrap().text, "Original");
    }

    #[test]
    fn recovery_directory_swapped_during_stage_never_writes_to_replacement() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("repository");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("scene.md"), "Original").unwrap();
        let repo = Repository::open(&root).unwrap();
        let recovery = temp.path().join("recovery");
        let moved = temp.path().join("moved");
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let store = RecoveryStore::open(&recovery).unwrap();
        let hash = repo.read("scene.md").unwrap().content_hash;
        let draft = store
            .stage(&repo, "scene.md", &hash, "First draft")
            .unwrap();
        let result = store.stage_inner(&repo, "scene.md", &hash, "New draft", || {
            fs::rename(&recovery, &moved).unwrap();
            symlink(&outside, &recovery).unwrap();
            Ok(())
        });
        assert_eq!(result.unwrap_err(), Error::RecoveryIo);
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_file(&recovery).unwrap();
        fs::rename(&moved, &recovery).unwrap();
        assert_eq!(store.read(&repo, "scene.md").unwrap(), Some(draft));
        assert_eq!(fs::read_dir(&recovery).unwrap().count(), 2);
    }
}

#[cfg(all(test, unix))]
#[path = "recovery_fuzz.rs"]
mod fuzz;
