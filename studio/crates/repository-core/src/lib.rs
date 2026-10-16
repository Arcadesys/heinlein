//! Bounded repository access and explicit, revision-guarded Markdown saves. Native hosts choose roots; renderers receive relative paths only.
//! Unix descriptor-relative opens reject every symlink component, including concurrent swaps.
mod drafting;
#[cfg(all(test, unix))]
mod fuzz_support;
mod recovery;
pub use drafting::{
    DraftingChange, DraftingChangeView, DraftingExternalFile, DraftingGroup, DraftingPlan,
    DraftingPreview, DraftingScene, DraftingState, DraftingUndo,
};
pub use recovery::{RecoveryDraft, RecoveryStore};
#[cfg(unix)]
use rustix::{
    fd::OwnedFd,
    fs::{open, openat, Mode, OFlags},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
const MAX_ENTRIES: usize = 4096;
const MAX_SCAN: usize = 20000;
const MAX_MANUSCRIPT_ITEMS: usize = 10000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Error {
    InvalidPath,
    Denied,
    NotFound,
    NotDirectory,
    NotFile,
    UnsupportedText,
    TooLarge,
    LimitExceeded,
    InvalidManifest,
    Io,
    UnsupportedPlatform,
    Conflict,
    ReadOnly,
    SaveUncertain,
    InvalidRecovery,
    RecoveryIo,
    RecoveryUncertain,
    RecoveryChanged,
    RecoveryBusy,
    DraftingCollision,
    DraftingChanged,
    DraftingPending,
    DraftingUncertain,
    PendingRecovery,
    EditorChanged,
    LegacySceneMove,
    AssetReferences,
    UntrustedTransaction,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidPath => "Invalid repository-relative path",
            Self::Denied => "Path is excluded or is a symbolic link",
            Self::NotFound => "Repository item was not found",
            Self::NotDirectory => "Item is not a directory",
            Self::NotFile => "Item is not a regular file",
            Self::UnsupportedText => "Only UTF-8 text documents are supported",
            Self::TooLarge => "File exceeds the read limit",
            Self::LimitExceeded => "Repository browsing limit exceeded",
            Self::InvalidManifest => "Scene manifest is invalid or unsupported",
            Self::Io => "Repository I/O failed; the draft was not saved",
            Self::Conflict => "Document changed on disk; reload before saving",
            Self::ReadOnly => "This file is read-only. Open a source scene to edit an assembled chapter.",
            Self::SaveUncertain => {
                "Document replaced, but durability could not be confirmed; reload before retrying"
            }
            Self::InvalidRecovery => "Recovery draft is invalid or unsupported; it was not changed",
            Self::RecoveryIo => {
                "Recovery storage is unavailable; the latest edits are not protected"
            }
            Self::RecoveryUncertain => {
                "Recovery storage changed, but durability could not be confirmed"
            }
            Self::RecoveryBusy => {
                "This scene is being edited in another Studio instance; close it before saving here"
            }
            Self::RecoveryChanged => {
                "Recovery draft needs review; reload recovery before saving or discarding"
            }
            Self::DraftingCollision => "A destination already exists; choose a different name or folder",
            Self::DraftingChanged => "The manuscript or files changed; refresh and preview the change again",
            Self::DraftingPending => "An interrupted manuscript change needs explicit rollback before continuing",
            Self::DraftingUncertain => "The manuscript structure may have changed, but completion or rollback durability is uncertain. Refresh before retrying; preserve any remaining transaction journal for recovery",
            Self::UntrustedTransaction => "This transaction journal has no matching private Studio receipt. Automatic rollback is unsafe; preserve the files and journal for manual recovery",
            Self::AssetReferences => "This scene contains link or asset-reference syntax. Copy or reorganize it and its assets manually; Studio will not change its directory or rewrite its bytes",
            Self::LegacySceneMove => "This scene belongs to a legacy manuscript. Copy it or use explicit legacy import; moving it would break the original manifest",
            Self::PendingRecovery => "A scene has a pending recovery draft. Restore or discard it before moving or changing manuscript structure",
            Self::EditorChanged => "The editor changed during author confirmation; preserve its text and review again",
            Self::UnsupportedPlatform => "Repository access currently requires macOS or Linux",
        })
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub text: String,
    pub content_hash: String,
    pub size_bytes: u64,
    pub frontmatter: Option<String>,
    pub generated_compatibility: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manuscript {
    pub path: String,
    pub project: String,
    pub schema_version: u32,
    pub volumes: Vec<Volume>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub number: u32,
    pub title: String,
    pub path: String,
    pub chapters: Vec<Chapter>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub number: u32,
    pub title: String,
    pub path: String,
    pub source: String,
    pub scenes: Vec<Scene>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub path: String,
}
#[derive(Deserialize)]
struct RawManifest {
    schema_version: u32,
    project: String,
    volumes: Vec<RawVolume>,
    #[serde(default)]
    sources: Vec<RawSource>,
}
#[derive(Deserialize)]
struct RawVolume {
    number: u32,
    title: String,
    directory: String,
    chapters: Vec<RawChapter>,
}
#[derive(Deserialize)]
struct RawChapter {
    number: u32,
    title: String,
    directory: String,
    source: String,
    scenes: Vec<String>,
}
#[derive(Deserialize)]
struct RawSource {
    path: String,
}

