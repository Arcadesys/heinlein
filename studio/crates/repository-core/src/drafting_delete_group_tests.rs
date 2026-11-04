fn delete_group_fixture() -> (Fixture, [String; 3]) {
    let f = Fixture::new();
    for path in ["ms/a.md", "ms/b.md", "ms/c.md", "ms/reference/notes.md"] {
        f.put(path, &format!("Synthetic—é 🐾 {path}\r\n"));
    }
    f.initialize();
    for title in ["Parent", "Delete me", "Nested"] {
        f.apply(DraftingChange::CreateGroup {
            title: title.into(),
        });
    }
    let (manifest, _) = f.repo.drafting_manifest().unwrap();
    let mut manifest = manifest.unwrap();
    let [parent, target, child]: [String; 3] = manifest
        .groups
        .iter()
        .map(|g| g.id.clone())
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let ids: Vec<_> = manifest.scenes.iter().map(|s| s.id.clone()).collect();
    for scene in &mut manifest.scenes {
        scene.group_id = Some(match scene.path.as_str() {
            "ms/b.md" => child.clone(),
            "ms/c.md" => parent.clone(),
            _ => target.clone(),
        });
        scene.reference = scene.path.contains("reference/");
    }
    // Children deliberately need not be adjacent to their parent in storage.
    manifest.library = Some(vec![
        LibraryEntry {
            id: parent.clone(),
            kind: LibraryEntryKind::Group,
            parent_id: None,
        },
        LibraryEntry {
            id: target.clone(),
            kind: LibraryEntryKind::Group,
            parent_id: Some(parent.clone()),
        },
        LibraryEntry {
            id: ids[2].clone(),
            kind: LibraryEntryKind::Scene,
            parent_id: Some(parent.clone()),
        },
        LibraryEntry {
            id: child.clone(),
            kind: LibraryEntryKind::Group,
            parent_id: Some(target.clone()),
        },
        LibraryEntry {
            id: ids[1].clone(),
            kind: LibraryEntryKind::Scene,
            parent_id: Some(child.clone()),
        },
        LibraryEntry {
            id: ids[0].clone(),
            kind: LibraryEntryKind::Scene,
            parent_id: Some(target.clone()),
        },
        LibraryEntry {
            id: ids[3].clone(),
            kind: LibraryEntryKind::Scene,
            parent_id: Some(target.clone()),
        },
    ]);
    f.put(MANIFEST, &manifest_text(&manifest).unwrap());
    (f, [parent, target, child])
}

#[test]
fn delete_group_promotes_children_at_its_position_preserves_files_and_restores_exact_index() {
    let (f, [parent, target, child]) = delete_group_fixture();
    let before = f.repo.load_drafting().unwrap();
    let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
    let files: Vec<_> = before
        .scenes
        .iter()
        .map(|s| {
            (
                s.path.clone(),
                fs::read(f.repo.root().join(&s.path)).unwrap(),
            )
        })
        .collect();
    f.put("ms/unlisted.md", "Unlisted—unchanged");
    fs::remove_file(f.repo.root().join("ms/c.md")).unwrap();
    let source = f.repo.read("ms/a.md").unwrap();
    f.recovery
        .stage(
            &f.repo,
            &source.path,
            &source.content_hash,
            "Unsaved author writing—preserve",
        )
        .unwrap();
    let plan = f
        .preview(DraftingChange::DeleteGroup {
            group_id: target.clone(),
        })
        .unwrap();
    assert!(plan.is_metadata_only());
    assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
    let undo = f.repo.apply_drafting(&plan, &f.recovery).unwrap();
    let reopened = Repository::open(f.repo.root()).unwrap();
    let after = reopened.load_drafting().unwrap();
    assert!(!after.groups.iter().any(|g| g.id == target));
    assert_eq!(after.scenes.len(), before.scenes.len());
    assert_eq!(
        after
            .scenes
            .iter()
            .map(|s| (&s.id, &s.path, s.reference))
            .collect::<Vec<_>>(),
        before
            .scenes
            .iter()
            .map(|s| (&s.id, &s.path, s.reference))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        after
            .library
            .iter()
            .filter(|e| e.parent_id.as_deref() == Some(&parent))
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            child.as_str(),
            before.scenes[0].id.as_str(),
            before.scenes[3].id.as_str(),
            before.scenes[2].id.as_str()
        ]
    );
    assert_eq!(after.scenes[0].group_id.as_deref(), Some(parent.as_str()));
    assert_eq!(after.scenes[1].group_id.as_deref(), Some(child.as_str()));
    for (path, bytes) in &files {
        if path != "ms/c.md" {
            assert_eq!(fs::read(f.repo.root().join(path)).unwrap(), *bytes);
        }
    }
    assert!(!f.repo.root().join("ms/c.md").exists());
    assert_eq!(
        f.repo.read("ms/unlisted.md").unwrap().text,
        "Unlisted—unchanged"
    );
    assert!(undo.is_metadata_only());
    let (_, redo) = f.repo.reverse_drafting(&undo, &f.recovery).unwrap();
    assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
    f.repo.reverse_drafting(&redo, &f.recovery).unwrap();
    assert!(!f
        .repo
        .load_drafting()
        .unwrap()
        .groups
        .iter()
        .any(|g| g.id == target));
}

