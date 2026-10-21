//! A separate private transaction for reviewed GitHub batches. Git refs are native-owned.
//! Reuses descriptor-relative file transitions, not the drafting journal protocol.
use crate::{
    content_hash,
    drafting::{Bytes, Edit},
    Error, RecoveryStore, Repository, Result,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
#[cfg(unix)]
use {
    rustix::fs::{flock, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags},
    std::{
        fs::File,
        io::{Read, Write},
        os::unix::fs::MetadataExt,
    },
};
pub struct UpdatePlan {
    id: String,
    key: String,
    expected: BTreeMap<String, Option<String>>,
    edits: Vec<Edit>,
}
impl UpdatePlan {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn paths(&self) -> Vec<String> {
        self.expected.keys().cloned().collect()
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    id: String,
    key: String,
    edits: Vec<Edit>,
}
pub struct UpdateStore {
    #[cfg(unix)]
    path: PathBuf,
    #[cfg(unix)]
    directory: File,
}
impl UpdateStore {
    #[cfg(unix)]
    pub fn open(path: &Path) -> Result<Self> {
        let directory = crate::recovery::open_directory(path, true)?;
        crate::recovery::private_metadata(&directory, true)?;
        Ok(Self {
            path: path.canonicalize().map_err(|_| Error::RecoveryIo)?,
            directory,
        })
    }
    #[cfg(not(unix))]
    pub fn open(_: &Path) -> Result<Self> {
        Err(Error::UnsupportedPlatform)
    }
    #[cfg(unix)]
    fn check(&self, repo: &Repository) -> Result<()> {
        crate::recovery::private_metadata(&self.directory, true)?;
        let current = crate::recovery::open_directory(&self.path, false)?;
        let a = current.metadata().map_err(|_| Error::RecoveryIo)?;
        let b = self.directory.metadata().map_err(|_| Error::RecoveryIo)?;
        if a.dev() != b.dev()
            || a.ino() != b.ino()
            || self.path.starts_with(repo.root())
            || repo.root().starts_with(&self.path)
        {
            return Err(Error::RecoveryIo);
        }
        Ok(())
    }
    fn name(repo: &Repository) -> String {
        format!("workspace-{}.json", repo.project_key())
    }
    #[cfg(unix)]
    fn read(&self, repo: &Repository) -> Result<Option<Record>> {
        self.check(repo)?;
        let name = Self::name(repo);
        let fd = match openat(
            &self.directory,
            name.as_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(e) if e == rustix::io::Errno::NOENT => return Ok(None),
            _ => return Err(Error::RecoveryIo),
        };
        if !fd.metadata().map_err(|_| Error::RecoveryIo)?.is_file() {
            return Err(Error::RecoveryIo);
        }
        let mut bytes = Vec::new();
        fd.take(400 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::RecoveryIo)?;
        if bytes.len() > 400 * 1024 * 1024 {
            return Err(Error::TooLarge);
        }
        let r: Record = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidRecovery)?;
        if r.version != 1
            || r.key != repo.project_key()
            || uuid::Uuid::parse_str(&r.id).is_err()
            || r.edits.len() > 256
        {
            return Err(Error::InvalidRecovery);
        }
        for edit in &r.edits {
            author_path(&edit.path)?;
            for b in [&edit.before, &edit.after].into_iter().flatten() {
                if b.mode & !0o777 != 0 || b.text.len() > crate::MAX_FILE_BYTES as usize * 4 {
                    return Err(Error::InvalidRecovery);
                }
            }
        }
        Ok(Some(r))
    }
    #[cfg(unix)]
    fn write(&self, repo: &Repository, r: &Record) -> Result<()> {
        self.check(repo)?;
        let bytes = serde_json::to_vec(r).map_err(|_| Error::RecoveryIo)?;
        if bytes.len() > 400 * 1024 * 1024 {
            return Err(Error::TooLarge);
        }
        let temp = format!("update-{}.tmp", uuid::Uuid::new_v4());
        let mut f = File::from(
            openat(
                &self.directory,
                temp.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| Error::RecoveryIo)?,
        );
        let result = (|| {
            f.write_all(&bytes).map_err(|_| Error::RecoveryIo)?;
            f.sync_all().map_err(|_| Error::RecoveryIo)?;
            self.check(repo)?;
            renameat(
                &self.directory,
                temp.as_str(),
                &self.directory,
                Self::name(repo).as_str(),
            )
            .map_err(|_| Error::RecoveryIo)?;
            self.directory
                .sync_all()
                .map_err(|_| Error::RecoveryUncertain)
        })();
        if result.is_err() {
            let _ = unlinkat(&self.directory, temp.as_str(), AtFlags::empty());
        }
        result
    }
    #[cfg(unix)]
    fn remove(&self, repo: &Repository) -> Result<()> {
        self.check(repo)?;
        unlinkat(&self.directory, Self::name(repo).as_str(), AtFlags::empty())
            .map_err(|_| Error::RecoveryIo)?;
        self.directory
            .sync_all()
            .map_err(|_| Error::RecoveryUncertain)
    }
    #[cfg(unix)]
    pub fn pending(&self, repo: &Repository) -> Result<bool> {
        Ok(self.read(repo)?.is_some())
    }
    #[cfg(not(unix))]
    pub fn pending(&self, _: &Repository) -> Result<bool> {
        Err(Error::UnsupportedPlatform)
    }
    #[cfg(unix)]
    pub fn finalize(&self, repo: &Repository, id: &str) -> Result<()> {
        let _save = repo.save_gate.lock().map_err(|_| Error::Io)?;
        let r = self.read(repo)?.ok_or(Error::InvalidRecovery)?;
        if r.id != id
            || r.edits
                .iter()
                .any(|e| repo.snapshot(&e.path).ok() != Some(e.after.clone()))
        {
            return Err(Error::Conflict);
        }
        self.remove(repo)
    }
    #[cfg(not(unix))]
    pub fn finalize(&self, _: &Repository, _: &str) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
    #[cfg(unix)]
    pub fn rollback(&self, repo: &Repository) -> Result<()> {
        let _save = repo.save_gate.lock().map_err(|_| Error::Io)?;
        self.rollback_unlocked(repo)
    }
    #[cfg(unix)]
    fn rollback_unlocked(&self, repo: &Repository) -> Result<()> {
        let Some(r) = self.read(repo)? else {
            return Ok(());
        };
        for e in r.edits.iter().rev() {
            let current = repo.snapshot(&e.path)?;
            if current == e.before {
                continue;
            }
            if current != e.after {
                return Err(Error::RecoveryChanged);
            }
            repo.write_transition(&Edit {
                path: e.path.clone(),
                before: e.after.clone(),
                after: e.before.clone(),
            })?;
        }
        self.remove(repo)
    }
    #[cfg(not(unix))]
    pub fn rollback(&self, _: &Repository) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
}
fn author_path(path: &str) -> Result<()> {
    crate::parts(path)?;
    if path == "ms/manuscript.json" || path.ends_with(".md") || path.ends_with(".markdown") {
        Ok(())
    } else {
        Err(Error::ReadOnly)
    }
}
impl Repository {
    pub fn check_workspace_clean(&self, paths: &[String], recovery: &RecoveryStore) -> Result<()> {
        self.require_clean_structure()?;
        recovery.with_clean_paths(self, paths, || Ok(()))
    }
    pub fn preview_workspace_update(
        &self,
        expected: BTreeMap<String, Option<String>>,
        replacements: BTreeMap<String, Option<String>>,
    ) -> Result<UpdatePlan> {
        self.require_clean_structure()?;
        if expected.len() > 4096 || replacements.len() > 256 {
            return Err(Error::LimitExceeded);
        }
        let mut edits = Vec::new();
        let mut bytes = 0;
        for (path, after) in replacements {
            author_path(&path)?;
            self.allowed(&path, false)?;
            let before = self.snapshot(&path)?;
            if before.as_ref().map(|b| content_hash(&b.text))
                != *expected.get(&path).ok_or(Error::Conflict)?
            {
                return Err(Error::Conflict);
            }
            let mode = before.as_ref().map(|b| b.mode).unwrap_or(0o600);
            let after = after.map(|text| Bytes { text, mode });
            for b in [&before, &after].into_iter().flatten() {
                bytes += b.text.len();
            }
            edits.push(Edit {
                path,
                before,
                after,
            });
        }
        if bytes > 64 * 1024 * 1024 {
            return Err(Error::TooLarge);
        }
        let plan = UpdatePlan {
            id: uuid::Uuid::new_v4().to_string(),
            key: self.project_key(),
            expected,
            edits,
        };
        self.verify_workspace(&plan)?;
        Ok(plan)
    }
    fn verify_workspace(&self, plan: &UpdatePlan) -> Result<()> {
        if plan.key != self.project_key() {
            return Err(Error::Conflict);
        }
        for (path, hash) in &plan.expected {
            author_path(path)?;
            if self.snapshot(path)?.map(|b| content_hash(&b.text)) != *hash {
                return Err(Error::Conflict);
            }
        }
        let candidate = plan
            .edits
            .iter()
            .find(|e| e.path == "ms/manuscript.json")
            .map(|e| e.after.as_ref().map(|b| b.text.clone()))
            .unwrap_or(self.snapshot("ms/manuscript.json")?.map(|b| b.text));
        if let Some(text) = candidate {
            let manifest = crate::parse_workspace_manifest(&text)?;
            for scene in manifest.scenes {
                let text = plan
                    .edits
                    .iter()
                    .find(|e| e.path == scene.path)
                    .map(|e| e.after.as_ref().map(|b| b.text.clone()))
                    .unwrap_or(self.snapshot(&scene.path)?.map(|b| b.text));
                if text.is_none() {
                    return Err(Error::InvalidManifest);
                }
            }
        }
        Ok(())
    }
    #[cfg(unix)]
    pub fn apply_workspace_update(
        &self,
        plan: &UpdatePlan,
        store: &UpdateStore,
        recovery: &RecoveryStore,
        check: impl Fn(usize) -> Result<()>,
    ) -> Result<()> {
        let _save = self.save_gate.lock().map_err(|_| Error::Io)?;
        store.check(self)?;
        flock(&store.directory, FlockOperation::NonBlockingLockExclusive)
            .map_err(|_| Error::RecoveryBusy)?;
        struct Unlock<'a>(&'a File);
        impl Drop for Unlock<'_> {
            fn drop(&mut self) {
                let _ = flock(self.0, FlockOperation::Unlock);
            }
        }
        let _lock = Unlock(&store.directory);
        if store.pending(self)? {
            return Err(Error::PendingRecovery);
        }
        let paths = plan
            .expected
            .keys()
            .filter(|p| p.as_str() != "ms/manuscript.json")
            .cloned()
            .collect::<Vec<_>>();
        recovery.with_clean_paths(self, &paths, || {
            self.require_clean_structure()?;
            self.verify_workspace(plan)?;
            check(0)?;
            store.write(
                self,
                &Record {
                    version: 1,
                    id: plan.id.clone(),
                    key: plan.key.clone(),
                    edits: plan.edits.clone(),
                },
            )?;
            let result = (|| {
                for (i, edit) in plan.edits.iter().enumerate() {
                    check(i + 1)?;
                    self.write_transition(edit)?;
                }
                check(plan.edits.len() + 1)?;
                Ok(())
            })();
            if let Err(error) = result {
                if store.rollback_unlocked(self).is_err() {
                    return Err(Error::RecoveryUncertain);
                }
                return Err(error);
            }
            Ok(())
        })
    }
    #[cfg(not(unix))]
    pub fn apply_workspace_update(
        &self,
        _: &UpdatePlan,
        _: &UpdateStore,
        _: &RecoveryStore,
        _: impl Fn(usize) -> Result<()>,
    ) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
}
