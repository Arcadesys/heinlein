mod support;
use github_workspace::{
    operations::{self, Identity},
    transport::Files,
    Error,
};
use support::*;
fn identity() -> Identity {
    Identity {
        name: "Example Writer".into(),
        email: "private@users.noreply.github.com".into(),
    }
}
fn setup(
    f: &Fixture,
    api: &MockApi,
) -> (
    github_workspace::auth::Auth,
    github_workspace::auth::Credential,
    github_workspace::registry::Workspace,
) {
    let (auth, _) = connected(&f.root, api);
    let c = auth.credential(api, 1006).unwrap();
    let w = f
        .registry
        .register(info(), 9, &c.binding, |repo| {
            Ok(commit(
                repo,
                &Files::from([("story.md".into(), b"Original story.\n".to_vec())]),
                &[],
            ))
        })
        .unwrap();
    *api.base.lock().unwrap() = Some(w.base_oid.clone());
    (auth, c, w)
}

fn plan(
    f: &Fixture,
    api: &MockApi,
    c: &github_workspace::auth::Credential,
    w: &github_workspace::registry::Workspace,
    changed: bool,
) -> operations::SendPlan {
    if changed {
        std::fs::write(
            f.registry.checkout(&w.id).unwrap().join("story.md"),
            "New — exact words.\n",
        )
        .unwrap();
    }
    operations::preview_send(
        &f.registry,
        api,
        c,
        &w.id,
        if changed {
            vec!["story.md".into()]
        } else {
            vec![]
        },
        Some(identity()),
        "Writing update".into(),
    )
    .unwrap()
}
#[test]
fn preview_is_read_only_and_confirm_versions_then_sends_once() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_auth, c, w) = setup(&f, &api);
    let p = plan(&f, &api, &c, &w, true);
    assert!(p.preview.creates_version);
    assert!(p.preview.can_send);
    assert_eq!(f.registry.get(&w.id).unwrap().head_oid, w.head_oid);
    assert!(
        github_workspace::journal::receipts(&f.registry.directory(&w.id).unwrap())
            .unwrap()
            .is_empty()
    );
    let calls = std::cell::Cell::new(0);
    let result = operations::confirm_send(
        &f.registry,
        &api,
        &c,
        &p,
        |_| Ok(()),
        |_, w, _| {
            calls.set(calls.get() + 1);
            *api.remote.lock().unwrap() = Some(w.head_oid.clone());
            Ok(())
        },
    )
    .unwrap();
    assert!(result.local_version_saved);
    assert_eq!(result.receipt.unwrap().status, "succeeded");
    operations::confirm_send(
        &f.registry,
        &api,
        &c,
        &p,
        |_| panic!("no duplicate version"),
        |_, _, _| panic!("no duplicate upload"),
    )
    .unwrap();
    assert_eq!(calls.get(), 1);
}
#[test]
fn existing_unsent_history_is_disclosed_even_when_not_selected_now() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_auth, c, w) = setup(&f, &api);
    std::fs::write(
        f.registry.checkout(&w.id).unwrap().join("earlier.md"),
        "Earlier private words",
    )
    .unwrap();
    let old = operations::version_preview(
        &f.registry,
        &w.id,
        vec!["earlier.md".into()],
        identity(),
        "Earlier".into(),
    )
    .unwrap();
    operations::commit_version(&f.registry, &old, |_| Ok(())).unwrap();
    let w = f.registry.get(&w.id).unwrap();
    let p = plan(&f, &api, &c, &w, true);
    assert!(p
        .preview
        .existing_versions
        .iter()
        .any(|h| h.files.iter().any(|f| f.path == "earlier.md")));
    assert!(p.preview.share.files.iter().any(|f| f.path == "earlier.md"));
    assert!(!p
        .preview
        .selected_files
        .iter()
        .any(|f| f.path == "earlier.md"));
}
#[test]
fn nochange_already_versioned_and_cancel_make_no_unnecessary_version() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_auth, c, w) = setup(&f, &api);
    let p = plan(&f, &api, &c, &w, false);
    assert!(!p.preview.can_send);
    drop(p);
    let p = plan(&f, &api, &c, &w, true);
    let pversion = operations::version_preview(
        &f.registry,
        &w.id,
        vec!["story.md".into()],
        identity(),
        "Local".into(),
    )
    .unwrap();
    drop(p);
    operations::commit_version(&f.registry, &pversion, |_| Ok(())).unwrap();
    let w = f.registry.get(&w.id).unwrap();
    let p = plan(&f, &api, &c, &w, false);
    assert!(!p.preview.creates_version);
    assert!(p.preview.can_send);
    let result = operations::confirm_send(
        &f.registry,
        &api,
        &c,
        &p,
        |_| Ok(()),
        |_, w, _| {
            *api.remote.lock().unwrap() = Some(w.head_oid.clone());
            Ok(())
        },
    )
    .unwrap();
    assert!(!result.local_version_saved);
    assert_eq!(f.registry.get(&w.id).unwrap().head_oid, w.head_oid);
}
#[test]
fn stale_file_remote_account_and_barrier_refuse_before_version_or_upload() {
    for case in ["file", "remote", "account", "base", "barrier"] {
        let f = Fixture::new();
        let api = MockApi::default();
        let (_auth, mut c, w) = setup(&f, &api);
        let p = plan(&f, &api, &c, &w, true);
        if case == "file" {
            std::fs::write(
                f.registry.checkout(&w.id).unwrap().join("story.md"),
                "Later typing",
            )
            .unwrap();
        }
        if case == "remote" {
            *api.remote.lock().unwrap() = Some(w.base_oid.clone());
        }
        if case == "account" {
            c.account.id += 1;
        }
        if case == "base" {
            *api.base.lock().unwrap() = Some("changed-base".into());
        }
        let result = operations::confirm_send(
            &f.registry,
            &api,
            &c,
            &p,
            |_| {
                if case == "barrier" {
                    Err(Error::Recovery)
                } else {
                    Ok(())
                }
            },
            |_, _, _| panic!("must not upload"),
        );
        assert!(result.is_err(), "{case}");
        assert_eq!(f.registry.get(&w.id).unwrap().head_oid, w.head_oid);
    }
}
#[test]
fn failed_or_unknown_upload_keeps_local_version_and_unknown_blocks_new_work() {
    for unknown in [false, true] {
        let f = Fixture::new();
        let api = MockApi::default();
        let (_auth, c, w) = setup(&f, &api);
        let p = plan(&f, &api, &c, &w, true);
        let result = operations::confirm_send(
            &f.registry,
            &api,
            &c,
            &p,
            |_| Ok(()),
            |_, _, _| {
                Err(if unknown {
                    Error::Network
                } else {
                    Error::Permission
                })
            },
        )
        .unwrap();
        assert!(result.local_version_saved);
        assert_ne!(f.registry.get(&w.id).unwrap().head_oid, w.head_oid);
        assert_eq!(
            result.receipt.unwrap().status,
            if unknown { "unknown" } else { "failed" }
        );
        let next =
            operations::preview_send(&f.registry, &api, &c, &w.id, vec![], None, String::new());
        if unknown {
            assert!(matches!(next, Err(Error::Uncertain)));
        } else {
            assert!(!next.unwrap().preview.creates_version);
        }
    }
}
#[test]
fn new_activity_after_version_refuses_upload_but_reports_saved_version() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_auth, c, w) = setup(&f, &api);
    let p = plan(&f, &api, &c, &w, true);
    let calls = std::cell::Cell::new(0);
    let outcome = operations::confirm_send(
        &f.registry,
        &api,
        &c,
        &p,
        |_| {
            calls.set(calls.get() + 1);
            if calls.get() > 2 {
                Err(Error::Changed)
            } else {
                Ok(())
            }
        },
        |_, _, _| panic!("no upload after new activity"),
    )
    .unwrap();
    assert!(outcome.local_version_saved);
    assert!(outcome.receipt.is_none());
    assert!(outcome.message.contains("Upload is not confirmed"));
    assert_ne!(f.registry.get(&w.id).unwrap().head_oid, w.head_oid);
}
#[test]
fn version_failure_and_branch_change_cannot_upload() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_auth, c, w) = setup(&f, &api);
    let p = plan(&f, &api, &c, &w, true);
    let changed = std::cell::Cell::new(false);
    assert!(operations::confirm_send(
        &f.registry,
        &api,
        &c,
        &p,
        |_| {
            if !changed.replace(true) {
                std::fs::write(
                    f.registry.checkout(&w.id).unwrap().join("story.md"),
                    "New activity",
                )
                .unwrap();
            }
            Ok(())
        },
        |_, _, _| panic!("no upload after failed version")
    )
    .is_err());
    assert_eq!(f.registry.get(&w.id).unwrap().head_oid, w.head_oid);
    let version = operations::version_preview(
        &f.registry,
        &w.id,
        vec!["story.md".into()],
        identity(),
        "Local".into(),
    )
    .unwrap();
    operations::commit_version(&f.registry, &version, |_| Ok(())).unwrap();
    let w = f.registry.get(&w.id).unwrap();
    let p = plan(&f, &api, &c, &w, false);
    let b = github_workspace::branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        "revision/other",
        true,
        |_, _| panic!("no fetch"),
    )
    .unwrap();
    github_workspace::branches::apply(&f.registry, &api, &c, &b, || Ok(())).unwrap();
    assert!(operations::confirm_send(
        &f.registry,
        &api,
        &c,
        &p,
        |_| Ok(()),
        |_, _, _| panic!("no upload after branch change")
    )
    .is_err());
}
