use crate::{uuid_id, Error, RepoInfo, Result};
#[cfg(unix)]
use rustix::fs::{
    flock, mkdirat, open, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
/// Private descriptor-anchored records; locks never get unlinked or replaced.
pub struct StateDir {
    path: PathBuf,
    fd: File,
}
pub struct Lock(File);
impl Drop for Lock {
    fn drop(&mut self) {
        #[cfg(unix)]
        let _ = flock(&self.0, FlockOperation::Unlock);
    }
}
impl StateDir {
    #[cfg(unix)]
    pub fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            return Err(Error::Storage);
        }
        let mut fd = File::from(
            open(
                "/",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| Error::Storage)?,
        );
        for part in path.components() {
            if let std::path::Component::Normal(name) = part {
                match mkdirat(&fd, name, Mode::from_bits_truncate(0o700)) {
                    Ok(()) => {}
                    Err(e) if e == rustix::io::Errno::EXIST => {}
                    _ => return Err(Error::Storage),
                }
                fd = File::from(
                    openat(
                        &fd,
                        name,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(|_| Error::Storage)?,
                );
            }
        }
        let value = Self {
            path: path.to_owned(),
            fd,
        };
        value.check()?;
        Ok(value)
    }
    #[cfg(not(unix))]
    pub fn open(_: &Path) -> Result<Self> {
        Err(Error::Unsupported)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn child(&self, id: &str) -> Result<Self> {
        uuid_id(id)?;
        self.check()?;
        Self::open(&self.path.join(id))
    }
    pub fn check(&self) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let a = self.fd.metadata()?;
            // Re-open every ancestor without following symlinks, not just the
            // leaf. Keep all reads/writes bound to the originally opened inode.
            let mut current = File::from(
                open(
                    "/",
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| Error::Storage)?,
            );
            for part in self.path.components() {
                if let std::path::Component::Normal(name) = part {
                    current = File::from(
                        openat(
                            &current,
                            name,
                            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                            Mode::empty(),
                        )
                        .map_err(|_| Error::Storage)?,
                    );
                }
            }
            let b = current.metadata()?;
            if !b.is_dir()
                || a.ino() != b.ino()
                || a.dev() != b.dev()
                || b.uid() != rustix::process::geteuid().as_raw()
                || b.mode() & 0o077 != 0
            {
                return Err(Error::Storage);
            }
        }
        Ok(())
    }
    fn name(name: &str) -> Result<()> {
        if name.is_empty()
            || name.len() > 128
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
            || name == ".."
            || name == "."
        {
            Err(Error::Storage)
        } else {
            Ok(())
        }
    }
    #[cfg(unix)]
    pub fn lock(&self, name: &str) -> Result<Lock> {
        Self::name(name)?;
        self.check()?;
        let fd = File::from(
            openat(
                &self.fd,
                name,
                OFlags::RDWR
                    | OFlags::CREATE
                    | OFlags::NOFOLLOW
                    | OFlags::CLOEXEC
                    | OFlags::NONBLOCK,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| Error::Storage)?,
        );
        if !fd.metadata()?.is_file() {
            return Err(Error::Storage);
        }
        flock(&fd, FlockOperation::NonBlockingLockExclusive).map_err(|_| Error::Busy)?;
        self.check()?;
        Ok(Lock(fd))
    }
    #[cfg(not(unix))]
    pub fn lock(&self, _: &str) -> Result<Lock> {
        Err(Error::Unsupported)
    }
    #[cfg(unix)]
    pub fn read<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        Self::name(name)?;
        self.check()?;
        let fd = match openat(
            &self.fd,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(f) => File::from(f),
            Err(e) if e == rustix::io::Errno::NOENT => return Ok(None),
            _ => return Err(Error::Storage),
        };
        if !fd.metadata()?.is_file() || fd.metadata()?.len() > 8 * 1024 * 1024 {
            return Err(Error::Storage);
        }
        let mut bytes = Vec::new();
        fd.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        self.check()?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(Error::Storage);
        }
        Ok(Some(serde_json::from_slice(&bytes)?))
    }
    #[cfg(not(unix))]
    pub fn read<T: DeserializeOwned>(&self, _: &str) -> Result<Option<T>> {
        Err(Error::Unsupported)
    }
    pub fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        self.write_bytes(name, &serde_json::to_vec(value)?)
    }
    #[cfg(unix)]
    pub fn write_bytes(&self, name: &str, bytes: &[u8]) -> Result<()> {
        Self::name(name)?;
        self.check()?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(Error::Limit);
        }
        let temp = format!("stage-{}", uuid::Uuid::new_v4());
        let result = (|| {
            let mut f = File::from(
                openat(
                    &self.fd,
                    temp.as_str(),
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map_err(|_| Error::Storage)?,
            );
            f.write_all(bytes)?;
            f.sync_all()?;
            self.check()?;
            renameat(&self.fd, temp.as_str(), &self.fd, name).map_err(|_| Error::Storage)?;
            self.fd.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = unlinkat(&self.fd, temp.as_str(), AtFlags::empty());
        }
        result
    }
    #[cfg(not(unix))]
    pub fn write_bytes(&self, _: &str, _: &[u8]) -> Result<()> {
        Err(Error::Unsupported)
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub repo: RepoInfo,
    pub account_id: u64,
    pub auth_binding: String,
    pub base_oid: String,
    pub head_oid: String,
    pub remote_oid: Option<String>,
    pub branch: String,
    pub pr: Option<PullRequest>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub merged: bool,
    pub draft: bool,
    pub head: String,
    pub base: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u8,
    workspaces: Vec<Workspace>,
}
pub struct Registry {
    pub state: StateDir,
    sources: PathBuf,
}
impl Registry {
    pub fn open(state: &Path, sources: &Path) -> Result<Self> {
        let state = StateDir::open(state)?;
        let sources = StateDir::open(sources)?;
        if state.path().starts_with(sources.path()) || sources.path().starts_with(state.path()) {
            return Err(Error::Storage);
        }
        Ok(Self {
            state,
            sources: sources.path().to_owned(),
        })
    }
    pub fn list(&self) -> Result<Vec<Workspace>> {
        let _lock = self.state.lock("catalog.lock")?;
        self.read()
    }
    fn read(&self) -> Result<Vec<Workspace>> {
        let c = self
            .state
            .read::<Catalog>("registry-v1.json")?
            .unwrap_or(Catalog {
                version: 1,
                workspaces: vec![],
            });
        if c.version != 1 || c.workspaces.len() > 128 {
            return Err(Error::Storage);
        }
        let mut ids = std::collections::HashSet::new();
        for w in &c.workspaces {
            uuid_id(&w.id)?;
            uuid_id(&w.auth_binding)?;
            w.repo.validate()?;
            crate::transport::valid_ref(&w.branch)?;
            git2::Oid::from_str(&w.head_oid)?;
            git2::Oid::from_str(&w.base_oid)?;
            if w.account_id == 0 || !ids.insert(w.id.clone()) {
                return Err(Error::Storage);
            }
        }
        Ok(c.workspaces)
    }
    pub fn get(&self, id: &str) -> Result<Workspace> {
        uuid_id(id)?;
        self.list()?
            .into_iter()
            .find(|w| w.id == id)
            .ok_or(Error::Missing)
    }
    pub fn save(&self, w: &Workspace) -> Result<()> {
        uuid_id(&w.id)?;
        let _lock = self.state.lock("catalog.lock")?;
        let mut all = self.read()?;
        if let Some(old) = all.iter_mut().find(|old| old.id == w.id) {
            if old.repo.id != w.repo.id {
                return Err(Error::Changed);
            }
            *old = w.clone()
        } else {
            all.push(w.clone())
        }
        self.state.write(
            "registry-v1.json",
            &Catalog {
                version: 1,
                workspaces: all,
            },
        )
    }
    pub fn directory(&self, id: &str) -> Result<StateDir> {
        self.state.child(id)
    }
    pub fn checkout(&self, id: &str) -> Result<PathBuf> {
        uuid_id(id)?;
        Ok(self.sources.join(id))
    }
    pub fn reopen(&self, id: &str) -> Result<(Workspace, git2::Repository)> {
        let w = self.get(id)?;
        let dir = self.directory(id)?;
        if crate::incoming::pending(self, id)?
            || crate::operations::branch_pending(self, id)?
            || crate::journal::receipts(&dir)?
                .iter()
                .any(|r| r.kind == "version" && r.status == "prepared")
        {
            return Err(Error::Recovery);
        }
        let source = self.checkout(id)?;
        if !source.is_dir() || fs::symlink_metadata(&source)?.file_type().is_symlink() {
            return Err(Error::Missing);
        }
        let repo = crate::transport::open(&dir, &source)?;
        if repo.head()?.target().map(|o| o.to_string()).as_deref() != Some(&w.head_oid)
            || repo.head()?.name()? != format!("refs/heads/{}", w.branch)
        {
            return Err(Error::Recovery);
        }
        Ok((w, repo))
    }
    pub fn register(
        &self,
        info: RepoInfo,
        account_id: u64,
        binding: &str,
        fetch: impl FnOnce(&git2::Repository) -> Result<git2::Oid>,
    ) -> Result<Workspace> {
        info.validate()?;
        uuid_id(binding)?;
        if account_id == 0 {
            return Err(Error::Account);
        }
        if let Some(w) = self.list()?.into_iter().find(|w| w.repo.id == info.id) {
            if w.account_id != account_id || w.auth_binding != binding {
                return Err(Error::Account);
            }
            if w.repo != info {
                return Err(Error::Changed);
            }
            return Ok(self.reopen(&w.id)?.0);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let private = self.directory(&id)?;
        let _lock = private.lock("workspace.lock")?;
        let stage = self.sources.join(format!("opening-{id}"));
        fs::create_dir(&stage)?;
        let result = (|| {
            let repo = crate::transport::initialize(&private, &stage)?;
            let base = fetch(&repo)?;
            let tree = crate::transport::tree_files(&repo, base)?;
            crate::transport::materialize(&stage, &tree)?;
            let branch = format!("heinlein/story-{id}");
            repo.reference(
                &format!("refs/heads/{branch}"),
                base,
                false,
                "New author workspace",
            )?;
            repo.set_head(&format!("refs/heads/{branch}"))?;
            let source = self.checkout(&id)?;
            fs::rename(&stage, &source)?;
            let repo = crate::transport::open(&private, &source)?;
            drop(repo);
            let w = Workspace {
                id: id.clone(),
                repo: info,
                account_id,
                auth_binding: binding.into(),
                base_oid: base.to_string(),
                head_oid: base.to_string(),
                remote_oid: None,
                branch,
                pr: None,
            };
            self.save(&w)?;
            Ok(w)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&stage);
        }
        result
    }
}
