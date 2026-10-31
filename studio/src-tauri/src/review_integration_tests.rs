//! Synthetic file/record/receipt integration, using the production native authority.
//! The trusted-confirmation seam is invoked here; no OS dialog/provider is driven.
use crate::{
    proposals::authority::{Authority, ReceiptStore},
    review_state::ReviewSession,
};
use drafting_questions::{
    review::{ReviewEdit, ReviewOutput, ReviewRequest, ReviewRole, ReviewScope, ReviewSnapshot},
    review_workflow::{Batch, CallResult, Options},
};
use proposal_store::{text_hash, PendingProposal, ProposalStore, ReviewStore};
use repository_core::{RecoveryStore, Repository};
use serde_json::Value;
use std::fs;
const BEFORE: &str = "🐺 Bad. Same. Same. Keep — voice.\r\n";
struct Fixture {
    _temp: tempfile::TempDir,
    repo: Repository,
    proposals: ProposalStore,
    records: ReviewStore,
    receipts: ReceiptStore,
    recovery: RecoveryStore,
    session: ReviewSession,
}
impl Fixture {
    fn new(edits: Vec<(usize, usize, &str)>) -> Self {
        Self::with_source(BEFORE, edits)
    }
    fn with_source(source: &str, edits: Vec<(usize, usize, &str)>) -> Self {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("source");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("scene.md"), source).unwrap();
        let repo = Repository::open(&root).unwrap();
        let request = ReviewRequest {
            request_id: "synthetic-review".into(),
            repository_id: "session-a".into(),
            scope: ReviewScope::Scene,
            snapshots: vec![ReviewSnapshot {
                path: "scene.md".into(),
                source: source.into(),
                source_hash: text_hash(source),
                scene_id: None,
            }],
            workflow: Some(Options {
                reviewers: vec!["contextual".into()],
                context: vec![],
                context_note: String::new(),
                ranges: vec![],
                review_id: None,
            }),
        };
        let mut session = ReviewSession::workflow(
            request,
            repo.project_key(),
            "test-model".into(),
            "synthetic-account".into(),
            1,
        )
        .unwrap();
        let mut coverage = session.coverage()[0].clone();
        coverage.status = "completed".into();
        coverage.request_id = Some("synthetic-call".into());
        let edits = edits
            .into_iter()
            .enumerate()
            .map(|(i, (from, to, replacement))| ReviewEdit {
                id: format!("provider-{i}"),
                role: ReviewRole::Editor,
                path: "scene.md".into(),
                from_utf8: from,
                to_utf8: to,
                original: source[from..to].into(),
                replacement: replacement.into(),
                reason: "Synthetic explicit correction".into(),
            })
            .collect();
        session
            .ingest(
                Batch {
                    calls: vec![CallResult {
                        provider_response_id: None,
                        coverage,
                        edits,
                        model: "test-model".into(),
                    }],
                    cancelled: false,
                    limit_reached: false,
                },
                &Default::default(),
            )
            .unwrap();
        let records = ReviewStore::open(temp.path().join("review-records")).unwrap();
        session.persist(&records, &repo).unwrap();
        Self {
            proposals: ProposalStore::open(temp.path().join("proposals")).unwrap(),
            receipts: ReceiptStore::open(temp.path().join("receipts")).unwrap(),
            recovery: RecoveryStore::open(temp.path().join("recovery")).unwrap(),
            _temp: temp,
            repo,
            records,
            session,
        }
    }
    fn view(&self) -> Value {
        serde_json::to_value(self.session.view()).unwrap()
    }
    fn ids(&self) -> Vec<String> {
        self.view()["edits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap().into())
            .collect()
    }
    fn prepare(&mut self, id: &str) -> PendingProposal {
        let candidate = self
            .session
            .candidate(id, &self.repo.project_key())
            .unwrap();
        let proposal = self
            .proposals
            .submit(
                &self.repo,
                &candidate.path,
                &candidate.base_hash,
                &candidate.replacement_text,
                candidate.origin,
            )
            .unwrap();
        self.session.prepared(id, proposal.clone()).unwrap();
        self.session.persist(&self.records, &self.repo).unwrap();
        proposal
    }
    fn apply(&mut self, host: &mut Authority, p: &PendingProposal, record: bool) {
        self.session
            .validate_binding(p.origin.review.as_ref().unwrap())
            .unwrap();
        let plan = host
            .review(
                &self.repo,
                "session-a",
                &self.proposals,
                &self.receipts,
                &self.recovery,
                &p.id,
                false,
            )
            .unwrap();
        assert_eq!(plan.replacement_text, p.replacement_text);
        let (review_id, revision) = self.session.revision_data();
        let result = self
            .records
            .with_revision(&self.repo, &review_id, revision, || {
                host.apply_confirmed(
                    &self.repo,
                    "session-a",
                    &self.receipts,
                    &self.recovery,
                    &plan.binding(),
                    || false,
                )
            })
            .unwrap();
        assert_eq!(result.receipt.status, "completed");
        if record {
            self.session.applied(
                "session-a",
                &p.id,
                &p.base_hash,
                &p.replacement_hash,
                &p.diff_hash,
            );
            self.session.persist(&self.records, &self.repo).unwrap();
        }
        assert!(host
            .apply_confirmed(
                &self.repo,
                "session-a",
                &self.receipts,
                &self.recovery,
                &plan.binding(),
                || false
            )
            .is_err());
    }
    fn reopen(&mut self) {
        let receipts = self
            .receipts
            .with_lock(&self.repo, || self.receipts.read_all(&self.repo))
            .unwrap();
        let stored: ReviewSession = self.records.load(&self.repo, self.session.id()).unwrap();
        let mut restored = stored
            .restore(&self.repo.project_key(), "session-b", |candidate| {
                receipts.iter().any(|r| {
                    r.kind == "apply"
                        && r.status == "completed"
                        && r.proposal_id == candidate.id
                        && r.origin.review == candidate.origin.review
                        && r.base_hash == candidate.base_hash
                        && r.replacement_hash == candidate.replacement_hash
                        && r.diff_hash == candidate.diff_hash
                })
            })
            .unwrap();
        restored
            .reconcile_receipts(
                &receipts
                    .iter()
                    .map(|r| {
                        (
                            r.kind.clone(),
                            r.status.clone(),
                            r.proposal_id.clone(),
                            r.base_hash.clone(),
                            r.replacement_hash.clone(),
                            r.diff_hash.clone(),
                            r.origin.review.clone(),
                        )
                    })
                    .collect::<Vec<_>>(),
            )
            .unwrap();
        // A new process/session has no retained native plan. Only informational lineage
        // is restored; the next apply still creates a fresh live plan below.
        restored.source_state("scene.md", Some(&self.repo.read("scene.md").unwrap().text));
        self.session = restored;
    }
}
#[test]
fn approved_unicode_shift_survives_restart_and_applies_only_the_other_identical_passage() {
    let first = BEFORE.find("Bad").unwrap();
    let second = BEFORE.rfind("Same").unwrap();
    let mut f = Fixture::new(vec![
        (first, first + 3, "Better 🦊"),
        (second, second + 4, "Other"),
    ]);
    let ids = f.ids();
    assert_eq!(
        f.view()["edits"][0]["location"],
        serde_json::json!({"line":1,"column":3})
    );
    let p = f.prepare(&ids[0]);
    f.apply(&mut Authority::default(), &p, true);
    f.reopen();
    let p = f.prepare(&ids[1]);
    assert_eq!(
        p.replacement_text,
        "🐺 Better 🦊. Same. Other. Keep — voice.\r\n"
    );
    let mut host = Authority::default();
    let plan = host
        .review(
            &f.repo,
            "session-b",
            &f.proposals,
            &f.receipts,
            &f.recovery,
            &p.id,
            false,
        )
        .unwrap();
    let result = host
        .apply_confirmed(
            &f.repo,
            "session-b",
            &f.receipts,
            &f.recovery,
            &plan.binding(),
            || false,
        )
        .unwrap();
    assert_eq!(result.receipt.status, "completed");
    assert_eq!(f.repo.read("scene.md").unwrap().text, p.replacement_text);
}
#[test]
fn completed_native_receipt_before_record_write_reconciles_once_without_replaying_approval() {
    let from = BEFORE.find("Bad").unwrap();
    let mut f = Fixture::new(vec![(from, from + 3, "Good")]);
    let id = f.ids()[0].clone();
    let p = f.prepare(&id);
    f.apply(&mut Authority::default(), &p, false);
    f.reopen();
    assert_eq!(f.view()["edits"][0]["status"], "accepted");
    assert!(f.session.candidate(&id, &f.repo.project_key()).is_err());
    assert!(f
        .session
        .validate_binding(p.origin.review.as_ref().unwrap())
        .is_err());
    assert_eq!(
        f.repo.read("scene.md").unwrap().text,
        BEFORE.replacen("Bad", "Good", 1)
    );
}
#[test]
fn explicit_conflict_choice_is_required_and_record_revision_excludes_an_old_plan() {
    let from = BEFORE.find("Bad").unwrap();
    let mut f = Fixture::new(vec![(from, from + 3, "Good"), (from, from + 3, "Clear")]);
    let ids = f.ids();
    assert!(f.session.candidate(&ids[0], &f.repo.project_key()).is_err());
    f.session.choose(&ids[0]).unwrap();
    let p = f.prepare(&ids[0]);
    let old_revision = f.session.revision;
    f.session.choose(&ids[1]).unwrap();
    f.session.persist(&f.records, &f.repo).unwrap();
    assert!(f
        .session
        .validate_binding(p.origin.review.as_ref().unwrap())
        .is_err());
    assert!(f
        .records
        .with_revision(
            &f.repo,
            f.session.id(),
            old_revision,
            || -> Result<(), String> {
                panic!("stale confirmation must never enter source mutation")
            }
        )
        .is_err());
    let p = f.prepare(&ids[1]);
    assert_eq!(
        p.origin.review.as_ref().unwrap().competing,
        vec![ids[0].clone()]
    );
    f.apply(&mut Authority::default(), &p, true);
    f.reopen();
    assert_eq!(f.view()["edits"][0]["status"], "supersededByAuthorChoice");
    assert_eq!(f.view()["edits"][1]["status"], "accepted");
}
#[test]
fn durable_rejection_receipt_survives_a_record_write_gap_and_regenerated_results() {
    let from = BEFORE.find("Bad").unwrap();
    let mut f = Fixture::new(vec![(from, from + 3, "Good")]);
    let id = f.ids()[0].clone();
    let p = f
        .session
        .rejection_candidate(&id, &f.repo.project_key())
        .unwrap();
    Authority::default()
        .reject_snapshot(&f.repo, &f.receipts, p)
        .unwrap();
    f.reopen();
    assert_eq!(f.view()["edits"][0]["status"], "rejected");
    assert_eq!(f.repo.read("scene.md").unwrap().text, BEFORE);
    let mut request = f.session.request.clone();
    request.workflow.as_mut().unwrap().review_id = None;
    let mut rerun = ReviewSession::workflow(
        request,
        f.repo.project_key(),
        "test-model".into(),
        "synthetic-account".into(),
        2,
    )
    .unwrap();
    let mut coverage = rerun.coverage()[0].clone();
    coverage.status = "completed".into();
    coverage.request_id = Some("later-call".into());
    let edit = ReviewEdit {
        id: "new-provider-id".into(),
        role: ReviewRole::Editor,
        path: "scene.md".into(),
        from_utf8: from,
        to_utf8: from + 3,
        original: "Bad".into(),
        replacement: "Good".into(),
        reason: "Again".into(),
    };
    ReviewOutput {
        schema_version: 1,
        edits: vec![edit.clone()],
    }
    .validate(&rerun.request)
    .unwrap();
    rerun
        .ingest(
            Batch {
                calls: vec![CallResult {
                    provider_response_id: None,
                    coverage,
                    edits: vec![edit],
                    model: "test-model".into(),
                }],
                cancelled: false,
                limit_reached: false,
            },
            &f.session.tombstones(),
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(rerun.view()).unwrap()["edits"][0]["status"],
        "rejected"
    );
}

