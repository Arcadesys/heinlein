#![cfg(unix)]
use repository_core::{Error, RecoveryStore, Repository, MAX_FILE_BYTES};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    path::PathBuf,
    process::{Command, Stdio},
    time::Instant,
};
use tempfile::TempDir;

const ORIGINAL: &str =
    "---\r\nid: stable-scene\r\nunknown: 'Keep: exact'\r\n---\r\n\r\nFragments. Queer—furry.\r\n";
fn fixture() -> (TempDir, Repository, RecoveryStore) {
    let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let root = temp.path().join("repository");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("scene.md"), ORIGINAL).unwrap();
    let repo = Repository::open(&root).unwrap();
    let store = RecoveryStore::open(temp.path().join("appdata/recovery")).unwrap();
    (temp, repo, store)
}
fn record(temp: &TempDir) -> PathBuf {
    fs::read_dir(temp.path().join("appdata/recovery"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .unwrap()
}
#[test]
fn snapshot_is_private_outside_repository_and_survives_reopen() {
    let (temp, repo, store) = fixture();
    let before = repo.read("scene.md").unwrap();
    let text = format!("{ORIGINAL}\r\nAuthor's new text.\r\n");
    let draft = store
        .stage(&repo, "scene.md", &before.content_hash, &text)
        .unwrap();
    assert_eq!(
        (draft.actor.as_str(), draft.client.as_str()),
        ("author", "studio")
    );
    assert!(draft.updated_at > 0);
    assert_eq!(repo.read("scene.md").unwrap().text, ORIGINAL);
    assert_eq!(fs::read_dir(repo.root()).unwrap().count(), 1);
    assert_eq!(
        fs::metadata(temp.path().join("appdata/recovery"))
            .unwrap()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(fs::metadata(record(&temp)).unwrap().mode() & 0o777, 0o600);
    let key = repo.project_key();
    drop(store);
    drop(repo);
    let reopened = Repository::open(temp.path().join("repository")).unwrap();
    let reopened_store = RecoveryStore::open(temp.path().join("appdata/recovery")).unwrap();
    assert_eq!(reopened.project_key(), key);
    assert_eq!(
        reopened_store.read(&reopened, "scene.md").unwrap(),
        Some(draft)
    );
}
#[test]
fn external_conflict_retains_buffer_and_never_changes_disk() {
    let (_temp, repo, store) = fixture();
    let hash = repo.read("scene.md").unwrap().content_hash;
    fs::write(repo.root().join("scene.md"), "External author text\n").unwrap();
    let draft = store
        .stage(&repo, "scene.md", &hash, "My unsaved text\n")
        .unwrap();
    assert_eq!(draft.base_hash, hash);
    assert_eq!(
        repo.save("scene.md", &hash, &draft.text).unwrap_err(),
        Error::Conflict
    );
    assert_eq!(store.read(&repo, "scene.md").unwrap(), Some(draft));
    assert_eq!(
        repo.read("scene.md").unwrap().text,
        "External author text\n"
    );
}
#[test]
fn failed_manuscript_save_retains_recovery_and_success_does_not_delete_it() {
    let (_temp, repo, store) = fixture();
    let hash = repo.read("scene.md").unwrap().content_hash;
    let draft = store.stage(&repo, "scene.md", &hash, "My draft").unwrap();
    fs::set_permissions(
        repo.root().join("scene.md"),
        fs::Permissions::from_mode(0o444),
    )
    .unwrap();
    assert_eq!(
        repo.save("scene.md", &hash, &draft.text).unwrap_err(),
        Error::Denied
    );
    assert_eq!(store.read(&repo, "scene.md").unwrap(), Some(draft.clone()));
    fs::set_permissions(
        repo.root().join("scene.md"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    repo.save("scene.md", &hash, &draft.text).unwrap();
    assert_eq!(store.read(&repo, "scene.md").unwrap(), Some(draft.clone()));
    store.discard(&repo, "scene.md", &draft.id).unwrap();
    assert_eq!(store.read(&repo, "scene.md").unwrap(), None);
}
#[test]
fn stale_discard_cannot_remove_newer_snapshot_across_store_instances() {
    let (temp, repo, first_store) = fixture();
    let second_store = RecoveryStore::open(temp.path().join("appdata/recovery")).unwrap();
    let hash = repo.read("scene.md").unwrap().content_hash;
    let first = first_store
        .stage(&repo, "scene.md", &hash, "First")
        .unwrap();
    assert_eq!(
        second_store
            .stage(&repo, "scene.md", &hash, "Second")
            .unwrap_err(),
        Error::RecoveryBusy
    );
    assert_eq!(
        second_store
            .discard(&repo, "scene.md", &first.id)
            .unwrap_err(),
        Error::RecoveryBusy
    );
    assert_eq!(
        second_store.read(&repo, "scene.md").unwrap_err(),
        Error::RecoveryBusy
    );
    fs::write(repo.root().join("other.md"), ORIGINAL).unwrap();
    second_store
        .stage(&repo, "other.md", &hash, "Independent scene")
        .unwrap();
    // The first owner exits; the next instance may claim this scene safely.
    drop(first_store);
    // Ownership transfer must not let a stale Retry Save replace unobserved recovery.
    for _ in 0..2 {
        assert_eq!(
            second_store
                .stage(&repo, "scene.md", &hash, "Stale retry")
                .unwrap_err(),
            Error::RecoveryChanged
        );
    }
    assert_eq!(
        second_store.read(&repo, "scene.md").unwrap(),
        Some(first.clone())
    );
    let second = second_store
        .stage(&repo, "scene.md", &hash, "Second")
        .unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(
        second_store
            .discard(&repo, "scene.md", &first.id)
            .unwrap_err(),
        Error::RecoveryChanged
    );
    assert_eq!(
        second_store.read(&repo, "scene.md").unwrap(),
        Some(second.clone())
    );
    second_store.discard(&repo, "scene.md", &second.id).unwrap();
    second_store.discard(&repo, "scene.md", &second.id).unwrap();
    assert_eq!(second_store.read(&repo, "scene.md").unwrap(), None);
}
#[test]
fn reading_empty_recovery_claims_scene_before_editing() {
    let (temp, repo, first) = fixture();
    let second = RecoveryStore::open(temp.path().join("appdata/recovery")).unwrap();
    let hash = repo.read("scene.md").unwrap().content_hash;
    assert_eq!(first.read(&repo, "scene.md").unwrap(), None);
    assert_eq!(
        second.read(&repo, "scene.md").unwrap_err(),
        Error::RecoveryBusy
    );
    assert_eq!(
        second
            .stage(&repo, "scene.md", &hash, "Second instance")
            .unwrap_err(),
        Error::RecoveryBusy
    );
    let draft = first
        .stage(&repo, "scene.md", &hash, "First instance")
        .unwrap();
    drop(first);
    assert_eq!(
        second
            .stage(&repo, "scene.md", &hash, "Stale second instance")
            .unwrap_err(),
        Error::RecoveryChanged
    );
    assert_eq!(second.read(&repo, "scene.md").unwrap(), Some(draft));
}
#[test]
fn repositories_and_paths_are_isolated_and_keys_are_stable() {
    let (temp, repo, store) = fixture();
    let hash = repo.read("scene.md").unwrap().content_hash;
    let first = store.stage(&repo, "scene.md", &hash, "First").unwrap();
    fs::write(repo.root().join("other.md"), ORIGINAL).unwrap();
    assert_eq!(store.read(&repo, "other.md").unwrap(), None);
    let second_root = temp.path().join("repository2");
    fs::create_dir(&second_root).unwrap();
    fs::write(second_root.join("scene.md"), ORIGINAL).unwrap();
    let second = Repository::open(&second_root).unwrap();
    assert_ne!(repo.project_key(), second.project_key());
    assert_eq!(store.read(&second, "scene.md").unwrap(), None);
    let normalized = Repository::open(repo.root().join(".")).unwrap();
    assert_eq!(repo.project_key(), normalized.project_key());
    assert_eq!(store.read(&normalized, "scene.md").unwrap(), Some(first));
}
#[test]
fn generated_sources_and_invalid_manifests_cannot_be_staged() {
    for manifest in [
        r#"{"schema_version":1,"project":"Book","volumes":[],"sources":[{"path":"scene.md"}]}"#,
        r#"{"schema_version":1,"project":"Book","volumes":[{"number":1,"title":"V","directory":"v","chapters":[{"number":1,"title":"C","directory":"v/c","source":"scene.md","scenes":[]}]}]}"#,
        r#"{"schema_version":2,"project":"Book","volumes":[]}"#,
        "malformed",
    ] {
        let (temp, repo, store) = fixture();
        let hash = repo.read("scene.md").unwrap().content_hash;
        fs::write(repo.root().join("scene-manifest.json"), manifest).unwrap();
        fs::write(repo.root().join(".gitignore"), "scene-manifest.json\n").unwrap();
        assert!(store
            .stage(&repo, "scene.md", &hash, "Do not stage generated")
            .is_err());
        assert_eq!(
            fs::read_dir(temp.path().join("appdata/recovery"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            fs::read_to_string(repo.root().join("scene.md")).unwrap(),
            ORIGINAL
        );
    }
}
#[test]
fn rejects_unsafe_paths_oversized_text_and_invalid_hashes() {
    let (temp, repo, store) = fixture();
    let hash = repo.read("scene.md").unwrap().content_hash;
    fs::write(repo.root().join("data.txt"), "text").unwrap();
    symlink(repo.root().join("scene.md"), repo.root().join("link.md")).unwrap();
    fs::write(repo.root().join(".gitignore"), "ignored.md\n").unwrap();
    fs::write(repo.root().join("ignored.md"), "ignored").unwrap();
    for path in [
        "../scene.md",
        "/scene.md",
        "link.md",
        "missing.md",
        "data.txt",
        "ignored.md",
        ".secret.md",
    ] {
        assert!(store.stage(&repo, path, &hash, "draft").is_err(), "{path}");
    }
    assert_eq!(
        store
            .stage(&repo, "scene.md", "bogus", "draft")
            .unwrap_err(),
        Error::InvalidRecovery
    );
    assert_eq!(
        store
            .stage(&repo, "scene.md", &hash, "binary\0")
            .unwrap_err(),
        Error::UnsupportedText
    );
    assert_eq!(
        store
            .stage(
                &repo,
                "scene.md",
                &hash,
                &"x".repeat(MAX_FILE_BYTES as usize + 1)
            )
            .unwrap_err(),
        Error::TooLarge
    );
    assert_eq!(
        fs::read_dir(temp.path().join("appdata/recovery"))
            .unwrap()
            .count(),
        0
    );
}
#[test]
fn corrupt_snapshot_is_reported_and_preserved_instead_of_overwritten() {
    let (temp, repo, store) = fixture();
    let hash = repo.read("scene.md").unwrap().content_hash;
    let draft = store.stage(&repo, "scene.md", &hash, "valuable").unwrap();
    let path = record(&temp);
    fs::write(&path, "truncated").unwrap();
    assert_eq!(
        store.read(&repo, "scene.md").unwrap_err(),
        Error::InvalidRecovery
    );
    assert_eq!(
        store.stage(&repo, "scene.md", &hash, "new").unwrap_err(),
        Error::InvalidRecovery
    );
    assert_eq!(
        store.discard(&repo, "scene.md", &draft.id).unwrap_err(),
        Error::InvalidRecovery
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "truncated");
}
#[test]
fn symlinked_or_public_storage_and_record_links_are_rejected() {
    let (temp, repo, store) = fixture();
    let hash = repo.read("scene.md").unwrap().content_hash;
    store.stage(&repo, "scene.md", &hash, "valuable").unwrap();
    let path = record(&temp);
    let outside = temp.path().join("outside.json");
    fs::rename(&path, &outside).unwrap();
    symlink(&outside, &path).unwrap();
    assert_eq!(
        store.read(&repo, "scene.md").unwrap_err(),
        Error::RecoveryIo
    );
    assert_eq!(
        store.stage(&repo, "scene.md", &hash, "new").unwrap_err(),
        Error::RecoveryIo
    );
    fs::remove_file(&path).unwrap();
    fs::hard_link(&outside, &path).unwrap();
    assert_eq!(
        store.read(&repo, "scene.md").unwrap_err(),
        Error::RecoveryIo
    );
    let alias = temp.path().join("alias");
    symlink(temp.path().join("appdata"), &alias).unwrap();
    assert!(RecoveryStore::open(alias.join("recovery")).is_err());
    fs::set_permissions(
        temp.path().join("appdata/recovery"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(RecoveryStore::open(temp.path().join("appdata/recovery")).is_err());
    assert_eq!(
        store.stage(&repo, "scene.md", &hash, "new").unwrap_err(),
        Error::RecoveryIo
    );
}
#[test]
fn reopening_removes_incomplete_temporary_without_promoting_it() {
    let (temp, repo, store) = fixture();
    let hash = repo.read("scene.md").unwrap().content_hash;
    let draft = store
        .stage(&repo, "scene.md", &hash, "Last complete")
        .unwrap();
    let folder = temp.path().join("appdata/recovery");
    fs::write(
        folder.join(format!(".heinlein-recovery-{}.tmp", uuid::Uuid::new_v4())),
        "incomplete",
    )
    .unwrap();
    drop(store);
    let reopened = RecoveryStore::open(&folder).unwrap();
    assert_eq!(reopened.read(&repo, "scene.md").unwrap(), Some(draft));
    assert_eq!(fs::read_dir(folder).unwrap().count(), 2);
}
#[test]
fn abrupt_process_exit_recovers_acknowledged_snapshot() {
    let (temp, repo, store) = fixture();
    drop(store);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "recovery_process_helper",
            "--nocapture",
        ])
        .env("HEINLEIN_RECOVERY_TEST_ROOT", temp.path())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    loop {
        let mut line = String::new();
        assert!(
            output.read_line(&mut line).unwrap() > 0,
            "child exited before durable acknowledgement"
        );
        if line.contains("RECOVERY_DURABLE") {
            break;
        }
    }
    // SIGKILL on Unix: no destructors, no close confirmation, no final flush.
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    let reopened = RecoveryStore::open(temp.path().join("appdata/recovery")).unwrap();
    let draft = reopened.read(&repo, "scene.md").unwrap().unwrap();
    assert_eq!(draft.text, "Buffer acknowledged before abrupt exit\r\n");
    assert_eq!(repo.read("scene.md").unwrap().text, ORIGINAL);
    reopened
        .stage(
            &repo,
            "scene.md",
            &draft.base_hash,
            "Recovered and continued",
        )
        .unwrap();
}
#[test]
#[ignore = "subprocess helper for abrupt_process_exit_recovers_acknowledged_snapshot"]
fn recovery_process_helper() {
    let Ok(root) = std::env::var("HEINLEIN_RECOVERY_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let repo = Repository::open(root.join("repository")).unwrap();
    let store = RecoveryStore::open(root.join("appdata/recovery")).unwrap();
    let hash = repo.read("scene.md").unwrap().content_hash;
    store
        .stage(
            &repo,
            "scene.md",
            &hash,
            "Buffer acknowledged before abrupt exit\r\n",
        )
        .unwrap();
    println!("RECOVERY_DURABLE");
    std::io::stdout().flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(60));
    panic!("parent should terminate the subprocess after acknowledgement");
}
#[test]
#[ignore = "opt-in machine-specific fsync benchmark; synthetic temporary files only"]
fn benchmark_durable_autosave() {
    let (_temp, repo, store) = fixture();
    let mut hash = repo.read("scene.md").unwrap().content_hash;
    let mut snapshot = vec![];
    let mut total = vec![];
    for n in 0..100 {
        let text = format!(
            "{ORIGINAL}{}\r\nRevision {n}\r\n",
            "Synthetic scene prose.\r\n".repeat(1000)
        );
        let start = Instant::now();
        let draft = store.stage(&repo, "scene.md", &hash, &text).unwrap();
        snapshot.push(start.elapsed().as_secs_f64() * 1000.0);
        hash = repo.save("scene.md", &hash, &text).unwrap().content_hash;
        store.discard(&repo, "scene.md", &draft.id).unwrap();
        total.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    snapshot.sort_by(f64::total_cmp);
    total.sort_by(f64::total_cmp);
    println!("100 synthetic ~23 KiB saves, OS={}, debug build; snapshot(file+directory fsync) p50={:.3}ms p95={:.3}ms; stage+save+CAS-clear p50={:.3}ms p95={:.3}ms", std::env::consts::OS, snapshot[49], snapshot[94], total[49], total[94]);
}
