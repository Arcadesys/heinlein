use super::*;
use std::{fs, process::Command};
fn fixture() -> (tempfile::TempDir, DraftStore) {
    let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let store = DraftStore::open(t.path().join("drafts")).unwrap();
    (t, store)
}
#[test]
fn exact_drafts_survive_reopen_and_never_require_a_repository() {
    let (t, store) = fixture();
    let text = "🐺 e\u{301} — story\r\nsecond\nthird\r\n  ";
    let (lease, first) = store.create(text).unwrap();
    let id = first.id.clone();
    let second = store
        .save(
            &lease,
            first.revision,
            &first.text_hash,
            &format!("{text}end"),
        )
        .unwrap();
    drop(lease);
    drop(store);
    let store = DraftStore::open(t.path().join("drafts")).unwrap();
    assert_eq!(store.read(&id).unwrap().draft, second);
    assert_eq!(store.list().unwrap()[0].id, id);
    assert_eq!(store.read(&id).unwrap().draft.text, format!("{text}end"));
    assert!(!t.path().join("ms").exists());
    let (_lease, blank) = store.create("").unwrap();
    assert!(store.list().unwrap().iter().all(|r| r.id != blank.id));
}
#[test]
fn stale_writes_discard_and_restore_are_revision_bound() {
    let (_t, store) = fixture();
    let (lease, first) = store.create("Keep — exactly.\r\n").unwrap();
    assert!(store.acquire(&first.id).is_err());
    let discarded = store
        .transition(&lease, first.revision, &first.text_hash, "discarded")
        .unwrap();
    assert!(store
        .save(&lease, first.revision, &first.text_hash, "late")
        .is_err());
    assert_eq!(store.list().unwrap()[0].state, "discarded");
    let restored = store
        .transition(&lease, discarded.revision, &discarded.text_hash, "active")
        .unwrap();
    assert_eq!(restored.text, first.text);
    assert!(store
        .save(
            &lease,
            discarded.revision,
            &discarded.text_hash,
            "late restore"
        )
        .is_err());
}
#[test]
fn malformed_current_exposes_last_good_without_silent_empty_or_overwrite() {
    let (t, store) = fixture();
    let (lease, a) = store.create("First 🐺\r\n").unwrap();
    let b = store
        .save(&lease, a.revision, &a.text_hash, "Second — kept")
        .unwrap();
    fs::write(
        t.path().join("drafts").join(format!("{}.json", a.id)),
        b"{broken",
    )
    .unwrap();
    let recovered = store.read(&a.id).unwrap();
    assert_eq!(recovered.draft.text, a.text);
    assert!(recovered.recovery_required);
    assert!(recovered.warning.is_some());
    assert!(store
        .save(
            &lease,
            b.revision,
            &b.text_hash,
            "Never overwrite ambiguity"
        )
        .is_err());
    let restored = store
        .restore_last_good(&lease, a.revision, &a.text_hash)
        .unwrap();
    assert_eq!(restored.text, a.text);
}
#[test]
fn real_process_lease_and_process_restart_preserve_acknowledged_bytes() {
    let (t, store) = fixture();
    let (lease, draft) = store.create("Parent").unwrap();
    let run = |mode: &str| {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "standalone::tests::lease_process_helper",
                "--ignored",
                "--nocapture",
            ])
            .env_clear()
            .env("HEINLEIN_SYNTHETIC_DRAFT_ROOT", t.path().join("drafts"))
            .env("HEINLEIN_SYNTHETIC_DRAFT_ID", &draft.id)
            .env("HEINLEIN_SYNTHETIC_DRAFT_MODE", mode)
            .status()
            .unwrap()
    };
    assert!(run("locked").success());
    drop(lease);
    assert!(run("save").success());
    drop(store);
    let restarted = DraftStore::open(t.path().join("drafts")).unwrap();
    assert_eq!(
        restarted.read(&draft.id).unwrap().draft.text,
        "From child — 🐺\r\n"
    );
    assert!(restarted.acquire(&draft.id).is_ok());
}
#[test]
#[ignore = "synthetic child helper, exercised by real_process_lease_and_process_restart_preserve_acknowledged_bytes"]
fn lease_process_helper() {
    let path = std::env::var_os("HEINLEIN_SYNTHETIC_DRAFT_ROOT").unwrap();
    let id = std::env::var("HEINLEIN_SYNTHETIC_DRAFT_ID").unwrap();
    let mode = std::env::var("HEINLEIN_SYNTHETIC_DRAFT_MODE").unwrap();
    let store = DraftStore::open(PathBuf::from(path)).unwrap();
    if mode == "locked" {
        assert!(store.acquire(&id).is_err());
        return;
    }
    let lease = store.acquire(&id).unwrap();
    let d = store.read(&id).unwrap().draft;
    let kept = store
        .save(&lease, d.revision, &d.text_hash, "From child — 🐺\r\n")
        .unwrap();
    assert_eq!(kept.text, "From child — 🐺\r\n");
}
#[test]
fn symlink_or_changed_lock_cannot_write_outside_or_gain_a_second_writer() {
    use std::os::unix::fs::symlink;
    let (t, store) = fixture();
    let (lease, d) = store.create("Original").unwrap();
    let outside = t.path().join("outside");
    fs::write(&outside, "Outside").unwrap();
    let record = t.path().join("drafts").join(format!("{}.json", d.id));
    fs::remove_file(&record).unwrap();
    symlink(&outside, &record).unwrap();
    assert!(store.save(&lease, d.revision, &d.text_hash, "Bad").is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "Outside");
    let lock = t.path().join("drafts").join(format!("{}.lock", d.id));
    fs::rename(&lock, t.path().join("old-lock")).unwrap();
    fs::write(&lock, "").unwrap();
    assert!(store.save(&lease, d.revision, &d.text_hash, "Bad").is_err());
}

