use super::*;
use crate::Document;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneVersion {
    pub saved_at: u64,
    pub source_path: Option<String>,
    pub hash: String,
}

// An untouched path uses the installed format's directory key. A Studio move
// rebinds that immutable ledger to its destination and gives the vacated path
// a fresh identity. Snapshots and their timestamp/hash handles stay in place.
#[cfg(unix)]
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryBindings {
    ledgers: HashMap<String, String>,
    rollback: Option<HistoryRollback>,
}

#[cfg(unix)]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryRollback {
    journal_hash: String,
    previous: HashMap<String, Option<String>>,
}

#[cfg(unix)]
impl RecoveryStore {
    fn bindings_name(repo: &Repository) -> String {
        format!(".heinlein-history-bindings-v1-{}.json", repo.project_key())
    }

    fn history_bindings(&self, repo: &Repository) -> Result<HistoryBindings> {
        self.check_directory()?;
        let fd = match openat(
            &self.directory,
            Self::bindings_name(repo).as_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(HistoryBindings::default()),
            Err(_) => return Err(Error::RecoveryIo),
        };
        let file = File::from(fd);
        private_metadata(&file, false)?;
        let mut bytes = Vec::new();
        file.take(crate::MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::RecoveryIo)?;
        if bytes.len() as u64 > crate::MAX_MANIFEST_BYTES {
            return Err(Error::InvalidRecovery);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidRecovery)
    }

    fn restore_binding(
        ledgers: &mut HashMap<String, String>,
        key: String,
        previous: Option<String>,
    ) {
        if let Some(ledger) = previous {
            ledgers.insert(key, ledger);
        } else {
            ledgers.remove(&key);
        }
    }

    fn write_bindings(&self, repo: &Repository, bindings: &HistoryBindings) -> Result<()> {
        let bytes = serde_json::to_vec(bindings).map_err(|_| Error::InvalidRecovery)?;
        if bytes.len() as u64 > crate::MAX_MANIFEST_BYTES {
            return Err(Error::LimitExceeded);
        }
        self.write_private_record(&Self::bindings_name(repo), &bytes)
    }

    fn path_history_key(&self, repo: &Repository, path: &str) -> Result<String> {
        Ok(self.key(repo, path)?.trim_end_matches(".json").to_owned())
    }

    // Called inside the authenticated structure transaction, while its private
    // store lock is held. All moves in a batch become visible in one rename.
    pub(crate) fn apply_history_moves(
        &self,
        repo: &Repository,
        journal_hash: &str,
        moves: &[(String, String)],
        restore: &HashMap<String, Option<String>>,
    ) -> Result<HashMap<String, Option<String>>> {
        if moves.is_empty() {
            return Ok(HashMap::new());
        }
        let mut bindings = self.history_bindings(repo)?;
        let mut previous = HashMap::new();
        if restore.is_empty() {
            for (source, destination) in moves {
                // Old builds stored exact text but no per-version location. Record
                // existing versions' current owner before changing the binding.
                if let Some(dir) = self.history_dir(repo, source, false)? {
                    for version in Self::versions(&dir)? {
                        if version.source_path.is_none() {
                            Self::write_private_at(
                                &dir,
                                &format!("origin.{}", version.saved_at),
                                source.as_bytes(),
                            )?;
                        }
                    }
                }

                let from = self.path_history_key(repo, source)?;
                let to = self.path_history_key(repo, destination)?;
                previous.insert(from.clone(), bindings.ledgers.get(&from).cloned());
                previous.insert(to.clone(), bindings.ledgers.get(&to).cloned());
                let ledger = bindings
                    .ledgers
                    .insert(
                        from.clone(),
                        content_hash(&uuid::Uuid::new_v4().to_string()),
                    )
                    .unwrap_or(from);
                bindings.ledgers.insert(to, ledger);
            }
        } else {
            // Undo and redo reinstate the exact ledger of each path. In
            // particular a later scene at a reused name keeps its own history.
            for (key, ledger) in restore {
                previous.insert(key.clone(), bindings.ledgers.get(key).cloned());
                Self::restore_binding(&mut bindings.ledgers, key.clone(), ledger.clone());
            }
        }
        bindings.rollback = Some(HistoryRollback {
            journal_hash: journal_hash.into(),
            previous: previous.clone(),
        });
        self.write_bindings(repo, &bindings)?;
        Ok(previous)
    }

