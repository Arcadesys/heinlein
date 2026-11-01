fn file_split_change(source: &str, path: &str, text: &str, offset: usize) -> DraftingChange {
    DraftingChange::SplitFile {
        source_path: source.into(),
        path: path.into(),
        expected_hash: content_hash(text),
        byte_offset: offset,
    }
}
#[test]
fn file_split_exact_bytes_modes_no_metadata_reopen_and_inverse() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let text = "---\r\ntitle: 星\r\n---\r\nFirst — 🐺.\nSecond é.\r\n";
    f.put("story.Markdown", text);
    fs::set_permissions(
        f.repo.root().join("story.Markdown"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    let offset = text.find("Second").unwrap();
    let plan = f
        .preview(file_split_change(
            "story.Markdown",
            "story-continued.Markdown",
            text,
            offset,
        ))
        .unwrap();
    assert_eq!(plan.edits.len(), 2);
    assert!(!f.repo.root().join("ms").exists());
    let undo = f.repo.apply_drafting(&plan, &f.recovery).unwrap();
    let prefix = fs::read(f.repo.root().join("story.Markdown")).unwrap();
    let suffix = fs::read(f.repo.root().join("story-continued.Markdown")).unwrap();
    assert_eq!([prefix, suffix].concat(), text.as_bytes());
    assert_eq!(
        f.repo.snapshot("story.Markdown").unwrap().unwrap().mode,
        0o640
    );
    assert_eq!(
        f.repo
            .snapshot("story-continued.Markdown")
            .unwrap()
            .unwrap()
            .mode,
        0o640
    );
    assert!(!f.repo.root().join("ms").exists());
    assert!(!f.repo.root().join(JOURNAL).exists());
    let reopened = Repository::open(f.repo.root()).unwrap();
    assert!(reopened.load_drafting().unwrap().revision.is_none());
    assert_eq!(
        reopened.read("story-continued.Markdown").unwrap().text,
        "Second é.\r\n"
    );
    f.repo.undo_drafting(&undo, &f.recovery).unwrap();
    assert_eq!(
        fs::read(f.repo.root().join("story.Markdown")).unwrap(),
        text.as_bytes()
    );
    assert!(!f.repo.root().join("story-continued.Markdown").exists());
    assert!(!f.repo.root().join("ms").exists());
}
#[test]
fn file_split_keeps_existing_manifest_exact_and_rejects_registered_members() {
    let f = Fixture::new();
    f.initialize();
    f.create("ms/mapped.md");
    f.put("ms/unmapped.md", "first second");
    let before = fs::read(f.repo.root().join(MANIFEST)).unwrap();
    let mode = f.repo.snapshot(MANIFEST).unwrap().unwrap().mode;
    f.apply(file_split_change(
        "ms/unmapped.md",
        "ms/unmapped-continued.md",
        "first second",
        6,
    ));
    assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), before);
    assert_eq!(f.repo.snapshot(MANIFEST).unwrap().unwrap().mode, mode);
    assert_eq!(
        f.preview(file_split_change(
            "ms/mapped.md",
            "ms/mapped-continued.md",
            "",
            1
        ))
        .unwrap_err(),
        Error::ReadOnly
    );
}
#[test]
fn file_split_strict_private_two_file_journals_forward_inverse_and_forgery() {
    let f = Fixture::new();
    f.put("story.md", "first second");
    let plan = f
        .preview(file_split_change(
            "story.md",
            "story-continued.md",
            "first second",
            6,
        ))
        .unwrap();
    let journal = Journal {
        schema_version: 1,
        repository_key: f.repo.project_key(),
        id: uuid(),
        edits: plan.edits.clone(),
    };
    validate_journal(&journal, &f.repo.project_key()).unwrap();
    let mut inverse = journal.clone();
    for e in &mut inverse.edits {
        std::mem::swap(&mut e.before, &mut e.after);
    }
    validate_journal(&inverse, &f.repo.project_key()).unwrap();
    for defect in 0..5 {
        let mut bad = journal.clone();
        match defect {
            0 => bad.edits[0].after.as_mut().unwrap().text.push('!'),
            1 => bad.edits[0].after.as_mut().unwrap().mode = 0o777,
            2 => bad.edits[0].path = "other/suffix.md".into(),
            3 => bad.edits[0].before = bad.edits[0].after.clone(),
            _ => bad.repository_key = "wrong".into(),
        };
        assert!(validate_journal(&bad, &f.repo.project_key()).is_err());
    }
    f.put(JOURNAL, &serde_json::to_string(&journal).unwrap());
    assert!(f.repo.preview_interrupted(&f.recovery).is_err());
}
#[test]
fn file_split_registration_after_interruption_refuses_rollback_before_inverse_planning() {
    use std::os::unix::fs::MetadataExt;
    for registered in ["ms/story.md", "ms/story-continued.md"] {
        let f = Fixture::new();
        f.put("ms/story.md", "first second");
        let plan = f
            .preview(file_split_change(
                "ms/story.md",
                "ms/story-continued.md",
                "first second",
                6,
            ))
            .unwrap();
        let journal = Journal {
            schema_version: 1,
            repository_key: f.repo.project_key(),
            id: plan.preview.id.clone(),
            edits: plan.edits.clone(),
        };
        f.repo.write_journal(&journal, &f.recovery).unwrap();
        f.repo.write_transition(&plan.edits[0]).unwrap();
        let author = Manifest {
            schema_version: 2,
            id: uuid(),
            project: "External author index".into(),
            groups: vec![],
            scenes: vec![DraftingScene {
                id: uuid(),
                title: "Registered after interruption".into(),
                path: registered.into(),
                group_id: None,
            }],
        };
        f.put(MANIFEST, &manifest_text(&author).unwrap());
        let affected = ["ms/story.md", "ms/story-continued.md", MANIFEST];
        let before: Vec<_> = affected
            .iter()
            .map(|p| f.repo.snapshot(p).unwrap())
            .collect();
        let journal_bytes = fs::read(f.repo.root().join(JOURNAL)).unwrap();
        let journal_mode = fs::metadata(f.repo.root().join(JOURNAL)).unwrap().mode();
        let receipt = f
            .temp
            .path()
            .join("private")
            .join(format!(".heinlein-structure-{}.json", f.repo.project_key()));
        let receipt_bytes = fs::read(&receipt).unwrap();
        let receipt_mode = fs::metadata(&receipt).unwrap().mode();
        let preview = f.repo.preview_interrupted(&f.recovery);
        if let Ok(rollback) = &preview {
            assert_eq!(
                f.repo.apply_drafting(rollback, &f.recovery).unwrap_err(),
                Error::DraftingChanged,
                "apply already refuses registered paths"
            );
        }
        assert!(matches!(preview,Err(Error::DraftingChanged)),"rollback preview must refuse original journal membership before inverse planning; apply already refuses");
        for (path, expected) in affected.iter().zip(before) {
            assert_eq!(f.repo.snapshot(path).unwrap(), expected);
        }
        assert_eq!(
            fs::read(f.repo.root().join(JOURNAL)).unwrap(),
            journal_bytes
        );
        assert_eq!(
            fs::metadata(f.repo.root().join(JOURNAL)).unwrap().mode(),
            journal_mode
        );
        assert_eq!(fs::read(&receipt).unwrap(), receipt_bytes);
        assert_eq!(fs::metadata(receipt).unwrap().mode(), receipt_mode);
    }
}
#[test]
fn file_split_registration_after_rollback_preview_is_already_guarded_at_apply() {
    use std::os::unix::fs::MetadataExt;
    for registered in ["ms/story.md", "ms/story-continued.md"] {
        let f = Fixture::new();
        f.put("ms/story.md", "first second");
        let plan = f
            .preview(file_split_change(
                "ms/story.md",
                "ms/story-continued.md",
                "first second",
                6,
            ))
            .unwrap();
        let journal = Journal {
            schema_version: 1,
            repository_key: f.repo.project_key(),
            id: plan.preview.id.clone(),
            edits: plan.edits.clone(),
        };
        f.repo.write_journal(&journal, &f.recovery).unwrap();
        f.repo.write_transition(&plan.edits[0]).unwrap();
        let rollback = f.repo.preview_interrupted(&f.recovery).unwrap();
        let author = Manifest {
            schema_version: 2,
            id: uuid(),
            project: "External index".into(),
            groups: vec![],
            scenes: vec![DraftingScene {
                id: uuid(),
                title: "Registered".into(),
                path: registered.into(),
                group_id: None,
            }],
        };
        f.put(MANIFEST, &manifest_text(&author).unwrap());
        let paths = ["ms/story.md", "ms/story-continued.md", MANIFEST];
        let before: Vec<_> = paths.iter().map(|p| f.repo.snapshot(p).unwrap()).collect();
        let bytes = fs::read(f.repo.root().join(JOURNAL)).unwrap();
        let journal_mode = fs::metadata(f.repo.root().join(JOURNAL)).unwrap().mode();
        let receipt = f
            .temp
            .path()
            .join("private")
            .join(format!(".heinlein-structure-{}.json", f.repo.project_key()));
        let receipt_bytes = fs::read(&receipt).unwrap();
        let receipt_mode = fs::metadata(&receipt).unwrap().mode();
        assert_eq!(
            f.repo.apply_drafting(&rollback, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        for (path, expected) in paths.iter().zip(before) {
            assert_eq!(f.repo.snapshot(path).unwrap(), expected);
        }
        assert_eq!(fs::read(f.repo.root().join(JOURNAL)).unwrap(), bytes);
        assert_eq!(
            fs::metadata(f.repo.root().join(JOURNAL)).unwrap().mode(),
            journal_mode
        );
        assert_eq!(fs::read(&receipt).unwrap(), receipt_bytes);
        assert_eq!(fs::metadata(receipt).unwrap().mode(), receipt_mode);
    }
}

#[test]
fn file_split_refuses_boundaries_stale_recovery_and_destination_races() {
    for (text, offset) in [
        ("first second", 0),
        ("first second", 12),
        ("é second", 1),
        ("a\r\nb", 2),
        ("---\ntitle: x\n---\nbody", 5),
        ("---\nunfinished body", 10),
    ] {
        let f = Fixture::new();
        f.put("story.md", text);
        assert!(f
            .preview(file_split_change("story.md", "suffix.md", text, offset))
            .is_err());
        assert_eq!(
            fs::read(f.repo.root().join("story.md")).unwrap(),
            text.as_bytes()
        );
        assert!(!f.repo.root().join("suffix.md").exists());
    }
    for race in ["source", "destination", "case", "recovery", "symlink"] {
        let f = Fixture::new();
        f.put("story.md", "first second");
        let plan = f
            .preview(file_split_change(
                "story.md",
                "suffix.md",
                "first second",
                6,
            ))
            .unwrap();
        match race {
            "source" => f.put("story.md", "author edit"),
            "destination" => f.put("suffix.md", "author destination"),
            "case" => f.put("SUFFIX.md", "case collision"),
            "recovery" => {
                f.recovery
                    .stage(
                        &f.repo,
                        "story.md",
                        &content_hash("first second"),
                        "pending",
                    )
                    .unwrap();
            }
            _ => {
                std::os::unix::fs::symlink(f.temp.path(), f.repo.root().join("suffix.md")).unwrap()
            }
        }
        assert!(f.repo.apply_drafting(&plan, &f.recovery).is_err(), "{race}");
        assert!(!f.repo.root().join(JOURNAL).exists());
        assert!(!f.repo.root().join("ms").exists());
        if race != "source" {
            assert_eq!(
                fs::read_to_string(f.repo.root().join("story.md")).unwrap(),
                "first second"
            );
        } else {
            assert_eq!(
                fs::read_to_string(f.repo.root().join("story.md")).unwrap(),
                "author edit"
            );
        }
    }
}
#[test]
fn file_split_transition_failure_and_interrupted_rollback_preserve_intervening_edits() {
    for after in 1..=2 {
        let f = Fixture::new();
        f.put("story.md", "first second");
        let plan = f
            .preview(file_split_change(
                "story.md",
                "suffix.md",
                "first second",
                6,
            ))
            .unwrap();
        FAIL_AFTER_EDIT.with(|slot| slot.set(Some(after)));
        let result = f.repo.apply_drafting(&plan, &f.recovery);
        FAIL_AFTER_EDIT.with(|slot| slot.set(None));
        assert_eq!(result.unwrap_err(), Error::Io);
        assert_eq!(
            fs::read_to_string(f.repo.root().join("story.md")).unwrap(),
            "first second"
        );
        assert!(!f.repo.root().join("suffix.md").exists());
        assert!(!f.repo.root().join(JOURNAL).exists());
        let journal = Journal {
            schema_version: 1,
            repository_key: f.repo.project_key(),
            id: plan.preview.id.clone(),
            edits: plan.edits.clone(),
        };
        f.repo.write_journal(&journal, &f.recovery).unwrap();
        for edit in plan.edits.iter().take(after) {
            f.repo.write_transition(edit).unwrap();
        }
        let rollback = f.repo.preview_interrupted(&f.recovery).unwrap();
        f.put("suffix.md", "intervening author text");
        assert_eq!(
            f.repo.apply_drafting(&rollback, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("suffix.md")).unwrap(),
            "intervening author text"
        );
        assert!(f.repo.root().join(JOURNAL).exists());
        assert!(f.repo.preview_interrupted(&f.recovery).is_err());
    }
}

#[test]
fn file_split_metadata_permissions_and_existing_destinations_remain_authoritative() {
    use std::os::unix::fs::PermissionsExt;
    for state in [
        "readonly",
        "malformed",
        "existing",
        "cross-directory",
        "stale",
    ] {
        let f = Fixture::new();
        f.put("story.md", "first second");
        let mut change = file_split_change("story.md", "suffix.md", "first second", 6);
        match state {
            "readonly" => fs::set_permissions(
                f.repo.root().join("story.md"),
                fs::Permissions::from_mode(0o444),
            )
            .unwrap(),
            "malformed" => f.put(MANIFEST, "{not valid"),
            "existing" => f.put("suffix.md", "existing author file"),
            "cross-directory" => {
                change = file_split_change("story.md", "other/suffix.md", "first second", 6)
            }
            _ => change = file_split_change("story.md", "suffix.md", "wrong hash", 6),
        }
        let before = f.repo.snapshot("story.md").unwrap();
        assert!(f.preview(change).is_err(), "{state}");
        assert_eq!(f.repo.snapshot("story.md").unwrap(), before);
        assert!(!f.repo.root().join(JOURNAL).exists());
    }
}

#[test]
fn file_split_legacy_and_generated_guards_recheck_at_apply() {
    for (authority, error) in [
        (
            r#"{"schema_version":1,"project":"Old","volumes":[],"sources":[{"path":"story.md"}]}"#,
            Error::ReadOnly,
        ),
        (
            r#"{"schema_version":1,"project":"Old","volumes":[{"number":1,"title":"Volume","directory":"v","chapters":[{"number":1,"title":"Chapter","directory":"v/c","source":"generated.md","scenes":["story.md"]}]}]}"#,
            Error::LegacySceneMove,
        ),
    ] {
        let f = Fixture::new();
        f.put("story.md", "first second");
        let plan = f
            .preview(file_split_change(
                "story.md",
                "suffix.md",
                "first second",
                6,
            ))
            .unwrap();
        f.put("scene-manifest.json", authority);
        assert_eq!(
            f.preview(file_split_change(
                "story.md",
                "suffix.md",
                "first second",
                6
            ))
            .unwrap_err(),
            error
        );
        assert_eq!(
            f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
            error
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("story.md")).unwrap(),
            "first second"
        );
        assert!(!f.repo.root().join("suffix.md").exists());
        assert_eq!(
            fs::read_to_string(f.repo.root().join("scene-manifest.json")).unwrap(),
            authority
        );
    }
}
