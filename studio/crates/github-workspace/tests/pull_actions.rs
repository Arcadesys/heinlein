mod support;
use github_workspace::{
    api::{PullDetail, StackState},
    pull_actions,
    registry::{PullRequest, Registry},
    Error,
};
use std::sync::atomic::Ordering;
use support::*;
fn setup(
    draft: bool,
) -> (
    Fixture,
    MockApi,
    github_workspace::auth::Credential,
    github_workspace::registry::Workspace,
) {
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, _) = connected(&f.root, &api);
    let c = auth.credential(&api, 1006).unwrap();
    let mut w = f
        .registry
        .register(info(), 9, &c.binding, |r| {
            Ok(commit(
                r,
                &github_workspace::transport::Files::from([(
                    "story.md".into(),
                    b"Original story.\n".to_vec(),
                )]),
                &[],
            ))
        })
        .unwrap();
    w.remote_oid = Some(w.head_oid.clone());
    w.pr = Some(PullRequest {
        number: 1,
        url: format!("{}/pull/1", w.repo.url()),
        state: "open".into(),
        merged: false,
        draft,
        head: w.branch.clone(),
        base: "main".into(),
    });
    f.registry.save(&w).unwrap();
    *api.detail.lock().unwrap() = Some(PullDetail {
        pull: w.pr.clone().unwrap(),
        node_id: "PR_synthetic".into(),
        head: w.head_oid.clone(),
        base: w.base_oid.clone(),
        head_repo_id: 42,
        base_repo_id: 42,
        mergeable: Some(true),
        merge_state: "clean".into(),
        merge_commit: None,
        stack: StackState::Standalone,
    });
    (f, api, c, w)
}
#[test]
fn unknown_policy_and_every_stack_state_refuse_without_writes() {
    let (f, api, c, w) = setup(false);
    let status = pull_actions::status(&f.registry, &api, &c, &w.id).unwrap();
    assert!(!status.merge_allowed);
    assert!(status.reason.contains("bypass"));
    assert!(matches!(
        pull_actions::preview(&f.registry, &api, &c, &w.id, "merge", "squash"),
        Err(Error::MergeUnavailable)
    ));
    api.proved.store(true, Ordering::SeqCst);
    for stack in [StackState::Unknown, StackState::Present] {
        api.detail.lock().unwrap().as_mut().unwrap().stack = stack;
        assert!(
            !pull_actions::status(&f.registry, &api, &c, &w.id)
                .unwrap()
                .merge_allowed
        );
    }
    assert_eq!(api.mutations.load(Ordering::SeqCst), 0);
}
#[test]
fn head_base_stack_and_policy_changes_invalidate_confirmation() {
    for change in 0..4 {
        let (f, api, c, w) = setup(false);
        api.proved.store(true, Ordering::SeqCst);
        let p = pull_actions::preview(&f.registry, &api, &c, &w.id, "merge", "merge").unwrap();
        {
            let mut d = api.detail.lock().unwrap();
            let d = d.as_mut().unwrap();
            match change {
                0 => d.head = "1111111111111111111111111111111111111111".into(),
                1 => d.base = "1111111111111111111111111111111111111111".into(),
                2 => d.stack = StackState::Present,
                _ => api.proved.store(false, Ordering::SeqCst),
            }
        }
        assert!(pull_actions::apply(&f.registry, &api, &c, &p, || Ok(())).is_err());
        assert_eq!(api.mutations.load(Ordering::SeqCst), 0);
        assert_eq!(f.registry.get(&w.id).unwrap(), w);
    }
}
#[test]
fn timeout_before_or_after_mutation_reconciles_read_only_across_restart() {
    for kind in ["ready", "merge"] {
        for mode in [1, 2, 3] {
            let (f, api, c, w) = setup(kind == "ready");
            api.proved.store(true, Ordering::SeqCst);
            api.mutation_mode.store(mode, Ordering::SeqCst);
            let p = pull_actions::preview(&f.registry, &api, &c, &w.id, kind, "squash").unwrap();
            let r = pull_actions::apply(&f.registry, &api, &c, &p, || Ok(())).unwrap();
            assert_eq!(
                r.status,
                match mode {
                    1 => "unknown",
                    2 => "succeeded",
                    _ => "failed",
                }
            );
            let reopened =
                Registry::open(&f.root.join("private"), &f.root.join("sources")).unwrap();
            let again = pull_actions::reconcile(&reopened, &api, &c, &w.id, &r.id).unwrap();
            assert_eq!(again.status, r.status);
            assert_eq!(api.mutations.load(Ordering::SeqCst), 1);
            let after = reopened.get(&w.id).unwrap();
            assert_eq!(after.head_oid, w.head_oid);
            assert_eq!(after.branch, w.branch);
            assert_eq!(
                std::fs::read(reopened.checkout(&w.id).unwrap().join("story.md")).unwrap(),
                b"Original story.\n"
            );
        }
    }
}
#[test]
fn ready_is_separate_and_closed_ready_is_not_success() {
    let (f, api, c, w) = setup(true);
    let p = pull_actions::preview(&f.registry, &api, &c, &w.id, "ready", "merge").unwrap();
    api.mutation_mode.store(1, Ordering::SeqCst);
    let r = pull_actions::apply(&f.registry, &api, &c, &p, || Ok(())).unwrap();
    {
        let mut d = api.detail.lock().unwrap();
        let d = d.as_mut().unwrap();
        d.pull.draft = false;
        d.pull.state = "closed".into();
    }
    assert_eq!(
        pull_actions::reconcile(&f.registry, &api, &c, &w.id, &r.id)
            .unwrap()
            .status,
        "unknown"
    );
    assert_eq!(api.mutations.load(Ordering::SeqCst), 1);
}

#[test]
fn saved_source_edit_or_recovery_barrier_invalidates_action_before_any_request() {
    let (f, api, c, w) = setup(true);
    let p = pull_actions::preview(&f.registry, &api, &c, &w.id, "ready", "merge").unwrap();
    assert!(matches!(
        pull_actions::apply(&f.registry, &api, &c, &p, || Err(Error::Recovery)),
        Err(Error::Recovery)
    ));
    std::fs::write(
        f.registry.checkout(&w.id).unwrap().join("story.md"),
        "New saved synthetic writing",
    )
    .unwrap();
    assert!(matches!(
        pull_actions::apply(&f.registry, &api, &c, &p, || Ok(())),
        Err(Error::Changed)
    ));
    assert_eq!(api.mutations.load(Ordering::SeqCst), 0);
}