    pub(crate) fn rollback_history_moves(
        &self,
        repo: &Repository,
        journal_hash: &str,
    ) -> Result<()> {
        let mut bindings = self.history_bindings(repo)?;
        let Some(rollback) = bindings.rollback.take() else {
            return Ok(());
        };
        if rollback.journal_hash != journal_hash {
            return Ok(());
        }
        for (key, previous) in rollback.previous {
            Self::restore_binding(&mut bindings.ledgers, key, previous);
        }
        self.write_bindings(repo, &bindings)
    }
}

#[cfg(unix)]
impl RecoveryStore {
    fn history_dir(&self, repo: &Repository, path: &str, create: bool) -> Result<Option<File>> {
        let key = self.path_history_key(repo, path)?;
        let bindings = self.history_bindings(repo)?;
        let ledger = bindings.ledgers.get(&key).unwrap_or(&key);
        if !valid_hash(ledger) {
            return Err(Error::InvalidRecovery);
        }
        let name = format!("history-{ledger}");
        if create {
            match mkdirat(
                &self.directory,
                name.as_str(),
                Mode::from_bits_truncate(0o700),
            ) {
                Ok(()) => self.directory.sync_all().map_err(|_| Error::RecoveryIo)?,
                Err(rustix::io::Errno::EXIST) => (),
                Err(_) => return Err(Error::RecoveryIo),
            }
        }
        match openat(
            &self.directory,
            name.as_str(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => {
                let file = File::from(fd);
                private_metadata(&file, true)?;
                Ok(Some(file))
            }
            Err(rustix::io::Errno::NOENT) if !create => Ok(None),
            Err(_) => Err(Error::RecoveryIo),
        }
    }

    fn versions(dir: &File) -> Result<Vec<SceneVersion>> {
        let mut versions = Vec::new();
        for entry in rustix::fs::Dir::read_from(dir).map_err(|_| Error::RecoveryIo)? {
            let entry = entry.map_err(|_| Error::RecoveryIo)?;
            let Some((time, hash)) = entry
                .file_name()
                .to_str()
                .ok()
                .and_then(|name| name.split_once('-'))
            else {
                continue;
            };
            if let Ok(saved_at) = time.parse() {
                if valid_hash(hash) {
                    let origin = format!("origin.{saved_at}");
                    let source_path = match openat(
                        dir,
                        origin.as_str(),
                        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                        Mode::empty(),
                    ) {
                        Ok(fd) => {
                            let file = File::from(fd);
                            private_metadata(&file, false)?;
                            let mut path = String::new();
                            file.take(4097)
                                .read_to_string(&mut path)
                                .map_err(|_| Error::InvalidRecovery)?;
                            crate::parts(&path)?;
                            Some(path)
                        }
                        Err(rustix::io::Errno::NOENT) => None,
                        Err(_) => return Err(Error::RecoveryIo),
                    };
                    versions.push(SceneVersion {
                        saved_at,
                        source_path,
                        hash: hash.into(),
                    });
                }
            }
        }
        versions.sort_by_key(|v| std::cmp::Reverse(v.saved_at));
        Ok(versions)
    }

    pub fn scene_versions(&self, repo: &Repository, path: &str) -> Result<Vec<SceneVersion>> {
        Self::validate_source(repo, path)?;
        match self.history_dir(repo, path, false)? {
            Some(dir) => Self::versions(&dir),
            None => Ok(Vec::new()),
        }
    }

    pub fn scene_version(
        &self,
        repo: &Repository,
        path: &str,
        saved_at: u64,
        hash: &str,
    ) -> Result<String> {
        Self::validate_source(repo, path)?;
        if !valid_hash(hash) {
            return Err(Error::InvalidRecovery);
        }
        let dir = self
            .history_dir(repo, path, false)?
            .ok_or(Error::InvalidRecovery)?;
        let file = File::from(
            openat(
                &dir,
                format!("{saved_at}-{hash}").as_str(),
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| Error::RecoveryIo)?,
        );
        private_metadata(&file, false)?;
        let mut text = String::new();
        file.take(MAX_FILE_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|_| Error::RecoveryIo)?;
        valid_text(&text)?;
        if content_hash(&text) != hash {
            return Err(Error::InvalidRecovery);
        }
        Ok(text)
    }

    // Called under the repository save gate and the process-lifetime scene ownership lock.
    pub(crate) fn remember_scene(&self, repo: &Repository, doc: &Document) -> Result<()> {
        let dir = self
            .history_dir(repo, &doc.path, true)?
            .ok_or(Error::RecoveryIo)?;
        let versions = Self::versions(&dir)?;
        let latest = versions.first();
        if latest.is_some_and(|v| v.hash == doc.content_hash) {
            return Ok(());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::RecoveryIo)?
            .as_millis() as u64;
        let time = now.max(latest.map_or(0, |v| v.saved_at.saturating_add(1)));
        // A crash can leave only this private staging name. The next save replaces it.
        let _ = unlinkat(&dir, "pending", AtFlags::empty());
        let mut file = File::from(
            openat(
                &dir,
                "pending",
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| Error::RecoveryIo)?,
        );
        file.write_all(doc.text.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| Error::RecoveryIo)?;
        Self::write_private_at(&dir, &format!("origin.{time}"), doc.path.as_bytes())?;
        renameat(
            &dir,
            "pending",
            &dir,
            format!("{time}-{}", doc.content_hash).as_str(),
        )
        .map_err(|_| Error::RecoveryIo)?;
        // Keep 20 recent saves plus one earlier snapshot per day for 30 writing days.
        let mut older_days = std::collections::HashSet::new();
        for version in versions.iter().skip(19) {
            let day = version.saved_at / 86_400_000;
            if older_days.len() >= 30 || !older_days.insert(day) {
                let _ = unlinkat(
                    &dir,
                    format!("origin.{}", version.saved_at).as_str(),
                    AtFlags::empty(),
                );
                unlinkat(
                    &dir,
                    format!("{}-{}", version.saved_at, version.hash).as_str(),
                    AtFlags::empty(),
                )
                .map_err(|_| Error::RecoveryIo)?;
            }
        }
        dir.sync_all().map_err(|_| Error::RecoveryUncertain)
    }
}

#[cfg(not(unix))]
impl RecoveryStore {
    pub fn scene_versions(&self, _: &Repository, _: &str) -> Result<Vec<SceneVersion>> {
        Err(Error::UnsupportedPlatform)
    }
    pub fn scene_version(&self, _: &Repository, _: &str, _: u64, _: &str) -> Result<String> {
        Err(Error::UnsupportedPlatform)
    }
    pub(crate) fn remember_scene(&self, _: &Repository, _: &Document) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn earlier_versions_survive_reopening_and_are_scoped_to_the_scene() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("novel");
        std::fs::create_dir(&root).unwrap();
        let path = "scene.md";
        let original = "First.\r\n\r\nA cut passage — here.\n";
        std::fs::write(root.join(path), original).unwrap();
        std::fs::write(root.join("other.md"), "Other").unwrap();
        let location = temp.path().join("recovery");
        {
            let repo = Repository::open(&root).unwrap();
            let store = RecoveryStore::open(&location).unwrap();
            let hash = repo.read(path).unwrap().content_hash;
            let saved = repo
                .save_with_recovery(path, &hash, "First.\r\n", &store)
                .unwrap();
            assert!(repo
                .save_with_recovery(path, &hash, "Stale", &store)
                .is_err());
            repo.save_with_recovery(path, &saved.content_hash, "First.\r\nLater edits.", &store)
                .unwrap();
        }
        let repo = Repository::open(&root).unwrap();
        let store = RecoveryStore::open(&location).unwrap();
        let versions = store.scene_versions(&repo, path).unwrap();
        assert_eq!(versions.len(), 2);
        let earlier = &versions[1];
        assert_eq!(
            store
                .scene_version(&repo, path, earlier.saved_at, &earlier.hash)
                .unwrap(),
            original
        );
        assert!(store
            .scene_version(&repo, "other.md", earlier.saved_at, &earlier.hash)
            .is_err());
        assert_eq!(repo.read(path).unwrap().text, "First.\r\nLater edits.");
    }
}
