mod support;
use github_workspace::{
    locator,
    registry::StateDir,
    transport::{self, Files},
    Error,
};
use support::*;
#[test]
fn urls_and_refs_are_data_not_arguments() {
    for url in [
        "git@github.com:a/b",
        "http://github.com/a/b",
        "https://token@github.com/a/b",
        "https://github.com/a/b/tree/main",
        "https://github.com/a/b?token=secret",
        "https://evil.invalid/a/b",
        "https://github.com/a/%2e%2e",
    ] {
        assert!(locator(url).is_err(), "{url}")
    }
    assert_eq!(
        locator("https://github.com/example/story.git").unwrap(),
        ("example".into(), "story".into())
    );
    for r in ["-main", "a..b", "a@{b", ""] {
        assert!(transport::valid_ref(r).is_err())
    }
}
#[test]
fn stable_offline_reopen_and_account_binding() {
    let f = Fixture::new();
    let w = f.register();
    let key = repository_core::Repository::open(f.registry.checkout(&w.id).unwrap())
        .unwrap()
        .project_key();
    drop(f.registry.reopen(&w.id).unwrap());
    let r = github_workspace::registry::Registry::open(
        &f.root.join("private"),
        &f.root.join("sources"),
    )
    .unwrap();
    let (again, _) = r.reopen(&w.id).unwrap();
    assert_eq!(again.repo.id, 42);
    assert_eq!(
        repository_core::Repository::open(r.checkout(&w.id).unwrap())
            .unwrap()
            .project_key(),
        key
    );
    assert!(matches!(
        r.register(info(), 10, &w.auth_binding, |_| panic!("must not reclone")),
        Err(Error::Account)
    ));
}
#[test]
fn raw_blobs_ignore_filters_hooks_and_configs() {
    let f = Fixture::new();
    let w = f
        .registry
        .register(info(), 9, "00000000-0000-4000-8000-000000000009", |repo| {
            repo.config()?
                .set_str("filter.bad.smudge", "touch /tmp/SHOULD-NOT-RUN")?;
            Ok(commit(
                repo,
                &Files::from([
                    ("story.md".into(), b"Exact\r\nsource\n".to_vec()),
                    (
                        ".gitattributes".into(),
                        b"*.md filter=bad text eol=crlf".to_vec(),
                    ),
                    (
                        ".gitconfig".into(),
                        b"[include]\npath=/not/allowed".to_vec(),
                    ),
                ]),
                &[],
            ))
        })
        .unwrap();
    let (_, repo) = f.registry.reopen(&w.id).unwrap();
    assert!(repo
        .config()
        .unwrap()
        .get_string("filter.bad.smudge")
        .is_err());
    assert_eq!(
        std::fs::read(f.registry.checkout(&w.id).unwrap().join("story.md")).unwrap(),
        b"Exact\r\nsource\n"
    );
}
#[test]
fn unsafe_trees_and_limits_never_register() {
    for files in [
        Files::from([("../escape.md".into(), vec![])]),
        Files::from([("A.md".into(), vec![]), ("a.md".into(), vec![])]),
        Files::from([(
            "x.md".into(),
            b"version https://git-lfs.github.com/spec/v1\n".to_vec(),
        )]),
        Files::from([("huge.md".into(), vec![0; 2 * 1024 * 1024 + 1])]),
    ] {
        assert!(transport::validate_files(&files).is_err())
    }
    let f = Fixture::new();
    assert!(f
        .registry
        .register(info(), 9, "00000000-0000-4000-8000-000000000009", |_| Err(
            Error::Canceled
        ))
        .is_err());
    assert!(f.registry.list().unwrap().is_empty());
    assert_eq!(
        std::fs::read_dir(f.root.join("sources")).unwrap().count(),
        0
    );
}
#[test]
fn symlinks_and_gitlinks_rejected_before_materialization() {
    for mode in [0o120000, 0o160000] {
        let f = Fixture::new();
        let result =
            f.registry
                .register(info(), 9, "00000000-0000-4000-8000-000000000009", |repo| {
                    let id = if mode == 0o120000 {
                        repo.blob(b"/private/source")?
                    } else {
                        commit(repo, &Files::new(), &[])
                    };
                    let mut tree = repo.treebuilder(None)?;
                    tree.insert("danger", id, mode)?;
                    let id = tree.write()?;
                    let tree = repo.find_tree(id)?;
                    let sig = git2::Signature::now("Test", "test@example.invalid")?;
                    Ok(repo.commit(None, &sig, &sig, "Synthetic", &tree, &[])?)
                });
        assert!(result.is_err());
        assert!(f.registry.list().unwrap().is_empty());
    }
}
#[test]
fn missing_checkout_never_reclones_and_failed_registry_stays_unregistered() {
    let f = Fixture::new();
    let w = f.register();
    std::fs::remove_dir_all(f.registry.checkout(&w.id).unwrap()).unwrap();
    assert!(matches!(f.registry.reopen(&w.id), Err(Error::Missing)));
    let f = Fixture::new();
    std::fs::create_dir(f.root.join("private/registry-v1.json")).unwrap();
    assert!(f
        .registry
        .register(
            info(),
            9,
            "00000000-0000-4000-8000-000000000009",
            |repo| Ok(commit(repo, &Files::new(), &[]))
        )
        .is_err());
}
#[test]
fn private_lock_and_malformed_state_fail_closed() {
    let f = Fixture::new();
    let dir = StateDir::open(&f.root.join("private")).unwrap();
    let _first = dir.lock("operation.lock").unwrap();
    assert!(matches!(dir.lock("operation.lock"), Err(Error::Busy)));
    std::fs::write(
        f.root.join("private/registry-v1.json"),
        b"{\"version\":99,\"workspaces\":[]}",
    )
    .unwrap();
    assert!(f.registry.list().is_err());
}

