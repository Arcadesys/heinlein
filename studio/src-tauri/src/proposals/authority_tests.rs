use super::*;
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    sync::{Arc, Barrier},
    thread,
};
use tempfile::TempDir;
const BEFORE: &str = "# Scene\r\nKeep — punctuation.\r\n";
const AFTER: &str = "# Scene\r\nUntrusted proposed — replacement.\r\n";
struct Fixture {
    _dir: TempDir,
    repo: Repository,
    store: ProposalStore,
    receipts: ReceiptStore,
    recovery: RecoveryStore,
    proposal: PendingProposal,
}
impl Fixture {
    fn new() -> Self {
        // macOS temp_dir can traverse /var -> /private/var. The Core
        // deliberately rejects symlink ancestors, so use the real temp root.
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = dir.path().join("repository");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("scene.md"), BEFORE).unwrap();
        let repo = Repository::open(root).unwrap();
        let store = ProposalStore::open(dir.path().join("proposals")).unwrap();
        let receipts = ReceiptStore::open(dir.path().join("receipts")).unwrap();
        let recovery = RecoveryStore::open(dir.path().join("recovery")).unwrap();
        let proposal = store
            .submit(
                &repo,
                "scene.md",
                &repo.read("scene.md").unwrap().content_hash,
                AFTER,
                ProposalOrigin::local_mcp(id(), "<script>unverified client</script>".into()),
            )
            .unwrap();
        Self {
            _dir: dir,
            repo,
            store,
            receipts,
            recovery,
            proposal,
        }
    }
    fn review(&self, host: &mut Authority) -> Review {
        host.review(
            &self.repo,
            "session",
            &self.store,
            &self.receipts,
            &self.recovery,
            &self.proposal.id,
            false,
        )
        .unwrap()
    }
    fn apply(&self, host: &mut Authority, review: &Review) -> Result<Outcome> {
        host.apply_confirmed(
            &self.repo,
            "session",
            &self.receipts,
            &self.recovery,
            &review.binding(),
            || false,
        )
    }
    fn text(&self) -> String {
        self.repo.read("scene.md").unwrap().text
    }
    fn records(&self, host: &Authority) -> Listing {
        host.list(&self.repo, "session", &self.store, &self.receipts)
            .unwrap()
    }
}
#[test]
fn exact_displayed_text_is_applied_with_separate_author_and_unverified_origin() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    assert_eq!(review.base_text, BEFORE);
    assert_eq!(review.replacement_text, AFTER);
    assert_eq!(review.origin.identity_assurance, "unverifiedLocalProcess");
    assert!(review.confirmation_message().contains(&review.diff_hash));
    let result = f.apply(&mut host, &review).unwrap();
    assert_eq!(f.text(), AFTER);
    assert_eq!(result.receipt.status, "completed");
    assert!(result.receipt.revert_available);
    assert_eq!(result.receipt.origin, f.proposal.origin);
    assert!(f.records(&host).pending.is_empty());
    let content = fs::read_to_string(f._dir.path().join("receipts").join(format!(
        "{}-{}.intent.json",
        f.repo.project_key(),
        result.receipt.id
    )))
    .unwrap();
    assert!(content.contains("studioNativeAuthor"));
    assert!(content.contains("unverifiedLocalProcess"));
}
#[test]
fn modified_record_after_review_never_changes_cached_application() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    let mut changed = f.proposal.clone();
    changed.replacement_text = "Attack after display".into();
    changed.replacement_hash = proposal_store::text_hash(&changed.replacement_text);
    changed.diff_hash = diff_hash(&changed.path, &changed.base_text, &changed.replacement_text);
    fs::write(
        f._dir
            .path()
            .join("proposals")
            .join(format!("{}-{}.json", changed.project_key, changed.id)),
        serde_json::to_vec(&changed).unwrap(),
    )
    .unwrap();
    assert_eq!(
        f.apply(&mut host, &review).unwrap().receipt.status,
        "completed"
    );
    assert_eq!(f.text(), AFTER);
}
#[test]
fn all_binding_mismatches_consume_review() {
    for field in 0..5 {
        let f = Fixture::new();
        let mut host = Authority::default();
        let review = f.review(&mut host);
        let mut binding = review.binding();
        match field {
            0 => binding.review_id = id(),
            1 => binding.proposal_id = id(),
            2 => binding.base_hash = "0".repeat(64),
            3 => binding.replacement_hash = "0".repeat(64),
            _ => binding.diff_hash = "0".repeat(64),
        }
        assert!(host
            .apply_confirmed(
                &f.repo,
                "session",
                &f.receipts,
                &f.recovery,
                &binding,
                || false
            )
            .is_err());
        assert!(f.apply(&mut host, &review).is_err());
        assert_eq!(f.text(), BEFORE);
    }
}
#[test]
fn dirty_source_or_pending_recovery_never_becomes_approval() {
    let f = Fixture::new();
    let mut host = Authority::default();
    assert!(host
        .review(
            &f.repo,
            "session",
            &f.store,
            &f.receipts,
            &f.recovery,
            &f.proposal.id,
            true
        )
        .is_err());
    let review = f.review(&mut host);
    assert!(host
        .apply_confirmed(
            &f.repo,
            "session",
            &f.receipts,
            &f.recovery,
            &review.binding(),
            || true
        )
        .is_err());
    host.invalidate();
    assert!(f.apply(&mut host, &review).is_err());
    let draft = f
        .recovery
        .stage(
            &f.repo,
            "scene.md",
            &f.proposal.base_hash,
            "Unsaved author text",
        )
        .unwrap();
    assert!(host
        .review(
            &f.repo,
            "session",
            &f.store,
            &f.receipts,
            &f.recovery,
            &f.proposal.id,
            false
        )
        .is_err());
    assert_eq!(f.recovery.read(&f.repo, "scene.md").unwrap(), Some(draft));
    assert_eq!(f.text(), BEFORE);
}
#[test]
fn recovery_created_after_display_blocks_save_and_survives() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    let draft = f
        .recovery
        .stage(
            &f.repo,
            "scene.md",
            &f.proposal.base_hash,
            "Late author edits",
        )
        .unwrap();
    let result = f.apply(&mut host, &review).unwrap();
    assert_eq!(result.receipt.status, "failed");
    assert_eq!(f.text(), BEFORE);
    assert_eq!(f.recovery.read(&f.repo, "scene.md").unwrap(), Some(draft));
    assert!(f.records(&host).pending.is_empty());
}
#[test]
fn stale_external_revision_is_rejected_without_silent_rebase() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    fs::write(f.repo.root().join("scene.md"), "Externally edited").unwrap();
    assert!(f.apply(&mut host, &review).unwrap_err().contains("changed"));
    assert_eq!(f.text(), "Externally edited");
    assert!(host
        .review(
            &f.repo,
            "session",
            &f.store,
            &f.receipts,
            &f.recovery,
            &f.proposal.id,
            false
        )
        .is_err());
}
#[test]
fn generated_scene_detected_after_review_is_read_only() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    fs::write(
        f.repo.root().join("scene-manifest.json"),
        r#"{"schema_version":1,"project":"Book","volumes":[],"sources":[{"path":"scene.md"}]}"#,
    )
    .unwrap();
    assert!(f.apply(&mut host, &review).is_err());
    assert_eq!(f.text(), BEFORE);
}
#[test]
fn double_apply_and_repeated_proposal_after_external_reset_are_rejected() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    f.apply(&mut host, &review).unwrap();
    assert!(f.apply(&mut host, &review).is_err());
    fs::write(f.repo.root().join("scene.md"), BEFORE).unwrap();
    assert!(host
        .review(
            &f.repo,
            "session",
            &f.store,
            &f.receipts,
            &f.recovery,
            &f.proposal.id,
            false
        )
        .is_err());
}
#[test]
fn expired_and_wrong_session_reviews_are_invalidated() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    host.plan.as_mut().unwrap().expires = Instant::now() - Duration::from_secs(1);
    assert!(f.apply(&mut host, &review).is_err());
    let review = f.review(&mut host);
    assert!(host
        .apply_confirmed(
            &f.repo,
            "other-session",
            &f.receipts,
            &f.recovery,
            &review.binding(),
            || false
        )
        .is_err());
    assert!(f.apply(&mut host, &review).is_err());
}
#[test]
fn intent_failure_prevents_write_and_consumes_review() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    f.receipts.fail_intents();
    assert!(f.apply(&mut host, &review).is_err());
    assert_eq!(f.text(), BEFORE);
    assert!(f.apply(&mut host, &review).is_err());
}
#[test]
fn receipt_failure_is_unknown_and_blocks_retry_and_revert() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    f.receipts.fail_completions();
    let result = f.apply(&mut host, &review).unwrap();
    assert_eq!(result.receipt.status, "uncertain");
    assert!(!result.receipt.revert_available);
    assert_eq!(f.text(), AFTER);
    let listing = f.records(&host);
    assert!(listing.pending.is_empty());
    assert_eq!(listing.receipts[0].status, "uncertain");
    assert!(host
        .review_revert(&f.repo, "session", &f.recovery, &result.receipt.id, false)
        .is_err());
    assert!(f.apply(&mut host, &review).is_err());
}
#[test]
fn guarded_revert_keeps_original_receipt_and_origin_and_creates_new_receipt() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    let applied = f.apply(&mut host, &review).unwrap();
    let reversed = host
        .review_revert(&f.repo, "session", &f.recovery, &applied.receipt.id, false)
        .unwrap();
    assert_eq!(reversed.base_text, AFTER);
    assert_eq!(reversed.replacement_text, BEFORE);
    assert_ne!(reversed.diff_hash, review.diff_hash);
    let reverted = f.apply(&mut host, &reversed).unwrap();
    assert_eq!(f.text(), BEFORE);
    assert_eq!(reverted.receipt.kind, "revert");
    assert_eq!(
        reverted.receipt.parent_receipt_id,
        Some(applied.receipt.id.clone())
    );
    assert_eq!(reverted.receipt.origin, f.proposal.origin);
    let records = f.records(&host).receipts;
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|r| !r.revert_available));
    assert!(host
        .review_revert(&f.repo, "session", &f.recovery, &applied.receipt.id, false)
        .is_err());
}
#[test]
fn revert_rejects_intervening_edits_and_preserves_them() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    let applied = f.apply(&mut host, &review).unwrap();
    let reversed = host
        .review_revert(&f.repo, "session", &f.recovery, &applied.receipt.id, false)
        .unwrap();
    fs::write(f.repo.root().join("scene.md"), "New author revision").unwrap();
    assert!(f.apply(&mut host, &reversed).is_err());
    assert_eq!(f.text(), "New author revision");
}
#[test]
fn stored_receipts_cannot_mint_authority_after_restart() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    let applied = f.apply(&mut host, &review).unwrap();
    let mut restarted = Authority::default();
    let listing = f.records(&restarted);
    assert_eq!(listing.receipts.len(), 1);
    assert!(!listing.receipts[0].revert_available);
    assert!(restarted
        .review_revert(&f.repo, "session", &f.recovery, &applied.receipt.id, false)
        .is_err());
    assert!(restarted
        .apply_confirmed(
            &f.repo,
            "session",
            &f.receipts,
            &f.recovery,
            &review.binding(),
            || false
        )
        .is_err());
}
#[test]
fn malicious_proposal_approval_fields_and_mismatched_hashes_are_rejected() {
    for attack in ["approved", "baseHash"] {
        let f = Fixture::new();
        let mut host = Authority::default();
        let mut value = serde_json::to_value(&f.proposal).unwrap();
        value[attack] = if attack == "approved" {
            true.into()
        } else {
            "0".repeat(64).into()
        };
        fs::write(
            f._dir
                .path()
                .join("proposals")
                .join(format!("{}-{}.json", f.proposal.project_key, f.proposal.id)),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert!(host
            .review(
                &f.repo,
                "session",
                &f.store,
                &f.receipts,
                &f.recovery,
                &f.proposal.id,
                false
            )
            .is_err());
        assert_eq!(f.text(), BEFORE);
    }
}
#[test]
fn receipt_files_are_private_immutable_and_repo_storage_is_rejected() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    f.apply(&mut host, &review).unwrap();
    for entry in fs::read_dir(f._dir.path().join("receipts")).unwrap() {
        assert_eq!(
            entry.unwrap().metadata().unwrap().permissions().mode() & 0o077,
            0
        );
    }
    let bad = ReceiptStore::open(f.repo.root().join("receipts")).unwrap();
    assert!(host.list(&f.repo, "session", &f.store, &bad).is_err());
    let link = f._dir.path().join("receipt-link");
    symlink(f._dir.path().join("receipts"), &link).unwrap();
    assert!(ReceiptStore::open(link).is_err());
}
#[test]
fn partial_receipt_and_forged_result_fail_closed_without_source_writes() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    let path = f._dir.path().join("receipts").join(format!(
        "{}-{}.intent.json",
        f.repo.project_key(),
        id()
    ));
    fs::write(&path, "{").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(f.apply(&mut host, &review).is_err());
    assert_eq!(f.text(), BEFORE);
    assert!(host
        .list(&f.repo, "session", &f.store, &f.receipts)
        .is_err());
}
#[test]
fn clean_core_save_and_stage_race_preserve_author_recovery() {
    let f = Fixture::new();
    let repo = Arc::new(f.repo);
    let recovery = Arc::new(f.recovery);
    recovery.read(&repo, "scene.md").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let (tx, rx) = std::sync::mpsc::channel();
    let r = Arc::clone(&repo);
    let s = Arc::clone(&recovery);
    let b = Arc::clone(&barrier);
    let hash = f.proposal.base_hash.clone();
    let writer = thread::spawn(move || {
        b.wait();
        tx.send(r.save_with_clean_recovery("scene.md", &hash, AFTER, &s))
            .unwrap();
    });
    barrier.wait();
    let staged = recovery
        .stage(
            &repo,
            "scene.md",
            &f.proposal.base_hash,
            "Author typing wins preservation",
        )
        .unwrap();
    let result = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("save must not deadlock");
    writer.join().unwrap();
    assert!(result.is_ok() || matches!(result, Err(repository_core::Error::PendingRecovery)));
    assert_eq!(recovery.read(&repo, "scene.md").unwrap(), Some(staged));
}
#[test]
fn clean_core_save_and_ordinary_save_do_not_invert_locks() {
    let f = Fixture::new();
    let repo = Arc::new(f.repo);
    let recovery = Arc::new(f.recovery);
    recovery.read(&repo, "scene.md").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let (tx, rx) = std::sync::mpsc::channel();
    let mut workers = vec![];
    for proposal in [true, false] {
        let r = Arc::clone(&repo);
        let s = Arc::clone(&recovery);
        let b = Arc::clone(&barrier);
        let hash = f.proposal.base_hash.clone();
        let tx = tx.clone();
        workers.push(thread::spawn(move || {
            b.wait();
            let result = if proposal {
                r.save_with_clean_recovery("scene.md", &hash, AFTER, &s)
            } else {
                r.save_with_recovery("scene.md", &hash, "Author save", &s)
            };
            tx.send(result).unwrap();
        }));
    }
    let a = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("first save must not deadlock");
    let b = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("second save must not deadlock");
    assert!(a.is_ok() || b.is_ok());
    for worker in workers {
        worker.join().unwrap();
    }
}
#[test]
fn native_gate_keeps_recovery_staging_concurrent_with_slow_save() {
    let gate = Arc::new(MutationGate::default());
    let slow_save = gate.edit().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let other = Arc::clone(&gate);
    let staging = thread::spawn(move || {
        let _stage = other.edit().unwrap();
        other.invalidate();
        tx.send(()).unwrap();
    });
    rx.recv_timeout(Duration::from_secs(1))
        .expect("recovery staging must not wait for slow ordinary save");
    assert_eq!(gate.generation(), 1);
    drop(slow_save);
    staging.join().unwrap();
}
#[test]
fn native_gate_excludes_stage_during_author_apply_but_dirty_epoch_never_blocks() {
    let gate = Arc::new(MutationGate::default());
    let apply = gate.author_operation().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let other = Arc::clone(&gate);
    let staging = thread::spawn(move || {
        let _stage = other.edit().unwrap();
        tx.send(()).unwrap();
    });
    gate.invalidate();
    assert_eq!(gate.generation(), 1);
    assert!(rx.recv_timeout(Duration::from_millis(25)).is_err());
    drop(apply);
    rx.recv_timeout(Duration::from_secs(1)).unwrap();
    staging.join().unwrap();
}

