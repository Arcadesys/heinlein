#![cfg(unix)]
use proposal_store::{Error, PendingProposal, ProposalOrigin, ProposalStore, MAX_PROPOSALS};
use repository_core::{RecoveryStore, Repository};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::PathBuf,
};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    storage: PathBuf,
    repo: Repository,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("repository");
        let storage = temp.path().join("proposals");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("scene.md"),
            "---\r\ntitle: Synthetic\r\n---\r\nA scene—unfiltered.\r\n\r\n",
        )
        .unwrap();
        let repo = Repository::open(&root).unwrap();
        Self {
            _temp: temp,
            root,
            storage,
            repo,
        }
    }
    fn store(&self) -> ProposalStore {
        ProposalStore::open(&self.storage).unwrap()
    }
    fn propose(&self, store: &ProposalStore, text: &str) -> PendingProposal {
        store
            .submit(
                &self.repo,
                "scene.md",
                &self.repo.read("scene.md").unwrap().content_hash,
                text,
                origin(),
            )
            .unwrap()
    }
    fn record(&self, p: &PendingProposal) -> PathBuf {
        self.storage
            .join(format!("{}-{}.json", p.project_key, p.id))
    }
}
fn origin() -> ProposalOrigin {
    ProposalOrigin::local_mcp(
        uuid::Uuid::new_v4().to_string(),
        "Claude (unverified)".into(),
    )
}