#[test]
fn guarded_revert_preserves_receipts_and_blocks_only_the_changed_source_lineage() {
    let from = BEFORE.find("Bad").unwrap();
    let other = BEFORE.rfind("Same").unwrap();
    let mut f = Fixture::new(vec![(from, from + 3, "Good"), (other, other + 4, "Other")]);
    let ids = f.ids();
    let p = f.prepare(&ids[0]);
    let mut host = Authority::default();
    f.apply(&mut host, &p, true);
    let receipt = host
        .list(&f.repo, "session-a", &f.proposals, &f.receipts)
        .unwrap()
        .receipts
        .into_iter()
        .find(|r| r.kind == "apply" && r.status == "completed")
        .unwrap();
    let plan = host
        .review_revert(&f.repo, "session-a", &f.recovery, &receipt.id, false)
        .unwrap();
    let outcome = host
        .apply_confirmed(
            &f.repo,
            "session-a",
            &f.receipts,
            &f.recovery,
            &plan.binding(),
            || false,
        )
        .unwrap();
    assert_eq!(outcome.receipt.status, "completed");
    assert_eq!(f.repo.read("scene.md").unwrap().text, BEFORE);
    f.session.source_state("scene.md", Some(BEFORE));
    assert!(f.session.candidate(&ids[1], &f.repo.project_key()).is_err());
    assert_eq!(f.view()["edits"][0]["status"], "accepted");
}
#[test]
fn identical_source_bytes_do_not_authorize_a_reassigned_scene_id() {
    let from = BEFORE.find("Bad").unwrap();
    let f = Fixture::new(vec![(from, from + 3, "Good")]);
    let root = f.repo.root();
    fs::create_dir(root.join("ms")).unwrap();
    fs::write(root.join("ms/scene.md"), BEFORE).unwrap();
    let old = uuid::Uuid::new_v4().to_string();
    let project = uuid::Uuid::new_v4().to_string();
    let manifest = |scene: &str| serde_json::json!({"schemaVersion":2,"id":project,"project":"Synthetic","groups":[],"scenes":[{"id":scene,"title":"Scene","path":"ms/scene.md","groupId":null}]});
    fs::write(
        root.join("ms/manuscript.json"),
        serde_json::to_vec(&manifest(&old)).unwrap(),
    )
    .unwrap();
    let mut origin =
        proposal_store::ProposalOrigin::native_openai("test-model".into(), "synthetic-call".into());
    origin.review = Some(proposal_store::ReviewAttribution {
        review_id: f.session.id().into(),
        finding_id: f.ids()[0].clone(),
        fingerprint: "a".repeat(64),
        scene_id: Some(old),
        competing: vec![],
    });
    let proposal = f
        .proposals
        .submit(
            &f.repo,
            "ms/scene.md",
            &text_hash(BEFORE),
            &BEFORE.replacen("Bad", "Good", 1),
            origin,
        )
        .unwrap();
    let mut host = Authority::default();
    let plan = host
        .review(
            &f.repo,
            "session-a",
            &f.proposals,
            &f.receipts,
            &f.recovery,
            &proposal.id,
            false,
        )
        .unwrap();
    fs::write(
        f.repo.root().join("ms/manuscript.json"),
        serde_json::to_vec(&manifest(&uuid::Uuid::new_v4().to_string())).unwrap(),
    )
    .unwrap();
    assert!(host
        .apply_confirmed(
            &f.repo,
            "session-a",
            &f.receipts,
            &f.recovery,
            &plan.binding(),
            || false
        )
        .is_err());
    assert_eq!(f.repo.read("ms/scene.md").unwrap().text, BEFORE);
}
#[test]
fn identical_whole_source_diff_cannot_substitute_a_different_repeated_passage_receipt() {
    let first = BEFORE.find("Same. ").unwrap();
    let second = BEFORE.rfind("Same. ").unwrap();
    let mut f = Fixture::new(vec![(first, first + 6, ""), (second, second + 6, "")]);
    let ids = f.ids();
    let p = f.prepare(&ids[0]);
    f.apply(&mut Authority::default(), &p, true);
    let mut value = serde_json::to_value(&f.session).unwrap();
    value["ledger"][0]["findingId"] = ids[1].clone().into();
    value["result"]["edits"][0]["status"] = "pending".into();
    value["result"]["edits"][1]["status"] = "accepted".into();
    value["result"]["edits"][1]["proposalId"] = p.id.clone().into();
    let changed: ReviewSession = serde_json::from_value(value).unwrap();
    let receipts = f
        .receipts
        .with_lock(&f.repo, || f.receipts.read_all(&f.repo))
        .unwrap();
    assert!(changed
        .restore(&f.repo.project_key(), "restart", |candidate| receipts
            .iter()
            .any(|r| r.proposal_id == candidate.id
                && r.origin.review == candidate.origin.review
                && r.status == "completed"
                && r.base_hash == candidate.base_hash
                && r.replacement_hash == candidate.replacement_hash
                && r.diff_hash == candidate.diff_hash))
        .is_err());
    assert_eq!(f.repo.read("scene.md").unwrap().text, p.replacement_text);
}