#[test]
fn passive_large_assets_keep_exact_blobs_modes_and_bounded_preview_memory() {
    use github_workspace::operations::{self, Identity};
    let f = Fixture::new();
    let w = f
        .registry
        .register(info(), 9, "00000000-0000-4000-8000-000000000009", |repo| {
            let asset = repo.blob(&vec![37; 3 * 1024 * 1024])?;
            let scene = repo.blob(b"Original scene.\n")?;
            let script = repo.blob(b"#!/bin/sh\necho never-executed\n")?;
            let mut builder = repo.treebuilder(None)?;
            builder.insert("cover.bin", asset, 0o100644)?;
            builder.insert("passive-script", script, 0o100755)?;
            builder.insert("story.md", scene, 0o100644)?;
            let tree = repo.find_tree(builder.write()?)?;
            let sig = git2::Signature::now("Synthetic", "test@example.invalid")?;
            Ok(repo.commit(None, &sig, &sig, "Synthetic large tree", &tree, &[])?)
        })
        .unwrap();
    let root = f.registry.checkout(&w.id).unwrap();
    assert_eq!(
        std::fs::read(root.join("cover.bin")).unwrap(),
        vec![37; 3 * 1024 * 1024]
    );
    let (_, repo) = f.registry.reopen(&w.id).unwrap();
    let before = transport::tree_files(&repo, w.head_oid.parse().unwrap()).unwrap();
    assert_eq!(before.entries.len(), 3);
    assert!(before.payload_bytes() < 1024);
    let cloned = before.clone();
    assert!(std::sync::Arc::ptr_eq(&before.entries, &cloned.entries));
    assert!(std::sync::Arc::ptr_eq(
        before.get("story.md").unwrap(),
        cloned.get("story.md").unwrap()
    ));
    std::fs::write(root.join("story.md"), "Revised scene.\n").unwrap();
    let p = operations::version_preview(
        &f.registry,
        &w.id,
        vec!["story.md".into()],
        Identity {
            name: "Synthetic".into(),
            email: "test@example.invalid".into(),
        },
        "One exact scene".into(),
    )
    .unwrap();
    let receipt = operations::commit_version(&f.registry, &p, |_| Ok(())).unwrap();
    let after = transport::tree_files(&repo, receipt.head.parse().unwrap()).unwrap();
    for path in ["cover.bin", "passive-script"] {
        assert_eq!(before.entries[path], after.entries[path]);
    }
    assert_eq!(after.entries["passive-script"].mode, 0o100755);
    assert_eq!(after["story.md"], b"Revised scene.\n");
    assert_eq!(
        std::fs::read(root.join("cover.bin")).unwrap(),
        vec![37; 3 * 1024 * 1024]
    );
    assert!(f.registry.reopen(&w.id).is_ok());
}
#[test]
fn rejected_new_open_removes_only_its_unpublished_object_database() {
    let f = Fixture::new();
    let w = f.register();
    let before = std::fs::read_dir(f.root.join("private"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect::<std::collections::BTreeSet<_>>();
    let mut other = info();
    other.id = 43;
    other.name = "other".into();
    for _ in 0..3 {
        assert!(f
            .registry
            .register(
                other.clone(),
                9,
                "00000000-0000-4000-8000-000000000009",
                |repo| {
                    let _ = repo.blob(&vec![11; 3 * 1024 * 1024])?;
                    Err(Error::Canceled)
                }
            )
            .is_err());
        let after = std::fs::read_dir(f.root.join("private"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(before, after);
        assert!(f.registry.reopen(&w.id).is_ok());
        assert_eq!(
            std::fs::read(f.registry.checkout(&w.id).unwrap().join("story.md")).unwrap(),
            b"Original story.\n"
        );
    }
}
#[test]
fn typed_limits_distinguish_passive_storage_editor_count_and_depth() {
    use github_workspace::transport::{TreeEntry, MAX_BLOB_BYTES, MAX_EDIT_BYTES, MAX_FILES};
    use std::{collections::BTreeMap, sync::Arc};
    let entry = |size| TreeEntry {
        oid: git2::Oid::ZERO_SHA1,
        mode: 0o100644,
        size,
        editable: false,
    };
    let mut files = Files::new();
    files.entries = Arc::new(BTreeMap::from([(
        "large.bin".into(),
        entry(MAX_BLOB_BYTES + 1),
    )]));
    assert!(matches!(
        transport::validate_files(&files),
        Err(Error::Budget {
            phase: "tree",
            kind: "blob bytes",
            ..
        })
    ));
    files.entries = Arc::new(
        (0..MAX_FILES + 1)
            .map(|n| (format!("f{n}"), entry(0)))
            .collect(),
    );
    assert!(matches!(
        transport::validate_files(&files),
        Err(Error::Budget {
            kind: "file count",
            ..
        })
    ));
    files.entries = Arc::new(
        (0..9)
            .map(|n| (format!("f{n}"), entry(MAX_BLOB_BYTES)))
            .collect(),
    );
    assert!(matches!(
        transport::validate_files(&files),
        Err(Error::Budget {
            kind: "total bytes",
            ..
        })
    ));
    let text = Files::from([("large.md".into(), vec![0; MAX_EDIT_BYTES + 1])]);
    assert!(matches!(
        transport::validate_files(&text),
        Err(Error::Budget {
            phase: "editor",
            kind: "file bytes",
            ..
        })
    ));
    let f = Fixture::new();
    let err = f
        .registry
        .register(info(), 9, "00000000-0000-4000-8000-000000000009", |repo| {
            let mut id = repo.blob(b"source")?;
            let mut mode = 0o100644;
            for _ in 0..35 {
                let mut b = repo.treebuilder(None)?;
                b.insert("nested", id, mode)?;
                id = b.write()?;
                mode = 0o040000;
            }
            let tree = repo.find_tree(id)?;
            let sig = git2::Signature::now("Synthetic", "test@example.invalid")?;
            Ok(repo.commit(None, &sig, &sig, "Deep synthetic tree", &tree, &[])?)
        })
        .unwrap_err();
    assert!(matches!(
        err,
        Error::Budget {
            kind: "directory depth",
            ..
        }
    ));
    assert!(err.to_string().contains("safe limit"));
}
#[test]
fn metadata_snapshots_bound_memory_while_materializing_96_mib() {
    let f = Fixture::new();
    let w = f
        .registry
        .register(info(), 9, "00000000-0000-4000-8000-000000000009", |repo| {
            let mut builder = repo.treebuilder(None)?;
            for n in 0..9 {
                let size = if n == 0 {
                    32 * 1024 * 1024
                } else {
                    8 * 1024 * 1024
                };
                let id = repo.blob(&vec![n as u8; size])?;
                builder.insert(format!("asset-{n}.bin"), id, 0o100644)?;
            }
            builder.insert("story.md", repo.blob(b"Small story.\n")?, 0o100644)?;
            let tree = repo.find_tree(builder.write()?)?;
            let sig = git2::Signature::now("Synthetic", "test@example.invalid")?;
            Ok(repo.commit(None, &sig, &sig, "Bounded synthetic stress", &tree, &[])?)
        })
        .unwrap();
    let (_, repo) = f.registry.reopen(&w.id).unwrap();
    let snapshot = transport::tree_files(&repo, w.head_oid.parse().unwrap()).unwrap();
    let copies = [
        snapshot.clone(),
        snapshot.clone(),
        snapshot.clone(),
        snapshot.clone(),
    ];
    assert!(copies
        .iter()
        .all(|s| std::sync::Arc::ptr_eq(&s.entries, &snapshot.entries)));
    assert_eq!(snapshot.payload_bytes(), 13);
    assert_eq!(
        snapshot.entries.values().map(|e| e.size).sum::<usize>(),
        96 * 1024 * 1024 + 13
    );
    let root = repository_core::Repository::open(f.registry.checkout(&w.id).unwrap()).unwrap();
    assert_eq!(
        github_workspace::operations::disk_files(&root, &snapshot).unwrap(),
        snapshot
    );
    assert_eq!(
        std::fs::metadata(root.root().join("asset-0.bin"))
            .unwrap()
            .len(),
        32 * 1024 * 1024
    );
}
#[test]
fn interrupted_unpublished_open_is_recovered_but_live_registered_and_unmarked_stores_survive() {
    let f = Fixture::new();
    let existing = f.register();
    let unmarked = uuid::Uuid::new_v4().to_string();
    let unknown = f.registry.directory(&unmarked).unwrap();
    std::fs::write(unknown.path().join("keep"), "Synthetic unknown state").unwrap();
    let mut other = info();
    other.id = 43;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        f.registry.register(
            other.clone(),
            9,
            "00000000-0000-4000-8000-000000000009",
            |repo| {
                let _ = commit(
                    repo,
                    &Files::from([("story.md".into(), b"Partial synthetic open".to_vec())]),
                    &[],
                );
                panic!("Synthetic process interruption")
            },
        )
    }));
    assert!(result.is_err());
    let orphans = std::fs::read_dir(f.root.join("sources"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("opening-"))
        .map(|e| e.path())
        .collect::<Vec<_>>();
    assert_eq!(orphans.len(), 1);
    let id = orphans[0]
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .trim_start_matches("opening-")
        .to_owned();
    let dir = f.registry.directory(&id).unwrap();
    let lock = dir.lock("workspace.lock").unwrap();
    // A concurrent new opener cannot reclaim an active opening.
    let _ = f.registry.register(
        other.clone(),
        9,
        "00000000-0000-4000-8000-000000000009",
        |_| Err(Error::Network),
    );
    assert!(orphans[0].exists());
    drop(lock);
    let again = github_workspace::registry::Registry::open(
        &f.root.join("private"),
        &f.root.join("sources"),
    )
    .unwrap();
    let _ = again.register(other, 9, "00000000-0000-4000-8000-000000000009", |_| {
        Err(Error::Network)
    });
    assert!(!orphans[0].exists());
    assert!(!dir.path().exists());
    assert!(unknown.path().join("keep").exists());
    assert_eq!(again.reopen(&existing.id).unwrap().0, existing);
}

#[test]
fn unknown_workspace_reopen_never_allocates_a_private_directory() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    assert!(matches!(f.registry.reopen(&id), Err(Error::Missing)));
    assert!(!f.root.join("private").join(id).exists());
}

#[test]
fn unsupported_scan_layouts_fail_with_typed_budgets_before_workspace_publication() {
    for distributed in [false, true] {
        let f = Fixture::new();
        let mut files = Files::from([("story.md".into(), b"Story\n".to_vec())]);
        let count = if distributed { 8192 } else { 5000 };
        for n in 0..count {
            let path = if distributed {
                format!("bucket-{}/asset-{n}.bin", n / 3000)
            } else {
                format!("asset-{n}.bin")
            };
            files.insert(path, Vec::new());
        }
        let result = f
            .registry
            .register(info(), 9, &uuid::Uuid::new_v4().to_string(), |repo| {
                // Construct raw synthetic Git trees without the managed validator,
                // so rejection is exercised by the real registration boundary.
                let empty = repo.blob(b"")?;
                let story = repo.blob(b"Story\n")?;
                let mut root = repo.treebuilder(None)?;
                root.insert("story.md", story, 0o100644)?;
                let mut groups = std::collections::BTreeMap::<String, Vec<String>>::new();
                for path in files.keys().filter(|p| p.as_str() != "story.md") {
                    if let Some((dir, name)) = path.split_once('/') {
                        groups.entry(dir.into()).or_default().push(name.into());
                    } else {
                        root.insert(path, empty, 0o100644)?;
                    }
                }
                for (dir, names) in groups {
                    let mut child = repo.treebuilder(None)?;
                    for name in names {
                        child.insert(name, empty, 0o100644)?;
                    }
                    root.insert(dir, child.write()?, 0o040000)?;
                }
                let tree = repo.find_tree(root.write()?)?;
                let sig = git2::Signature::now("Synthetic", "test@example.invalid")?;
                Ok(repo.commit(None, &sig, &sig, "Synthetic scan budget", &tree, &[])?)
            });
        assert!(
            matches!(result,Err(Error::Budget{phase:"workspace scan",kind,..})if kind==if distributed{"traversal entries"}else{"directory entries"})
        );
        assert!(f.registry.list().unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(f.root.join("sources")).unwrap().count(),
            0
        );
    }
}

#[test]
fn accepted_scan_boundary_tree_supports_inspection_local_version_and_branch_preview() {
    use github_workspace::{
        branches,
        operations::{self, Identity},
    };
    use std::sync::atomic::Ordering;
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, _) = connected(&f.root, &api);
    let c = auth.credential(&api, 1006).unwrap();
    let mut files = Files::from([("a/story.md".into(), b"Original author text.\n".to_vec())]);
    for n in 0..transport::MAX_DIRECTORY_CHILDREN - 1 {
        files.insert(format!("a/passive-{n}.bin"), Vec::new());
    }
    for n in 0..transport::MAX_DIRECTORY_CHILDREN {
        files.insert(format!("b/passive-{n}.bin"), Vec::new());
    }
    for n in 0..2 {
        files.insert(format!("extra-{n}.bin"), Vec::new());
    }
    // 4,094 actual children per directory + 2 OS dot entries; exactly 8,192
    // file/directory nodes overall, including the two parent directories.
    let w = f
        .registry
        .register(info(), 9, &c.binding, |repo| Ok(commit(repo, &files, &[])))
        .unwrap();
    *api.base.lock().unwrap() = Some(w.base_oid.clone());
    let path = f.registry.checkout(&w.id).unwrap();
    let root = repository_core::Repository::open(&path).unwrap();
    assert_eq!(
        root.list("a").unwrap().len(),
        transport::MAX_DIRECTORY_CHILDREN
    );
    let (_, git) = f.registry.reopen(&w.id).unwrap();
    let tracked = transport::tree_files(&git, w.head_oid.parse().unwrap()).unwrap();
    assert_eq!(operations::disk_files(&root, &tracked).unwrap(), tracked);
    std::fs::write(path.join("a/story.md"), "Author-selected local revision.\n").unwrap();
    let version = operations::version_preview(
        &f.registry,
        &w.id,
        vec!["a/story.md".into()],
        Identity {
            name: "Synthetic".into(),
            email: "test@example.invalid".into(),
        },
        "Exact local version".into(),
    )
    .unwrap();
    assert_eq!(version.preview.files.len(), 1);
    let saved = operations::commit_version(&f.registry, &version, |_| Ok(())).unwrap();
    let branch = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        "revision/scan-boundary",
        true,
        |_, _| panic!("local branch requires no fetch"),
    )
    .unwrap();
    assert_eq!(branch.preview.head, saved.head);
    assert!(branch.preview.files.is_empty());
    assert_eq!(api.mutations.load(Ordering::SeqCst), 0);
    assert_eq!(
        std::fs::read(path.join("a/story.md")).unwrap(),
        b"Author-selected local revision.\n"
    );
}