#[test]
fn forged_valid_receipt_data_can_block_but_never_authorize_a_write() {
    let f = Fixture::new();
    let mut temporary_host = Authority::default();
    let review = f.review(&mut temporary_host);
    let forged = receipts::Intent::new(&f.repo, review.clone());
    f.receipts
        .with_lock(&f.repo, || {
            f.receipts.write_intent(&f.repo, &forged)?;
            f.receipts
                .write_completion(&f.repo, &forged, "completed", None)
        })
        .unwrap();
    let mut host = Authority::default();
    assert_eq!(f.text(), BEFORE);
    assert!(!f.records(&host).receipts[0].revert_available);
    assert!(host
        .review_revert(&f.repo, "session", &f.recovery, &forged.id, false)
        .is_err());
    assert!(f.apply(&mut host, &review).is_err());
    assert!(host
        .review(
            &f.repo,
            "session",
            &f.store,
            &f.receipts,
            &f.recovery,
            &f.proposal.id,
            false
        )
        .is_err());
    assert_eq!(f.text(), BEFORE);
}

#[test]
fn dirty_confirmation_attempt_invalidates_the_native_review() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    assert!(host
        .confirmation(&f.repo, "session", &review.binding(), true)
        .is_err());
    assert!(host
        .confirmation(&f.repo, "session", &review.binding(), false)
        .is_err());
    assert_eq!(f.text(), BEFORE);
}

