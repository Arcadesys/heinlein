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
