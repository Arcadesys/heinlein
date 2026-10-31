use super::*;
use crate::{registry::Registry, RepoInfo};

const BINDING: &str = "00000000-0000-4000-8000-000000000009";
fn info(id: u64) -> RepoInfo {
    RepoInfo {
        id,
        owner: "synthetic".into(),
        name: format!("story-{id}"),
        private: true,
        default_branch: "main".into(),
        installation_id: 7,
    }
}
fn version(repo: &Repository, files: &Files, parent: Option<Oid>) -> Oid {
    let tree = tree_from_files(repo, files).unwrap();
    let tree = repo.find_tree(tree).unwrap();
    let sig = git2::Signature::now("Synthetic Writer", "writer@example.invalid").unwrap();
    let parent = parent.map(|p| repo.find_commit(p).unwrap());
    repo.commit(
        None,
        &sig,
        &sig,
        "Synthetic version",
        &tree,
        &parent.iter().collect::<Vec<_>>(),
    )
    .unwrap()
}
fn noise(size: usize, mut state: u64) -> Vec<u8> {
    // Deterministic incompressible fixture, never private source or network data.
    (0..size)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect()
}
#[test]
fn initial_open_above_old_transfer_cap_and_offline_reopen_preserve_full_history() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let remote = Repository::init_bare(root.join("remote.git")).unwrap();
    let files = Files::from([(
        "story.md".into(),
        "Exact source — intentional.\n".as_bytes().to_vec(),
    )]);
    let base = version(&remote, &files, None);
    // 104 MiB incompressible pack, within independent 32 MiB blob/256 MiB tree caps.
    let parent = remote.find_commit(base).unwrap();
    let mut builder = remote.treebuilder(Some(&parent.tree().unwrap())).unwrap();
    for n in 0..4 {
        let oid = remote.blob(&noise(26 * 1024 * 1024, n + 1)).unwrap();
        builder
            .insert(format!("asset-{n}.bin"), oid, 0o100644)
            .unwrap();
    }
    let tree_id = builder.write().unwrap();
    drop(builder);
    let tree = remote.find_tree(tree_id).unwrap();
    let sig = git2::Signature::now("Synthetic Writer", "writer@example.invalid").unwrap();
    let tip = remote
        .commit(None, &sig, &sig, "Synthetic assets", &tree, &[&parent])
        .unwrap();
    remote
        .reference("refs/heads/main", tip, false, "Synthetic main")
        .unwrap();
    let registry = Registry::open(&root.join("private"), &root.join("sources")).unwrap();
    let workspace = registry
        .register(info(42), 9, BINDING, |repo| {
            fetch_bounded(
                repo,
                remote.path().to_str().unwrap(),
                "main",
                None,
                MAX_PRIVATE_BYTES,
            )
        })
        .unwrap();
    let checkout = registry.checkout(&workspace.id).unwrap();
    let key = repository_core::Repository::open(&checkout)
        .unwrap()
        .project_key();
    let (_, repo) = registry.reopen(&workspace.id).unwrap();
    assert!(repo.find_commit(base).is_ok());
    assert!(!repo.is_shallow());
    assert_eq!(workspace.base_oid, tip.to_string());
    assert!(object_disk_budget(repo.path(), MAX_PRIVATE_BYTES).unwrap() > 100 * 1024 * 1024);
    assert!(repo.find_reference("refs/heads/main").is_err());
    assert!(fs::read(repo.path().join("FETCH_HEAD"))
        .unwrap_or_default()
        .is_empty());
    assert_eq!(remote.refname_to_id("refs/heads/main").unwrap(), tip);
    assert_eq!(repo.remotes().unwrap().len(), 0);
    drop(repo);
    drop(tree);
    drop(parent);
    drop(remote);
    fs::remove_dir_all(root.join("remote.git")).unwrap();
    drop(registry);
    let reopened = Registry::open(&root.join("private"), &root.join("sources")).unwrap();
    assert_eq!(
        reopened
            .register(info(42), 9, BINDING, |_| panic!(
                "offline reopen must not fetch"
            ))
            .unwrap(),
        workspace
    );
    assert_eq!(
        repository_core::Repository::open(&checkout)
            .unwrap()
            .project_key(),
        key
    );
    assert_eq!(
        fs::read(checkout.join("story.md")).unwrap(),
        files["story.md"]
    );
}