#[test]
fn delete_group_handles_empty_root_and_legacy_groups_without_changing_flat_scene_order() {
    let f = Fixture::new();
    f.put("ms/a.md", "One");
    f.put("ms/b.md", "Two");
    f.initialize();
    f.apply(DraftingChange::CreateGroup {
        title: "Empty".into(),
    });
    let before = f.repo.load_drafting().unwrap();
    let empty = before.groups[0].id.clone();
    let undo = f.apply(DraftingChange::DeleteGroup { group_id: empty });
    assert!(f.repo.load_drafting().unwrap().groups.is_empty());
    f.repo.undo_drafting(&undo, &f.recovery).unwrap();
    let (manifest, _) = f.repo.drafting_manifest().unwrap();
    let mut manifest = manifest.unwrap();
    manifest.library = None;
    manifest.preserve_flat_order = false;
    manifest.scenes[0].group_id = Some(manifest.groups[0].id.clone());
    f.put(MANIFEST, &manifest_text(&manifest).unwrap());
    f.apply(DraftingChange::DeleteGroup {
        group_id: manifest.groups[0].id.clone(),
    });
    let (after, _) = f.repo.drafting_manifest().unwrap();
    let after = after.unwrap();
    assert!(after.preserve_flat_order);
    assert_eq!(
        after.scenes.iter().map(|s| &s.id).collect::<Vec<_>>(),
        manifest.scenes.iter().map(|s| &s.id).collect::<Vec<_>>()
    );
    assert!(after.scenes.iter().all(|s| s.group_id.is_none()));
}

#[test]
fn delete_group_rejects_unknown_groups_stale_previews_and_undo_without_losing_changes() {
    let (f, [_, target, _]) = delete_group_fixture();
    let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
    assert_eq!(
        f.preview(DraftingChange::DeleteGroup { group_id: uuid() })
            .unwrap_err(),
        Error::DraftingChanged
    );
    assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
    let plan = f
        .preview(DraftingChange::DeleteGroup {
            group_id: target.clone(),
        })
        .unwrap();
    f.apply(DraftingChange::CreateGroup {
        title: "Newer group".into(),
    });
    let newer = fs::read(f.repo.root().join(MANIFEST)).unwrap();
    assert_eq!(
        f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
        Error::DraftingChanged
    );
    assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), newer);
    let undo = f.apply(DraftingChange::DeleteGroup { group_id: target });
    f.apply(DraftingChange::CreateGroup {
        title: "After deletion".into(),
    });
    assert_eq!(
        f.repo.undo_drafting(&undo, &f.recovery).unwrap_err(),
        Error::DraftingChanged
    );
}

#[test]
fn delete_group_failed_and_interrupted_writes_restore_the_original_index() {
    for interrupted in [false, true] {
        let (f, [_, target, _]) = delete_group_fixture();
        let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
        let plan = f
            .preview(DraftingChange::DeleteGroup { group_id: target })
            .unwrap();
        if interrupted {
            let journal = Journal {
                schema_version: 1,
                repository_key: f.repo.project_key(),
                id: plan.preview.id.clone(),
                edits: plan.edits.clone(),
            };
            f.repo.write_journal(&journal, &f.recovery).unwrap();
            f.repo.write_transition(&plan.edits[0]).unwrap();
            let rollback = f.preview(DraftingChange::RecoverInterrupted {}).unwrap();
            f.repo.apply_drafting(&rollback, &f.recovery).unwrap();
        } else {
            FAIL_AFTER_EDIT.with(|slot| slot.set(Some(1)));
            let result = f.repo.apply_drafting(&plan, &f.recovery);
            FAIL_AFTER_EDIT.with(|slot| slot.set(None));
            assert_eq!(result.unwrap_err(), Error::Io);
        }
        assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
        assert!(!f.repo.root().join(JOURNAL).exists());
    }
}
