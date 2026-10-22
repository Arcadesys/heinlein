mod support;
use github_workspace::{
    branches,
    operations::{self, Identity},
    registry::Registry,
    Error,
};
use support::*;
fn setup() -> (
    Fixture,
    github_workspace::auth::Credential,
    github_workspace::registry::Workspace,
    MockApi,
) {
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, _) = connected(&f.root, &api);
    let c = auth.credential(&api, 1006).unwrap();
    let w = f
        .registry
        .register(info(), 9, &c.binding, |repo| {
            Ok(commit(
                repo,
                &github_workspace::transport::Files::from([(
                    "story.md".into(),
                    b"Original story.\n".to_vec(),
                )]),
                &[],
            ))
        })
        .unwrap();
    *api.base.lock().unwrap() = Some(w.base_oid.clone());
    (f, c, w, api)
}
#[test]
fn author_named_branch_switch_preserves_unsent_commits_ids_roots_and_offline_reopen() {
    let (f, c, w, api) = setup();
    let root = f.registry.checkout(&w.id).unwrap();
    let plan = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        "revision/second-draft",
        true,
        |_, _| panic!("current branch needs no fetch"),
    )
    .unwrap();
    let next = branches::apply(&f.registry, &api, &c, &plan, || Ok(())).unwrap();
    assert_eq!(next.id, w.id);
    assert_eq!(f.registry.checkout(&next.id).unwrap(), root);
    assert_eq!(next.branch, "revision/second-draft");
    assert!(branches::authority(&f.registry, &next, &c).is_ok());
    std::fs::write(root.join("story.md"), "Local unsent revision.\n").unwrap();
    let version = operations::version_preview(
        &f.registry,
        &next.id,
        vec!["story.md".into()],
        Identity {
            name: "Synthetic".into(),
            email: "test@example.invalid".into(),
        },
        "Local commit".into(),
    )
    .unwrap();
    let receipt = operations::commit_version(&f.registry, &version, |_| Ok(())).unwrap();
    let plan = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        &w.branch,
        false,
        |_, _| panic!("saved local branch needs no fetch"),
    )
    .unwrap();
    let original = branches::apply(&f.registry, &api, &c, &plan, || Ok(())).unwrap();
    assert_eq!(original.head_oid, w.head_oid);
    assert_eq!(
        std::fs::read(root.join("story.md")).unwrap(),
        b"Original story.\n"
    );
    let registry = Registry::open(&f.root.join("private"), &f.root.join("sources")).unwrap();
    let plan = branches::preview(
        &registry,
        &api,
        &c,
        &w.id,
        "revision/second-draft",
        "revision/second-draft",
        false,
        |_, _| panic!("saved local branch needs no fetch"),
    )
    .unwrap();
    let again = branches::apply(&registry, &api, &c, &plan, || Ok(())).unwrap();
    assert_eq!(again.head_oid, receipt.head);
    assert_eq!(again.remote_oid, None);
    assert_eq!(
        std::fs::read(root.join("story.md")).unwrap(),
        b"Local unsent revision.\n"
    );
    assert_eq!(registry.reopen(&w.id).unwrap().0.id, w.id);
}
#[test]
fn dirty_untracked_collision_default_and_stale_account_never_switch() {
    let (f, c, w, api) = setup();
    let root = f.registry.checkout(&w.id).unwrap();
    std::fs::write(root.join("private.env"), "Synthetic untracked bytes").unwrap();
    assert!(matches!(
        branches::preview(
            &f.registry,
            &api,
            &c,
            &w.id,
            &w.branch,
            "other",
            true,
            |_, _| panic!()
        ),
        Err(Error::Uncommitted)
    ));
    std::fs::remove_file(root.join("private.env")).unwrap();
    for name in ["main", "bad..ref", &w.branch] {
        assert!(branches::preview(
            &f.registry,
            &api,
            &c,
            &w.id,
            &w.branch,
            name,
            true,
            |_, _| panic!()
        )
        .is_err());
    }
    let plan = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        "other",
        true,
        |_, _| panic!(),
    )
    .unwrap();
    std::fs::write(root.join("story.md"), "Newer saved writing").unwrap();
    assert!(branches::apply(&f.registry, &api, &c, &plan, || Ok(())).is_err());
    assert_eq!(f.registry.get(&w.id).unwrap().branch, w.branch);
    assert_eq!(
        std::fs::read(root.join("story.md")).unwrap(),
        b"Newer saved writing"
    );
}
#[test]
fn legacy_catalog_load_does_not_migrate_or_broaden_capability() {
    let (f, c, w, api) = setup();
    let dir = f.registry.directory(&w.id).unwrap();
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.root.join("private/registry-v1.json")).unwrap())
            .unwrap();
    for item in legacy["workspaces"].as_array_mut().unwrap() {
        item.as_object_mut().unwrap().remove("baseBranch");
    }
    std::fs::write(
        f.root.join("private/registry-v1.json"),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let catalog = std::fs::read(f.root.join("private/registry-v1.json")).unwrap();
    assert!(branches::authority(&f.registry, &w, &c).is_ok());
    assert!(!dir.path().join("branch-capabilities-v1.json").exists());
    assert_eq!(
        std::fs::read(f.root.join("private/registry-v1.json")).unwrap(),
        catalog
    );
    dir.write(
        "branch-capabilities-v1.json",
        &serde_json::json!({"version":99,"workspace_id":w.id,"repo_id":w.repo.id,"branches":{}}),
    )
    .unwrap();
    assert!(branches::authority(&f.registry, &w, &c).is_err());
    assert!(operations::version_preview(
        &f.registry,
        &w.id,
        vec!["story.md".into()],
        Identity {
            name: "Test".into(),
            email: "test@example.invalid".into()
        },
        "Unknown version".into()
    )
    .is_err());
    assert!(github_workspace::incoming::IncomingPlan::create(
        &f.registry,
        &w.id,
        w.head_oid.parse().unwrap(),
        w.branch.clone()
    )
    .is_err());
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
    assert!(f.registry.reopen(&w.id).is_ok());
    assert_eq!(
        std::fs::read(f.root.join("private/registry-v1.json")).unwrap(),
        catalog
    );
    assert_eq!(
        std::fs::read(f.registry.checkout(&w.id).unwrap().join("story.md")).unwrap(),
        b"Original story.\n"
    );
}
#[test]
fn restart_at_every_durable_branch_boundary_retains_work_and_recovers_without_network() {
    for boundary in 0..6 {
        let (f, c, w, api) = setup();
        let plan = branches::preview(
            &f.registry,
            &api,
            &c,
            &w.id,
            &w.branch,
            "revision/recovery",
            true,
            |_, _| panic!("no fetch"),
        )
        .unwrap();
        let result = branches::apply_with_hook(
            &f.registry,
            &api,
            &c,
            &plan,
            || Ok(()),
            |step| {
                if step == boundary {
                    Err(Error::Storage)
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err(), "boundary {boundary}");
        assert!(branches::pending(&f.registry, &w.id).unwrap());
        assert!(f.registry.reopen(&w.id).is_err());
        let registry = Registry::open(&f.root.join("private"), &f.root.join("sources")).unwrap();
        let recovered = branches::recover(&registry, &w.id).unwrap();
        assert_eq!(recovered.id, w.id);
        assert_eq!(recovered.branch, "revision/recovery");
        assert!(!branches::pending(&registry, &w.id).unwrap());
        assert_eq!(
            std::fs::read(registry.checkout(&w.id).unwrap().join("story.md")).unwrap(),
            b"Original story.\n"
        );
        assert!(registry.reopen(&w.id).is_ok());
    }
}
#[test]
fn account_remote_collision_and_changed_default_keep_original_capability_and_bytes() {
    let (f, mut c, w, api) = setup();
    let bytes = std::fs::read(f.registry.checkout(&w.id).unwrap().join("story.md")).unwrap();
    *api.remote.lock().unwrap() = Some(w.head_oid.clone());
    assert!(matches!(
        branches::preview(
            &f.registry,
            &api,
            &c,
            &w.id,
            &w.branch,
            "revision/collision",
            true,
            |_, _| panic!()
        ),
        Err(Error::Changed)
    ));
    *api.remote.lock().unwrap() = None;
    let p = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        "revision/new",
        true,
        |_, _| panic!(),
    )
    .unwrap();
    c.account.id = 10;
    assert!(branches::apply(&f.registry, &api, &c, &p, || Ok(())).is_err());
    c.account.id = 9;
    api.repo.lock().unwrap().default_branch = w.branch.clone();
    assert!(branches::apply(&f.registry, &api, &c, &p, || Ok(())).is_err());
    assert_eq!(f.registry.get(&w.id).unwrap(), w);
    assert_eq!(
        std::fs::read(f.registry.checkout(&w.id).unwrap().join("story.md")).unwrap(),
        bytes
    );
}
#[test]
fn deleted_local_target_ref_is_not_recreated_from_stale_selection() {
    let (f, c, w, api) = setup();
    let p = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        "revision/new",
        true,
        |_, _| panic!(),
    )
    .unwrap();
    let next = branches::apply(&f.registry, &api, &c, &p, || Ok(())).unwrap();
    let p = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        &w.branch,
        false,
        |_, _| panic!(),
    )
    .unwrap();
    let (_, git) = f.registry.reopen(&w.id).unwrap();
    git.find_reference(&format!("refs/heads/{}", w.branch))
        .unwrap()
        .delete()
        .unwrap();
    assert!(branches::apply(&f.registry, &api, &c, &p, || Ok(())).is_err());
    assert_eq!(f.registry.get(&w.id).unwrap(), next);
}