#[test]
fn discarded_tombstone_survives_corrupt_current_and_prevents_backup_resurrection() {
    let (t, store) = fixture();
    let (lease, a) = store.create("Do not resurrect — 🐺").unwrap();
    let discarded = store
        .transition(&lease, a.revision, &a.text_hash, "discarded")
        .unwrap();
    fs::write(
        t.path().join("drafts").join(format!("{}.json", a.id)),
        b"{broken",
    )
    .unwrap();
    let recovered = store.read(&a.id).unwrap();
    assert_eq!(recovered.draft.state, "discarded");
    assert!(recovered.recovery_required);
    let repaired = store
        .restore_last_good(&lease, recovered.draft.revision, &recovered.draft.text_hash)
        .unwrap();
    assert_eq!(repaired.state, "discarded");
    assert!(repaired.revision > discarded.revision);
    assert!(store
        .save(&lease, repaired.revision, &repaired.text_hash, "late")
        .is_err());
}
#[test]
fn atomic_failures_preserve_last_good_and_ack_loss_retry_is_exact() {
    let (t, store) = fixture();
    let (lease, first) = store.create("first 🐺\r\n").unwrap();
    for stage in ["write", "publish"] {
        FAULT.with(|f| *f.borrow_mut() = Some((format!("{}.json", first.id), stage.into())));
        assert!(store
            .save(&lease, first.revision, &first.text_hash, "next")
            .is_err());
        FAULT.with(|f| *f.borrow_mut() = None);
        assert_eq!(store.read(&first.id).unwrap().draft, first);
        assert!(fs::read_dir(t.path().join("drafts")).unwrap().all(|p| !p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }
    FAULT.with(|f| *f.borrow_mut() = Some((format!("{}.json", first.id), "sync".into())));
    assert!(store
        .save(&lease, first.revision, &first.text_hash, "next")
        .is_err());
    FAULT.with(|f| *f.borrow_mut() = None);
    let ack = store
        .save(&lease, first.revision, &first.text_hash, "next")
        .unwrap();
    assert_eq!(ack.revision, 2);
    assert!(store
        .save(&lease, first.revision, &first.text_hash, "different late")
        .is_err());
}
#[test]
fn drafts_exceed_project_limit_without_truncation_and_corruption_does_not_hide_siblings() {
    let (t, store) = fixture();
    let text = "—🐺\r\n".repeat(400000);
    assert!(text.len() > 2 * 1024 * 1024);
    let (_lease, large) = store.create(&text).unwrap();
    assert_eq!(store.read(&large.id).unwrap().draft.text, text);
    let (_lease, other) = store.create("other").unwrap();
    fs::write(
        t.path().join("drafts").join(format!("{}.json", other.id)),
        b"not json",
    )
    .unwrap();
    let rows = store.list().unwrap();
    assert!(rows.iter().any(|r| r.id == large.id));
    assert!(rows
        .iter()
        .any(|r| r.id == other.id && r.state == "unavailable"));
    let text = "x".repeat(MAX_DRAFT_BYTES + 1);
    assert!(store.create(&text).is_err());
    assert_eq!(
        store.read(&large.id).unwrap().draft.text.len(),
        large.text.len()
    );
}
#[test]
fn interrupted_temporaries_are_reclaimed_only_under_their_own_lease_and_missing_current_stays_findable(
) {
    let (t, store) = fixture();
    let (lease, d) = store.create("old").unwrap();
    let next = store
        .save(&lease, d.revision, &d.text_hash, "kept current")
        .unwrap();
    let orphan =
        t.path()
            .join("drafts")
            .join(format!(".{}.json-{}.tmp", d.id, uuid::Uuid::new_v4()));
    fs::write(&orphan, b"unacknowledged").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&orphan, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(store.acquire(&d.id).is_err());
    assert!(orphan.exists());
    drop(lease);
    let lease = store.acquire(&d.id).unwrap();
    assert!(!orphan.exists());
    assert_eq!(store.read(&d.id).unwrap().draft.text, next.text);
    fs::remove_file(t.path().join("drafts").join(format!("{}.json", d.id))).unwrap();
    let row = store
        .list()
        .unwrap()
        .into_iter()
        .find(|r| r.id == d.id)
        .unwrap();
    assert!(row.warning.is_some());
    assert_eq!(row.preview, "old");
    drop(lease);
}
#[test]
fn interrupted_no_replace_link_is_reconciled_without_relaxing_hardlink_guard() {
    let (t, store) = fixture();
    let (lease, d) = store.create("exact linked bytes").unwrap();
    let root = t.path().join("drafts");
    let current = root.join(format!("{}.json", d.id));
    let temporary = root.join(format!(".{}.json-{}.tmp", d.id, uuid::Uuid::new_v4()));
    fs::hard_link(&current, &temporary).unwrap();
    assert!(store.read(&d.id).is_err());
    drop(lease);
    let lease = store.acquire(&d.id).unwrap();
    assert!(!temporary.exists());
    assert_eq!(store.read(&d.id).unwrap().draft.text, d.text);
    let outside = t.path().join("untrusted-link");
    fs::hard_link(current, outside).unwrap();
    assert!(store.read(&d.id).is_err());
    drop(lease);
}
