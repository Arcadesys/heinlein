#[test]
fn split_with_unrelated_index_drift_preserves_files_index_entries_and_undo() {
    for missing in [false, true] {
        let f = Fixture::new();
        let text = "First—é.\r\nSecond 🐾.\r\n";
        f.put("ms/original.md", text);
        if missing {
            f.put("ms/unrelated.md", "An unrelated scene");
        }
        f.initialize();
        if missing {
            fs::remove_file(f.repo.root().join("ms/unrelated.md")).unwrap();
        } else {
            f.put("ms/unlisted.md", "Unlisted notes—keep exact");
        }
        let before = f.repo.load_drafting().unwrap();
        let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
        let offset = text.find("Second").unwrap();
        let plan = f.preview(split_change(&f, text, offset)).unwrap();
        let undo = f.repo.apply_drafting(&plan, &f.recovery).unwrap();
        let after = f.repo.load_drafting().unwrap();
        assert_eq!(after.scenes[0], before.scenes[0]);
        assert_eq!(&after.scenes[2..], &before.scenes[1..]);
        assert_eq!(after.untracked_paths, before.untracked_paths);
        assert_eq!(after.missing_paths, before.missing_paths);
        let prefix = fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap();
        let suffix = fs::read_to_string(f.repo.root().join("ms/suffix.md")).unwrap();
        assert_eq!(prefix + &suffix, text);
        if !missing {
            assert_eq!(
                fs::read_to_string(f.repo.root().join("ms/unlisted.md")).unwrap(),
                "Unlisted notes—keep exact"
            );
        }
        f.repo.undo_drafting(&undo, &f.recovery).unwrap();
        assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
        assert_eq!(f.repo.read("ms/original.md").unwrap().text, text);
        assert!(!f.repo.root().join("ms/suffix.md").exists());
    }
}

#[test]
fn split_with_existing_index_drift_still_rejects_changes_after_preview() {
    for source_changed in [false, true] {
        let f = Fixture::new();
        let text = "First section. Second section.";
        f.put("ms/original.md", text);
        f.initialize();
        f.put("ms/unlisted.md", "Existing unlisted notes");
        let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
        let plan = f.preview(split_change(&f, text, 15)).unwrap();
        if source_changed {
            f.put("ms/original.md", "Newer source—preserve");
        } else {
            f.put("ms/another.md", "Added after preview");
        }
        assert_eq!(
            f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
        assert!(!f.repo.root().join("ms/suffix.md").exists());
        assert_eq!(
            f.repo.read("ms/original.md").unwrap().text,
            if source_changed { "Newer source—preserve" } else { text }
        );
    }
}