#[test]
fn refreshing_a_cached_review_imports_other_host_decisions_and_restores_valid_operations() {
    let from = BEFORE.find("Bad").unwrap();
    let other = BEFORE.rfind("Same").unwrap();
    let f = Fixture::new(vec![
        (from, from + 3, "Good"),
        (from, from + 3, "Clear"),
        (other, other + 4, "Other"),
    ]);
    let ids = f.ids();
    let review_id = f.session.id().to_owned();
    let mut a = None;
    let mut b = None;
    ReviewSession::refresh_cached(&mut a, &f.records, &f.repo, "host-a", &review_id, |_| false)
        .unwrap();
    ReviewSession::refresh_cached(&mut b, &f.records, &f.repo, "host-b", &review_id, |_| false)
        .unwrap();
    let a_state = a.as_mut().unwrap();
    a_state.choose(&ids[0]).unwrap();
    let p = a_state.candidate(&ids[0], &f.repo.project_key()).unwrap();
    let old = f
        .proposals
        .submit(
            &f.repo,
            &p.path,
            &p.base_hash,
            &p.replacement_text,
            p.origin,
        )
        .unwrap();
    a_state.prepared(&ids[0], old.clone()).unwrap();
    a_state.persist(&f.records, &f.repo).unwrap();
    // Host B refreshes A's revision, changes the selected alternative and
    // durably rejects an unrelated finding while A retains its old cache.
    assert!(ReviewSession::refresh_cached(
        &mut b,
        &f.records,
        &f.repo,
        "host-b",
        &review_id,
        |_| false
    )
    .unwrap());
    let b_state = b.as_mut().unwrap();
    b_state.choose(&ids[1]).unwrap();
    let rejection = b_state
        .rejection_candidate(&ids[2], &f.repo.project_key())
        .unwrap();
    let receipt = Authority::default()
        .reject_snapshot(&f.repo, &f.receipts, rejection)
        .unwrap();
    b_state.rejected(&ids[2], receipt.proposal_id).unwrap();
    b_state.persist(&f.records, &f.repo).unwrap();
    let old_revision = a.as_ref().unwrap().revision;
    assert!(ReviewSession::refresh_cached(
        &mut a,
        &f.records,
        &f.repo,
        "host-a",
        &review_id,
        |_| false
    )
    .unwrap());
    let a = a.as_mut().unwrap();
    assert!(a.revision > old_revision);
    let view = serde_json::to_value(a.view()).unwrap();
    assert_eq!(view["edits"][2]["status"], "rejected");
    assert_eq!(view["edits"][1]["selected"], true);
    assert!(!a.is_prepared(&ids[0]));
    assert!(a
        .validate_binding(old.origin.review.as_ref().unwrap())
        .is_err());
    let p = a.candidate(&ids[1], &f.repo.project_key()).unwrap();
    let p = f
        .proposals
        .submit(
            &f.repo,
            &p.path,
            &p.base_hash,
            &p.replacement_text,
            p.origin,
        )
        .unwrap();
    a.prepared(&ids[1], p.clone()).unwrap();
    a.persist(&f.records, &f.repo).unwrap();
    let mut host = Authority::default();
    let plan = host
        .review(
            &f.repo,
            "host-a",
            &f.proposals,
            &f.receipts,
            &f.recovery,
            &p.id,
            false,
        )
        .unwrap();
    let outcome = f
        .records
        .with_revision(&f.repo, &review_id, a.revision, || {
            host.apply_confirmed(
                &f.repo,
                "host-a",
                &f.receipts,
                &f.recovery,
                &plan.binding(),
                || false,
            )
        })
        .unwrap();
    assert_eq!(outcome.receipt.status, "completed");
    assert_eq!(
        f.repo.read("scene.md").unwrap().text,
        BEFORE.replacen("Bad", "Clear", 1)
    );
}

