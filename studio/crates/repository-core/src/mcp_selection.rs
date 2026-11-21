//! Host-owned, explicit MCP read/proposal selection. Never manuscript authority.
use crate::{
    recovery::{open_directory, private_metadata},
    Error, Repository, Result,
};
use rustix::fs::{flock, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
const RECORD: &str = "selection-v1.json";
const LIMIT: u64 = 64 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub repository: PathBuf,
    pub scenes: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub project_wide: bool,
    pub proposal_store: PathBuf,
    pub device: u64,
    pub inode: u64,
}
impl Selection {
    pub fn sources(&self) -> Result<Vec<String>> {
        if self.project_wide {
            self.repository()?.mcp_project_sources()
        } else {
            Ok(self.scenes.clone())
        }
    }
    pub fn repository(&self) -> Result<Repository> {
        let repo = Repository::open(&self.repository)?;
        if repo.verified_root_identity()? != (self.device, self.inode) {
            return Err(Error::RecoveryIo);
        }
        Ok(repo)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub schema_version: u32,
    pub generation: String,
    pub selection: Option<Selection>,
}
pub struct SelectionStore {
    path: PathBuf,
    directory: File,
}
impl SelectionStore {
    pub fn open(path: &Path) -> Result<Self> {
        let directory = open_directory(path, true)?;
        private_metadata(&directory, true)?;
        Ok(Self {
            path: path.to_path_buf(),
            directory,
        })
    }
    fn lock(&self) -> Result<File> {
        let current = open_directory(&self.path, false)?;
        private_metadata(&current, true)?;
        let a = current.metadata().map_err(|_| Error::RecoveryIo)?;
        let b = self.directory.metadata().map_err(|_| Error::RecoveryIo)?;
        if (a.dev(), a.ino()) != (b.dev(), b.ino()) {
            return Err(Error::RecoveryIo);
        }
        let file = File::from(
            openat(
                &self.directory,
                "selection.lock",
                OFlags::RDWR
                    | OFlags::CREATE
                    | OFlags::NOFOLLOW
                    | OFlags::NONBLOCK
                    | OFlags::CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| Error::RecoveryIo)?,
        );
        private_metadata(&file, false)?;
        flock(&file, FlockOperation::NonBlockingLockExclusive).map_err(|_| Error::RecoveryIo)?;
        Ok(file)
    }
    fn read_locked(&self) -> Result<Option<State>> {
        let file = match openat(
            &self.directory,
            RECORD,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(_) => return Err(Error::RecoveryIo),
        };
        private_metadata(&file, false)?;
        let mut bytes = vec![];
        file.take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::RecoveryIo)?;
        if bytes.len() as u64 > LIMIT {
            return Err(Error::RecoveryIo);
        }
        let state: State = serde_json::from_slice(&bytes).map_err(|_| Error::RecoveryIo)?;
        if !matches!(state.schema_version, 1 | 2)
            || uuid::Uuid::parse_str(&state.generation).is_err()
        {
            return Err(Error::RecoveryIo);
        }
        if let Some(s) = &state.selection {
            if (s.project_wide && (state.schema_version != 2 || !s.scenes.is_empty()))
                || (!s.project_wide
                    && (state.schema_version != 1 || s.scenes.is_empty() || s.scenes.len() > 128))
                || !s.repository.is_absolute()
                || !s.proposal_store.is_absolute()
                || s.proposal_store.starts_with(&s.repository)
                || s.repository.starts_with(&s.proposal_store)
                || self.path.starts_with(&s.repository)
                || s.repository.starts_with(&self.path)
            {
                return Err(Error::RecoveryIo);
            }
        }
        Ok(Some(state))
    }
    /// Hold the selection lock through a tool call, so revocation and project
    /// changes cannot complete while an older-scope call is still running.
    pub fn with_current<T>(&self, read: impl FnOnce(Option<State>) -> T) -> Result<T> {
        let _lock = self.lock()?;
        Ok(read(self.read_locked()?))
    }
    pub fn load(&self) -> Result<Option<State>> {
        self.with_current(|state| state)
    }
    fn write_locked(&self, selection: Option<Selection>) -> Result<State> {
        self.read_locked()?; // Preserve corrupt or unsupported records for recovery.
        let state = State {
            schema_version: if selection.as_ref().is_some_and(|s| s.project_wide) {
                2
            } else {
                1
            },
            generation: uuid::Uuid::new_v4().to_string(),
            selection,
        };
        let bytes = serde_json::to_vec(&state).map_err(|_| Error::RecoveryIo)?;
        if bytes.len() as u64 > LIMIT {
            return Err(Error::RecoveryIo);
        }
        let name = format!("{}.tmp", uuid::Uuid::new_v4());
        let result = (|| {
            let mut file = File::from(
                openat(
                    &self.directory,
                    name.as_str(),
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map_err(|_| Error::RecoveryIo)?,
            );
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| Error::RecoveryIo)?;
            renameat(&self.directory, name.as_str(), &self.directory, RECORD)
                .map_err(|_| Error::RecoveryIo)?;
            self.directory
                .sync_all()
                .map_err(|_| Error::RecoveryUncertain)?;
            Ok(state)
        })();
        if result.is_err() {
            let _ = unlinkat(&self.directory, name.as_str(), AtFlags::empty());
        }
        result
    }
    pub fn select(
        &self,
        repo: &Repository,
        scenes: Vec<String>,
        proposal_store: &Path,
    ) -> Result<State> {
        self.select_inner(repo, scenes, proposal_store, None)
    }
    pub fn select_checked(
        &self,
        repo: &Repository,
        scenes: Vec<String>,
        proposal_store: &Path,
        expected_generation: Option<&str>,
    ) -> Result<State> {
        self.select_inner(repo, scenes, proposal_store, Some(expected_generation))
    }
    fn select_inner(
        &self,
        repo: &Repository,
        scenes: Vec<String>,
        proposal_store: &Path,
        expected_generation: Option<Option<&str>>,
    ) -> Result<State> {
        let _lock = self.lock()?;
        if let Some(expected) = expected_generation {
            let current = self.read_locked()?;
            if current.as_ref().map(|s| s.generation.as_str()) != expected {
                return Err(Error::Conflict);
            }
        }
        if scenes.is_empty()
            || scenes.len() > 128
            || !proposal_store.is_absolute()
            || proposal_store.starts_with(repo.root())
            || repo.root().starts_with(proposal_store)
            || self.path.starts_with(repo.root())
            || repo.root().starts_with(&self.path)
        {
            return Err(Error::RecoveryIo);
        }
        let mut unique = std::collections::HashSet::new();
        for path in &scenes {
            if !unique.insert(path)
                || !matches!(
                    Path::new(path)
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(str::to_ascii_lowercase)
                        .as_deref(),
                    Some("md" | "markdown")
                )
                || repo.read(path)?.generated_compatibility
            {
                return Err(Error::RecoveryIo);
            }
        }
        let (device, inode) = repo.verified_root_identity()?;
        self.write_locked(Some(Selection {
            repository: repo.root().to_path_buf(),
            scenes,
            project_wide: false,
            proposal_store: proposal_store.to_path_buf(),
            device,
            inode,
        }))
    }
    /// A native author action grants this project, including future saved Markdown.
    /// Existing per-file selections never expand implicitly. Older clients reject v2.
    pub fn select_project_checked(
        &self,
        repo: &Repository,
        proposal_store: &Path,
        expected_generation: Option<&str>,
    ) -> Result<State> {
        let _lock = self.lock()?;
        let current = self.read_locked()?;
        if current.as_ref().map(|s| s.generation.as_str()) != expected_generation {
            return Err(Error::Conflict);
        }
        if !proposal_store.is_absolute()
            || proposal_store.starts_with(repo.root())
            || repo.root().starts_with(proposal_store)
            || self.path.starts_with(repo.root())
            || repo.root().starts_with(&self.path)
        {
            return Err(Error::RecoveryIo);
        }
        repo.mcp_project_sources()?;
        let (device, inode) = repo.verified_root_identity()?;
        self.write_locked(Some(Selection {
            repository: repo.root().to_path_buf(),
            scenes: vec![],
            project_wide: true,
            proposal_store: proposal_store.to_path_buf(),
            device,
            inode,
        }))
    }
    pub fn revoke(&self) -> Result<State> {
        let _lock = self.lock()?;
        self.write_locked(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_restart_switch_revoke_and_root_replacement() {
        let tmp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = tmp.path();
        for name in ["a", "b"] {
            std::fs::create_dir(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("scene.md"), "Exact — 🦊\r\n").unwrap();
        }
        let dir = root.join("selection");
        let s = SelectionStore::open(&dir).unwrap();
        assert!(s.load().unwrap().is_none());
        let a = Repository::open(root.join("a")).unwrap();
        let b = Repository::open(root.join("b")).unwrap();
        let first = s
            .select(&a, vec!["scene.md".into()], &root.join("proposals"))
            .unwrap();
        let reopened = SelectionStore::open(&dir).unwrap();
        s.with_current(|_| assert!(reopened.revoke().is_err()))
            .unwrap();
        assert_eq!(
            reopened.load().unwrap().unwrap().generation,
            first.generation
        );
        let second = s
            .select(&b, vec!["scene.md".into()], &root.join("proposals"))
            .unwrap();
        assert_ne!(first.generation, second.generation);
        let binding = second.selection.unwrap();
        std::fs::rename(root.join("b"), root.join("old-b")).unwrap();
        std::fs::create_dir(root.join("b")).unwrap();
        assert!(binding.repository().is_err());
        s.revoke().unwrap();
        assert!(s
            .select_checked(
                &a,
                vec!["scene.md".into()],
                &root.join("proposals"),
                Some(&first.generation)
            )
            .is_err());
        assert!(reopened.load().unwrap().unwrap().selection.is_none());
        assert_eq!(
            std::fs::read(a.root().join("scene.md")).unwrap(),
            "Exact — 🦊\r\n".as_bytes()
        );
    }
    #[test]
    fn corrupt_symlink_and_repository_overlap_never_expand_access() {
        let tmp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let dir = tmp.path().join("selection");
        let s = SelectionStore::open(&dir).unwrap();
        std::fs::write(dir.join(RECORD), b"bad").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join(RECORD), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(s.load().is_err());
        assert!(s.revoke().is_err());
        assert_eq!(std::fs::read(dir.join(RECORD)).unwrap(), b"bad");
        std::fs::remove_file(dir.join(RECORD)).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("outside"), dir.join(RECORD)).unwrap();
        assert!(s.load().is_err());
        assert!(s.revoke().is_err());
        assert!(!tmp.path().join("outside").exists());
        let repo = Repository::open(tmp.path()).unwrap();
        assert!(s
            .select(
                &repo,
                vec!["scene.md".into()],
                &tmp.path().join("proposals")
            )
            .is_err());
    }
}