#[test]
fn reported_transfer_and_exact_available_edges_use_existing_storage_policy() {
    let reported = 104_916_647;
    assert!(reported > 100 * 1024 * 1024);
    for used in [0, 4096, 100 * 1024 * 1024, MAX_PRIVATE_BYTES - reported] {
        let available = fetch_allowance(used, MAX_PRIVATE_BYTES).unwrap();
        assert!(available <= MAX_PRIVATE_BYTES);
        assert!(transfer_budget(reported, 50_000, available).is_ok());
        assert!(transfer_budget(available, 50_000, available).is_ok());
        assert!(matches!(transfer_budget(available + 1, 1, available),
            Err(Error::Budget { phase: "fetch", kind: "transfer bytes", observed, cap })
            if observed == (available + 1) as u64 && cap == available as u64));
        assert!(matches!(
            transfer_budget(0, 50_001, available),
            Err(Error::Budget {
                kind: "object count",
                cap: 50_000,
                ..
            })
        ));
    }
    let available = fetch_allowance(MAX_PRIVATE_BYTES - 1, MAX_PRIVATE_BYTES).unwrap();
    assert_eq!(available, 1);
    assert!(transfer_budget(1, 1, available).is_ok());
    assert!(transfer_budget(2, 1, available).is_err());
    for used in [MAX_PRIVATE_BYTES, MAX_PRIVATE_BYTES + 1, usize::MAX] {
        assert!(matches!(
            fetch_allowance(used, MAX_PRIVATE_BYTES),
            Err(Error::Limit)
        ));
    }
    assert!(fetch_allowance(0, 0).is_err());
    assert!(fetch_allowance(0, MAX_PRIVATE_BYTES + 1).is_err());
}