#[test]
fn refresh_refuses_rolled_back_or_invalid_records_without_replacing_the_cache() {
    let from = BEFORE.find("Bad").unwrap();
    let f = Fixture::new(vec![(from, from + 3, "Good")]);
    let id = f.session.id().to_owned();
    let finding = f.ids()[0].clone();
    let mut slot = None;
    ReviewSession::refresh_cached(&mut slot, &f.records, &f.repo, "host-a", &id, |_| false)
        .unwrap();
    let path = f
        ._temp
        .path()
        .join("review-records")
        .join(format!("{}-{id}.json", f.repo.project_key()));
    let old = fs::read(&path).unwrap();
    let current = slot.as_mut().unwrap();
    let p = current
        .rejection_candidate(&finding, &f.repo.project_key())
        .unwrap();
    let receipt = Authority::default()
        .reject_snapshot(&f.repo, &f.receipts, p)
        .unwrap();
    current.rejected(&finding, receipt.proposal_id).unwrap();
    current.persist(&f.records, &f.repo).unwrap();
    let revision = current.revision;
    assert!(
        !ReviewSession::refresh_cached(&mut slot, &f.records, &f.repo, "host-a", &id, |_| false)
            .unwrap()
    );
    fs::write(&path, &old).unwrap();
    assert!(
        ReviewSession::refresh_cached(&mut slot, &f.records, &f.repo, "host-a", &id, |_| false)
            .is_err()
    );
    assert_eq!(slot.as_ref().unwrap().revision, revision);
    let mut invalid: Value = serde_json::from_slice(&old).unwrap();
    invalid["revision"] = (revision + 1).into();
    invalid["result"]["workflow"]["definitions"][0]["hash"] = "bad".into();
    fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(
        ReviewSession::refresh_cached(&mut slot, &f.records, &f.repo, "host-a", &id, |_| false)
            .is_err()
    );
    assert_eq!(slot.as_ref().unwrap().revision, revision);
    assert_eq!(
        serde_json::to_value(slot.as_ref().unwrap().view()).unwrap()["edits"][0]["status"],
        "rejected"
    );
    assert_eq!(f.repo.read("scene.md").unwrap().text, BEFORE);
}
#[test]
fn refreshing_a_matching_legacy_review_does_not_require_a_v2_record() {
    let from = BEFORE.find("Bad").unwrap();
    let f = Fixture::new(vec![(from, from + 3, "Good")]);
    let mut request = f.session.request.clone();
    request.workflow = None;
    let legacy = ReviewSession::new(
        request,
        ReviewOutput {
            schema_version: 1,
            edits: vec![],
        },
        "test-model".into(),
    )
    .unwrap();
    let id = legacy.id().to_owned();
    let mut slot = Some(legacy);
    assert!(!ReviewSession::refresh_cached(
        &mut slot,
        &f.records,
        &f.repo,
        "session-a",
        &id,
        |_| false
    )
    .unwrap());
    assert_eq!(
        serde_json::to_value(slot.unwrap().view()).unwrap()["schemaVersion"],
        1
    );
}