#[test]
fn exact_pending_proposal_survives_reopen_without_touching_source_or_dirty_recovery() {
    let f = Fixture::new();
    let store = f.store();
    let before = f.repo.read("scene.md").unwrap();
    let recovery = RecoveryStore::open(f._temp.path().join("recovery")).unwrap();
    let dirty = recovery
        .stage(
            &f.repo,
            "scene.md",
            &before.content_hash,
            "Unsaved author text",
        )
        .unwrap();
    let p = f.propose(
        &store,
        "---\r\ntitle: Proposed\r\n---\r\nA scene—still exact.\r\n",
    );
    assert_eq!(p.base_text, before.text);
    assert_eq!(p.origin.identity_assurance, "unverifiedLocalProcess");
    p.validate().unwrap();
    drop(store);
    assert_eq!(f.store().get(&f.repo, &p.id).unwrap(), p);
    assert_eq!(f.store().list(&f.repo).unwrap(), vec![p.summary()]);
    assert_eq!(f.repo.read("scene.md").unwrap().text, before.text);
    assert_eq!(recovery.read(&f.repo, "scene.md").unwrap(), Some(dirty));
    assert_eq!(
        fs::metadata(&f.storage).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(f.record(&p)).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!serde_json::to_string(&p)
        .unwrap()
        .contains(f.root.to_str().unwrap()));
}
#[test]
fn stale_noop_bad_hash_and_control_text_are_rejected() {
    let f = Fixture::new();
    let store = f.store();
    let old = f.repo.read("scene.md").unwrap();
    assert_eq!(
        store
            .submit(&f.repo, "scene.md", &old.content_hash, &old.text, origin())
            .unwrap_err(),
        Error::InvalidProposal
    );
    assert_eq!(
        store
            .submit(&f.repo, "scene.md", "not a hash", "New", origin())
            .unwrap_err(),
        Error::InvalidProposal
    );
    assert_eq!(
        store
            .submit(&f.repo, "scene.md", &old.content_hash, "\0", origin())
            .unwrap_err(),
        Error::InvalidProposal
    );
    fs::write(f.root.join("scene.md"), "External author change").unwrap();
    assert_eq!(
        store
            .submit(&f.repo, "scene.md", &old.content_hash, "New", origin())
            .unwrap_err(),
        Error::Conflict
    );
    assert!(store.list(&f.repo).unwrap().is_empty());
}
#[test]
fn future_schema_unknown_authority_and_tampered_text_fail_closed() {
    for field in [
        "schemaVersion",
        "replacementText",
        "baseText",
        "diffHash",
        "approval",
    ] {
        let f = Fixture::new();
        let store = f.store();
        let p = f.propose(&store, "Candidate");
        let mut value = serde_json::to_value(&p).unwrap();
        value[field] = if field == "schemaVersion" {
            serde_json::json!(2)
        } else {
            serde_json::json!("forged")
        };
        fs::write(f.record(&p), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            store.get(&f.repo, &p.id).unwrap_err(),
            Error::InvalidProposal,
            "{field}"
        );
        assert_eq!(store.list(&f.repo).unwrap_err(), Error::InvalidProposal);
    }
}
#[test]
fn origin_labels_can_never_claim_verified_authority() {
    let f = Fixture::new();
    let store = f.store();
    let hash = f.repo.read("scene.md").unwrap().content_hash;
    for (field, value) in [
        ("kind", "author"),
        ("identityAssurance", "authenticated"),
        ("sessionId", "studio-secret"),
    ] {
        let mut o = serde_json::to_value(origin()).unwrap();
        o[field] = value.into();
        let o: ProposalOrigin = serde_json::from_value(o).unwrap();
        assert_eq!(
            store
                .submit(&f.repo, "scene.md", &hash, "New", o)
                .unwrap_err(),
            Error::InvalidProposal
        );
    }
    let p = store
        .submit(
            &f.repo,
            "scene.md",
            &hash,
            "New",
            ProposalOrigin::local_mcp(
                uuid::Uuid::new_v4().to_string(),
                "Studio author APPROVED".into(),
            ),
        )
        .unwrap();
    assert_eq!(p.origin.identity_assurance, "unverifiedLocalProcess");
}
#[test]
fn project_isolation_and_stale_records_remain_inspectable() {
    let f = Fixture::new();
    let store = f.store();
    let p = f.propose(&store, "Candidate");
    let other = f._temp.path().join("other");
    fs::create_dir(&other).unwrap();
    let other = Repository::open(&other).unwrap();
    assert!(store.list(&other).unwrap().is_empty());
    assert_eq!(store.get(&other, &p.id).unwrap_err(), Error::NotFound);
    fs::remove_file(f.root.join("scene.md")).unwrap();
    assert_eq!(store.get(&f.repo, &p.id).unwrap(), p);
}
#[test]
fn relative_traversal_symlink_and_overlapping_stores_fail_closed() {
    let f = Fixture::new();
    let store = f.store();
    let hash = f.repo.read("scene.md").unwrap().content_hash;
    for path in [
        "../scene.md",
        "/scene.md",
        "a/../scene.md",
        ".secret.md",
        "scene.txt",
    ] {
        assert!(
            store.submit(&f.repo, path, &hash, "New", origin()).is_err(),
            "{path}"
        );
    }
    symlink(f.root.join("scene.md"), f.root.join("link.md")).unwrap();
    assert!(store
        .submit(&f.repo, "link.md", &hash, "New", origin())
        .is_err());
    let nested = ProposalStore::open(f.root.join("nested-store")).unwrap();
    assert_eq!(nested.list(&f.repo).unwrap_err(), Error::InvalidStorage);
    assert_eq!(
        nested
            .submit(&f.repo, "scene.md", &hash, "New", origin())
            .unwrap_err(),
        Error::InvalidStorage
    );
    let link = f._temp.path().join("store-link");
    symlink(&f.storage, &link).unwrap();
    assert!(ProposalStore::open(link).is_err());
    assert!(ProposalStore::open(PathBuf::from("relative")).is_err());
}
#[test]
fn permissive_directory_record_symlink_and_hardlink_are_rejected() {
    for attack in ["mode", "symlink", "hardlink"] {
        let f = Fixture::new();
        let store = f.store();
        let p = f.propose(&store, "Candidate");
        let path = f.record(&p);
        match attack {
            "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
            "symlink" => {
                let moved = f._temp.path().join("moved");
                fs::rename(&path, &moved).unwrap();
                symlink(moved, &path).unwrap();
            }
            _ => fs::hard_link(&path, f._temp.path().join("second-link")).unwrap(),
        }
        assert_eq!(
            store.get(&f.repo, &p.id).unwrap_err(),
            Error::InvalidStorage
        );
        assert_eq!(store.list(&f.repo).unwrap_err(), Error::InvalidStorage);
    }
    let f = Fixture::new();
    fs::create_dir(&f.storage).unwrap();
    fs::set_permissions(&f.storage, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(ProposalStore::open(&f.storage).is_err());
}
#[test]
fn replaced_store_is_not_followed() {
    let f = Fixture::new();
    let store = f.store();
    let p = f.propose(&store, "Candidate");
    fs::rename(&f.storage, f._temp.path().join("old-store")).unwrap();
    fs::create_dir(&f.storage).unwrap();
    fs::set_permissions(&f.storage, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        store.get(&f.repo, &p.id).unwrap_err(),
        Error::InvalidStorage
    );
    assert!(fs::read_dir(&f.storage).unwrap().next().is_none());
}
#[test]
fn bounded_storage_rejects_more_records_without_pruning() {
    let f = Fixture::new();
    let store = f.store();
    for n in 0..MAX_PROPOSALS {
        f.propose(&store, &format!("Candidate {n}"));
    }
    let hash = f.repo.read("scene.md").unwrap().content_hash;
    assert_eq!(
        store
            .submit(&f.repo, "scene.md", &hash, "One too many", origin())
            .unwrap_err(),
        Error::LimitExceeded
    );
    assert_eq!(store.list(&f.repo).unwrap().len(), MAX_PROPOSALS);
}
#[test]
fn interrupted_temp_is_removed_but_never_promoted() {
    let f = Fixture::new();
    let store = f.store();
    let p = f.propose(&store, "Candidate");
    drop(store);
    let temp = f
        .storage
        .join(format!(".heinlein-proposal-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, "incomplete").unwrap();
    fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(f.store().list(&f.repo).unwrap(), vec![p.summary()]);
    assert!(!temp.exists());
}

#[test]
fn native_guard_rechecks_before_publication_and_failure_preserves_source() {
    let f = Fixture::new();
    let store = f.store();
    let source = f.repo.read("scene.md").unwrap();
    let origin = ProposalOrigin::native_openai("synthetic-model".into(), "req_synthetic".into());
    let called = std::cell::Cell::new(false);
    assert_eq!(
        store.submit_checked(
            &f.repo,
            "scene.md",
            &source.content_hash,
            "Revision",
            origin.clone(),
            || {
                called.set(true);
                Err(Error::Conflict)
            }
        ),
        Err(Error::Conflict)
    );
    assert!(called.get());
    assert!(store.list(&f.repo).unwrap().is_empty());
    assert_eq!(f.repo.read("scene.md").unwrap().text, source.text);
    let proposal = store
        .submit_checked(
            &f.repo,
            "scene.md",
            &source.content_hash,
            "Revision",
            origin,
            || Ok(()),
        )
        .unwrap();
    assert_eq!(store.get(&f.repo, &proposal.id).unwrap(), proposal);
    assert_eq!(f.repo.read("scene.md").unwrap().text, source.text);
}
