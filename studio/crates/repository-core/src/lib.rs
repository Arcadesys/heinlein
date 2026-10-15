//! Read-only repository access. Native hosts choose roots; renderers receive relative paths only.
//! Unix descriptor-relative opens reject every symlink component, including concurrent swaps.
#[cfg(unix)]
use rustix::{
    fd::OwnedFd,
    fs::{open, openat, Mode, OFlags},
};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    io::Read,
    path::{Path, PathBuf},
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
            Self::Io => "Repository could not be read",
            Self::UnsupportedPlatform => {
                "Read-only repository access currently requires macOS or Linux"
            }
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

pub struct Repository {
    root: PathBuf,
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
        let root = path.to_path_buf();
        Ok(Self { root, fd })
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
            text,
            frontmatter,
            generated_compatibility,
        })
    }
    fn is_generated(&self, path: &str) -> Result<bool> {
        let mut base = parent(path);
        loop {
            let manifest = join(base, "scene-manifest.json")?;
            if self.allowed(&manifest, false).is_ok() {
                match self.raw(&manifest, MAX_MANIFEST_BYTES, false) {
                    Ok(text) => {
                        if let Ok(raw) = serde_json::from_str::<RawManifest>(&text) {
                            if raw.schema_version == 1
                                && raw
                                    .sources
                                    .iter()
                                    .any(|s| join(base, &s.path).as_deref() == Ok(path))
                            {
                                return Ok(true);
                            }
                        }
                    }
                    Err(Error::NotFound) => {}
                    Err(e) => return Err(e),
                }
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