#[test]
fn manifest_free_raw_source_review_persists_without_writes_until_guarded_approval() {
    let source = "---\r\ntitle: Écriture 🦊\nvoice: Keep — interruptions.\r\n---\n🐺 Bad.\r\n尾声 — exact.\n";
    let offset = source.find("Bad").unwrap();
    let mut f = Fixture::with_source(source, vec![(offset, offset + 3, "Clear")]);
    let original_inventory: Vec<_> = fs::read_dir(f.repo.root())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert!(!f.repo.root().join("ms/manuscript.json").exists());
    assert!(!f.repo.root().join("scene-manifest.json").exists());
    assert_eq!(
        fs::read(f.repo.root().join("scene.md")).unwrap(),
        source.as_bytes()
    );
    f.reopen();
    let id = f.ids()[0].clone();
    let proposal = f.prepare(&id);
    assert_eq!(proposal.path, "scene.md");
    assert_eq!(
        proposal.replacement_text,
        source.replacen("Bad", "Clear", 1)
    );
    assert_eq!(
        fs::read(f.repo.root().join("scene.md")).unwrap(),
        source.as_bytes()
    );
    let mut host = Authority::default();
    assert!(host
        .review(
            &f.repo,
            "session-b",
            &f.proposals,
            &f.receipts,
            &f.recovery,
            &proposal.id,
            true
        )
        .is_err());
    let plan = host
        .review(
            &f.repo,
            "session-b",
            &f.proposals,
            &f.receipts,
            &f.recovery,
            &proposal.id,
            false,
        )
        .unwrap();
    assert_eq!(
        fs::read(f.repo.root().join("scene.md")).unwrap(),
        source.as_bytes()
    );
    let result = host
        .apply_confirmed(
            &f.repo,
            "session-b",
            &f.receipts,
            &f.recovery,
            &plan.binding(),
            || false,
        )
        .unwrap();
    assert_eq!(result.receipt.status, "completed");
    f.session.applied(
        "session-b",
        &proposal.id,
        &proposal.base_hash,
        &proposal.replacement_hash,
        &proposal.diff_hash,
    );
    f.session.persist(&f.records, &f.repo).unwrap();
    f.reopen();
    assert_eq!(
        f.repo.read("scene.md").unwrap().text,
        source.replacen("Bad", "Clear", 1)
    );
    assert_eq!(f.view()["edits"][0]["status"], "accepted");
    let inventory: Vec<_> = fs::read_dir(f.repo.root())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(inventory, original_inventory);
}
