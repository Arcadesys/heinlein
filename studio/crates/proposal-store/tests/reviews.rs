#![cfg(unix)]
use proposal_store::{Error, ReviewStore};
use repository_core::Repository;
use serde::{Deserialize, Serialize};
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u32,
    revision: u64,
    review_id: String,
    status: String,
}
#[test]
fn atomic_review_reload_and_revision_cas_never_restore_an_older_pending_list() {
    let t = tempfile::tempdir().unwrap();
    let base = t.path().canonicalize().unwrap();
    let root = base.join("source");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("scene.md"), "Synthetic author bytes").unwrap();
    let repo = Repository::open(&root).unwrap();
    let path = base.join("reviews");
    let a = ReviewStore::open(&path).unwrap();
    let b = ReviewStore::open(&path).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut record = Record {
        schema_version: 2,
        revision: 1,
        review_id: id.clone(),
        status: "pending".into(),
    };
    a.save(&repo, &id, None, &record).unwrap();
    record.revision = 2;
    record.status = "rejected".into();
    a.save(&repo, &id, Some(1), &record).unwrap();
    record.status = "pending".into();
    assert!(matches!(
        b.save(&repo, &id, Some(1), &record),
        Err(Error::Conflict)
    ));
    drop(a);
    drop(b);
    let reopened = ReviewStore::open(&path).unwrap();
    let saved: Record = reopened.load(&repo, &id).unwrap();
    assert_eq!(saved.status, "rejected");
    assert_eq!(saved.revision, 2);
    assert_eq!(reopened.list::<Record>(&repo).unwrap().len(), 1);
    assert_eq!(
        std::fs::read(root.join("scene.md")).unwrap(),
        b"Synthetic author bytes"
    );
    assert!(reopened.with_revision(&repo, &id, 1, || Ok(())).is_err());
}
#[test]
fn private_review_store_refuses_symlinks_unknown_fields_and_source_side_storage() {
    use std::os::unix::fs::symlink;
    let t = tempfile::tempdir().unwrap();
    let base = t.path().canonicalize().unwrap();
    let root = base.join("source");
    std::fs::create_dir(&root).unwrap();
    let repo = Repository::open(&root).unwrap();
    let path = base.join("reviews");
    let store = ReviewStore::open(&path).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let record = Record {
        schema_version: 2,
        revision: 1,
        review_id: id.clone(),
        status: "rejected".into(),
    };
    store.save(&repo, &id, None, &record).unwrap();
    let key = path.join(format!("{}-{id}.json", repo.project_key()));
    let before = std::fs::read(&key).unwrap();
    std::fs::remove_file(&key).unwrap();
    let outside = base.join("outside.json");
    std::fs::write(&outside, &before).unwrap();
    symlink(&outside, &key).unwrap();
    assert!(store.load::<Record>(&repo, &id).is_err());
    assert!(store.save(&repo, &id, Some(1), &record).is_err());
    assert_eq!(std::fs::read(&outside).unwrap(), before);
    std::fs::remove_file(&key).unwrap();
    std::fs::write(&key,b"{\"schemaVersion\":2,\"revision\":1,\"reviewId\":\"bad\",\"status\":\"pending\",\"unknownAuthority\":true}").unwrap();
    std::fs::set_permissions(&key, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    assert!(store.load::<Record>(&repo, &id).is_err());
    let source_store = ReviewStore::open(root.join("private")).unwrap();
    assert!(source_store.save(&repo, &id, None, &record).is_err());
}
