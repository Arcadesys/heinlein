//! Trusted, in-process Studio authority. Proposal JSON and stored receipts are data,
//! never capabilities. Only a live review plan plus native author confirmation can
//! save a scene. This is deliberately not the ADR's future revision ledger/transport.
use proposal_store::{diff_hash, PendingProposal, ProposalOrigin, ProposalStore, ProposalSummary};
use repository_core::{RecoveryStore, Repository};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[path = "receipts.rs"]
mod receipts;
pub use receipts::ReceiptStore;

type Result<T> = std::result::Result<T, String>;
const REVIEW_TTL: Duration = Duration::from_secs(5 * 60);
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn clean(dirty: bool) -> Result<()> {
    if dirty {
        Err("Save your scene and resolve recovery before reviewing or applying proposals".into())
    } else {
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Review {
    pub id: String,
    pub kind: String,
    pub proposal_id: String,
    pub path: String,
    pub base_hash: String,
    pub replacement_hash: String,
    pub diff_hash: String,
    pub base_text: String,
    pub replacement_text: String,
    pub origin: ProposalOrigin,
    pub expires_at_ms: u64,
    pub parent_receipt_id: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub review_id: String,
    pub proposal_id: String,
    pub base_hash: String,
    pub replacement_hash: String,
    pub diff_hash: String,
}
impl Review {
    #[cfg(test)]
    pub fn binding(&self) -> Binding {
        Binding {
            review_id: self.id.clone(),
            proposal_id: self.proposal_id.clone(),
            base_hash: self.base_hash.clone(),
            replacement_hash: self.replacement_hash.clone(),
            diff_hash: self.diff_hash.clone(),
        }
    }
    fn matches(&self, binding: &Binding) -> bool {
        self.id == binding.review_id
            && self.proposal_id == binding.proposal_id
            && self.base_hash == binding.base_hash
            && self.replacement_hash == binding.replacement_hash
            && self.diff_hash == binding.diff_hash
    }
    fn validate(&self, project_key: &str) -> Result<()> {
        if !valid_id(&self.id)
            || !matches!(self.kind.as_str(), "apply" | "revert")
            || self.expires_at_ms == 0
            || (self.kind == "revert") != self.parent_receipt_id.is_some()
            || self
                .parent_receipt_id
                .as_deref()
                .is_some_and(|value| !valid_id(value))
        {
            return Err("Invalid receipt review".into());
        }
        PendingProposal {
            schema_version: 1,
            id: self.proposal_id.clone(),
            project_key: project_key.into(),
            path: self.path.clone(),
            base_hash: self.base_hash.clone(),
            replacement_hash: self.replacement_hash.clone(),
            diff_hash: self.diff_hash.clone(),
            base_text: self.base_text.clone(),
            replacement_text: self.replacement_text.clone(),
            origin: self.origin.clone(),
            created_at_ms: 1,
        }
        .validate()
        .map_err(|e| e.to_string())
    }
    /// Native dialog is created from the retained plan, never renderer-provided text.
    pub fn confirmation_message(&self) -> String {
        format!("{} the exact whole-scene change reviewed in Studio?\n\nScene: {}\nProposal: {}\nUnverified MCP client: {}\nUnverified session: {}\n\nBase SHA-256: {}\nReplacement SHA-256: {}\nDiff SHA-256: {}\n\nThis author action changes a working draft, not a release approval.", if self.kind == "revert" { "Revert" } else { "Apply" }, self.path, self.proposal_id, self.origin.client_label, self.origin.session_id, self.base_hash, self.replacement_hash, self.diff_hash)
    }
}
fn valid_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .is_ok_and(|id| id.to_string() == value && id.get_version_num() == 4)
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub kind: String,
    pub proposal_id: String,
    pub path: String,
    pub base_hash: String,
    pub replacement_hash: String,
    pub diff_hash: String,
    pub origin: ProposalOrigin,
    pub parent_receipt_id: Option<String>,
    pub status: String,
    pub message: Option<String>,
    pub created_at_ms: u64,
    pub revert_available: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub pending: Vec<ProposalSummary>,
    pub receipts: Vec<Receipt>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub receipt: Receipt,
    pub warning: Option<String>,
}
struct Plan {
    repository_id: String,
    project_key: String,
    review: Review,
    expires: Instant,
}
struct Undo {
    project_key: String,
    repository_id: String,
    review: Review,
}
/// Ordinary save and recovery staging may overlap. Confirmed author operations
/// exclusively pause both. Dirty notifications only advance an atomic epoch and
/// never wait on filesystem I/O or a native dialog.
#[derive(Default)]
pub struct MutationGate {
    lock: std::sync::RwLock<()>,
    epoch: std::sync::atomic::AtomicU64,
}
impl MutationGate {
    pub fn edit(&self) -> Result<std::sync::RwLockReadGuard<'_, ()>> {
        self.lock
            .read()
            .map_err(|_| "Editor operations unavailable".into())
    }
    pub fn author_operation(&self) -> Result<std::sync::RwLockWriteGuard<'_, ()>> {
        self.lock
            .write()
            .map_err(|_| "Editor operations unavailable".into())
    }
    pub fn invalidate(&self) {
        self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn generation(&self) -> u64 {
        self.epoch.load(std::sync::atomic::Ordering::SeqCst)
    }
}
#[derive(Default)]
pub struct Authority {
    plan: Option<Plan>,
    undo: HashMap<String, Undo>,
}