// Some manifests use `source` as a chapter's entry scene, not an export.
// Explicit output declarations always win; otherwise an in-chapter scene is
// author-controlled source, and a distinct chapter source is assembled output.
fn declares_assembled_path(raw: &RawManifest, base: &str, path: &str) -> bool {
    raw.sources
        .iter()
        .any(|source| join(base, &source.path).as_deref() == Ok(path))
        || raw
            .volumes
            .iter()
            .flat_map(|volume| &volume.chapters)
            .any(|chapter| {
                join(base, &chapter.source).as_deref() == Ok(path)
                    && !chapter
                        .scenes
                        .iter()
                        .any(|scene| join(base, scene).as_deref() == Ok(path))
            })
}

pub struct Repository {
    root: PathBuf,
    save_gate: Mutex<()>,
    #[cfg(unix)]
    fd: OwnedFd,
}
fn parts(path: &str) -> Result<Vec<&str>> {
    if path.len() > 4096
        || path.contains('\\')
        || path.contains(':')
        || path.contains('\0')
        || path.starts_with('/')
    {
        return Err(Error::InvalidPath);
    }
    if path.is_empty() {
        return Ok(vec![]);
    }
    let p: Vec<_> = path.split('/').collect();
    if p.len() > MAX_DEPTH {
        return Err(Error::LimitExceeded);
    }
    if p.iter()
        .any(|s| s.is_empty() || *s == "." || *s == ".." || s.chars().any(char::is_control))
    {
        return Err(Error::InvalidPath);
    }
    Ok(p)
}
fn blocked(s: &str) -> bool {
    let n = s.to_ascii_lowercase();
    n.starts_with('.')
        || n.starts_with("credentials.")
        || n.starts_with("secrets.")
        || matches!(
            n.as_str(),
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "vendor"
                | "__pycache__"
                | "coverage"
                | "secrets"
                | "credentials"
                | "id_rsa"
                | "id_ed25519"
                | "credentials.json"
                | "secrets.json"
                | "credentials.txt"
                | "secrets.txt"
        )
        || n.ends_with(".pem")
        || n.ends_with(".key")
        || n.ends_with(".p12")
        || n.ends_with(".pfx")
        || n.ends_with(".env")
}
fn join(base: &str, child: &str) -> Result<String> {
    parts(child)?;
    if child.is_empty() {
        return Err(Error::InvalidPath);
    }
    let p = if base.is_empty() {
        child.into()
    } else {
        format!("{base}/{child}")
    };
    parts(&p)?;
    Ok(p)
}
fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(p, _)| p)
}
fn text_extension(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| v.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown" | "txt" | "json" | "yaml" | "yml" | "toml" | "rst" | "csv" | "tsv")
    )
}
#[cfg(unix)]
fn errno(e: rustix::io::Errno) -> Error {
    match e {
        rustix::io::Errno::NOENT => Error::NotFound,
        rustix::io::Errno::LOOP => Error::Denied,
        rustix::io::Errno::NOTDIR => Error::Denied,
        _ => Error::Io,
    }
}
impl Repository {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn name(&self) -> String {
        self.root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    }
    /// Stable opaque identity for local preferences/recovery, never an authorization token.
    pub fn project_key(&self) -> String {
        // Root paths are absolute, normalized and opened without following symlinks.
        format!(
            "{:x}",
            Sha256::digest(self.root.as_os_str().as_encoded_bytes())
        )
    }
    #[cfg(unix)]
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        // Root selection is native-host-only. Walk the selection itself with no-follow
        // descriptors, rather than canonicalize-then-open (which has a symlink race).
        if !path.is_absolute() {
            return Err(Error::InvalidPath);
        }
        let mut fd = open(
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(errno)?;
        for component in path.components() {
            match component {
                std::path::Component::RootDir => {}
                std::path::Component::Normal(name) => {
                    fd = openat(
                        &fd,
                        name,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(errno)?;
                }
                _ => return Err(Error::InvalidPath),
            }
        }
        let root = path.canonicalize().map_err(|_| Error::Io)?;
        // Keep durable identity canonical as well as descriptor-bound. A concurrent
        // root replacement must not associate the held repository with another path.
        let held = std::fs::File::from(rustix::io::dup(&fd).map_err(errno)?)
            .metadata()
            .map_err(|_| Error::Io)?;
        let resolved = std::fs::metadata(&root).map_err(|_| Error::Io)?;
        use std::os::unix::fs::MetadataExt;
        if (held.dev(), held.ino()) != (resolved.dev(), resolved.ino()) {
            return Err(Error::Conflict);
        }
        Ok(Self {
            root,
            fd,
            save_gate: Mutex::new(()),
        })
    }
    #[cfg(not(unix))]
    pub fn open(_path: impl AsRef<Path>) -> Result<Self> {
        Err(Error::UnsupportedPlatform)
    }
    #[cfg(unix)]
    fn handle(&self, path: &str, internal: bool) -> Result<std::fs::File> {
        let components = parts(path)?;
        if !internal && components.iter().any(|s| blocked(s)) {
            return Err(Error::Denied);
        }
        let mut fd = rustix::io::dup(&self.fd).map_err(errno)?;
        for (i, component) in components.iter().enumerate() {
            let mut flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK;
            if i + 1 < components.len() {
                flags |= OFlags::DIRECTORY;
            }
            fd = openat(&fd, *component, flags, Mode::empty()).map_err(errno)?;
        }
        Ok(fd.into())
    }
    #[cfg(not(unix))]
    fn handle(&self, _path: &str, _internal: bool) -> Result<std::fs::File> {
        Err(Error::UnsupportedPlatform)
    }
    fn raw(&self, path: &str, max: u64, internal: bool) -> Result<String> {
        let file = self.handle(path, internal)?;
        let meta = file.metadata().map_err(|_| Error::Io)?;
        if !meta.is_file() {
            return Err(Error::NotFile);
        }
        if meta.len() > max {
            return Err(Error::TooLarge);
        }
        let mut bytes = Vec::new();
        file.take(max + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Io)?;
        if bytes.len() as u64 > max {
            return Err(Error::TooLarge);
        }
        if bytes
            .iter()
            .any(|b| *b == 0 || (*b < 32 && !matches!(*b, 9 | 10 | 13)))
        {
            return Err(Error::UnsupportedText);
        }
        String::from_utf8(bytes).map_err(|_| Error::UnsupportedText)
    }
    fn allowed(&self, path: &str, is_dir: bool) -> Result<()> {
        let components = parts(path)?;
        if components.iter().any(|s| blocked(s)) {
            return Err(Error::Denied);
        }
        let mut base = String::new();
        for component in &components {
            let ignore = join(&base, ".gitignore")?;
            match self.raw(&ignore, 64 * 1024, true) {
                Ok(content) => {
                    let mut builder = ignore::gitignore::GitignoreBuilder::new(&base);
                    for line in content.lines() {
                        builder.add_line(None, line).map_err(|_| Error::Denied)?;
                    }
                    let matcher = builder.build().map_err(|_| Error::Denied)?;
                    if matcher
                        .matched_path_or_any_parents(path, is_dir)
                        .is_ignore()
                    {
                        return Err(Error::Denied);
                    }
                }
                Err(Error::NotFound) => {}
                Err(_) => return Err(Error::Denied),
            }
            base = join(&base, component)?;
        }
        Ok(())
    }
    pub fn list(&self, path: &str) -> Result<Vec<Entry>> {
        self.allowed(path, true)?;
        let file = self.handle(path, false)?;
        if !file.metadata().map_err(|_| Error::Io)?.is_dir() {
            return Err(Error::NotDirectory);
        }
        self.list_handle(path, &file)
    }
    #[cfg(unix)]
    fn list_handle(&self, path: &str, file: &std::fs::File) -> Result<Vec<Entry>> {
        let mut entries = Vec::new();
        let dir = rustix::fs::Dir::read_from(file).map_err(errno)?;
        for (count, entry) in dir.enumerate() {
            if count >= MAX_ENTRIES {
                return Err(Error::LimitExceeded);
            }
            let entry = entry.map_err(errno)?;
            let Ok(name) = entry.file_name().to_str() else {
                continue;
            };
            if name == "." || name == ".." || blocked(name) {
                continue;
            }
            let Ok(relative) = join(path, name) else {
                continue;
            };
            let Ok(handle) = self.handle(&relative, false) else {
                continue;
            };
            let meta = handle.metadata().map_err(|_| Error::Io)?;
            if !meta.is_file() && !meta.is_dir() {
                continue;
            }
            if self.allowed(&relative, meta.is_dir()).is_err() {
                continue;
            }
            entries.push(Entry {
                path: relative,
                name: name.into(),
                kind: if meta.is_dir() { "directory" } else { "file" }.into(),
                size_bytes: if meta.is_file() { meta.len() } else { 0 },
            });
        }
        entries.sort_by(|a, b| {
            (a.kind != "directory", a.name.to_lowercase(), &a.name).cmp(&(
                b.kind != "directory",
                b.name.to_lowercase(),
                &b.name,
            ))
        });
        Ok(entries)
    }
    #[cfg(not(unix))]
    fn list_handle(&self, _path: &str, _file: &std::fs::File) -> Result<Vec<Entry>> {
        Err(Error::UnsupportedPlatform)
    }
    pub fn read(&self, path: &str) -> Result<Document> {
        self.allowed(path, false)?;
        if !text_extension(path) {
            return Err(Error::UnsupportedText);
        }
        let text = self.raw(path, MAX_FILE_BYTES, false)?;
        let frontmatter = frontmatter(&text);
        let generated_compatibility = self.is_generated(path)?;
        Ok(Document {
            path: path.into(),
            size_bytes: text.len() as u64,
            content_hash: content_hash(&text),
            text,
            frontmatter,
            generated_compatibility,
        })
    }
    /// Save only the exact author-provided UTF-8 bytes. No Markdown/YAML reserialization.
    /// The native host serializes access; the mutex additionally serializes callers of this core.
    pub fn save(&self, path: &str, expected_hash: &str, text: &str) -> Result<Document> {
        let _save = self.save_gate.lock().map_err(|_| Error::Io)?;
        self.save_inner(path, expected_hash, text, || Ok(()))
    }
    /// Author-confirmed whole-scene operations must reject all pending recovery.
    /// Keep the normal lock order: repository save gate, then recovery gate. Never
    /// call `save` from inside `RecoveryStore::with_clean_paths` (lock inversion).
    /// Ordinary typing still uses `save_with_recovery` so staging stays concurrent.
    pub fn save_with_clean_recovery(
        &self,
        path: &str,
        expected_hash: &str,
        text: &str,
        recovery: &RecoveryStore,
    ) -> Result<Document> {
        self.save_with_clean_recovery_checked(path, expected_hash, text, recovery, || Ok(()))
    }
    /// Recheck live native editor authority after temporary-file fsync and before
    /// commit, while retaining the same repository-then-recovery lock order.
    pub fn save_with_clean_recovery_checked(
        &self,
        path: &str,
        expected_hash: &str,
        text: &str,
        recovery: &RecoveryStore,
        before_commit: impl FnOnce() -> Result<()>,
    ) -> Result<Document> {
        let _save = self.save_gate.lock().map_err(|_| Error::Io)?;
        recovery.with_clean_paths(self, &[path.to_owned()], || {
            self.save_inner(path, expected_hash, text, before_commit)
        })
    }
    /// Native save route also observes process-lifetime scene ownership.
    pub fn save_with_recovery(
        &self,
        path: &str,
        expected_hash: &str,
        text: &str,
        recovery: &RecoveryStore,
    ) -> Result<Document> {
        self.save_with_recovery_inner(path, expected_hash, text, recovery, || Ok(()))
    }
    fn save_with_recovery_inner(
        &self,
        path: &str,
        expected_hash: &str,
        text: &str,
        recovery: &RecoveryStore,
        before_commit: impl FnOnce() -> Result<()>,
    ) -> Result<Document> {
        let _save = self.save_gate.lock().map_err(|_| Error::Io)?;
        recovery.with_owned_scene(self, path, || {
            self.save_inner(path, expected_hash, text, before_commit)
        })
    }
    fn save_inner(
        &self,
        path: &str,
        expected_hash: &str,
        text: &str,
        before_commit: impl FnOnce() -> Result<()>,
    ) -> Result<Document> {
        self.require_clean_structure()?;
        self.allowed(path, false)?;
        if !matches!(
            Path::new(path)
                .extension()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("md" | "markdown")
        ) {
            return Err(Error::ReadOnly);
        }
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(Error::TooLarge);
        }
        if text
            .bytes()
            .any(|b| b == 0 || (b < 32 && !matches!(b, 9 | 10 | 13)))
        {
            return Err(Error::UnsupportedText);
        }
        // Unknown or malformed nearby manifest metadata is not permission to mutate.
        self.check_write_manifests(path)?;
        let current = self.read(path)?;
        if current.generated_compatibility {
            return Err(Error::ReadOnly);
        }
        if current.content_hash != expected_hash {
            return Err(Error::Conflict);
        }
        if current.text == text {
            return Ok(current);
        }
        self.replace(path, expected_hash, text, before_commit)?;
        Ok(Document {
            path: path.into(),
            text: text.into(),
            content_hash: content_hash(text),
            size_bytes: text.len() as u64,
            frontmatter: frontmatter(text),
            generated_compatibility: false,
        })
    }
    fn check_write_manifests(&self, path: &str) -> Result<()> {
        let mut base = parent(path);
        loop {
            let manifest = join(base, "scene-manifest.json")?;
            // Ignore rules cannot hide authority metadata from the write boundary.
            match self.raw(&manifest, MAX_MANIFEST_BYTES, true) {
                Ok(text) => {
                    let raw: RawManifest =
                        serde_json::from_str(&text).map_err(|_| Error::InvalidManifest)?;
                    if raw.schema_version != 1 {
                        return Err(Error::InvalidManifest);
                    }
                    if declares_assembled_path(&raw, base, path) {
                        return Err(Error::ReadOnly);
                    }
                }
                Err(Error::NotFound) => {}
                Err(e) => return Err(e),
            }
            if base.is_empty() {
                break;
            }
            base = parent(base);
        }
        Ok(())
    }
    #[cfg(unix)]
    fn replace(
        &self,
        path: &str,
        expected_hash: &str,
        text: &str,
        before_commit: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        use rustix::fs::{fchmod, renameat, unlinkat, AtFlags};
        use std::os::unix::fs::MetadataExt;
        let directory = self.handle(parent(path), false)?;
        let name = parts(path)?.pop().ok_or(Error::InvalidPath)?;
        let original = self.handle(path, false)?;
        let metadata = original.metadata().map_err(|_| Error::Io)?;
        if !metadata.is_file() {
            return Err(Error::NotFile);
        }
        // Do not let atomic rename silently bypass the original file's read-only mode.
        if metadata.mode() & 0o222 == 0 {
            return Err(Error::Denied);
        }
        let temporary = format!(".heinlein-save-{}.tmp", uuid::Uuid::new_v4());
        let fd = openat(
            &directory,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(errno)?;
        let mut file = std::fs::File::from(fd);
        let result = (|| {
            file.write_all(text.as_bytes()).map_err(|_| Error::Io)?;
            fchmod(
                &file,
                Mode::from_bits_truncate((metadata.mode() & 0o777) as _),
            )
            .map_err(errno)?;
            file.sync_all().map_err(|_| Error::Io)?;
            before_commit()?;
            self.allowed(path, false)?;
            self.check_write_manifests(path)?;
            let resolved_directory = self
                .handle(parent(path), false)?
                .metadata()
                .map_err(|_| Error::Io)?;
            let held_directory = directory.metadata().map_err(|_| Error::Io)?;
            if (resolved_directory.dev(), resolved_directory.ino())
                != (held_directory.dev(), held_directory.ino())
            {
                return Err(Error::Conflict);
            }
            // Recheck after staging, immediately before the atomic replacement.
            let latest = self.read(path)?;
            let latest_meta = self
                .handle(path, false)?
                .metadata()
                .map_err(|_| Error::Io)?;
            if latest.content_hash != expected_hash
                || (latest_meta.dev(), latest_meta.ino()) != (metadata.dev(), metadata.ino())
            {
                return Err(Error::Conflict);
            }
            renameat(&directory, temporary.as_str(), &directory, name).map_err(errno)?;
            directory.sync_all().map_err(|_| Error::SaveUncertain)?;
            Ok(())
        })();
        // After rename this name is absent. Before rename, failures never touch the original.
        let _ = unlinkat(&directory, temporary.as_str(), AtFlags::empty());
        result
    }
    #[cfg(not(unix))]
    fn replace(
        &self,
        _path: &str,
        _expected_hash: &str,
        _text: &str,
        _before_commit: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
    fn is_generated(&self, path: &str) -> Result<bool> {
        let mut base = parent(path);
        loop {
            let manifest = join(base, "scene-manifest.json")?;
            // Authority metadata remains relevant even when hidden from browsing.
            match self.raw(&manifest, MAX_MANIFEST_BYTES, true) {
                Ok(text) => {
                    if let Ok(raw) = serde_json::from_str::<RawManifest>(&text) {
                        if raw.schema_version == 1 && declares_assembled_path(&raw, base, path) {
                            return Ok(true);
                        }
                    }
                }
                Err(Error::NotFound) => {}
                Err(e) => return Err(e),
            }
            if base.is_empty() {
                break;
            }
            base = parent(base);
        }
        Ok(false)
    }
    pub fn discover(&self) -> Result<Vec<String>> {
        let mut pending = vec![String::new()];
        let mut found = Vec::new();
        let mut count = 0;
        while let Some(path) = pending.pop() {
            for entry in self.list(&path)? {
                count += 1;
                if count > MAX_SCAN {
                    return Err(Error::LimitExceeded);
                }
                if entry.kind == "directory" {
                    if parts(&entry.path)?.len() >= MAX_DEPTH {
                        return Err(Error::LimitExceeded);
                    }
                    pending.push(entry.path);
                } else if entry.name == "scene-manifest.json" {
                    found.push(entry.path)
                }
            }
        }
        found.sort();
        Ok(found)
    }
    pub fn manuscript(&self, path: &str) -> Result<Manuscript> {
        self.allowed(path, false)?;
        if Path::new(path).file_name().and_then(|p| p.to_str()) != Some("scene-manifest.json") {
            return Err(Error::InvalidManifest);
        }
        let text = self.raw(path, MAX_MANIFEST_BYTES, false)?;
        let raw: RawManifest = serde_json::from_str(&text).map_err(|_| Error::InvalidManifest)?;
        if raw.schema_version != 1 || raw.project.len() > 4096 {
            return Err(Error::InvalidManifest);
        }
        let base = parent(path);
        let mut count = 0;
        let mut volumes = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for v in raw.volumes {
            count += 1;
            let vp = self.manifest_item(base, &v.directory, true)?;
            let mut chapters = Vec::new();
            for c in v.chapters {
                count += 1;
                let cp = self.manifest_item(base, &c.directory, true)?;
                let source = self.manifest_item(base, &c.source, false)?;
                let mut scenes = Vec::new();
                for scene in c.scenes {
                    count += 1;
                    if count > MAX_MANUSCRIPT_ITEMS {
                        return Err(Error::LimitExceeded);
                    }
                    let sp = self.manifest_item(base, &scene, false)?;
                    if !sp.starts_with(&format!("{cp}/")) || !seen.insert(sp.clone()) {
                        return Err(Error::InvalidManifest);
                    }
                    scenes.push(Scene { path: sp });
                }
                if !cp.starts_with(&format!("{vp}/")) {
                    return Err(Error::InvalidManifest);
                }
                chapters.push(Chapter {
                    number: c.number,
                    title: c.title,
                    path: cp,
                    source,
                    scenes,
                });
            }
            if count > MAX_MANUSCRIPT_ITEMS {
                return Err(Error::LimitExceeded);
            }
            volumes.push(Volume {
                number: v.number,
                title: v.title,
                path: vp,
                chapters,
            });
        }
        Ok(Manuscript {
            path: path.into(),
            project: raw.project,
            schema_version: raw.schema_version,
            volumes,
        })
    }
    fn manifest_item(&self, base: &str, path: &str, is_dir: bool) -> Result<String> {
        let p = join(base, path)?;
        self.allowed(&p, is_dir)?;
        let meta = self.handle(&p, false)?.metadata().map_err(|_| Error::Io)?;
        if is_dir && !meta.is_dir() {
            return Err(Error::NotDirectory);
        }
        if !is_dir && (!meta.is_file() || !text_extension(&p)) {
            return Err(Error::UnsupportedText);
        }
        if !is_dir && meta.len() > MAX_FILE_BYTES {
            return Err(Error::TooLarge);
        }
        Ok(p)
    }
}
fn frontmatter(text: &str) -> Option<String> {
    let mut lines = text.split_inclusive('\n');
    if lines.next()?.trim_end_matches(['\r', '\n']) != "---" {
        return None;
    }
    let mut raw = String::new();
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some(raw);
        }
        raw.push_str(line);
        if raw.len() > 64 * 1024 {
            return None;
        }
    }
    None
}

