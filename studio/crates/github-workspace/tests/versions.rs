mod support;
use github_workspace::{
    journal::Receipt,
    operations::{self, Identity},
    transport::{self, Files},
    Error,
};
use std::sync::atomic::Ordering;
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
fn version(f: &Fixture, w: &github_workspace::registry::Workspace) -> operations::VersionPlan {
    std::fs::write(
        f.registry.checkout(&w.id).unwrap().join("story.md"),
        "Author's new story.\n",
    )
    .unwrap();
    operations::version_preview(
        &f.registry,
        &w.id,
        vec!["story.md".into()],
        identity(),
        "A writing version".into(),
    )
    .unwrap()
}
#[test]
fn exact_selected_files_and_idempotent_local_commit() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_, _, w) = setup(&f, &api);
    let root = f.registry.checkout(&w.id).unwrap();
    std::fs::write(root.join("notes.md"), "Unapproved note").unwrap();
    std::fs::write(root.join(".env"), "PRIVATE_TEST_SECRET").unwrap();
    let plan = version(&f, &w);
    assert_eq!(plan.preview.files.len(), 1);
    let first = operations::commit_version(&f.registry, &plan, |paths| {
        assert_eq!(paths, ["story.md"]);
        Ok(())
    })
    .unwrap();
    let again = operations::commit_version(&f.registry, &plan, |_| {
        panic!("must reconcile not commit again")
    })
    .unwrap();
    assert_eq!(first.head, again.head);
    let (_, repo) = f.registry.reopen(&w.id).unwrap();
    let files = transport::tree_files(&repo, git2::Oid::from_str(&first.head).unwrap()).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files["story.md"], b"Author's new story.\n");
    assert_eq!(
        std::fs::read(root.join("notes.md")).unwrap(),
        b"Unapproved note"
    );
    assert_eq!(
        repo.find_commit(git2::Oid::from_str(&first.head).unwrap())
            .unwrap()
            .parent_count(),
        1
    );
}
#[test]
fn stale_disk_and_recovery_barriers_leave_head_unchanged() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_, _, w) = setup(&f, &api);
    let plan = version(&f, &w);
    assert!(matches!(
        operations::commit_version(&f.registry, &plan, |_| Err(Error::Recovery)),
        Err(Error::Recovery)
    ));
    std::fs::write(
        f.registry.checkout(&w.id).unwrap().join("story.md"),
        "Concurrent edit",
    )
    .unwrap();
    assert!(matches!(
        operations::commit_version(&f.registry, &plan, |_| Ok(())),
        Err(Error::Changed)
    ));
    assert_eq!(f.registry.get(&w.id).unwrap().head_oid, w.head_oid);
}
#[test]
fn interrupted_ref_update_reconciles_one_version_after_restart() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_, _, w) = setup(&f, &api);
    let (_, repo) = f.registry.reopen(&w.id).unwrap();
    let next = commit(
        &repo,
        &Files::from([("story.md".into(), b"Next".to_vec())]),
        &[git2::Oid::from_str(&w.head_oid).unwrap()],
    );
    let id = uuid::Uuid::new_v4().to_string();
    Receipt {
        id: id.clone(),
        workspace_id: w.id.clone(),
        kind: "version".into(),
        status: "prepared".into(),
        old_head: w.head_oid.clone(),
        head: next.to_string(),
        branch: w.branch.clone(),
        remote_before: None,
        url: None,
        pr_number: None,
        message: "Prepared".into(),
    }
    .save(&f.registry.directory(&w.id).unwrap())
    .unwrap();
    repo.reference(
        &format!("refs/heads/{}", w.branch),
        next,
        true,
        "Synthetic crash",
    )
    .unwrap();
    assert!(f.registry.reopen(&w.id).is_err());
    let done = operations::recover_local_version(&f.registry, &w.id, &id).unwrap();
    assert_eq!(done.status, "succeeded");
    assert_eq!(
        f.registry.reopen(&w.id).unwrap().0.head_oid,
        next.to_string()
    );
}
#[test]
fn lost_push_response_is_checked_not_automatically_replayed() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_, c, w) = setup(&f, &api);
    let plan = version(&f, &w);
    operations::commit_version(&f.registry, &plan, |_| Ok(())).unwrap();
    let send = operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "push",
        String::new(),
        String::new(),
    )
    .unwrap();
    assert!(send.preview.branch.starts_with("heinlein/story-"));
    assert_ne!(send.preview.branch, "main");
    let r = operations::send(&f.registry, &api, &c, &send, |_, w, _| {
        *api.remote.lock().unwrap() = Some(w.head_oid.clone());
        Err(Error::Network)
    })
    .unwrap();
    assert_eq!(r.status, "unknown");
    assert!(matches!(
        operations::share_preview(
            &f.registry,
            &api,
            &c,
            &w.id,
            "push",
            String::new(),
            String::new()
        ),
        Err(Error::Uncertain)
    ));
    let done = operations::reconcile(&f.registry, &api, &c, &w.id, &r.id).unwrap();
    assert_eq!(done.status, "succeeded");
    let again = operations::send(&f.registry, &api, &c, &send, |_, _, _| {
        panic!("no repeated push")
    })
    .unwrap();
    assert_eq!(again.id, r.id);
}
#[test]
fn lost_pr_response_recovers_exact_marker_without_second_request() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_, c, w) = setup(&f, &api);
    let plan = version(&f, &w);
    let local = operations::commit_version(&f.registry, &plan, |_| Ok(())).unwrap();
    *api.remote.lock().unwrap() = Some(local.head.clone());
    let mut current = f.registry.get(&w.id).unwrap();
    current.remote_oid = Some(local.head);
    f.registry.save(&current).unwrap();
    let pr = operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "feedback",
        "Please read".into(),
        "Feedback welcome".into(),
    )
    .unwrap();
    api.fail_create.store(true, Ordering::SeqCst);
    let r = operations::send(&f.registry, &api, &c, &pr, |_, _, _| {
        panic!("PR is HTTP only")
    })
    .unwrap();
    assert_eq!(r.status, "unknown");
    let done = operations::reconcile(&f.registry, &api, &c, &w.id, &r.id).unwrap();
    assert_eq!(done.status, "succeeded");
    assert_eq!(api.create_calls.load(Ordering::SeqCst), 1);
    assert!(f.registry.get(&w.id).unwrap().pr.unwrap().draft);
}
#[test]
fn account_remote_movement_and_permission_changes_block_sharing() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, c, w) = setup(&f, &api);
    let plan = version(&f, &w);
    operations::commit_version(&f.registry, &plan, |_| Ok(())).unwrap();
    let send = operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "push",
        String::new(),
        String::new(),
    )
    .unwrap();
    *api.remote.lock().unwrap() = Some("1111111111111111111111111111111111111111".into());
    assert!(
        operations::send(&f.registry, &api, &c, &send, |_, _, _| panic!(
            "must not send"
        ))
        .is_err()
    );
    *api.remote.lock().unwrap() = None;
    api.denied.store(true, Ordering::SeqCst);
    assert!(operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "push",
        String::new(),
        String::new()
    )
    .is_err());
    api.denied.store(false, Ordering::SeqCst);
    auth.sign_out().unwrap();
    assert!(operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "push",
        String::new(),
        String::new()
    )
    .is_err());
}
#[test]
fn branch_switch_is_recovered_without_remote_action_or_source_rewrite() {
    for switched in [false, true] {
        let f = Fixture::new();
        let w = f.register();
        let mut after = w.clone();
        after.branch = "heinlein/story-00000000-0000-4000-8000-000000000099".into();
        after.remote_oid = None;
        let dir = f.registry.directory(&w.id).unwrap();
        dir.write(
            "branch-transaction.json",
            &serde_json::json!({"version":1,"before":w,"after":after}),
        )
        .unwrap();
        if switched {
            let git = transport::open(&dir, &f.registry.checkout(&w.id).unwrap()).unwrap();
            git.reference(
                &format!("refs/heads/{}", after.branch),
                w.head_oid.parse().unwrap(),
                false,
                "Synthetic interrupted switch",
            )
            .unwrap();
            git.set_head(&format!("refs/heads/{}", after.branch))
                .unwrap();
        }
        assert!(matches!(f.registry.reopen(&w.id), Err(Error::Recovery)));
        operations::recover_branch(&f.registry, &w.id).unwrap();
        let (reopened, git) = f.registry.reopen(&w.id).unwrap();
        assert_eq!(reopened.branch, after.branch);
        assert_eq!(reopened.head_oid, w.head_oid);
        assert_eq!(
            git.head().unwrap().name().unwrap(),
            format!("refs/heads/{}", after.branch)
        );
        assert_eq!(
            std::fs::read(f.registry.checkout(&w.id).unwrap().join("story.md")).unwrap(),
            b"Original story.\n"
        );
    }
}
#[test]
fn rejected_push_has_one_failed_receipt_and_never_forces() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_a, c, w) = setup(&f, &api);
    let v = version(&f, &w);
    operations::commit_version(&f.registry, &v, |_| Ok(())).unwrap();
    let p = operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "push",
        String::new(),
        String::new(),
    )
    .unwrap();
    let calls = std::cell::Cell::new(0);
    let r = operations::send(&f.registry, &api, &c, &p, |_, _, _| {
        calls.set(calls.get() + 1);
        Err(Error::Permission)
    })
    .unwrap();
    assert_eq!(r.status, "failed");
    let same = operations::send(&f.registry, &api, &c, &p, |_, _, _| {
        panic!("no duplicate send")
    })
    .unwrap();
    assert_eq!(same.id, r.id);
    assert_eq!(calls.get(), 1);
}
#[test]
fn offline_versions_and_explicit_rename_rebind_preserve_source_identity() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (a, c, w) = setup(&f, &api);
    let source = f.registry.checkout(&w.id).unwrap();
    let project_key = repository_core::Repository::open(&source)
        .unwrap()
        .project_key();
    api.repo.lock().unwrap().name = "renamed-story".into();
    let approved = api.repo.lock().unwrap().clone();
    let rebound = operations::rebind(&f.registry, &api, &c, &w.id, &approved).unwrap();
    assert_eq!(rebound.repo.id, w.repo.id);
    assert_eq!(f.registry.checkout(&w.id).unwrap(), source);
    a.sign_out().unwrap();
    let p = version(&f, &rebound);
    operations::commit_version(&f.registry, &p, |_| Ok(())).unwrap();
    assert_eq!(
        repository_core::Repository::open(source)
            .unwrap()
            .project_key(),
        project_key
    );
}
#[test]
fn ready_pr_is_a_known_failure_not_an_uncertain_new_request() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_a, c, w) = setup(&f, &api);
    let v = version(&f, &w);
    let receipt = operations::commit_version(&f.registry, &v, |_| Ok(())).unwrap();
    let mut w = f.registry.get(&w.id).unwrap();
    w.remote_oid = Some(receipt.head.clone());
    f.registry.save(&w).unwrap();
    *api.remote.lock().unwrap() = Some(receipt.head);
    api.prs.lock().unwrap().push((
        github_workspace::registry::PullRequest {
            number: 1,
            url: format!("{}/pull/1", w.repo.url()),
            state: "open".into(),
            merged: false,
            draft: false,
            head: w.branch.clone(),
            base: "main".into(),
        },
        String::new(),
    ));
    let p = operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "feedback",
        "A feedback request".into(),
        String::new(),
    )
    .unwrap();
    let r = operations::send(&f.registry, &api, &c, &p, |_, _, _| panic!("not a push")).unwrap();
    assert_eq!(r.status, "failed");
    assert_eq!(api.create_calls.load(Ordering::SeqCst), 0);
}
#[test]
fn feedback_preview_contains_sent_changes_against_the_pr_base() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_auth, c, w) = setup(&f, &api);
    let version = version(&f, &w);
    let saved = operations::commit_version(&f.registry, &version, |_| Ok(())).unwrap();
    let push = operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "push",
        String::new(),
        String::new(),
    )
    .unwrap();
    assert_eq!(push.preview.commits, vec![saved.head.clone()]);
    operations::send(&f.registry, &api, &c, &push, |_, w, _| {
        *api.remote.lock().unwrap() = Some(w.head_oid.clone());
        Ok(())
    })
    .unwrap();
    let feedback = operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "feedback",
        "Review my writing".into(),
        "Please review the scene.".into(),
    )
    .unwrap();
    assert_eq!(feedback.preview.commits, vec![saved.head.clone()]);
    assert_eq!(feedback.preview.files.len(), 1);
    assert_eq!(feedback.preview.files[0].path, "story.md");
    assert_eq!(
        feedback.preview.files[0].before_hash,
        Some(github_workspace::hash(b"Original story.\n"))
    );
    assert_eq!(
        feedback.preview.files[0].after_hash,
        Some(github_workspace::hash(b"Author's new story.\n"))
    );
    // A later push remains relative to the sent writing tip, not the PR base.
    std::fs::write(
        f.registry.checkout(&w.id).unwrap().join("story.md"),
        "Second local scene.\n",
    )
    .unwrap();
    let second = operations::version_preview(
        &f.registry,
        &w.id,
        vec!["story.md".into()],
        identity(),
        "Second version".into(),
    )
    .unwrap();
    let second = operations::commit_version(&f.registry, &second, |_| Ok(())).unwrap();
    let push = operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "push",
        String::new(),
        String::new(),
    )
    .unwrap();
    assert_eq!(push.preview.commits, vec![second.head]);
    assert_eq!(
        push.preview.files[0].before_hash,
        Some(github_workspace::hash(b"Author's new story.\n"))
    );
}