impl Authority {
    pub fn invalidate(&mut self) {
        self.plan = None;
    }
    pub fn list(
        &self,
        repo: &Repository,
        repository_id: &str,
        proposals: &ProposalStore,
        receipts: &ReceiptStore,
    ) -> Result<Listing> {
        let mut records = receipts.with_lock(repo, || receipts.read_all(repo))?;
        let consumed: HashSet<_> = records
            .iter()
            .filter(|r| r.kind == "apply")
            .map(|r| r.proposal_id.clone())
            .collect();
        for record in &mut records {
            record.revert_available = record.status == "completed"
                && self.undo.get(&record.id).is_some_and(|undo| {
                    undo.project_key == repo.project_key() && undo.repository_id == repository_id
                });
        }
        Ok(Listing {
            pending: proposals
                .list(repo)
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|p| !consumed.contains(&p.id))
                .collect(),
            receipts: records,
        })
    }
    // Explicit native repository, storage and editor inputs keep authority boundaries visible.
    #[allow(clippy::too_many_arguments)]
    pub fn review(
        &mut self,
        repo: &Repository,
        repository_id: &str,
        proposals: &ProposalStore,
        receipts: &ReceiptStore,
        recovery: &RecoveryStore,
        proposal_id: &str,
        dirty: bool,
    ) -> Result<Review> {
        self.plan = None;
        clean(dirty)?;
        let proposal = proposals
            .get(repo, proposal_id)
            .map_err(|e| e.to_string())?;
        proposal.validate().map_err(|e| e.to_string())?;
        receipts.with_lock(repo, || receipts.require_unattempted(repo, &proposal.id))?;
        let review = Review {
            id: id(),
            kind: "apply".into(),
            proposal_id: proposal.id,
            path: proposal.path,
            base_hash: proposal.base_hash,
            replacement_hash: proposal.replacement_hash,
            diff_hash: proposal.diff_hash,
            base_text: proposal.base_text,
            replacement_text: proposal.replacement_text,
            origin: proposal.origin,
            expires_at_ms: now() + REVIEW_TTL.as_millis() as u64,
            parent_receipt_id: None,
        };
        self.issue(repo, repository_id, recovery, review)
    }
    pub fn review_revert(
        &mut self,
        repo: &Repository,
        repository_id: &str,
        recovery: &RecoveryStore,
        receipt_id: &str,
        dirty: bool,
    ) -> Result<Review> {
        self.plan = None;
        clean(dirty)?;
        // Stored JSON does not mint a revert capability after restart.
        let undo = self
            .undo
            .get(receipt_id)
            .ok_or("No live confirmed apply is available to revert in this Studio session")?;
        if undo.project_key != repo.project_key() || undo.repository_id != repository_id {
            return Err("Repository changed; review again".into());
        }
        let previous = &undo.review;
        let review = Review {
            id: id(),
            kind: "revert".into(),
            proposal_id: previous.proposal_id.clone(),
            path: previous.path.clone(),
            base_hash: previous.replacement_hash.clone(),
            replacement_hash: previous.base_hash.clone(),
            diff_hash: diff_hash(
                &previous.path,
                &previous.replacement_text,
                &previous.base_text,
            ),
            base_text: previous.replacement_text.clone(),
            replacement_text: previous.base_text.clone(),
            origin: previous.origin.clone(),
            expires_at_ms: now() + REVIEW_TTL.as_millis() as u64,
            parent_receipt_id: Some(receipt_id.into()),
        };
        self.issue(repo, repository_id, recovery, review)
    }
    fn issue(
        &mut self,
        repo: &Repository,
        repository_id: &str,
        recovery: &RecoveryStore,
        review: Review,
    ) -> Result<Review> {
        review.validate(&repo.project_key())?;
        // This read never refreshes the displayed base to a newer disk revision.
        check_source(repo, &review)?;
        recovery
            .with_clean_paths(repo, std::slice::from_ref(&review.path), || Ok(()))
            .map_err(|e| e.to_string())?;
        self.plan = Some(Plan {
            repository_id: repository_id.into(),
            project_key: repo.project_key(),
            review: review.clone(),
            expires: Instant::now() + REVIEW_TTL,
        });
        Ok(review)
    }
    pub fn cancel(&mut self, repository_id: &str, review_id: &str) {
        if self
            .plan
            .as_ref()
            .is_some_and(|p| p.repository_id == repository_id && p.review.id == review_id)
        {
            self.plan = None;
        }
    }
    /// Return only the host-owned exact plan for the native confirmation dialog.
    pub fn confirmation(
        &mut self,
        repo: &Repository,
        repository_id: &str,
        binding: &Binding,
        dirty: bool,
    ) -> Result<Review> {
        if dirty {
            self.plan = None;
            clean(dirty)?;
        }
        if !self.plan.as_ref().is_some_and(|p| {
            p.repository_id == repository_id
                && p.project_key == repo.project_key()
                && p.expires > Instant::now()
                && p.review.matches(binding)
        }) {
            self.plan = None;
            return Err("Review expired or changed; review the whole scene again".into());
        }
        Ok(self.plan.as_ref().unwrap().review.clone())
    }
    /// Call only after a successful trusted native author confirmation. The native
    /// host serializes this with editor mutation and checks its actual dirty flag.
    pub fn apply_confirmed(
        &mut self,
        repo: &Repository,
        repository_id: &str,
        receipts: &ReceiptStore,
        recovery: &RecoveryStore,
        binding: &Binding,
        editor_changed: impl Fn() -> bool,
    ) -> Result<Outcome> {
        let review = self.confirmation(repo, repository_id, binding, editor_changed())?;
        self.plan = None; // One attempt, including conflict, I/O failure, and timeout.
        clean(editor_changed())?;
        check_source(repo, &review)?;
        receipts.with_lock(repo, || {
            if review.kind == "apply" { receipts.require_unattempted(repo, &review.proposal_id)?; }
            else {
                let parent = review.parent_receipt_id.as_ref().ok_or("Missing revert parent")?;
                if !self.undo.contains_key(parent) { return Err("This apply has already been reverted or its authority expired".into()); }
                receipts.require_unreverted(repo, parent)?;
            }
            let intent = receipts::Intent::new(repo, review.clone());
            // Intent durability is required before any source write. An incomplete
            // intent/receipt is a stop condition, never a reason to repeat the save.
            receipts.write_intent(repo, &intent)?;
            if let Some(parent) = &review.parent_receipt_id { self.undo.remove(parent); }
            let saved = repo.save_with_clean_recovery_checked(&review.path, &review.base_hash, &review.replacement_text, recovery, || {
                if editor_changed() { Err(repository_core::Error::EditorChanged) } else { Ok(()) }
            });
            let (status, message) = match saved {
                Ok(document) if document.content_hash == review.replacement_hash => ("completed", None),
                Ok(_) => ("uncertain", Some("The returned source did not match the reviewed replacement. Preserve all files and inspect before continuing".into())),
                Err(repository_core::Error::SaveUncertain) => ("uncertain", Some("The source may have changed, but durability is uncertain. Inspect current source and local receipts; do not retry blindly".into())),
                Err(error) => ("failed", Some(format!("Core rejected the operation: {error}. This attempt is retained; review current source before preparing a new proposal"))),
            };
            let mut receipt = intent.receipt(status, message.clone());
            if let Err(error) = receipts.write_completion(repo, &intent, status, message.clone()) {
                receipt.status = "uncertain".into(); receipt.message = Some(format!("Operation result could not be durably recorded: {error}. The source may have changed. Preserve the intent and inspect before retrying"));
            }
            if receipt.status == "completed" && review.kind == "apply" {
                receipt.revert_available = true;
                self.undo.insert(intent.id.clone(), Undo { project_key: repo.project_key(), repository_id: repository_id.into(), review });
            }
            Ok(Outcome { warning: receipt.message.clone(), receipt })
        })
    }
}
fn check_source(repo: &Repository, review: &Review) -> Result<()> {
    let current = repo.read(&review.path).map_err(|e| e.to_string())?;
    if current.generated_compatibility {
        return Err("Generated compatibility scenes cannot be changed".into());
    }
    if current.content_hash != review.base_hash || current.text != review.base_text {
        return Err(
            "Scene changed on disk; review a new proposal against the current source".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "authority_tests.rs"]
mod tests;
