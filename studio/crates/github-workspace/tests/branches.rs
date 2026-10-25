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

#[test]
fn nondefault_starting_branch_advances_through_native_target_review_and_send() {
    use github_workspace::{
        incoming::{self, IncomingPlan},
        transport::{self, Files},
    };
    use std::sync::atomic::Ordering;
    let (f, c, w, api) = setup();
    api.heads
        .lock()
        .unwrap()
        .insert("release".into(), Some(w.head_oid.clone()));
    api.heads
        .lock()
        .unwrap()
        .insert("revision/release".into(), None);
    let plan = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "release",
        "revision/release",
        true,
        |_, branch| {
            assert_eq!(branch, "release");
            Ok(w.head_oid.parse().unwrap())
        },
    )
    .unwrap();
    let working = branches::apply(&f.registry, &api, &c, &plan, || Ok(())).unwrap();
    assert_eq!(working.base_branch.as_deref(), Some("release"));
    let (_, git) = f.registry.reopen(&w.id).unwrap();
    let newer = commit(
        &git,
        &Files::from([("story.md".into(), b"Advanced release.\n".to_vec())]),
        &[working.head_oid.parse().unwrap()],
    );
    api.heads
        .lock()
        .unwrap()
        .insert("release".into(), Some(newer.to_string()));
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
    let target = working.incoming_branch("default").unwrap();
    assert_eq!(target, "release");
    let incoming = IncomingPlan::create(&f.registry, &w.id, newer, target).unwrap();
    assert!(incoming.preview.ready);
    let recovery = repository_core::RecoveryStore::open(f.root.join("recovery")).unwrap();
    incoming::apply(
        &f.registry,
        &api,
        &c,
        &incoming,
        Identity {
            name: "Synthetic".into(),
            email: "test@example.invalid".into(),
        },
        &recovery,
        |_| Ok(()),
    )
    .unwrap();
    let updated = f.registry.get(&w.id).unwrap();
    assert_eq!(updated.base_oid, newer.to_string());
    assert_eq!(updated.branch, "revision/release");
    let share = operations::share_preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        "push",
        String::new(),
        String::new(),
    )
    .unwrap();
    assert_eq!(share.preview.base, "release");
    let receipt = operations::send(&f.registry, &api, &c, &share, |_, saved, _| {
        assert_eq!(saved.branch, "revision/release");
        api.heads
            .lock()
            .unwrap()
            .insert(saved.branch.clone(), Some(saved.head_oid.clone()));
        Ok(())
    })
    .unwrap();
    assert_eq!(receipt.status, "succeeded");
    assert_eq!(*api.base.lock().unwrap(), Some(w.base_oid));
    assert_eq!(api.mutations.load(Ordering::SeqCst), 0);
    let after = transport::tree_files(&git, updated.head_oid.parse().unwrap()).unwrap();
    assert_eq!(&*after["story.md"], b"Advanced release.\n");
}

#[test]
fn catalog_lock_refuses_before_any_branch_book_change() {
    let (f, c, w, api) = setup();
    let plan = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        "revision/metadata",
        true,
        |_, _| panic!(),
    )
    .unwrap();
    let before = branches::apply(&f.registry, &api, &c, &plan, || Ok(())).unwrap();
    let dir = f.registry.directory(&w.id).unwrap();
    let path = dir.path().join("branch-capabilities-v1.json");
    let old = std::fs::read(&path).unwrap();
    let prior_journal = std::fs::read(dir.path().join("workspace-metadata-v1.json")).ok();
    let mut after = before.clone();
    after.remote_oid = Some(after.head_oid.clone());
    let catalog = github_workspace::registry::StateDir::open(&f.root.join("private")).unwrap();
    let _busy = catalog.lock("catalog.lock").unwrap();
    assert!(matches!(f.registry.save(&before, &after), Err(Error::Busy)));
    assert_eq!(
        std::fs::read(path).unwrap(),
        old,
        "busy catalog must not change branch authority"
    );
    assert_eq!(
        std::fs::read(dir.path().join("workspace-metadata-v1.json")).ok(),
        prior_journal
    );
}

