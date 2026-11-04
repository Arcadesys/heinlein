#[test]
fn delete_sheet_preserves_other_sheets_and_restores_exact_bytes_index_modes_and_redo() {
    use std::os::unix::fs::PermissionsExt;
    for reference in [false, true] {
        let f = Fixture::new();
        let text = "---\r\ntitle: Synthetic\r\n---\r\nExact—é 🐾.\r\n";
        f.put("ms/a.md", text);
        f.put("ms/b.md", "Other sheet—unchanged");
        f.initialize();
        f.apply(DraftingChange::SetSheetReference {
            path: "ms/a.md".into(),
            reference,
        });
        fs::set_permissions(
            f.repo.root().join("ms/a.md"),
            fs::Permissions::from_mode(0o640),
        )
        .unwrap();
        let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
        f.put("ms/unlisted.md", "Unlisted notes");
        let plan = f
            .preview(DraftingChange::DeleteSheet {
                path: "ms/a.md".into(),
            })
            .unwrap();
        assert_eq!(f.repo.read("ms/a.md").unwrap().text, text);
        assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
        let undo = f.repo.apply_drafting(&plan, &f.recovery).unwrap();
        assert!(!f.repo.root().join("ms/a.md").exists());
        let reopened = Repository::open(f.repo.root()).unwrap();
        let state = reopened.load_drafting().unwrap();
        assert_eq!(state.scenes.len(), 1);
        assert_eq!(state.scenes[0].path, "ms/b.md");
        assert!(!state
            .library
            .iter()
            .any(|entry| entry.kind == LibraryEntryKind::Scene && entry.id != state.scenes[0].id));
        assert_eq!(
            reopened.read("ms/b.md").unwrap().text,
            "Other sheet—unchanged"
        );
        assert_eq!(
            reopened.read("ms/unlisted.md").unwrap().text,
            "Unlisted notes"
        );
        let (_, redo) = f.repo.reverse_drafting(&undo, &f.recovery).unwrap();
        assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
        assert_eq!(f.repo.read("ms/a.md").unwrap().text, text);
        assert_eq!(
            fs::metadata(f.repo.root().join("ms/a.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        f.repo.reverse_drafting(&redo, &f.recovery).unwrap();
        assert!(!f.repo.root().join("ms/a.md").exists());
    }
}

#[test]
fn delete_sheet_supports_discovered_references_and_missing_entries_without_discovery() {
    let f = Fixture::new();
    f.put("ms/a.md", "Regular sheet");
    f.initialize();
    let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
    f.put("ms/reference/outline.md", "Reference—exact");
    let undo = f.apply(DraftingChange::DeleteSheet {
        path: "ms/reference/outline.md".into(),
    });
    assert!(f.repo.load_drafting().unwrap().reference_sheets.is_empty());
    assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
    f.repo.undo_drafting(&undo, &f.recovery).unwrap();
    assert_eq!(
        f.repo.read("ms/reference/outline.md").unwrap().text,
        "Reference—exact"
    );
    fs::remove_file(f.repo.root().join("ms/a.md")).unwrap();
    let undo = f.apply(DraftingChange::DeleteSheet {
        path: "ms/a.md".into(),
    });
    assert!(f.repo.load_drafting().unwrap().missing_paths.is_empty());
    f.repo.undo_drafting(&undo, &f.recovery).unwrap();
    assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
    assert!(!f.repo.root().join("ms/a.md").exists());
}

#[test]
fn delete_sheet_rejects_stale_source_index_membership_recovery_and_undo_collisions() {
    for race in ["source", "index", "membership", "recovery", "undo"] {
        let f = Fixture::new();
        f.put("ms/a.md", "Original—exact");
        f.initialize();
        let plan = f
            .preview(DraftingChange::DeleteSheet {
                path: "ms/a.md".into(),
            })
            .unwrap();
        match race {
            "source" => f.put("ms/a.md", "Newer source"),
            "index" => {
                f.create("ms/b.md");
            }
            "membership" => f.put("ms/unlisted.md", "New member"),
            "recovery" => {
                f.recovery
                    .stage(
                        &f.repo,
                        "ms/a.md",
                        &content_hash("Original—exact"),
                        "Unsaved draft",
                    )
                    .unwrap();
            }
            "undo" => {
                let undo = f.repo.apply_drafting(&plan, &f.recovery).unwrap();
                f.put("ms/a.md", "Replacement sheet");
                assert!(f.repo.undo_drafting(&undo, &f.recovery).is_err());
                assert_eq!(f.repo.read("ms/a.md").unwrap().text, "Replacement sheet");
                continue;
            }
            _ => unreachable!(),
        }
        assert!(f.repo.apply_drafting(&plan, &f.recovery).is_err());
        assert_eq!(
            f.repo.read("ms/a.md").unwrap().text,
            if race == "source" {
                "Newer source"
            } else {
                "Original—exact"
            }
        );
    }
}

#[test]
fn delete_sheet_failed_or_interrupted_transaction_restores_source_and_index() {
    for interrupted in [false, true] {
        for completed in 1..=2 {
            let f = Fixture::new();
            f.put("ms/a.md", "Original—exact");
            f.initialize();
            let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
            let plan = f
                .preview(DraftingChange::DeleteSheet {
                    path: "ms/a.md".into(),
                })
                .unwrap();
            if interrupted {
                let journal = Journal {
                    schema_version: 1,
                    repository_key: f.repo.project_key(),
                    id: plan.preview.id.clone(),
                    edits: plan.edits.clone(),
                };
                f.repo.write_journal(&journal, &f.recovery).unwrap();
                for edit in plan.edits.iter().take(completed) {
                    f.repo.write_transition(edit).unwrap();
                }
                let rollback = f.preview(DraftingChange::RecoverInterrupted {}).unwrap();
                f.repo.apply_drafting(&rollback, &f.recovery).unwrap();
            } else {
                FAIL_AFTER_EDIT.with(|slot| slot.set(Some(completed)));
                let result = f.repo.apply_drafting(&plan, &f.recovery);
                FAIL_AFTER_EDIT.with(|slot| slot.set(None));
                assert_eq!(result.unwrap_err(), Error::Io);
            }
            assert_eq!(f.repo.read("ms/a.md").unwrap().text, "Original—exact");
            assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
            assert!(!f.repo.root().join(JOURNAL).exists());
        }
    }
}

#[test]
fn delete_sheet_preserves_path_permissions_and_legacy_authority() {
    use std::os::unix::fs::PermissionsExt;
    for path in [
        "../outside.md",
        "outside.md",
        "ms/asset.png",
        "ms/manuscript.json",
    ] {
        let f = Fixture::new();
        f.put("ms/a.md", "Original—exact");
        f.initialize();
        assert!(f
            .preview(DraftingChange::DeleteSheet { path: path.into() })
            .is_err());
        assert_eq!(f.repo.read("ms/a.md").unwrap().text, "Original—exact");
    }
    let f = Fixture::new();
    f.put("ms/a.md", "Original—exact");
    f.initialize();
    fs::set_permissions(
        f.repo.root().join("ms/a.md"),
        fs::Permissions::from_mode(0o444),
    )
    .unwrap();
    assert_eq!(
        f.preview(DraftingChange::DeleteSheet {
            path: "ms/a.md".into()
        })
        .unwrap_err(),
        Error::Denied
    );
    for (authority, expected) in [
        (
            r#"{"schema_version":1,"project":"Old","volumes":[],"sources":[{"path":"ms/a.md"}]}"#,
            Error::ReadOnly,
        ),
        (
            r#"{"schema_version":1,"project":"Old","volumes":[{"number":1,"title":"Volume","directory":"v","chapters":[{"number":1,"title":"Chapter","directory":"v/c","source":"generated.md","scenes":["ms/a.md"]}]}]}"#,
            Error::LegacySceneMove,
        ),
    ] {
        let f = Fixture::new();
        f.put("ms/a.md", "Original—exact");
        f.initialize();
        let plan = f
            .preview(DraftingChange::DeleteSheet {
                path: "ms/a.md".into(),
            })
            .unwrap();
        f.put("scene-manifest.json", authority);
        assert_eq!(
            f.preview(DraftingChange::DeleteSheet {
                path: "ms/a.md".into()
            })
            .unwrap_err(),
            expected
        );
        assert_eq!(
            f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
            expected
        );
        assert_eq!(f.repo.read("ms/a.md").unwrap().text, "Original—exact");
    }
}
