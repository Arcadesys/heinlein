// Native TempDir movement acceptance; included in drafting::tests.
fn movement_setup(groups: &[&str], items: &[(&str, Option<usize>)]) -> Fixture {
    let f = Fixture::new();
    f.initialize();
    for title in groups {
        f.apply(DraftingChange::CreateGroup {
            title: (*title).into(),
        });
    }
    for (name, _) in items {
        f.create(&format!("ms/{name}.md"));
        f.put(
            &format!("ms/{name}.md"),
            &format!("{name} — e\u{301} 🦊\r\nExact writing.\nEND\r\n"),
        );
    }
    let mut manifest: Manifest =
        serde_json::from_slice(&fs::read(f.repo.root().join(MANIFEST)).unwrap()).unwrap();
    for (scene, (_, group)) in manifest.scenes.iter_mut().zip(items) {
        scene.group_id = group.map(|i| manifest.groups[i].id.clone());
    }
    fs::write(
        f.repo.root().join(MANIFEST),
        manifest_text(&manifest).unwrap(),
    )
    .unwrap();
    f
}
fn movement_order(f: &Fixture) -> Vec<String> {
    f.repo
        .load_drafting()
        .unwrap()
        .scenes
        .iter()
        .map(|s| s.path.clone())
        .collect()
}
fn movement_bytes(f: &Fixture) -> std::collections::BTreeMap<String, Vec<u8>> {
    f.repo
        .load_drafting()
        .unwrap()
        .scenes
        .iter()
        .map(|s| {
            (
                s.path.clone(),
                fs::read(f.repo.root().join(&s.path)).unwrap(),
            )
        })
        .collect()
}
#[test]
fn movement_group_slots_preserve_gaps_ids_bytes_and_actual_publishing_order() {
    let f = movement_setup(
        &["Opening", "Later"],
        &[
            ("u0", None),
            ("a1", Some(0)),
            ("a2", Some(0)),
            ("u1", None),
            ("b1", Some(1)),
            ("b2", Some(1)),
            ("u2", None),
        ],
    );
    let before = f.repo.load_drafting().unwrap();
    let bytes = movement_bytes(&f);
    let plan = f
        .preview(DraftingChange::ReorderGroup {
            group_id: before.groups[1].id.clone(),
            before_group_id: Some(before.groups[0].id.clone()),
        })
        .unwrap();
    assert!(plan
        .preview
        .warnings
        .iter()
        .any(|w| w.contains("Ungrouped scenes are not group cargo")));
    f.repo.apply_drafting(&plan, &f.recovery).unwrap();
    assert_eq!(
        movement_order(&f),
        ["u0", "b1", "b2", "a1", "a2", "u1", "u2"].map(|s| format!("ms/{s}.md"))
    );
    f.apply(DraftingChange::ReorderGroup {
        group_id: before.groups[1].id.clone(),
        before_group_id: None,
    });
    let reopened = Repository::open(f.repo.root()).unwrap();
    let after = reopened.load_drafting().unwrap();
    assert_eq!(
        movement_order(&f),
        ["u0", "a1", "a2", "u1", "u2", "b1", "b2"].map(|s| format!("ms/{s}.md"))
    );
    assert_eq!(bytes, movement_bytes(&f));
    for scene in &before.scenes {
        assert_eq!(after.scenes.iter().find(|s| s.id == scene.id), Some(scene));
    }
    let copy = reopened
        .preview_publishing_copy(
            crate::PublishingMetadata {
                title: "Synthetic".into(),
                author: "Test Writer".into(),
                rights: "Synthetic only".into(),
                language: "en".into(),
                formats: vec!["html".into()],
                folder_name: "synthetic-copy".into(),
                free_play_approved: true,
                no_cover_approved: true,
            },
            &f.recovery,
        )
        .unwrap();
    assert_eq!(
        copy.preview
            .sources
            .iter()
            .map(|s| &s.id)
            .collect::<Vec<_>>(),
        after.scenes.iter().map(|s| &s.id).collect::<Vec<_>>()
    );
    assert!(
        copy.preview.manuscript.find("u2 —").unwrap()
            < copy.preview.manuscript.find("b1 —").unwrap()
    );
}
#[test]
fn movement_consecutive_empty_slots_populate_in_either_order_with_one_anchor_rule() {
    for reverse in [false, true] {
        let f = movement_setup(
            &["A", "Empty one", "Empty two", "B"],
            &[("a", Some(0)), ("b", Some(3)), ("tail", None)],
        );
        let before = f.repo.load_drafting().unwrap();
        let bytes = movement_bytes(&f);
        f.apply(DraftingChange::ReorderGroup {
            group_id: before.groups[2].id.clone(),
            before_group_id: Some(before.groups[0].id.clone()),
        });
        assert_eq!(bytes, movement_bytes(&f));
        assert_eq!(movement_order(&f), ["ms/a.md", "ms/b.md", "ms/tail.md"]);
        let order = if reverse { [1, 2] } else { [2, 1] };
        for i in order {
            f.apply(DraftingChange::CreateScene {
                title: format!("New{i}"),
                path: format!("ms/new{i}.md"),
                group_id: Some(before.groups[i].id.clone()),
                before_id: None,
            });
        }
        assert_eq!(
            movement_order(&f),
            [
                "ms/new2.md",
                "ms/a.md",
                "ms/new1.md",
                "ms/b.md",
                "ms/tail.md"
            ]
        );
        assert_eq!(fs::read(f.repo.root().join("ms/new1.md")).unwrap(), b"");
        // Empty at the final slot is populated after trailing No-chapter writing.
        f.apply(DraftingChange::CreateGroup {
            title: "Last empty".into(),
        });
        let last = f
            .repo
            .load_drafting()
            .unwrap()
            .groups
            .last()
            .unwrap()
            .id
            .clone();
        f.apply(DraftingChange::CreateScene {
            title: "Last".into(),
            path: "ms/last.md".into(),
            group_id: Some(last),
            before_id: None,
        });
        assert_eq!(movement_order(&f).last().unwrap(), "ms/last.md");
    }
}
#[test]
fn movement_legacy_interleaving_and_metadata_mismatch_refuse_inference_but_allow_explicit_scene_move(
) {
    for items in [
        vec![
            ("a1", Some(0)),
            ("gap", None),
            ("a2", Some(0)),
            ("b", Some(1)),
        ],
        vec![("b", Some(1)), ("a1", Some(0)), ("a2", Some(0))],
    ] {
        let f = movement_setup(&["A", "B", "Empty"], &items);
        let state = f.repo.load_drafting().unwrap();
        let raw = fs::read(f.repo.root().join(MANIFEST)).unwrap();
        assert!(state
            .group_move_issue
            .as_ref()
            .unwrap()
            .contains("Use Move scene"));
        assert_eq!(
            f.preview(DraftingChange::ReorderGroup {
                group_id: state.groups[1].id.clone(),
                before_group_id: Some(state.groups[0].id.clone())
            })
            .unwrap_err(),
            Error::DraftingGroupOrder
        );
        assert_eq!(
            f.preview(DraftingChange::CreateScene {
                title: "No inference".into(),
                path: "ms/not-created.md".into(),
                group_id: Some(state.groups[2].id.clone()),
                before_id: None
            })
            .unwrap_err(),
            Error::DraftingGroupOrder
        );
        assert_eq!(raw, fs::read(f.repo.root().join(MANIFEST)).unwrap());
        assert!(!f.repo.root().join("ms/not-created.md").exists());
        let a1 = state.scenes.iter().find(|s| s.path == "ms/a1.md").unwrap();
        let a2 = state.scenes.iter().find(|s| s.path == "ms/a2.md").unwrap();
        f.apply(DraftingChange::PlaceScene {
            scene_id: a2.id.clone(),
            destination: SceneDestination::After {
                scene_id: a1.id.clone(),
                group_id: a1.group_id.clone(),
            },
        });
        assert_eq!(
            f.repo
                .load_drafting()
                .unwrap()
                .scenes
                .iter()
                .find(|s| s.id == a2.id)
                .unwrap()
                .group_id,
            a1.group_id
        );
    }
}
#[test]
fn movement_cross_group_empty_and_ungrouped_are_atomic_and_forged_membership_refuses() {
    let f = movement_setup(&["A", "Empty", "B"], &[("a", Some(0)), ("b", Some(2))]);
    let state = f.repo.load_drafting().unwrap();
    let bytes = movement_bytes(&f);
    let a = &state.scenes[0];
    let b = &state.scenes[1];
    assert_eq!(
        f.preview(DraftingChange::PlaceScene {
            scene_id: a.id.clone(),
            destination: SceneDestination::Before {
                scene_id: b.id.clone(),
                group_id: a.group_id.clone()
            }
        })
        .unwrap_err(),
        Error::DraftingChanged
    );
    f.apply(DraftingChange::PlaceScene {
        scene_id: a.id.clone(),
        destination: SceneDestination::After {
            scene_id: b.id.clone(),
            group_id: b.group_id.clone(),
        },
    });
    assert_eq!(movement_order(&f), ["ms/b.md", "ms/a.md"]);
    assert_eq!(f.repo.load_drafting().unwrap().groups, state.groups);
    f.apply(DraftingChange::PlaceScene {
        scene_id: a.id.clone(),
        destination: SceneDestination::GroupEnd {
            group_id: state.groups[1].id.clone(),
        },
    });
    assert_eq!(movement_order(&f), ["ms/a.md", "ms/b.md"]);
    assert_eq!(
        f.repo.load_drafting().unwrap().scenes[0].group_id.as_ref(),
        Some(&state.groups[1].id)
    );
    f.apply(DraftingChange::PlaceScene {
        scene_id: a.id.clone(),
        destination: SceneDestination::UngroupedEnd {},
    });
    assert_eq!(movement_order(&f), ["ms/b.md", "ms/a.md"]);
    assert!(f.repo.load_drafting().unwrap().scenes[1].group_id.is_none());
    assert_eq!(bytes, movement_bytes(&f));
}
#[test]
fn movement_noop_stale_and_source_hash_guards_do_not_rewrite_or_double_apply() {
    let f = movement_setup(&["A", "B"], &[("a", Some(0)), ("b", Some(1))]);
    let state = f.repo.load_drafting().unwrap();
    // Even noncanonical whitespace survives a self-slot no-op.
    let raw = fs::read_to_string(f.repo.root().join(MANIFEST)).unwrap() + "\n\n";
    fs::write(f.repo.root().join(MANIFEST), &raw).unwrap();
    let plan = f
        .preview(DraftingChange::ReorderGroup {
            group_id: state.groups[0].id.clone(),
            before_group_id: Some(state.groups[0].id.clone()),
        })
        .unwrap();
    assert!(plan.edits.is_empty());
    assert!(!f.repo.apply_drafting(&plan, &f.recovery).unwrap().available);
    assert_eq!(
        fs::read_to_string(f.repo.root().join(MANIFEST)).unwrap(),
        raw
    );
    assert!(!f.repo.root().join(JOURNAL).exists());
    let plan = f
        .preview(DraftingChange::ReorderGroup {
            group_id: state.groups[1].id.clone(),
            before_group_id: Some(state.groups[0].id.clone()),
        })
        .unwrap();
    f.put("ms/b.md", "External — author words");
    assert_eq!(
        f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
        Error::DraftingChanged
    );
    assert_eq!(
        fs::read_to_string(f.repo.root().join(MANIFEST)).unwrap(),
        raw
    );
    let plan = f
        .preview(DraftingChange::ReorderGroup {
            group_id: state.groups[1].id.clone(),
            before_group_id: Some(state.groups[0].id.clone()),
        })
        .unwrap();
    f.repo.apply_drafting(&plan, &f.recovery).unwrap();
    assert_eq!(
        f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
        Error::DraftingChanged
    );
}
#[test]
fn movement_manifest_failure_rolls_back_order_without_touching_scene_bytes() {
    let f = movement_setup(&["A", "B"], &[("a", Some(0)), ("b", Some(1))]);
    let before = f.repo.load_drafting().unwrap();
    let raw = fs::read(f.repo.root().join(MANIFEST)).unwrap();
    let bytes = movement_bytes(&f);
    let plan = f
        .preview(DraftingChange::ReorderGroup {
            group_id: before.groups[1].id.clone(),
            before_group_id: Some(before.groups[0].id.clone()),
        })
        .unwrap();
    FAIL_AFTER_EDIT.with(|s| s.set(Some(1)));
    let outcome = f.repo.apply_drafting(&plan, &f.recovery);
    FAIL_AFTER_EDIT.with(|s| s.set(None));
    assert_eq!(outcome.unwrap_err(), Error::Io);
    assert_eq!(raw, fs::read(f.repo.root().join(MANIFEST)).unwrap());
    assert_eq!(bytes, movement_bytes(&f));
}
#[test]
#[ignore = "synthetic child invoked by movement_abrupt_group_transaction_recovers_explicitly"]
fn movement_crash_child() {
    let root = PathBuf::from(std::env::var_os("HEINLEIN_MOVEMENT_TEST_ROOT").unwrap());
    let repo = Repository::open(root.join("repo")).unwrap();
    let recovery = RecoveryStore::open(root.join("private")).unwrap();
    let state = repo.load_drafting().unwrap();
    let plan = repo
        .preview_drafting(
            state.revision.as_deref(),
            DraftingChange::ReorderGroup {
                group_id: state.groups[1].id.clone(),
                before_group_id: Some(state.groups[0].id.clone()),
            },
            &[],
            &recovery,
        )
        .unwrap();
    let journal = Journal {
        schema_version: 1,
        repository_key: repo.project_key(),
        id: plan.preview.id.clone(),
        edits: plan.edits.clone(),
    };
    recovery
        .with_clean_paths(&repo, &plan.recovery_paths, || {
            repo.write_journal(&journal, &recovery)
        })
        .unwrap();
    repo.write_transition(&plan.edits[0]).unwrap();
    std::process::exit(76);
}
#[test]
fn movement_abrupt_group_transaction_recovers_explicitly() {
    let f = movement_setup(&["A", "B"], &[("a", Some(0)), ("b", Some(1))]);
    let raw = fs::read(f.repo.root().join(MANIFEST)).unwrap();
    let bytes = movement_bytes(&f);
    let Fixture {
        temp,
        repo,
        recovery,
    } = f;
    drop(recovery);
    drop(repo);
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "drafting::tests::movement_crash_child",
            "--ignored",
        ])
        .env("HEINLEIN_MOVEMENT_TEST_ROOT", temp.path())
        .output()
        .unwrap();
    assert_eq!(
        child.status.code(),
        Some(76),
        "child stdout:{} stderr:{}",
        String::from_utf8_lossy(&child.stdout),
        String::from_utf8_lossy(&child.stderr)
    );
    let f = Fixture {
        repo: Repository::open(temp.path().join("repo")).unwrap(),
        recovery: RecoveryStore::open(temp.path().join("private")).unwrap(),
        temp,
    };
    assert!(f.repo.load_drafting().unwrap().recovery_required);
    let rollback = f.preview(DraftingChange::RecoverInterrupted {}).unwrap();
    f.repo.apply_drafting(&rollback, &f.recovery).unwrap();
    assert_eq!(raw, fs::read(f.repo.root().join(MANIFEST)).unwrap());
    assert_eq!(bytes, movement_bytes(&f));
    assert!(!f.repo.load_drafting().unwrap().recovery_required);
}
