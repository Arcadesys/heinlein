mod support;
use github_workspace::{
    incoming::{self, IncomingPlan, Resolution},
    operations::{self, Identity},
    transport::{self, Files},
    Error,
};
use repository_core::{RecoveryStore, Repository};
use support::*;
fn identity() -> Identity {
    Identity {
        name: "Example Writer".into(),
        email: "example@users.noreply.github.com".into(),
    }
}
fn base() -> Files {
    Files::from([
        ("one.md".into(), b"Original one.\n".to_vec()),
        ("two.md".into(), b"Original two.\n".to_vec()),
    ])
}
fn setup(
    f: &Fixture,
    api: &MockApi,
    files: &Files,
) -> (
    github_workspace::auth::Auth,
    github_workspace::auth::Credential,
    github_workspace::registry::Workspace,
) {
    let (a, _) = connected(&f.root, api);
    let c = a.credential(api, 1006).unwrap();
    let w = f
        .registry
        .register(info(), 9, &c.binding, |repo| Ok(commit(repo, files, &[])))
        .unwrap();
    *api.base.lock().unwrap() = Some(w.base_oid.clone());
    (a, c, w)
}
fn local(
    f: &Fixture,
    w: &github_workspace::registry::Workspace,
    files: &Files,
) -> github_workspace::registry::Workspace {
    let root = f.registry.checkout(&w.id).unwrap();
    let (_, repo) = f.registry.reopen(&w.id).unwrap();
    let before = transport::tree_files(&repo, git2::Oid::from_str(&w.head_oid).unwrap()).unwrap();
    for p in before.keys() {
        if !files.contains_key(p) {
            std::fs::remove_file(root.join(p)).unwrap();
        }
    }
    for (p, b) in files {
        std::fs::create_dir_all(root.join(p).parent().unwrap()).unwrap();
        std::fs::write(root.join(p), b).unwrap();
    }
    let selected = before
        .keys()
        .chain(files.keys())
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let p = operations::version_preview(
        &f.registry,
        &w.id,
        selected,
        identity(),
        "Local writing".into(),
    )
    .unwrap();
    operations::commit_version(&f.registry, &p, |_| Ok(())).unwrap();
    f.registry.get(&w.id).unwrap()
}
fn remote(
    f: &Fixture,
    w: &github_workspace::registry::Workspace,
    api: &MockApi,
    files: &Files,
) -> git2::Oid {
    let (_, repo) = f.registry.reopen(&w.id).unwrap();
    let oid = commit(&repo, files, &[git2::Oid::from_str(&w.base_oid).unwrap()]);
    *api.base.lock().unwrap() = Some(oid.to_string());
    oid
}
#[test]
fn disjoint_changes_apply_as_reviewed_version_and_reopen_offline() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_a, c, w) = setup(&f, &api, &base());
    let mut own = base();
    own.insert("one.md".into(), b"My one.\n".to_vec());
    let w = local(&f, &w, &own);
    let mut theirs = base();
    theirs.insert("two.md".into(), b"Their two.\n".to_vec());
    let oid = remote(&f, &w, &api, &theirs);
    let p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
    assert!(p.preview.ready);
    assert_eq!(p.preview.files.len(), 1);
    let root = f.registry.checkout(&w.id).unwrap();
    assert_eq!(
        std::fs::read(root.join("two.md")).unwrap(),
        base()["two.md"]
    );
    let recovery = RecoveryStore::open(f.root.join("recovery")).unwrap();
    incoming::apply(&f.registry, &api, &c, &p, identity(), &recovery, |_| Ok(())).unwrap();
    assert_eq!(std::fs::read(root.join("one.md")).unwrap(), own["one.md"]);
    assert_eq!(
        std::fs::read(root.join("two.md")).unwrap(),
        theirs["two.md"]
    );
    let (_, repo) = f.registry.reopen(&w.id).unwrap();
    assert_eq!(
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent_count(),
        2
    );
}
#[test]
fn same_passage_has_no_default_choice_or_source_writes() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_a, _c, w) = setup(&f, &api, &base());
    let mut own = base();
    own.insert("one.md".into(), b"My one.\n".to_vec());
    let w = local(&f, &w, &own);
    let mut theirs = base();
    theirs.insert("one.md".into(), b"Their one.\n".to_vec());
    let oid = remote(&f, &w, &api, &theirs);
    let mut p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
    assert!(!p.preview.ready);
    let conflict = p.preview.conflicts[0].clone();
    assert!(conflict.resolution.is_none());
    let root = Repository::open(f.registry.checkout(&w.id).unwrap()).unwrap();
    assert!(p.core_plan(&root).is_err());
    assert!(p
        .resolve(
            &conflict.id,
            Resolution {
                choice: "combined".into(),
                result: Some("<<<<<<< invalid".into())
            }
        )
        .is_err());
    p.resolve(
        &conflict.id,
        Resolution {
            choice: "combined".into(),
            result: Some("Author combined — intentionally.\n".into()),
        },
    )
    .unwrap();
    assert!(p.preview.ready);
    assert_eq!(
        std::fs::read(root.root().join("one.md")).unwrap(),
        own["one.md"]
    );
}
fn manuscript() -> Files {
    let mut files = Files::new();
    let scenes=(1..=3).map(|i|{let path=format!("ms/scenes/{i}.md");files.insert(path.clone(),format!("Scene {i}.\n").into_bytes());serde_json::json!({"id":format!("00000000-0000-4000-8000-{i:012}"),"title":format!("Scene {i}"),"path":path,"groupId":null})}).collect::<Vec<_>>();
    files.insert("ms/manuscript.json".into(),serde_json::to_vec_pretty(&serde_json::json!({"schemaVersion":2,"id":"00000000-0000-4000-8000-000000000090","project":"Synthetic","groups":[],"scenes":scenes})).unwrap());
    files
}
fn edit_manifest(files: &mut Files, edit: impl FnOnce(&mut serde_json::Value)) {
    let mut v = serde_json::from_slice(&files["ms/manuscript.json"]).unwrap();
    edit(&mut v);
    files.insert(
        "ms/manuscript.json".into(),
        serde_json::to_vec_pretty(&v).unwrap(),
    );
}
#[test]
fn semantic_move_combines_with_edit_and_competing_order_requires_choice() {
    let f = Fixture::new();
    let api = MockApi::default();
    let original = manuscript();
    let (_a, _c, w) = setup(&f, &api, &original);
    let mut own = original.clone();
    let text = own.remove("ms/scenes/1.md").unwrap();
    own.insert("ms/scenes/moved.md".into(), text);
    edit_manifest(&mut own, |v| {
        v["scenes"][0]["path"] = serde_json::json!("ms/scenes/moved.md");
        v["scenes"].as_array_mut().unwrap().swap(0, 1);
    });
    let w = local(&f, &w, &own);
    let mut theirs = original;
    theirs.insert(
        "ms/scenes/1.md".into(),
        b"GitHub edited scene one.\n".to_vec(),
    );
    edit_manifest(&mut theirs, |v| {
        v["scenes"].as_array_mut().unwrap().swap(1, 2)
    });
    let oid = remote(&f, &w, &api, &theirs);
    let mut p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
    assert_eq!(p.preview.conflicts.len(), 1);
    assert_eq!(p.preview.conflicts[0].kind, "order");
    let id = p.preview.conflicts[0].id.clone();
    p.resolve(
        &id,
        Resolution {
            choice: "mine".into(),
            result: None,
        },
    )
    .unwrap();
    assert!(p.preview.ready);
    let root = Repository::open(f.registry.checkout(&w.id).unwrap()).unwrap();
    let core = p.core_plan(&root).unwrap();
    let store =
        repository_core::workspace_update::UpdateStore::open(&f.root.join("updates")).unwrap();
    let recovery = RecoveryStore::open(f.root.join("recovery")).unwrap();
    root.apply_workspace_update(&core, &store, &recovery, |_| Ok(()))
        .unwrap();
    assert_eq!(
        std::fs::read(root.root().join("ms/scenes/moved.md")).unwrap(),
        b"GitHub edited scene one.\n"
    );
    store.rollback(&root).unwrap();
    assert_eq!(
        std::fs::read(root.root().join("ms/scenes/moved.md")).unwrap(),
        own["ms/scenes/moved.md"]
    );
}
#[test]
fn delete_edit_requires_author_resolution() {
    let f = Fixture::new();
    let api = MockApi::default();
    let original = manuscript();
    let (_a, _c, w) = setup(&f, &api, &original);
    let mut own = original.clone();
    own.remove("ms/scenes/1.md");
    edit_manifest(&mut own, |v| {
        v["scenes"].as_array_mut().unwrap().remove(0);
    });
    let w = local(&f, &w, &own);
    let mut theirs = original;
    theirs.insert("ms/scenes/1.md".into(), b"Remote edit.\n".to_vec());
    let oid = remote(&f, &w, &api, &theirs);
    let mut p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
    assert!(!p.preview.ready);
    let id = p.preview.conflicts[0].id.clone();
    p.resolve(
        &id,
        Resolution {
            choice: "mine".into(),
            result: None,
        },
    )
    .unwrap();
    assert!(p.preview.ready);
}
#[test]
fn failure_at_every_boundary_restores_and_blocks_reopen_until_recovery() {
    for fail in 0..=3 {
        let f = Fixture::new();
        let api = MockApi::default();
        let (_a, c, w) = setup(&f, &api, &base());
        let mut theirs = base();
        theirs.insert("one.md".into(), b"Remote one.\n".to_vec());
        theirs.insert("two.md".into(), b"Remote two.\n".to_vec());
        let oid = remote(&f, &w, &api, &theirs);
        let p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
        let recovery = RecoveryStore::open(f.root.join("recovery")).unwrap();
        assert!(
            incoming::apply(&f.registry, &api, &c, &p, identity(), &recovery, |step| {
                if step == fail {
                    Err(repository_core::Error::Conflict)
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        assert!(matches!(f.registry.reopen(&w.id), Err(Error::Recovery)));
        for (p, b) in base() {
            assert_eq!(
                std::fs::read(f.registry.checkout(&w.id).unwrap().join(p)).unwrap(),
                b
            );
        }
        incoming::rollback(&f.registry, &w.id).unwrap();
        f.registry.reopen(&w.id).unwrap();
    }
}
#[test]
fn late_disk_edit_rejects_plan_without_writes() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_a, c, w) = setup(&f, &api, &base());
    let mut theirs = base();
    theirs.insert("one.md".into(), b"Remote one.\n".to_vec());
    let oid = remote(&f, &w, &api, &theirs);
    let p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
    let path = f.registry.checkout(&w.id).unwrap();
    std::fs::write(path.join("two.md"), "Late local edit").unwrap();
    let recovery = RecoveryStore::open(f.root.join("recovery")).unwrap();
    assert!(matches!(
        incoming::apply(&f.registry, &api, &c, &p, identity(), &recovery, |_| Ok(())),
        Err(Error::Changed)
    ));
    assert!(!incoming::pending(&f.registry, &w.id).unwrap());
    assert_eq!(
        std::fs::read(path.join("two.md")).unwrap(),
        b"Late local edit"
    );
}
#[test]
fn restart_after_source_ref_catalog_and_finalize_boundaries_is_recoverable() {
    for fail in [0, 1, 2, 3, 10_001, 10_002, 10_003] {
        let f = Fixture::new();
        let api = MockApi::default();
        let (_a, c, w) = setup(&f, &api, &base());
        let mut theirs = base();
        theirs.insert("one.md".into(), b"Remote one.\n".to_vec());
        theirs.insert("two.md".into(), b"Remote two.\n".to_vec());
        let oid = remote(&f, &w, &api, &theirs);
        let p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
        let recovery = RecoveryStore::open(f.root.join("recovery")).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            incoming::apply(&f.registry, &api, &c, &p, identity(), &recovery, |step| {
                if step == fail {
                    panic!("synthetic process stop")
                }
                Ok(())
            })
        }));
        assert!(result.is_err());
        assert!(matches!(f.registry.reopen(&w.id), Err(Error::Recovery)));
        incoming::rollback(&f.registry, &w.id).unwrap();
        let (w2, _) = f.registry.reopen(&w.id).unwrap();
        let original = base();
        let expected = if fail == 10_003 {
            assert_ne!(w2.head_oid, w.head_oid);
            &theirs
        } else {
            assert_eq!(w2.head_oid, w.head_oid);
            &original
        };
        for (p, b) in expected {
            assert_eq!(
                &std::fs::read(f.registry.checkout(&w.id).unwrap().join(p)).unwrap(),
                b
            );
        }
    }
}
#[test]
fn interrupted_update_preserves_unknown_external_edits_and_backup() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_a, c, w) = setup(&f, &api, &base());
    let mut theirs = base();
    theirs.insert("one.md".into(), b"Remote one.\n".to_vec());
    let oid = remote(&f, &w, &api, &theirs);
    let p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
    let recovery = RecoveryStore::open(f.root.join("recovery")).unwrap();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        incoming::apply(&f.registry, &api, &c, &p, identity(), &recovery, |step| {
            if step == 2 {
                panic!("stop after source write")
            }
            Ok(())
        })
    }));
    let file = f.registry.checkout(&w.id).unwrap().join("one.md");
    std::fs::write(&file, "External newer writing").unwrap();
    assert!(incoming::rollback(&f.registry, &w.id).is_err());
    assert!(incoming::pending(&f.registry, &w.id).unwrap());
    assert_eq!(std::fs::read(file).unwrap(), b"External newer writing");
}
#[test]
fn restart_during_rollback_does_not_strand_original_writing() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_a, c, w) = setup(&f, &api, &base());
    let mut theirs = base();
    theirs.insert("one.md".into(), b"Remote one.\n".to_vec());
    let oid = remote(&f, &w, &api, &theirs);
    let p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
    let recovery = RecoveryStore::open(f.root.join("recovery")).unwrap();
    assert!(
        incoming::apply(&f.registry, &api, &c, &p, identity(), &recovery, |step| {
            if step == 10_001 {
                Err(repository_core::Error::Conflict)
            } else {
                Ok(())
            }
        })
        .is_err()
    );
    let root = Repository::open(f.registry.checkout(&w.id).unwrap()).unwrap();
    let store = repository_core::workspace_update::UpdateStore::open(
        &f.registry
            .directory(&w.id)
            .unwrap()
            .path()
            .join("update-backups"),
    )
    .unwrap();
    store.rollback(&root).unwrap();
    incoming::rollback(&f.registry, &w.id).unwrap();
    assert_eq!(f.registry.reopen(&w.id).unwrap().0.head_oid, w.head_oid);
}
#[test]
fn independently_added_scenes_require_a_complete_explicit_order() {
    let f = Fixture::new();
    let api = MockApi::default();
    let original = manuscript();
    let (_a, _c, w) = setup(&f, &api, &original);
    let mut own = original.clone();
    let mut theirs = original;
    for (files, i) in [(&mut own, 4), (&mut theirs, 5)] {
        let path = format!("ms/scenes/{i}.md");
        files.insert(path.clone(), format!("Added {i}.\n").into_bytes());
        edit_manifest(files, |v| {
            v["scenes"].as_array_mut().unwrap().push(serde_json::json!({"id":format!("00000000-0000-4000-8000-{i:012}"),"title":format!("Added {i}"),"path":path,"groupId":null}))
        });
    }
    let w = local(&f, &w, &own);
    let oid = remote(&f, &w, &api, &theirs);
    let mut p = IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).unwrap();
    for _ in 0..3 {
        let Some(id) = p
            .preview
            .conflicts
            .iter()
            .find(|c| c.resolution.is_none())
            .map(|c| c.id.clone())
        else {
            break;
        };
        p.resolve(
            &id,
            Resolution {
                choice: "mine".into(),
                result: None,
            },
        )
        .unwrap();
    }
    assert!(p.preview.ready);
    let result = p
        .preview
        .documents
        .iter()
        .find(|d| d.path == "ms/manuscript.json")
        .unwrap()
        .result
        .as_ref()
        .unwrap();
    let m = repository_core::parse_workspace_manifest(result).unwrap();
    assert_eq!(m.scenes.len(), 5);
}
#[test]
fn invalid_remote_manifest_and_unrelated_history_stop_without_source_writes() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (_a, _c, w) = setup(&f, &api, &manuscript());
    let mut invalid = manuscript();
    edit_manifest(&mut invalid, |v| {
        v["scenes"][1]["id"] = v["scenes"][0]["id"].clone();
    });
    let oid = remote(&f, &w, &api, &invalid);
    assert!(IncomingPlan::create(&f.registry, &w.id, oid, "main".into()).is_err());
    let (_, git) = f.registry.reopen(&w.id).unwrap();
    let mut separate = manuscript();
    separate.insert("separate.md".into(), b"Unrelated history".to_vec());
    let unrelated = commit(&git, &separate, &[]);
    assert!(IncomingPlan::create(&f.registry, &w.id, unrelated, "main".into()).is_err());
    assert_eq!(f.registry.get(&w.id).unwrap().head_oid, w.head_oid);
}
