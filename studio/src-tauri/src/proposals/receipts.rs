//! Bounded, append-only local operation records. Files are never accepted as author
//! capabilities. Unknown/partial records stop mutation; no startup replay occurs.
use super::{id, now, valid_id, Receipt, Result, Review};
use repository_core::Repository;
use serde::{Deserialize, Serialize};
use std::path::Path;
#[cfg(unix)]
use {
    rustix::fs::{flock, mkdirat, open, openat, FlockOperation, Mode, OFlags},
    std::{
        fs::File,
        io::{Read, Write},
        os::unix::fs::MetadataExt,
        path::PathBuf,
    },
};
const MAX_OPERATIONS: usize = 256;
const MAX_BYTES: u64 = 128 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = proposal_store::MAX_RECORD_BYTES + 64 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Intent {
    schema_version: u32,
    pub id: String,
    project_key: String,
    review: Review,
    confirmed_by: String,
    created_at_ms: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completion {
    schema_version: u32,
    receipt_id: String,
    status: String,
    message: Option<String>,
}
/// An immutable author dismissal, not an operation intent or approval.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rejection {
    schema_version: u32,
    id: String,
    proposal: proposal_store::PendingProposal,
    created_at_ms: u64,
}
impl Rejection {
    fn validate(&self) -> Result<()> {
        if self.schema_version != 1 || !valid_id(&self.id) || self.created_at_ms == 0 {
            return Err("Invalid rejection decision".into());
        }
        self.proposal.validate().map_err(|e| e.to_string())
    }
    fn receipt(&self) -> Receipt {
        Receipt {
            id: self.id.clone(),
            kind: "reject".into(),
            proposal_id: self.proposal.id.clone(),
            path: self.proposal.path.clone(),
            base_hash: self.proposal.base_hash.clone(),
            replacement_hash: self.proposal.replacement_hash.clone(),
            diff_hash: self.proposal.diff_hash.clone(),
            origin: self.proposal.origin.clone(),
            parent_receipt_id: None,
            status: "rejected".into(),
            message: None,
            created_at_ms: self.created_at_ms,
            revert_available: false,
        }
    }
}
impl Intent {
    pub fn new(repo: &Repository, review: Review) -> Self {
        Self {
            schema_version: 1,
            id: id(),
            project_key: repo.project_key(),
            review,
            confirmed_by: "studioNativeAuthor".into(),
            created_at_ms: now(),
        }
    }
    fn validate(&self) -> Result<()> {
        if self.schema_version != 1
            || !valid_id(&self.id)
            || self.confirmed_by != "studioNativeAuthor"
            || self.created_at_ms == 0
        {
            return Err("Invalid local operation intent".into());
        }
        self.review.validate(&self.project_key)
    }
    pub fn receipt(&self, status: &str, message: Option<String>) -> Receipt {
        Receipt {
            id: self.id.clone(),
            kind: self.review.kind.clone(),
            proposal_id: self.review.proposal_id.clone(),
            path: self.review.path.clone(),
            base_hash: self.review.base_hash.clone(),
            replacement_hash: self.review.replacement_hash.clone(),
            diff_hash: self.review.diff_hash.clone(),
            origin: self.review.origin.clone(),
            parent_receipt_id: self.review.parent_receipt_id.clone(),
            status: status.into(),
            message,
            created_at_ms: self.created_at_ms,
            revert_available: false,
        }
    }
}
pub struct ReceiptStore {
    gate: std::sync::Mutex<()>,
    #[cfg(unix)]
    path: PathBuf,
    #[cfg(unix)]
    directory: File,
    #[cfg(test)]
    fail_completion: std::cell::Cell<bool>,
    #[cfg(test)]
    fail_intent: std::cell::Cell<bool>,
}
#[cfg(unix)]
struct Lock<'a>(&'a File);
#[cfg(unix)]
impl Drop for Lock<'_> {
    fn drop(&mut self) {
        let _ = flock(self.0, FlockOperation::Unlock);
    }
}
impl ReceiptStore {
    #[cfg(unix)]
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let directory = open_directory(path.as_ref(), true)?;
        private(&directory, true)?;
        let path = path.as_ref().canonicalize().map_err(|e| e.to_string())?;
        Ok(Self {
            gate: std::sync::Mutex::new(()),
            path,
            directory,
            #[cfg(test)]
            fail_completion: false.into(),
            #[cfg(test)]
            fail_intent: false.into(),
        })
    }
    #[cfg(not(unix))]
    pub fn open(_path: impl AsRef<Path>) -> Result<Self> {
        Err("Proposal receipts currently require macOS or Linux".into())
    }
    #[cfg(unix)]
    pub(super) fn with_lock<T>(
        &self,
        repo: &Repository,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "Local receipt storage is unavailable")?;
        flock(&self.directory, FlockOperation::LockExclusive)
            .map_err(|_| "Local receipt storage is unavailable")?;
        let _lock = Lock(&self.directory);
        self.check(repo)?;
        operation()
    }
    #[cfg(not(unix))]
    pub(super) fn with_lock<T>(
        &self,
        _repo: &Repository,
        _operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        Err("Unsupported platform".into())
    }
    #[cfg(unix)]
    fn check(&self, repo: &Repository) -> Result<()> {
        private(&self.directory, true)?;
        let fresh = open_directory(&self.path, false)?;
        private(&fresh, true)?;
        let current = fresh.metadata().map_err(|e| e.to_string())?;
        let held = self.directory.metadata().map_err(|e| e.to_string())?;
        if (held.dev(), held.ino()) != (current.dev(), current.ino())
            || self.path.starts_with(repo.root())
            || repo.root().starts_with(&self.path)
        {
            return Err("Receipt storage changed or overlaps the repository".into());
        }
        Ok(())
    }
    #[cfg(unix)]
    fn inventory(&self) -> Result<(Vec<String>, u64)> {
        let mut names = vec![];
        let mut total = 0;
        for (i, entry) in rustix::fs::Dir::read_from(&self.directory)
            .map_err(|e| e.to_string())?
            .enumerate()
        {
            if i >= MAX_OPERATIONS * 2 + 2 {
                return Err("Local receipt limit reached".into());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| "Invalid receipt filename")?;
            if matches!(name, "." | "..") {
                continue;
            }
            if !valid_name(name) {
                return Err(
                    "Unexpected record in local receipt storage; inspect it before continuing"
                        .into(),
                );
            }
            let file = self.file(name)?;
            let size = file.metadata().map_err(|e| e.to_string())?.len();
            if size > MAX_RECORD_BYTES {
                return Err("Local receipt is too large".into());
            }
            total += size;
            if total > MAX_BYTES {
                return Err("Local receipt storage limit reached".into());
            }
            names.push(name.to_owned());
        }
        Ok((names, total))
    }
    #[cfg(unix)]
    fn file(&self, name: &str) -> Result<File> {
        let file = File::from(
            openat(
                &self.directory,
                name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| "Unsafe or unreadable receipt")?,
        );
        private(&file, false)?;
        Ok(file)
    }
    #[cfg(unix)]
    fn read<T: serde::de::DeserializeOwned>(&self, name: &str) -> Result<T> {
        let file = self.file(name)?;
        let mut bytes = vec![];
        file.take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Receipt could not be read")?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err("Local receipt is too large".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Incomplete or invalid receipt. Preserve it and inspect current source; automatic retry is blocked".into())
    }
    #[cfg(unix)]
    fn append(&self, repo: &Repository, name: &str, record: &impl Serialize) -> Result<()> {
        self.check(repo)?;
        let (names, total) = self.inventory()?;
        let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
        if names.len() >= MAX_OPERATIONS * 2
            || total + bytes.len() as u64 > MAX_BYTES
            || bytes.len() as u64 > MAX_RECORD_BYTES
        {
            return Err("Local receipt storage limit reached; preserve existing receipts".into());
        }
        // CREATE|EXCL is deliberately never replaced/renamed over an old receipt.
        // Partial creation remains a blocking record after any crash or I/O error.
        let mut file = File::from(
            openat(
                &self.directory,
                name,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| "Cannot create immutable receipt; no existing receipt was replaced")?,
        );
        file.write_all(&bytes)
            .map_err(|_| "Receipt write failed; inspect source before retrying")?;
        file.sync_all()
            .map_err(|_| "Receipt durability is uncertain; inspect source before retrying")?;
        self.directory.sync_all().map_err(|_| {
            "Receipt directory durability is uncertain; inspect source before retrying"
        })?;
        Ok(())
    }
    #[cfg(unix)]
    pub(super) fn read_all(&self, repo: &Repository) -> Result<Vec<Receipt>> {
        self.check(repo)?;
        let (names, _) = self.inventory()?;
        let prefix = format!("{}-", repo.project_key());
        let mut records = vec![];
        for name in names
            .iter()
            .filter(|name| name.starts_with(&prefix) && name.ends_with(".intent.json"))
        {
            let intent: Intent = self.read(name)?;
            intent.validate()?;
            if intent.project_key != repo.project_key() || *name != intent_name(&intent) {
                return Err("Receipt scope mismatch".into());
            }
            let result_name = completion_name(&intent);
            let receipt = if names.contains(&result_name) {
                let result: Completion = self.read(&result_name)?;
                if result.schema_version != 1
                    || result.receipt_id != intent.id
                    || !matches!(result.status.as_str(), "completed" | "failed" | "uncertain")
                    || result.message.as_ref().is_some_and(|m| m.len() > 8192)
                {
                    return Err("Invalid receipt result".into());
                }
                intent.receipt(&result.status, result.message)
            } else {
                intent.receipt("uncertain", Some("An author-confirmed intent has no completion receipt. The operation may have applied. Inspect the source; automatic replay and retry are blocked".into()))
            };
            records.push(receipt);
        }
        for name in names
            .iter()
            .filter(|name| name.starts_with(&prefix) && name.ends_with(".result.json"))
        {
            if !names.contains(&name.replace(".result.json", ".intent.json")) {
                return Err("Receipt result has no intent; inspect local records".into());
            }
        }
        for name in names
            .iter()
            .filter(|name| name.starts_with(&prefix) && name.ends_with(".reject.json"))
        {
            let rejection: Rejection = self.read(name)?;
            rejection.validate()?;
            if rejection.proposal.project_key != repo.project_key()
                || *name != format!("{}-{}.reject.json", repo.project_key(), rejection.id)
            {
                return Err("Rejection scope mismatch".into());
            }
            records.push(rejection.receipt());
        }
        records.sort_by(|a, b| (b.created_at_ms, &b.id).cmp(&(a.created_at_ms, &a.id)));
        Ok(records)
    }
    #[cfg(not(unix))]
    pub(super) fn read_all(&self, _repo: &Repository) -> Result<Vec<Receipt>> {
        Err("Unsupported platform".into())
    }
    pub(super) fn require_unattempted(&self, repo: &Repository, proposal_id: &str) -> Result<()> {
        if self
            .read_all(repo)?
            .iter()
            .any(|r| matches!(r.kind.as_str(), "apply" | "reject") && r.proposal_id == proposal_id)
        {
            return Err("This proposal already has an operation intent or rejection decision. Inspect its receipt; do not apply or reject it again".into());
        }
        Ok(())
    }
    #[cfg(unix)]
    pub(super) fn write_rejection(
        &self,
        repo: &Repository,
        proposal: proposal_store::PendingProposal,
    ) -> Result<Receipt> {
        self.require_unattempted(repo, &proposal.id)?;
        let (names, _) = self.inventory()?;
        if operation_count(&names) >= MAX_OPERATIONS {
            return Err("Local receipt operation limit reached; preserve existing records".into());
        }
        let rejection = Rejection {
            schema_version: 1,
            id: id(),
            proposal,
            created_at_ms: now(),
        };
        rejection.validate()?;
        if rejection.proposal.project_key != repo.project_key() {
            return Err("Rejection scope mismatch".into());
        }
        self.append(
            repo,
            &format!("{}-{}.reject.json", repo.project_key(), rejection.id),
            &rejection,
        )?;
        Ok(rejection.receipt())
    }
    #[cfg(not(unix))]
    pub(super) fn write_rejection(
        &self,
        _repo: &Repository,
        _proposal: proposal_store::PendingProposal,
    ) -> Result<Receipt> {
        Err("Unsupported platform".into())
    }
    pub(super) fn require_unreverted(&self, repo: &Repository, receipt_id: &str) -> Result<()> {
        if self
            .read_all(repo)?
            .iter()
            .any(|r| r.parent_receipt_id.as_deref() == Some(receipt_id))
        {
            return Err(
                "This apply already has a revert intent; inspect its receipt and current source"
                    .into(),
            );
        }
        Ok(())
    }
    #[cfg(unix)]
    pub(super) fn write_intent(&self, repo: &Repository, intent: &Intent) -> Result<()> {
        #[cfg(test)]
        if self.fail_intent.get() {
            return Err("Injected intent failure".into());
        }
        intent.validate()?;
        // Reserve both a record slot and completion byte budget before the save.
        let (names, total) = self.inventory()?;
        let bytes = serde_json::to_vec(intent).map_err(|e| e.to_string())?;
        if operation_count(&names) >= MAX_OPERATIONS
            || names.len() + 2 > MAX_OPERATIONS * 2
            || total + bytes.len() as u64 + 16384 > MAX_BYTES
        {
            return Err("Local receipt storage cannot reserve completion capacity".into());
        }
        self.append(repo, &intent_name(intent), intent)
    }
    #[cfg(not(unix))]
    pub(super) fn write_intent(&self, _repo: &Repository, _intent: &Intent) -> Result<()> {
        Err("Unsupported platform".into())
    }
    #[cfg(unix)]
    pub(super) fn write_completion(
        &self,
        repo: &Repository,
        intent: &Intent,
        status: &str,
        message: Option<String>,
    ) -> Result<()> {
        #[cfg(test)]
        if self.fail_completion.get() {
            return Err("Injected completion failure".into());
        }
        self.append(
            repo,
            &completion_name(intent),
            &Completion {
                schema_version: 1,
                receipt_id: intent.id.clone(),
                status: status.into(),
                message,
            },
        )
    }
    #[cfg(not(unix))]
    pub(super) fn write_completion(
        &self,
        _repo: &Repository,
        _intent: &Intent,
        _status: &str,
        _message: Option<String>,
    ) -> Result<()> {
        Err("Unsupported platform".into())
    }
    #[cfg(test)]
    pub(super) fn fail_completions(&self) {
        self.fail_completion.set(true);
    }
    #[cfg(test)]
    pub(super) fn fail_intents(&self) {
        self.fail_intent.set(true);
    }
}
fn operation_count(names: &[String]) -> usize {
    names
        .iter()
        .filter(|n| n.ends_with(".intent.json") || n.ends_with(".reject.json"))
        .count()
}
fn intent_name(intent: &Intent) -> String {
    format!("{}-{}.intent.json", intent.project_key, intent.id)
}
fn completion_name(intent: &Intent) -> String {
    format!("{}-{}.result.json", intent.project_key, intent.id)
}
fn valid_name(name: &str) -> bool {
    let Some(base) = name
        .strip_suffix(".intent.json")
        .or_else(|| name.strip_suffix(".result.json"))
        .or_else(|| name.strip_suffix(".reject.json"))
    else {
        return false;
    };
    let Some((key, id)) = base.split_once('-') else {
        return false;
    };
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && valid_id(id)
}
#[cfg(unix)]
fn private(file: &File, directory: bool) -> Result<()> {
    let meta = file
        .metadata()
        .map_err(|_| "Receipt metadata unavailable")?;
    if (if directory {
        !meta.is_dir()
    } else {
        !meta.is_file() || meta.nlink() != 1
    }) || meta.uid() != rustix::process::geteuid().as_raw()
        || meta.mode() & 0o077 != 0
    {
        return Err(
            "Receipt storage must be private, owned by this user, and free of links".into(),
        );
    }
    Ok(())
}
#[cfg(unix)]
fn open_directory(path: &Path, create_leaf: bool) -> Result<File> {
    if !path.is_absolute() {
        return Err("Receipt storage must be an absolute native-selected path".into());
    }
    let components: Vec<_> = path.components().collect();
    let mut fd = open(
        "/",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| "Receipt root is unavailable")?;
    for (index, component) in components.iter().enumerate() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
                match openat(&fd, *name, flags, Mode::empty()) {
                    Ok(next) => {
                        if create_leaf && index + 1 == components.len() {
                            // Also retry parent durability when a previous creation
                            // succeeded but its parent fsync reported an error.
                            File::from(
                                rustix::io::dup(&fd).map_err(|_| "Receipt parent unavailable")?,
                            )
                            .sync_all()
                            .map_err(|_| "Receipt parent durability is uncertain")?;
                        }
                        fd = next;
                    }
                    Err(rustix::io::Errno::NOENT)
                        if create_leaf && index + 1 == components.len() =>
                    {
                        match mkdirat(&fd, *name, Mode::from_bits_truncate(0o700)) {
                            Ok(()) => {
                                // Make the new directory entry durable before any
                                // intent inside it can authorize a manuscript save.
                                File::from(
                                    rustix::io::dup(&fd)
                                        .map_err(|_| "Receipt parent unavailable")?,
                                )
                                .sync_all()
                                .map_err(|_| "Receipt parent durability is uncertain")?;
                            }
                            Err(rustix::io::Errno::EXIST) => {}
                            Err(_) => return Err("Cannot create private receipt directory".into()),
                        }
                        fd = openat(&fd, *name, flags, Mode::empty())
                            .map_err(|_| "Unsafe receipt directory")?;
                    }
                    Err(_) => return Err("Unsafe or unavailable receipt directory".into()),
                }
            }
            _ => return Err("Invalid receipt directory".into()),
        }
    }
    Ok(File::from(fd))
}
