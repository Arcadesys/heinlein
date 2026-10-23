//! Native-selected destinations. No overwrite, no source edits, no network.
use crate::{LiteralScene, RecoveryStore, Repository};
use rustix::fs::{
    linkat, mkdirat, openat, renameat_with, unlinkat, AtFlags, Mode, OFlags, RenameFlags,
};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};
type Result<T> = std::result::Result<T, String>;
fn failure() -> String {
    "The destination could not be safely written. Your standalone draft is retained. Check the destination before trying again.".into()
}
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 240
        && !matches!(name, "." | "..")
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control)
}
/// Retains the selected parent inode; private paths are excluded by the native host.
pub struct DraftDestination {
    directory: File,
    parent: PathBuf,
    name: String,
}
impl DraftDestination {
    pub fn open(path: &Path) -> Result<Self> {
        let parent = path.parent().ok_or_else(failure)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(failure)?;
        if !safe_name(name) {
            return Err("Choose a new plain filename or folder name.".into());
        }
        let directory = crate::recovery::open_directory(parent, false).map_err(|_| failure())?;
        Ok(Self {
            directory,
            parent: parent.into(),
            name: name.into(),
        })
    }
    pub fn path(&self) -> PathBuf {
        self.parent.join(&self.name)
    }
    fn check(&self) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        let current =
            crate::recovery::open_directory(&self.parent, false).map_err(|_| failure())?;
        let a = current.metadata().map_err(|_| failure())?;
        let b = self.directory.metadata().map_err(|_| failure())?;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return Err(failure());
        }
        Ok(())
    }
    fn absent(&self) -> Result<()> {
        match rustix::fs::statat(
            &self.directory,
            self.name.as_str(),
            AtFlags::SYMLINK_NOFOLLOW,
        ) {
            Err(rustix::io::Errno::NOENT) => Ok(()),
            _ => Err(
                "That destination already exists. Choose a new name; nothing was overwritten."
                    .into(),
            ),
        }
    }
    pub fn verify_file(&self, expected_hash: &str) -> Result<()> {
        self.check()?;
        let fd = openat(
            &self.directory,
            self.name.as_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| failure())?;
        let file = File::from(fd);
        if !file.metadata().map_err(|_| failure())?.is_file() {
            return Err(failure());
        }
        let mut text = String::new();
        file.take((super::standalone::MAX_DRAFT_BYTES as u64) + 1)
            .read_to_string(&mut text)
            .map_err(|_| failure())?;
        if text.len() > super::standalone::MAX_DRAFT_BYTES
            || crate::content_hash(&text) != expected_hash
        {
            return Err("The placed file does not match the captured draft. The original is retained; do not retry blindly.".into());
        }
        Ok(())
    }
    pub fn write_file(&self, text: &str, guard: impl Fn() -> Result<()>) -> Result<()> {
        self.check()?;
        self.absent()?;
        // Missing paths declared as generated compatibility output are still protected.
        for root in self.parent.ancestors() {
            let repo = Repository::open(root).map_err(|_| failure())?;
            let path = self.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| failure())?
                .to_str()
                .ok_or_else(failure)?;
            repo.check_write_manifests(relative)
                .map_err(|e| e.to_string())?;
        }
        let temporary = format!(".heinlein-draft-{}.tmp", uuid::Uuid::new_v4());
        let result = (|| {
            let fd = openat(
                &self.directory,
                temporary.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map_err(|_| failure())?;
            let mut file = File::from(fd);
            file.write_all(text.as_bytes()).map_err(|_| failure())?;
            file.sync_all().map_err(|_| failure())?;
            guard()?;
            self.check()?;
            linkat(&self.directory,temporary.as_str(),&self.directory,self.name.as_str(),AtFlags::empty()).map_err(|_|"The destination appeared while placing. Nothing was overwritten; check the existing file.".to_string())?;
            unlinkat(&self.directory, temporary.as_str(), AtFlags::empty())
                .map_err(|_| failure())?;
            self.directory.sync_all().map_err(|_|"The copy may exist, but disk durability is uncertain. Keep the original and check placement.".to_string())?;
            self.verify_file(&crate::content_hash(text))
        })();
        let _ = unlinkat(&self.directory, temporary.as_str(), AtFlags::empty());
        result
    }
    /// Publish a complete new project only after its exact scene+manifest transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn write_project(
        &self,
        project: &str,
        title: &str,
        file_name: &str,
        text: &str,
        scene_id: &str,
        recovery: &RecoveryStore,
        guard: impl Fn() -> Result<()>,
    ) -> Result<()> {
        self.check()?;
        self.absent()?;
        if !safe_name(file_name) {
            return Err("Choose a plain Markdown scene filename.".into());
        }
        let stage = format!(".heinlein-project-{}", uuid::Uuid::new_v4());
        mkdirat(&self.directory, stage.as_str(), Mode::from_raw_mode(0o700))
            .map_err(|_| failure())?;
        // A crash may leave this bounded unpublished stage; it is never mistaken for
        // the destination or removed with an unbounded recursive delete.
        let repo = Repository::open(self.parent.join(&stage)).map_err(|e| e.to_string())?;
        let scene = LiteralScene {
            id: scene_id.into(),
            title: title.into(),
            path: format!("ms/{file_name}"),
            text: text.into(),
        };
        let plan = repo
            .preview_literal_scene(None, Some(project.into()), scene, recovery)
            .map_err(|e| e.to_string())?;
        guard()?;
        repo.apply_drafting(&plan, recovery)
            .map_err(|e| e.to_string())?;
        verify_scene(
            &repo,
            &format!("ms/{file_name}"),
            scene_id,
            &crate::content_hash(text),
        )?;
        guard()?;
        self.check()?;
        renameat_with(&self.directory,stage.as_str(),&self.directory,self.name.as_str(),RenameFlags::NOREPLACE).map_err(|_|"The new project destination appeared or could not be published. The original draft and unpublished stage are retained; check placement.".to_string())?;
        self.directory.sync_all().map_err(|_|"The project may exist, but its disk durability is uncertain. Check placement before retrying.".to_string())?;
        let repo = Repository::open(self.path()).map_err(|e| e.to_string())?;
        verify_scene(
            &repo,
            &format!("ms/{file_name}"),
            scene_id,
            &crate::content_hash(text),
        )
    }
}
pub fn verify_scene(repo: &Repository, path: &str, scene_id: &str, hash: &str) -> Result<()> {
    let d = repo.read(path).map_err(|e| e.to_string())?;
    let state = repo.load_drafting().map_err(|e| e.to_string())?;
    if d.content_hash != hash
        || d.generated_compatibility
        || state.recovery_required
        || !state
            .scenes
            .iter()
            .any(|s| s.id == scene_id && s.path == path)
    {
        return Err("The placed scene or manuscript index could not be verified. The original draft is retained; resolve destination recovery before retrying.".into());
    }
    Ok(())
}