#[test]
fn dirty_change_during_source_staging_is_rechecked_before_commit() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    let reads = std::cell::Cell::new(0);
    let outcome = host
        .apply_confirmed(
            &f.repo,
            "session",
            &f.receipts,
            &f.recovery,
            &review.binding(),
            || {
                let n = reads.get() + 1;
                reads.set(n);
                n >= 3
            },
        )
        .unwrap();
    assert_eq!(reads.get(), 3);
    assert_eq!(outcome.receipt.status, "failed");
    assert!(outcome.warning.unwrap().contains("editor changed"));
    assert_eq!(f.text(), BEFORE);
    assert!(!outcome.receipt.revert_available);
}

#[test]
fn native_origin_survives_apply_revert_and_disk_receipts() {
    let mut f = Fixture::new();
    let origin = ProposalOrigin::native_openai("synthetic-model".into(), "req_synthetic".into());
    f.proposal = f
        .store
        .submit(
            &f.repo,
            "scene.md",
            &f.repo.read("scene.md").unwrap().content_hash,
            AFTER,
            origin.clone(),
        )
        .unwrap();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    assert_eq!(review.origin, origin);
    assert!(review.confirmation_message().contains("synthetic-model"));
    let applied = f.apply(&mut host, &review).unwrap();
    let revert = host
        .review_revert(&f.repo, "session", &f.recovery, &applied.receipt.id, false)
        .unwrap();
    assert_eq!(revert.origin, origin);
    let reverted = f.apply(&mut host, &revert).unwrap();
    assert_eq!(reverted.receipt.origin, origin);
    assert_eq!(f.text(), BEFORE);
    let restarted = Authority::default();
    let records = f.records(&restarted);
    assert!(records
        .receipts
        .iter()
        .all(|r| r.origin == origin && !r.revert_available));
}