fn metadata_workspace() -> (Fixture, github_workspace::registry::Workspace) {
    let (f, c, w, api) = setup();
    let p = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        "revision/metadata",
        true,
        |_, _| panic!(),
    )
    .unwrap();
    let w = branches::apply(&f.registry, &api, &c, &p, || Ok(())).unwrap();
    (f, w)
}
#[test]
fn paired_metadata_restart_at_each_boundary_preserves_unrelated_workspaces_and_source() {
    for boundary in 0..=4 {
        let (f, before) = metadata_workspace();
        let root = f.registry.checkout(&before.id).unwrap();
        let source = std::fs::read(root.join("story.md")).unwrap();
        let mut second_info = info();
        second_info.id = 43;
        second_info.name = "other".into();
        let second = f
            .registry
            .register(second_info, 9, &before.auth_binding, |r| {
                Ok(commit(
                    r,
                    &github_workspace::transport::Files::from([(
                        "other.md".into(),
                        b"Other source".to_vec(),
                    )]),
                    &[],
                ))
            })
            .unwrap();
        let mut after = before.clone();
        after.remote_oid = Some(after.head_oid.clone());
        assert!(f
            .registry
            .save_with_hook(&before, &after, |at| if at == boundary {
                Err(Error::Storage)
            } else {
                Ok(())
            })
            .is_err());
        if boundary == 0 {
            assert!(!f.registry.metadata_pending(&before.id).unwrap());
            assert_eq!(f.registry.get(&before.id).unwrap(), before);
            continue;
        }
        assert!(f.registry.metadata_pending(&before.id).unwrap());
        assert!(matches!(
            f.registry.reopen(&before.id),
            Err(Error::Recovery)
        ));
        assert!(matches!(
            branches::local_authorized(&f.registry, &before),
            Err(Error::Recovery)
        ));
        let mut second_after = second.clone();
        second_after.remote_oid = Some(second.head_oid.clone());
        f.registry.save(&second, &second_after).unwrap();
        let registry = Registry::open(&f.root.join("private"), &f.root.join("sources")).unwrap();
        let catalog = github_workspace::registry::StateDir::open(&f.root.join("private")).unwrap();
        let busy = catalog.lock("catalog.lock").unwrap();
        assert!(matches!(
            registry.recover_metadata(&before.id),
            Err(Error::Busy)
        ));
        drop(busy);
        assert!(registry.metadata_pending(&before.id).unwrap());
        assert_eq!(registry.recover_metadata(&before.id).unwrap(), after);
        assert!(!registry.metadata_pending(&before.id).unwrap());
        assert_eq!(registry.recover_metadata(&before.id).unwrap(), after);
        assert_eq!(registry.get(&second.id).unwrap(), second_after);
        assert!(branches::local_authorized(&registry, &after).is_ok());
        assert_eq!(std::fs::read(root.join("story.md")).unwrap(), source);
        let mut stale = before.clone();
        stale.remote_oid = Some("f".repeat(40));
        assert!(matches!(
            registry.save(&before, &stale),
            Err(Error::Changed)
        ));
        assert_eq!(registry.get(&before.id).unwrap(), after);
    }
}
#[test]
fn metadata_recovery_refuses_third_values_missing_records_and_forged_journals() {
    for corruption in [
        "book",
        "catalog",
        "missing-book",
        "missing-catalog",
        "journal",
        "identity",
    ] {
        let (f, before) = metadata_workspace();
        let dir = f.registry.directory(&before.id).unwrap();
        let mut after = before.clone();
        after.remote_oid = Some(after.head_oid.clone());
        assert!(f
            .registry
            .save_with_hook(&before, &after, |at| if at == 1 {
                Err(Error::Storage)
            } else {
                Ok(())
            })
            .is_err());
        let catalog = f.root.join("private/registry-v1.json");
        let book = dir.path().join("branch-capabilities-v1.json");
        let journal = dir.path().join("workspace-metadata-v1.json");
        match corruption {
            "book" => {
                let mut v: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&book).unwrap()).unwrap();
                v["branches"][&before.branch]["remoteOid"] = "f".repeat(40).into();
                dir.write("branch-capabilities-v1.json", &v).unwrap();
            }
            "catalog" => {
                let state =
                    github_workspace::registry::StateDir::open(&f.root.join("private")).unwrap();
                let mut v: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&catalog).unwrap()).unwrap();
                v["workspaces"][0]["remoteOid"] = "e".repeat(40).into();
                state.write("registry-v1.json", &v).unwrap();
            }
            "missing-book" => std::fs::remove_file(&book).unwrap(),
            "missing-catalog" => std::fs::remove_file(&catalog).unwrap(),
            "identity" => {
                let mut v: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
                v["before"]["accountId"] = 999.into();
                dir.write("workspace-metadata-v1.json", &v).unwrap();
            }
            _ => dir
                .write_bytes("workspace-metadata-v1.json", b"malformed")
                .unwrap(),
        }
        let retained = [&catalog, &book, &journal].map(|p| std::fs::read(p).ok());
        assert!(
            f.registry.recover_metadata(&before.id).is_err(),
            "{corruption}"
        );
        assert_eq!(
            [&catalog, &book, &journal].map(|p| std::fs::read(p).ok()),
            retained
        );
    }
    let (f, before) = metadata_workspace();
    let dir = f.registry.directory(&before.id).unwrap();
    let mut book: serde_json::Value = dir.read("branch-capabilities-v1.json").unwrap().unwrap();
    book["branches"][&before.branch]["remoteOid"] = "f".repeat(40).into();
    dir.write("branch-capabilities-v1.json", &book).unwrap();
    assert!(!f.registry.metadata_pending(&before.id).unwrap());
    assert!(matches!(
        branches::local_authorized(&f.registry, &before),
        Err(Error::Recovery)
    ));
    assert!(f.registry.save(&before, &before).is_err());
    assert!(f.registry.recover_metadata(&before.id).is_err());
}
#[test]
fn branch_parent_recovers_a_partially_written_child_metadata_pair() {
    let (f, c, w, api) = setup();
    let dir = f.registry.directory(&w.id).unwrap();
    let p = branches::preview(
        &f.registry,
        &api,
        &c,
        &w.id,
        &w.branch,
        "revision/child",
        true,
        |_, _| panic!(),
    )
    .unwrap();
    assert!(branches::apply_with_hook(
        &f.registry,
        &api,
        &c,
        &p,
        || Ok(()),
        |at| if at == 3 { Err(Error::Storage) } else { Ok(()) }
    )
    .is_err());
    let parent: serde_json::Value = dir.read("branch-switch-v1.json").unwrap().unwrap();
    let before_book: Option<serde_json::Value> = dir.read("branch-capabilities-v1.json").unwrap();
    let child = serde_json::json!({"version":1,"operation":uuid::Uuid::new_v4().to_string(),"parent_operation":parent["id"],"before":parent["before"],"after":parent["after"],"before_book":before_book,"after_book":parent["book"],"change":"Branch"});
    dir.write("workspace-metadata-v1.json", &child).unwrap();
    dir.write("branch-capabilities-v1.json", &parent["book"])
        .unwrap();
    let mut wrong_child = child.clone();
    wrong_child["parent_operation"] = uuid::Uuid::new_v4().to_string().into();
    dir.write("workspace-metadata-v1.json", &wrong_child)
        .unwrap();
    assert!(branches::recover(&f.registry, &w.id).is_err());
    dir.write("workspace-metadata-v1.json", &child).unwrap();
    let mut unknown_parent = parent.clone();
    unknown_parent["version"] = 99.into();
    dir.write("branch-switch-v1.json", &unknown_parent).unwrap();
    assert!(branches::recover(&f.registry, &w.id).is_err());
    dir.write("branch-switch-v1.json", &parent).unwrap();

    let registry = Registry::open(&f.root.join("private"), &f.root.join("sources")).unwrap();
    let after = branches::recover(&registry, &w.id).unwrap();
    assert_eq!(after.branch, "revision/child");
    assert!(!registry.metadata_pending(&w.id).unwrap());
    assert!(!branches::pending(&registry, &w.id).unwrap());
    assert!(branches::local_authorized(&registry, &after).is_ok());
    assert_eq!(
        std::fs::read(registry.checkout(&w.id).unwrap().join("story.md")).unwrap(),
        b"Original story.\n"
    );
}