fn snapshot(root: &Path) -> BTreeMap<std::path::PathBuf, Vec<u8>> {
    let mut paths = vec![root.to_owned()];
    let mut files = BTreeMap::new();
    while let Some(path) = paths.pop() {
        for entry in fs::read_dir(&path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                // Include directories so an empty leaked staging folder fails too.
                files.insert(path.strip_prefix(root).unwrap().to_owned(), Vec::new());
                paths.push(path);
            } else {
                files.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    files
}
fn asset_tip(remote: &Repository, bytes: &[u8]) -> Oid {
    let files = Files::from([("story.md".into(), b"Synthetic remote writing.\n".to_vec())]);
    let base = version(remote, &files, None);
    let parent = remote.find_commit(base).unwrap();
    let mut builder = remote.treebuilder(Some(&parent.tree().unwrap())).unwrap();
    builder
        .insert("asset.bin", remote.blob(bytes).unwrap(), 0o100644)
        .unwrap();
    let tree = remote.find_tree(builder.write().unwrap()).unwrap();
    let sig = git2::Signature::now("Synthetic Writer", "writer@example.invalid").unwrap();
    let tip = remote
        .commit(None, &sig, &sig, "Synthetic asset", &tree, &[&parent])
        .unwrap();
    remote
        .reference("refs/heads/main", tip, false, "Synthetic main")
        .unwrap();
    tip
}
#[test]
fn actual_accounting_is_checked_before_transport_and_exhaustion_is_not_unlimited() {
    let temp = tempfile::tempdir().unwrap();
    let repo = Repository::init_bare(temp.path().join("local.git")).unwrap();
    fs::write(repo.path().join("existing-private-data"), [0u8; 16384]).unwrap();
    let used = object_disk_budget(repo.path(), MAX_PRIVATE_BYTES).unwrap();
    // Sum real files, not the nominal GitHub repository size or allocated capacity.
    let actual: usize = snapshot(repo.path()).values().map(Vec::len).sum();
    assert_eq!(used, actual);
    assert_eq!(
        fetch_allowance(used, MAX_PRIVATE_BYTES).unwrap(),
        MAX_PRIVATE_BYTES - actual
    );
    let before = snapshot(repo.path());
    assert!(matches!(
        fetch_bounded(&repo, "/no-synthetic-remote-here", "main", None, used),
        Err(Error::Limit)
    ));
    assert!(matches!(
        fetch_bounded(&repo, "/no-synthetic-remote-here", "main", None, used - 1),
        Err(Error::Budget {
            phase: "private objects",
            kind: "disk bytes",
            ..
        })
    ));
    assert_eq!(snapshot(repo.path()), before);
}
#[cfg(unix)]
#[test]
fn invalid_private_storage_is_rejected_before_transport() {
    let temp = tempfile::tempdir().unwrap();
    let repo = Repository::init_bare(temp.path().join("local.git")).unwrap();
    std::os::unix::fs::symlink("/nonexistent-synthetic-target", repo.path().join("link")).unwrap();
    assert!(matches!(
        fetch_bounded(
            &repo,
            "/no-synthetic-remote-here",
            "main",
            None,
            MAX_PRIVATE_BYTES
        ),
        Err(Error::Storage)
    ));
}
#[test]
fn failed_opens_remove_staging_and_preserve_existing_writing_and_persisted_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let registry = Registry::open(&root.join("private"), &root.join("sources")).unwrap();
    let existing = registry
        .register(info(1), 9, BINDING, |repo| {
            Ok(version(
                repo,
                &Files::from([("story.md".into(), b"Saved local source.\n".to_vec())]),
                None,
            ))
        })
        .unwrap();
    let checkout = registry.checkout(&existing.id).unwrap();
    let key = repository_core::Repository::open(&checkout)
        .unwrap()
        .project_key();
    fs::write(
        checkout.join("story.md"),
        "Uncommitted exact writing — keep it.\r\n",
    )
    .unwrap();
    let (_, existing_git) = registry.reopen(&existing.id).unwrap();
    let original_head = existing_git.head().unwrap().target();
    let original_ref = existing_git.head().unwrap().name().unwrap().to_owned();
    let private_before = snapshot(&root.join("private"));
    let sources_before = snapshot(&root.join("sources"));
    let remote = Repository::init_bare(root.join("remote.git")).unwrap();
    let tip = asset_tip(&remote, &noise(128 * 1024, 123));
    let remote_before = snapshot(remote.path());
    for _ in 0..2 {
        // Existing private bytes + one available byte must abort in the real callback.
        let error = registry
            .register(info(2), 9, BINDING, |repo| {
                let used = object_disk_budget(repo.path(), MAX_PRIVATE_BYTES)?;
                fetch_bounded(
                    repo,
                    remote.path().to_str().unwrap(),
                    "main",
                    None,
                    used + 1,
                )
            })
            .unwrap_err();
        assert!(matches!(
            error,
            Error::Budget {
                phase: "fetch",
                kind: "transfer bytes",
                cap: 1,
                ..
            }
        ));
        assert_eq!(snapshot(&root.join("private")), private_before);
        assert_eq!(snapshot(&root.join("sources")), sources_before);
        assert_eq!(registry.list().unwrap(), vec![existing.clone()]);
    }
    assert_eq!(remote.refname_to_id("refs/heads/main").unwrap(), tip);
    assert_eq!(snapshot(remote.path()), remote_before);
    drop(existing_git);
    drop(registry);
    let registry = Registry::open(&root.join("private"), &root.join("sources")).unwrap();
    let (again, git) = registry.reopen(&existing.id).unwrap();
    assert_eq!(again, existing);
    assert_eq!(git.head().unwrap().target(), original_head);
    assert_eq!(git.head().unwrap().name().unwrap(), original_ref);
    assert_eq!(
        repository_core::Repository::open(checkout)
            .unwrap()
            .project_key(),
        key
    );
    assert_eq!(snapshot(&root.join("sources")), sources_before);
}
#[test]
fn compressed_transfer_must_also_pass_post_fetch_actual_disk_budget_before_publication() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let remote = Repository::init_bare(root.join("remote.git")).unwrap();
    asset_tip(&remote, &vec![0; 128 * 1024]);
    let registry = Registry::open(&root.join("private"), &root.join("sources")).unwrap();
    assert!(registry.list().unwrap().is_empty());
    let private_before = snapshot(&root.join("private"));
    let sources_before = snapshot(&root.join("sources"));
    let error = registry
        .register(info(42), 9, BINDING, |repo| {
            let used = object_disk_budget(repo.path(), MAX_PRIVATE_BYTES)?;
            // Small compressed pack fits, but its pack index and ref metadata do not.
            fetch_bounded(
                repo,
                remote.path().to_str().unwrap(),
                "main",
                None,
                used + 1024,
            )
        })
        .unwrap_err();
    assert!(
        matches!(
            error,
            Error::Budget {
                phase: "private objects",
                kind: "disk bytes",
                ..
            }
        ),
        "{error:?}"
    );
    assert_eq!(snapshot(&root.join("private")), private_before);
    assert_eq!(snapshot(&root.join("sources")), sources_before);
    assert!(registry.list().unwrap().is_empty());
}
