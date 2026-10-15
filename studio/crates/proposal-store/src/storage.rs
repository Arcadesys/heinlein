use super::*;
use rustix::fs::{
    flock, mkdirat, open, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags,
};
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// Native launch code supplies an explicit private directory outside the repository.
/// All records are untrusted input; the store is never an approval journal.
pub struct ProposalStore {
    path: PathBuf,
    directory: File,
    gate: Mutex<()>,
}
struct StoreLock<'a>(&'a File);
impl Drop for StoreLock<'_> {
    fn drop(&mut self) {
        let _ = flock(self.0, FlockOperation::Unlock);
    }
}

impl ProposalStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let directory = open_directory(path.as_ref(), true)?;
        private_metadata(&directory, true)?;
        let path = path.as_ref().canonicalize().map_err(|_| Error::StorageIo)?;
        let store = Self {
            path,
            directory,
            gate: Mutex::new(()),
        };
        let guard = store.gate.lock().map_err(|_| Error::StorageIo)?;
        let lock = store.lock()?;
        store.check_directory()?;
        store.remove_abandoned_temporaries()?;
        drop(lock);
        drop(guard);
        Ok(store)
    }
    pub fn submit(
        &self,
        repo: &Repository,
        path: &str,
        expected_base_hash: &str,
        replacement_text: &str,
        origin: ProposalOrigin,
    ) -> Result<PendingProposal> {
        let _gate = self.gate.lock().map_err(|_| Error::StorageIo)?;
        let _lock = self.lock()?;
        self.submit_inner(
            repo,
            path,
            expected_base_hash,
            replacement_text,
            origin,
            || Ok(()),
        )
    }
    fn submit_inner(
        &self,
        repo: &Repository,
        path: &str,
        expected_base_hash: &str,
        replacement_text: &str,
        origin: ProposalOrigin,
        before_commit: impl FnOnce() -> Result<()>,
    ) -> Result<PendingProposal> {
        self.check_repository(repo)?;
        if !valid_hash(expected_base_hash) || !valid_text(replacement_text) {
            return Err(Error::InvalidProposal);
        }
        origin.validate()?;
        let current = validate_source(repo, path)?;
        if current.content_hash != expected_base_hash {
            return Err(Error::Conflict);
        }
        let proposal = PendingProposal {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            project_key: repo.project_key(),
            path: path.into(),
            base_hash: current.content_hash,
            replacement_hash: text_hash(replacement_text),
            diff_hash: diff_hash(path, &current.text, replacement_text),
            base_text: current.text,
            replacement_text: replacement_text.into(),
            origin,
            created_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::StorageIo)?
                .as_millis()
                .try_into()
                .map_err(|_| Error::StorageIo)?,
        };
        proposal.validate()?;
        let bytes = serde_json::to_vec(&proposal).map_err(|_| Error::InvalidProposal)?;
        let (names, total_bytes) = self.inventory()?;
        if names.len() >= MAX_PROPOSALS || total_bytes + bytes.len() as u64 > MAX_STORE_BYTES {
            return Err(Error::LimitExceeded);
        }
        let key = record_key(&proposal.project_key, &proposal.id)?;
        let temporary = format!(".heinlein-proposal-{}.tmp", uuid::Uuid::new_v4());
        let fd = openat(
            &self.directory,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| Error::StorageIo)?;
        let mut file = File::from(fd);
        let result = (|| {
            file.write_all(&bytes).map_err(|_| Error::StorageIo)?;
            file.sync_all().map_err(|_| Error::StorageIo)?;
            before_commit()?;
            self.check_repository(repo)?;
            // A later edit may still race this read; it only makes a proposal stale.
            // Applying always requires a separate current-source check in Core.
            if validate_source(repo, path)?.content_hash != expected_base_hash {
                return Err(Error::Conflict);
            }
            // Cooperating stores hold the same flock, UUIDs are never reused. Do not
            // replace an existing record even if a collision is deliberately arranged.
            match openat(
                &self.directory,
                key.as_str(),
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Err(rustix::io::Errno::NOENT) => {}
                _ => return Err(Error::InvalidStorage),
            }
            renameat(
                &self.directory,
                temporary.as_str(),
                &self.directory,
                key.as_str(),
            )
            .map_err(|_| Error::StorageIo)?;
            self.directory
                .sync_all()
                .map_err(|_| Error::StorageUncertain)?;
            Ok(proposal)
        })();
        let _ = unlinkat(&self.directory, temporary.as_str(), AtFlags::empty());
        result
    }
    /// Summaries only; exact text is fetched individually. No automatic deletion or pruning.
    pub fn list(&self, repo: &Repository) -> Result<Vec<ProposalSummary>> {
        let _gate = self.gate.lock().map_err(|_| Error::StorageIo)?;
        let _lock = self.lock()?;
        self.check_repository(repo)?;
        let (names, _) = self.inventory()?;
        let prefix = format!("{}-", repo.project_key());
        let mut summaries = Vec::new();
        for name in names.into_iter().filter(|name| name.starts_with(&prefix)) {
            let proposal = self.read_record(repo, &name)?;
            summaries.push(proposal.summary());
        }
        summaries.sort_by(|a, b| (a.created_at_ms, &a.id).cmp(&(b.created_at_ms, &b.id)));
        Ok(summaries)
    }
    pub fn get(&self, repo: &Repository, id: &str) -> Result<PendingProposal> {
        let _gate = self.gate.lock().map_err(|_| Error::StorageIo)?;
        let _lock = self.lock()?;
        self.check_repository(repo)?;
        self.read_record(repo, &record_key(&repo.project_key(), id)?)
    }
    fn read_record(&self, repo: &Repository, key: &str) -> Result<PendingProposal> {
        let fd = openat(
            &self.directory,
            key,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| {
            if e == rustix::io::Errno::NOENT {
                Error::NotFound
            } else {
                Error::InvalidStorage
            }
        })?;
        let file = File::from(fd);
        private_metadata(&file, false)?;
        if file.metadata().map_err(|_| Error::StorageIo)?.len() > MAX_RECORD_BYTES {
            return Err(Error::InvalidProposal);
        }
        let mut bytes = Vec::new();
        file.take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::StorageIo)?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err(Error::InvalidProposal);
        }
        let proposal: PendingProposal =
            serde_json::from_slice(&bytes).map_err(|_| Error::InvalidProposal)?;
        proposal.validate()?;
        if proposal.project_key != repo.project_key()
            || record_key(&proposal.project_key, &proposal.id)? != key
        {
            return Err(Error::InvalidProposal);
        }
        // Preserve stale/removed-source proposals for explicit author reconciliation.
        // A successful get/list never means that the source is still applicable.
        Ok(proposal)
    }
    fn lock(&self) -> Result<StoreLock<'_>> {
        flock(&self.directory, FlockOperation::LockExclusive).map_err(|_| Error::StorageIo)?;
        Ok(StoreLock(&self.directory))
    }
    fn check_repository(&self, repo: &Repository) -> Result<()> {
        self.check_directory()?;
        if self.path.starts_with(repo.root()) || repo.root().starts_with(&self.path) {
            return Err(Error::InvalidStorage);
        }
        Ok(())
    }
    fn check_directory(&self) -> Result<()> {
        private_metadata(&self.directory, true)?;
        let resolved = open_directory(&self.path, false)?;
        private_metadata(&resolved, true)?;
        let held = self.directory.metadata().map_err(|_| Error::StorageIo)?;
        let current = resolved.metadata().map_err(|_| Error::StorageIo)?;
        if (held.dev(), held.ino()) != (current.dev(), current.ino()) {
            return Err(Error::InvalidStorage);
        }
        Ok(())
    }
    fn inventory(&self) -> Result<(Vec<String>, u64)> {
        let mut names = Vec::new();
        let mut total = 0;
        for (index, entry) in rustix::fs::Dir::read_from(&self.directory)
            .map_err(|_| Error::StorageIo)?
            .enumerate()
        {
            if index >= MAX_PROPOSALS + 2 {
                return Err(Error::LimitExceeded);
            }
            let entry = entry.map_err(|_| Error::StorageIo)?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| Error::InvalidStorage)?;
            if matches!(name, "." | "..") {
                continue;
            }
            if !valid_record_key(name) {
                return Err(Error::InvalidStorage);
            }
            let file = File::from(
                openat(
                    &self.directory,
                    name,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| Error::InvalidStorage)?,
            );
            private_metadata(&file, false)?;
            let size = file.metadata().map_err(|_| Error::StorageIo)?.len();
            if size > MAX_RECORD_BYTES {
                return Err(Error::InvalidProposal);
            }
            total += size;
            if total > MAX_STORE_BYTES {
                return Err(Error::LimitExceeded);
            }
            names.push(name.into());
        }
        Ok((names, total))
    }
    fn remove_abandoned_temporaries(&self) -> Result<()> {
        let mut removed = false;
        for (index, entry) in rustix::fs::Dir::read_from(&self.directory)
            .map_err(|_| Error::StorageIo)?
            .enumerate()
        {
            if index >= MAX_PROPOSALS + 258 {
                return Err(Error::LimitExceeded);
            }
            let entry = entry.map_err(|_| Error::StorageIo)?;
            let Ok(name) = entry.file_name().to_str() else {
                return Err(Error::InvalidStorage);
            };
            let Some(id) = name
                .strip_prefix(".heinlein-proposal-")
                .and_then(|s| s.strip_suffix(".tmp"))
            else {
                continue;
            };
            if !valid_id(id) {
                return Err(Error::InvalidStorage);
            }
            let file = File::from(
                openat(
                    &self.directory,
                    name,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| Error::InvalidStorage)?,
            );
            private_metadata(&file, false)?;
            unlinkat(&self.directory, name, AtFlags::empty()).map_err(|_| Error::StorageIo)?;
            removed = true;
        }
        if removed {
            self.directory
                .sync_all()
                .map_err(|_| Error::StorageUncertain)?;
        }
        Ok(())
    }
}
fn record_key(project: &str, id: &str) -> Result<String> {
    if !valid_hash(project) || !valid_id(id) {
        return Err(Error::InvalidProposal);
    }
    Ok(format!("{project}-{id}.json"))
}
fn valid_record_key(name: &str) -> bool {
    name.strip_suffix(".json")
        .and_then(|s| s.split_once('-'))
        .is_some_and(|(project, id)| valid_hash(project) && valid_id(id))
}
fn private_metadata(file: &File, directory: bool) -> Result<()> {
    let metadata = file.metadata().map_err(|_| Error::StorageIo)?;
    if metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o777 != if directory { 0o700 } else { 0o600 }
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file() || metadata.nlink() != 1
        }
    {
        return Err(Error::InvalidStorage);
    }
    Ok(())
}
fn open_directory(path: &Path, create: bool) -> Result<File> {
    if !path.is_absolute() || path == Path::new("/") {
        return Err(Error::InvalidStorage);
    }
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut directory = File::from(open("/", flags, Mode::empty()).map_err(|_| Error::StorageIo)?);
    for component in path.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                let fd = match openat(&directory, name, flags, Mode::empty()) {
                    Ok(fd) => fd,
                    Err(rustix::io::Errno::NOENT) if create => {
                        match mkdirat(&directory, name, Mode::from_bits_truncate(0o700)) {
                            Ok(()) => directory.sync_all().map_err(|_| Error::StorageIo)?,
                            Err(rustix::io::Errno::EXIST) => {}
                            Err(_) => return Err(Error::StorageIo),
                        }
                        openat(&directory, name, flags, Mode::empty())
                            .map_err(|_| Error::InvalidStorage)?
                    }
                    Err(_) => return Err(Error::InvalidStorage),
                };
                directory = File::from(fd);
            }
            _ => return Err(Error::InvalidStorage),
        }
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};
    #[test]
    fn failed_stage_and_external_edit_preserve_existing_records_and_source() {
        let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = t.path().join("repo");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("scene.md"), "Before").unwrap();
        let repo = Repository::open(&root).unwrap();
        let store = ProposalStore::open(t.path().join("store")).unwrap();
        let hash = repo.read("scene.md").unwrap().content_hash;
        let origin =
            || ProposalOrigin::local_mcp(uuid::Uuid::new_v4().to_string(), "synthetic".into());
        let p = store
            .submit(&repo, "scene.md", &hash, "First", origin())
            .unwrap();
        assert_eq!(
            store
                .submit_inner(&repo, "scene.md", &hash, "Second", origin(), || Err(
                    Error::StorageIo
                ))
                .unwrap_err(),
            Error::StorageIo
        );
        assert_eq!(store.list(&repo).unwrap(), vec![p.summary()]);
        assert_eq!(
            store
                .submit_inner(&repo, "scene.md", &hash, "Second", origin(), || {
                    fs::write(root.join("scene.md"), "External").unwrap();
                    Ok(())
                })
                .unwrap_err(),
            Error::Conflict
        );
        assert_eq!(repo.read("scene.md").unwrap().text, "External");
        assert_eq!(store.list(&repo).unwrap(), vec![p.summary()]);
    }
    #[test]
    fn store_swap_during_staging_cannot_write_new_directory() {
        let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = t.path().join("repo");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("scene.md"), "Before").unwrap();
        let repo = Repository::open(&root).unwrap();
        let path = t.path().join("store");
        let store = ProposalStore::open(&path).unwrap();
        let outside = t.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let hash = repo.read("scene.md").unwrap().content_hash;
        let result = store.submit_inner(
            &repo,
            "scene.md",
            &hash,
            "Candidate",
            ProposalOrigin::local_mcp(uuid::Uuid::new_v4().to_string(), "synthetic".into()),
            || {
                fs::rename(&path, t.path().join("moved")).unwrap();
                symlink(&outside, &path).unwrap();
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), Error::InvalidStorage);
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        assert_eq!(repo.read("scene.md").unwrap().text, "Before");
    }
}