fn content_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

#[cfg(all(test, unix))]
mod save_failure_tests {
    use super::*;
    #[test]
    fn staged_write_failure_leaves_original_and_cleans_temporary() {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = dir.path().join("scene.md");
        std::fs::write(&path, "Original—safe.\r\n").unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        let doc = repo.read("scene.md").unwrap();
        assert_eq!(
            repo.save_inner("scene.md", &doc.content_hash, "Edited", || Err(Error::Io))
                .unwrap_err(),
            Error::Io
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), doc.text);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn newer_recovery_can_stage_while_manuscript_save_is_pending() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("repository");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("scene.md"), "Original").unwrap();
        let repo = Repository::open(&root).unwrap();
        let store = RecoveryStore::open(temp.path().join("recovery")).unwrap();
        let hash = repo.read("scene.md").unwrap().content_hash;
        let first = store.stage(&repo, "scene.md", &hash, "First edit").unwrap();
        repo.save_with_recovery_inner("scene.md", &hash, &first.text, &store, || {
            store.stage(&repo, "scene.md", &hash, "Second edit while save pending")?;
            Ok(())
        })
        .unwrap();
        assert_eq!(repo.read("scene.md").unwrap().text, "First edit");
        assert_eq!(
            store.discard(&repo, "scene.md", &first.id).unwrap_err(),
            Error::RecoveryChanged
        );
        assert_eq!(
            store.read(&repo, "scene.md").unwrap().unwrap().text,
            "Second edit while save pending"
        );
    }
    #[test]
    fn external_edit_during_staging_is_not_overwritten() {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = dir.path().join("scene.md");
        std::fs::write(&path, "Original").unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        let doc = repo.read("scene.md").unwrap();
        let result = repo.save_inner("scene.md", &doc.content_hash, "Edited", || {
            std::fs::write(&path, "External").unwrap();
            Ok(())
        });
        assert_eq!(result.unwrap_err(), Error::Conflict);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "External");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