#[test]
fn ordinary_metadata_save_cannot_grant_branches_or_account_authority() {
    let (f, before) = metadata_workspace();
    let dir = f.registry.directory(&before.id).unwrap();
    let book = std::fs::read(dir.path().join("branch-capabilities-v1.json")).unwrap();
    for field in ["branch", "account", "binding", "repo", "base"] {
        let mut after = before.clone();
        match field {
            "branch" => after.branch = "arbitrary/new".into(),
            "account" => after.account_id = 10,
            "binding" => after.auth_binding = uuid::Uuid::new_v4().to_string(),
            "repo" => after.repo.name = "other".into(),
            _ => after.base_branch = Some("release".into()),
        }
        assert!(f.registry.save(&before, &after).is_err());
        assert_eq!(f.registry.get(&before.id).unwrap(), before);
        assert_eq!(
            std::fs::read(dir.path().join("branch-capabilities-v1.json")).unwrap(),
            book
        );
    }
    let (f, _, legacy, _) = setup();
    let mut after = legacy.clone();
    after.remote_oid = Some(after.head_oid.clone());
    f.registry.save(&legacy, &after).unwrap();
    assert!(!f
        .registry
        .directory(&legacy.id)
        .unwrap()
        .path()
        .join("branch-capabilities-v1.json")
        .exists());
}