#[test]
fn rejection_is_persistent_immutable_and_never_approval() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    let rejected = host
        .reject(&f.repo, &f.store, &f.receipts, &f.proposal.id)
        .unwrap();
    assert_eq!(rejected.kind, "reject");
    assert_eq!(rejected.status, "rejected");
    assert!(!rejected.revert_available);
    assert_eq!(rejected.origin, f.proposal.origin);
    assert!(f.apply(&mut host, &review).is_err());
    assert!(host
        .reject(&f.repo, &f.store, &f.receipts, &f.proposal.id)
        .is_err());
    let mut restarted = Authority::default();
    assert!(f.records(&restarted).pending.is_empty());
    assert_eq!(f.records(&restarted).receipts.len(), 1);
    assert!(restarted
        .review(
            &f.repo,
            "session",
            &f.store,
            &f.receipts,
            &f.recovery,
            &f.proposal.id,
            false
        )
        .is_err());
    assert!(restarted
        .review_revert(&f.repo, "session", &f.recovery, &rejected.id, false)
        .is_err());
    assert!(f.store.get(&f.repo, &f.proposal.id).is_ok());
    assert_eq!(f.text(), BEFORE);
}

#[test]
fn rejection_invalidates_another_hosts_preexisting_review() {
    let f = Fixture::new();
    let mut reviewer = Authority::default();
    let review = f.review(&mut reviewer);
    let mut rejecter = Authority::default();
    rejecter
        .reject(&f.repo, &f.store, &f.receipts, &f.proposal.id)
        .unwrap();
    assert!(f.apply(&mut reviewer, &review).is_err());
    assert_eq!(f.text(), BEFORE);
}

