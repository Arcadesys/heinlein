//! Host-private standalone documents. These are not repositories or manuscripts.
//! Text is acknowledged only after descriptor-relative, fsynced publication.
#[cfg(unix)]
use rustix::fs::{
    flock, linkat, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
thread_local! {static FAULT:std::cell::RefCell<Option<(String,String)>>=const{std::cell::RefCell::new(None)};}
#[cfg(test)]
fn fault(name: &str, stage: &str) -> Result<()> {
    FAULT.with(|f| {
        if f.borrow()
            .as_ref()
            .is_some_and(|v| v.0 == name && v.1 == stage)
        {
            Err(error())
        } else {
            Ok(())
        }
    })
}
type Result<T> = std::result::Result<T, String>;
// Independent of the 2 MiB project-file limit. Resource failures never evict text.
pub const MAX_DRAFT_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = (MAX_DRAFT_BYTES as u64) * 6 + 1024 * 1024;
fn error() -> String {
    "Local draft storage is unavailable. Keep this window open; your last kept version is preserved.".into()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}
/// Location metadata is read-only evidence, not authority to write a destination.
fn project_location(
    kind: &str,
    destination: &str,
    root: Option<&str>,
    relative: Option<&str>,
) -> Result<Option<(PathBuf, String)>> {
    if kind == "file" {
        return if root.is_none() && relative.is_none() {
            Ok(None)
        } else {
            Err(error())
        };
    }
    let path = Path::new(destination);
    let (root, relative) = match (root, relative) {
        (Some(root), Some(relative)) => (PathBuf::from(root), relative.to_string()),
        (None, None) => {
            // Compatibility for earlier plain ms/file receipts. Never guess a root for
            // an older nested receipt that did not retain its selected project identity.
            let parent=path.parent().filter(|p|p.file_name()==Some(std::ffi::OsStr::new("ms"))).ok_or("This older placement has no verified project root. The original is retained; inspect the copy before retrying.")?;
            let root = parent.parent().ok_or_else(error)?.to_path_buf();
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(error)?;
            (root, format!("ms/{name}"))
        }
        _ => return Err(error()),
    };
    if !root.is_absolute()
        || root.as_os_str().len() > 4096
        || root.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        || relative.len() > 4096
        || !relative.starts_with("ms/")
        || relative.contains(['\\', ':'])
        || relative.chars().any(char::is_control)
        || relative
            .split('/')
            .any(|s| s.is_empty() || matches!(s, "." | ".."))
        || root.join(&relative) != path
    {
        return Err(error());
    }
    Ok(Some((root, relative)))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementReceipt {
    pub id: String,
    pub kind: String,
    pub destination: String,
    pub source_revision: u64,
    pub source_hash: String,
    pub scene_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_path: Option<String>,
    pub completed_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub label: Option<String>,
    pub text: String,
    pub text_hash: String,
    pub state: String,
    pub updated_at: u64,
    pub placements: Vec<PlacementReceipt>,
}
impl Draft {
    fn validate(&self) -> Result<()> {
        if self.schema_version != 1
            || !valid_id(&self.id)
            || self.revision == 0
            || self.revision == u64::MAX
            || !matches!(self.state.as_str(), "active" | "discarded")
            || self.text.len() > MAX_DRAFT_BYTES
            || self.text_hash != crate::content_hash(&self.text)
            || self
                .label
                .as_ref()
                .is_some_and(|s| s.len() > 256 || s.chars().any(char::is_control))
            || self.placements.len() > 1024
        {
            return Err(error());
        }
        for p in &self.placements {
            project_location(
                &p.kind,
                &p.destination,
                p.project_root.as_deref(),
                p.scene_path.as_deref(),
            )?;
            if !valid_id(&p.id)
                || p.source_revision == 0
                || p.source_hash.len() != 64
                || !p.source_hash.bytes().all(|c| c.is_ascii_hexdigit())
                || p.destination.len() > 4096
                || !Path::new(&p.destination).is_absolute()
                || !matches!(p.kind.as_str(), "file" | "existingProject" | "newProject")
            {
                return Err(error());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedDraft {
    pub draft: Draft,
    pub warning: Option<String>,
    pub recovery_required: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
    pub label: Option<String>,
    pub revision: u64,
    pub text_hash: String,
    pub state: String,
    pub updated_at: u64,
    pub preview: String,
    pub warning: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementIntent {
    pub schema_version: u32,
    pub id: String,
    pub draft_id: String,
    pub source_revision: u64,
    pub source_hash: String,
    pub kind: String,
    pub destination: String,
    pub scene_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_path: Option<String>,
    pub project_key: Option<String>,
}
impl PlacementIntent {
    pub fn scene_location(&self) -> Result<(PathBuf, String)> {
        self.validate()?;
        project_location(
            &self.kind,
            &self.destination,
            self.project_root.as_deref(),
            self.scene_path.as_deref(),
        )?
        .ok_or_else(error)
    }
    fn validate(&self) -> Result<()> {
        project_location(
            &self.kind,
            &self.destination,
            self.project_root.as_deref(),
            self.scene_path.as_deref(),
        )?;
        if self.schema_version != 1
            || !valid_id(&self.id)
            || !valid_id(&self.draft_id)
            || self.source_revision == 0
            || self.source_hash.len() != 64
            || !self.source_hash.bytes().all(|c| c.is_ascii_hexdigit())
            || !matches!(
                self.kind.as_str(),
                "file" | "existingProject" | "newProject"
            )
            || !Path::new(&self.destination).is_absolute()
            || self.destination.len() > 4096
            || self.destination.chars().any(char::is_control)
            || self.scene_id.as_ref().is_some_and(|id| !valid_id(id))
        {
            return Err(error());
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateProof {
    schema_version: u32,
    id: String,
    revision: u64,
    state: String,
}
impl StateProof {
    fn of(d: &Draft) -> Self {
        Self {
            schema_version: 1,
            id: d.id.clone(),
            revision: d.revision,
            state: d.state.clone(),
        }
    }
}
/// The file descriptor owns a stable per-draft process-lifetime flock. No unlink.
pub struct DraftLease {
    id: String,
    #[cfg(unix)]
    lock: File,
}
impl DraftLease {
    pub fn id(&self) -> &str {
        &self.id
    }
}
pub struct DraftStore {
    path: PathBuf,
    #[cfg(unix)]
    directory: File,
}
impl DraftStore {
    #[cfg(unix)]
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let directory =
            crate::recovery::open_directory(path.as_ref(), true).map_err(|_| error())?;
        crate::recovery::private_metadata(&directory, true).map_err(|_| error())?;
        let path = path.as_ref().canonicalize().map_err(|_| error())?;
        Ok(Self { path, directory })
    }
    #[cfg(not(unix))]
    pub fn open(_path: impl AsRef<Path>) -> Result<Self> {
        Err("Standalone draft storage currently requires macOS or Linux".into())
    }
    #[cfg(unix)]
    fn check(&self) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        let current = crate::recovery::open_directory(&self.path, false).map_err(|_| error())?;
        crate::recovery::private_metadata(&current, true).map_err(|_| error())?;
        let a = current.metadata().map_err(|_| error())?;
        let b = self.directory.metadata().map_err(|_| error())?;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return Err(error());
        }
        Ok(())
    }
    #[cfg(unix)]
    pub fn acquire(&self, id: &str) -> Result<DraftLease> {
        self.check()?;
        if !valid_id(id) {
            return Err(error());
        }
        let fd = openat(
            &self.directory,
            format!("{id}.lock"),
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|_| error())?;
        let lock = File::from(fd);
        crate::recovery::private_metadata(&lock, false).map_err(|_| error())?;
        flock(&lock,FlockOperation::NonBlockingLockExclusive).map_err(|_|"This draft is open in another Heinlein window. You can read it here; close the other window before editing.".to_string())?;
        // Only this draft's stable lease can own its interrupted temporary files.
        for (n, entry) in rustix::fs::Dir::read_from(&self.directory)
            .map_err(|_| error())?
            .enumerate()
        {
            if n >= 100000 {
                return Err(error());
            }
            let entry = entry.map_err(|_| error())?;
            let Ok(name) = entry.file_name().to_str() else {
                continue;
            };
            if name.starts_with(&format!(".{id}")) && name.ends_with(".tmp") {
                let tail = name.strip_suffix(".tmp").unwrap();
                if tail.len() >= 36 && tail.get(tail.len() - 36..).is_some_and(valid_id) {
                    self.check_temporary(name)?;
                    unlinkat(&self.directory, name, AtFlags::empty()).map_err(|_| error())?;
                }
            }
        }
        self.directory.sync_all().map_err(|_| error())?;
        Ok(DraftLease {
            id: id.into(),
            lock,
        })
    }
    #[cfg(unix)]
    fn check_temporary(&self, name: &str) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        let fd = openat(
            &self.directory,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error())?;
        let file = File::from(fd);
        let meta = file.metadata().map_err(|_| error())?;
        if meta.nlink() == 1 {
            return crate::recovery::private_metadata(&file, false).map_err(|_| error());
        }
        // A crash between no-replace link and temporary unlink leaves exactly two
        // names for this private inode. Require the native publication witness.
        if !meta.is_file()
            || meta.nlink() != 2
            || meta.uid() != rustix::process::geteuid().as_raw()
            || meta.mode() & 0o777 != 0o600
        {
            return Err(error());
        }
        let published = name
            .get(1..name.len().checked_sub(41).ok_or_else(error)?)
            .ok_or_else(error)?;
        if !published.ends_with(".json") {
            return Err(error());
        }
        let fd = openat(
            &self.directory,
            published,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error())?;
        let witness = File::from(fd).metadata().map_err(|_| error())?;
        if meta.dev() != witness.dev() || meta.ino() != witness.ino() {
            return Err(error());
        }
        Ok(())
    }
    #[cfg(unix)]
    fn check_lease(&self, lease: &DraftLease) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        self.check()?;
        let file = self.read_file(&format!("{}.lock", lease.id))?;
        let a = file.metadata().map_err(|_| error())?;
        let b = lease.lock.metadata().map_err(|_| error())?;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return Err(
                "Draft writer ownership changed; keep your text here and reopen Drafts.".into(),
            );
        }
        Ok(())
    }
    #[cfg(unix)]
    fn read_file(&self, name: &str) -> Result<File> {
        let fd = openat(
            &self.directory,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error())?;
        let file = File::from(fd);
        crate::recovery::private_metadata(&file, false).map_err(|_| error())?;
        Ok(file)
    }
    #[cfg(unix)]
    fn value<T: serde::de::DeserializeOwned>(&self, name: &str) -> Result<T> {
        let file = self.read_file(name)?;
        if file.metadata().map_err(|_| error())?.len() > MAX_RECORD_BYTES {
            return Err(error());
        }
        let mut bytes = Vec::new();
        file.take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error())?;
        serde_json::from_slice(&bytes).map_err(|_| error())
    }
    #[cfg(unix)]
    fn current(&self, id: &str) -> Result<Draft> {
        self.check()?;
        if !valid_id(id) {
            return Err(error());
        }
        let record: Draft = self.value(&format!("{id}.json"))?;
        record.validate()?;
        let proof = self.proof(id)?;
        if proof.revision > record.revision || proof.state != record.state {
            return Err(error());
        }
        if record.id != id {
            return Err(error());
        }
        Ok(record)
    }
    #[cfg(unix)]
    fn proof(&self, id: &str) -> Result<StateProof> {
        let proof: StateProof = self.value(&format!("{id}.state.json"))?;
        if proof.schema_version != 1
            || proof.id != id
            || proof.revision == 0
            || !matches!(proof.state.as_str(), "active" | "discarded")
        {
            return Err(error());
        }
        Ok(proof)
    }
    #[cfg(unix)]
    pub fn read(&self, id: &str) -> Result<LoadedDraft> {
        match self.current(id) {
            Ok(draft) => Ok(LoadedDraft {
                draft,
                warning: None,
                recovery_required: false,
            }),
            Err(_) => {
                if !valid_id(id) {
                    return Err(error());
                }
                let mut draft: Draft = self.value(&format!("{id}.last.json"))?;
                draft.validate()?;
                if draft.id != id {
                    return Err(error());
                }
                let proof = self.proof(id)?;
                if proof.revision >= draft.revision {
                    draft.state = proof.state;
                }
                Ok(LoadedDraft{draft,warning:Some("The newest draft could not be verified. This is the last good version. Restore it explicitly before editing; newer bytes may be uncertain.".into()),recovery_required:true})
            }
        }
    }
    #[cfg(unix)]
    fn atomic<T: Serialize>(&self, name: &str, value: &T, new: bool) -> Result<()> {
        self.check()?;
        let bytes = serde_json::to_vec(value).map_err(|_| error())?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err("Local preservation limit reached; keep this window open. No text was truncated or removed.".into());
        }
        let temporary = format!(".{name}-{}.tmp", uuid::Uuid::new_v4());
        let result = (|| {
            let fd = openat(
                &self.directory,
                temporary.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map_err(|_| error())?;
            let mut file = File::from(fd);
            #[cfg(test)]
            fault(name, "write")?;
            file.write_all(&bytes).map_err(|_| error())?;
            file.sync_all().map_err(|_| error())?;
            self.check()?;
            #[cfg(test)]
            fault(name, "publish")?;
            if new {
                linkat(
                    &self.directory,
                    temporary.as_str(),
                    &self.directory,
                    name,
                    AtFlags::empty(),
                )
                .map_err(|_| error())?;
                unlinkat(&self.directory, temporary.as_str(), AtFlags::empty())
                    .map_err(|_| error())?;
            } else {
                renameat(&self.directory, temporary.as_str(), &self.directory, name)
                    .map_err(|_| error())?;
            }
            #[cfg(test)]
            fault(name, "sync")?;
            self.directory.sync_all().map_err(|_|"The draft may be kept, but disk durability is uncertain. Keep this window open and retry.".into())
        })();
        let _ = unlinkat(&self.directory, temporary.as_str(), AtFlags::empty());
        result
    }
    #[cfg(unix)]
    pub fn create(&self, text: &str) -> Result<(DraftLease, Draft)> {
        if text.len() > MAX_DRAFT_BYTES {
            return Err("This draft exceeds the 64 MiB local preservation bound. Keep the buffer open; nothing is truncated.".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let lease = self.acquire(&id)?;
        let draft = Draft {
            schema_version: 1,
            id,
            revision: 1,
            label: None,
            text: text.into(),
            text_hash: crate::content_hash(text),
            state: "active".into(),
            updated_at: now(),
            placements: vec![],
        };
        self.atomic(
            &format!("{}.state.json", draft.id),
            &StateProof::of(&draft),
            true,
        )?;
        self.atomic(&format!("{}.json", draft.id), &draft, true)?;
        Ok((lease, draft))
    }
    #[cfg(unix)]
    pub fn save(&self, lease: &DraftLease, revision: u64, hash: &str, text: &str) -> Result<Draft> {
        self.check_lease(lease)?;
        let before = self.current(&lease.id)?;
        if before.state != "active" {
            return Err(
                "This draft was discarded. Restore it explicitly from Discarded drafts.".into(),
            );
        }
        if before.revision == revision.saturating_add(1)
            && before.text_hash == crate::content_hash(text)
        {
            self.read_file(&format!("{}.json", lease.id))?
                .sync_all()
                .map_err(|_| error())?;
            self.directory.sync_all().map_err(|_| error())?;
            return Ok(before);
        }
        self.match_revision(&before, revision, hash)?;
        let mut next = before.clone();
        next.text = text.into();
        next.text_hash = crate::content_hash(text);
        self.publish(lease, &before, next)
    }
    fn match_revision(&self, draft: &Draft, revision: u64, hash: &str) -> Result<()> {
        if draft.revision != revision || draft.text_hash != hash {
            return Err("This draft revision changed. Keep your visible text and reload the kept version for comparison.".into());
        }
        Ok(())
    }
    #[cfg(unix)]
    fn publish(&self, lease: &DraftLease, before: &Draft, mut next: Draft) -> Result<Draft> {
        self.check_lease(lease)?;
        next.revision = before.revision.checked_add(1).ok_or_else(error)?;
        next.updated_at = now();
        next.validate()?;
        self.atomic(&format!("{}.last.json", lease.id), before, false)?;
        if next.state != before.state {
            self.atomic(
                &format!("{}.state.json", lease.id),
                &StateProof::of(&next),
                false,
            )?;
        }
        self.atomic(&format!("{}.json", lease.id), &next, false)?;
        Ok(next)
    }
    #[cfg(unix)]
    pub fn transition(
        &self,
        lease: &DraftLease,
        revision: u64,
        hash: &str,
        state: &str,
    ) -> Result<Draft> {
        self.check_lease(lease)?;
        let before = self.current(&lease.id)?;
        self.match_revision(&before, revision, hash)?;
        if !matches!(state, "active" | "discarded") || before.state == state {
            return Err("Draft state changed; refresh Drafts.".into());
        }
        let mut next = before.clone();
        next.state = state.into();
        self.publish(lease, &before, next)
    }
    #[cfg(unix)]
    pub fn restore_last_good(
        &self,
        lease: &DraftLease,
        revision: u64,
        hash: &str,
    ) -> Result<Draft> {
        self.check_lease(lease)?;
        let loaded = self.read(&lease.id)?;
        if !loaded.recovery_required {
            return Err("The current draft is already verified; reopen it.".into());
        }
        self.match_revision(&loaded.draft, revision, hash)?;
        let mut next = loaded.draft;
        next.revision = next
            .revision
            .max(self.proof(&lease.id)?.revision)
            .checked_add(1)
            .ok_or_else(error)?;
        next.updated_at = now();
        next.validate()?;
        self.atomic(
            &format!("{}.state.json", lease.id),
            &StateProof::of(&next),
            false,
        )?;
        self.atomic(&format!("{}.json", lease.id), &next, false)?;
        Ok(next)
    }
    #[cfg(unix)]
    pub fn list(&self) -> Result<Vec<DraftSummary>> {
        self.check()?;
        let mut out = vec![];
        let mut seen = std::collections::HashSet::new();
        for (index, entry) in rustix::fs::Dir::read_from(&self.directory)
            .map_err(|_| error())?
            .enumerate()
        {
            if index >= 100000 {
                return Err("There are too many draft records to list safely. Existing drafts are retained; no cleanup was performed.".into());
            }
            let entry = entry.map_err(|_| error())?;
            let Ok(name) = entry.file_name().to_str() else {
                return Err(error());
            };
            let Some(id) = name
                .strip_suffix(".last.json")
                .or_else(|| name.strip_suffix(".json"))
                .filter(|id| valid_id(id))
            else {
                continue;
            };
            if !seen.insert(id.to_string()) {
                continue;
            }
            let loaded = match self.read(id) {
                Ok(loaded) => loaded,
                Err(message) => {
                    out.push(DraftSummary {
                        id: id.into(),
                        label: None,
                        revision: 0,
                        text_hash: String::new(),
                        state: "unavailable".into(),
                        updated_at: 0,
                        preview: String::new(),
                        warning: Some(message),
                    });
                    continue;
                }
            };
            let d = loaded.draft;
            if d.text.is_empty()
                && d.label.is_none()
                && d.placements.is_empty()
                && d.state == "active"
            {
                continue;
            }
            out.push(DraftSummary {
                id: d.id,
                label: d.label,
                revision: d.revision,
                text_hash: d.text_hash,
                state: d.state,
                updated_at: d.updated_at,
                preview: d.text.chars().take(100).collect(),
                warning: loaded.warning,
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        Ok(out)
    }
    #[cfg(unix)]
    pub fn intent(&self, lease: &DraftLease, intent: &PlacementIntent) -> Result<()> {
        self.check_lease(lease)?;
        intent.validate()?;
        if intent.draft_id != lease.id {
            return Err(error());
        }
        let current = self.current(&lease.id)?;
        self.match_revision(&current, intent.source_revision, &intent.source_hash)?;
        if current.state != "active" {
            return Err("Restore the discarded draft before placing a copy.".into());
        }
        if !self.pending(lease.id())?.is_empty() {
            return Err(
                "A previous placement needs checking before another copy is created.".into(),
            );
        }
        self.atomic(
            &format!("{}-{}.placement.json", lease.id, intent.id),
            intent,
            true,
        )
    }
    #[cfg(unix)]
    pub fn pending(&self, id: &str) -> Result<Vec<PlacementIntent>> {
        self.check()?;
        if !valid_id(id) {
            return Err(error());
        }
        let current = self.read(id)?.draft;
        let mut intents = vec![];
        for (n, entry) in rustix::fs::Dir::read_from(&self.directory)
            .map_err(|_| error())?
            .enumerate()
        {
            if n >= 100000 {
                return Err(error());
            }
            let entry = entry.map_err(|_| error())?;
            let Ok(name) = entry.file_name().to_str() else {
                return Err(error());
            };
            if name.starts_with(&format!("{id}-")) && name.ends_with(".placement.json") {
                let intent: PlacementIntent = self.value(name)?;
                intent.validate()?;
                if intent.draft_id != id {
                    return Err(error());
                }
                if !current.placements.iter().any(|p| p.id == intent.id) {
                    intents.push(intent)
                }
            }
        }
        Ok(intents)
    }
    /// Native may forget an intent only after proving the destination absent.
    #[cfg(unix)]
    pub fn cancel_intent(&self, lease: &DraftLease, operation: &str) -> Result<()> {
        self.check_lease(lease)?;
        if !valid_id(operation) {
            return Err(error());
        }
        unlinkat(
            &self.directory,
            format!("{}-{}.placement.json", lease.id, operation).as_str(),
            AtFlags::empty(),
        )
        .map_err(|_| error())?;
        self.directory.sync_all().map_err(|_| error())
    }
    /// Called only after native destination bytes and optional membership verify.
    #[cfg(unix)]
    pub fn finish_placement(&self, lease: &DraftLease, intent: &PlacementIntent) -> Result<Draft> {
        self.check_lease(lease)?;
        let before = self.current(&lease.id)?;
        if before.placements.iter().any(|p| p.id == intent.id) {
            return Ok(before);
        }
        intent.validate()?;
        let saved: PlacementIntent =
            self.value(&format!("{}-{}.placement.json", lease.id, intent.id))?;
        if serde_json::to_vec(&saved).ok() != serde_json::to_vec(intent).ok()
            || intent.draft_id != lease.id
        {
            return Err(error());
        }
        let mut next = before.clone();
        next.placements.push(PlacementReceipt {
            id: intent.id.clone(),
            kind: intent.kind.clone(),
            destination: intent.destination.clone(),
            source_revision: intent.source_revision,
            source_hash: intent.source_hash.clone(),
            scene_id: intent.scene_id.clone(),
            project_root: intent.project_root.clone(),
            scene_path: intent.scene_path.clone(),
            completed_at: now(),
        });
        self.publish(lease, &before, next)
    }
}
#[cfg(all(test, unix))]
#[path = "standalone_tests.rs"]
mod tests;