#[test]
fn applied_proposal_cannot_be_rejected() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    f.apply(&mut host, &review).unwrap();
    assert!(host
        .reject(&f.repo, &f.store, &f.receipts, &f.proposal.id)
        .is_err());
    assert_eq!(f.records(&host).receipts.len(), 1);
    assert_eq!(f.text(), AFTER);
}

#[test]
fn malformed_rejection_blocks_apply_instead_of_being_ignored() {
    let f = Fixture::new();
    let mut host = Authority::default();
    let review = f.review(&mut host);
    let filename = f._dir.path().join("receipts").join(format!(
        "{}-{}.reject.json",
        f.repo.project_key(),
        id()
    ));
    fs::write(&filename, b"{}").unwrap();
    fs::set_permissions(&filename, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(f.apply(&mut host, &review).is_err());
    assert_eq!(f.text(), BEFORE);
}

#[test]
fn concurrent_reject_and_apply_have_exactly_one_winner() {
    for _ in 0..8 {
        let f = Fixture::new();
        let mut applying_host = Authority::default();
        let review = f.review(&mut applying_host);
        let repo = Arc::new(Repository::open(f.repo.root()).unwrap());
        let barrier = Arc::new(Barrier::new(2));
        let receipt_path = f._dir.path().join("receipts");
        let proposal_path = f._dir.path().join("proposals");
        let r = Arc::clone(&repo);
        let b = Arc::clone(&barrier);
        let pid = f.proposal.id.clone();
        let rejecting = thread::spawn(move || {
            let receipts = ReceiptStore::open(receipt_path).unwrap();
            let proposals = ProposalStore::open(proposal_path).unwrap();
            b.wait();
            Authority::default().reject(&r, &proposals, &receipts, &pid)
        });
        barrier.wait();
        let applied = f.apply(&mut applying_host, &review);
        let rejected = rejecting.join().unwrap();
        assert_ne!(applied.is_ok(), rejected.is_ok());
        let records = f.records(&applying_host);
        assert_eq!(records.receipts.len(), 1);
        assert!(records.pending.is_empty());
        assert_eq!(f.text(), if applied.is_ok() { AFTER } else { BEFORE });
    }
}
