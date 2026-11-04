#[test]
fn reference_split_keeps_classification_and_exact_source() {
    let f = Fixture::new();
    f.initialize();
    f.create("ms/a.md");
    f.put("ms/a.md", "first second");
    f.apply(DraftingChange::SetSheetReference {
        path: "ms/a.md".into(),
        reference: true,
    });
    f.apply(DraftingChange::SplitScene {
        scene_id: f.repo.load_drafting().unwrap().scenes[0].id.clone(),
        path: "ms/b.md".into(),
        title: "Second".into(),
        expected_hash: content_hash("first second"),
        byte_offset: 6,
    });
    assert!(f
        .repo
        .load_drafting()
        .unwrap()
        .scenes
        .iter()
        .all(|sheet| sheet.reference));
    assert_eq!(
        f.repo.read("ms/a.md").unwrap().text + &f.repo.read("ms/b.md").unwrap().text,
        "first second"
    );
}

#[test]
fn reference_classification_persists_and_undo_preserves_newer_source() {
    let f = Fixture::new();
    f.initialize();
    f.create("ms/a.md");
    f.put("ms/a.md", "Exact — source.\r\n");
    let before = f.repo.load_drafting().unwrap();
    let plan = f
        .preview(DraftingChange::SetSheetReference {
            path: "ms/a.md".into(),
            reference: true,
        })
        .unwrap();
    assert!(plan.is_metadata_only());
    let undo = f.repo.apply_drafting(&plan, &f.recovery).unwrap();
    let reopened = Repository::open(f.repo.root()).unwrap();
    let after = reopened.load_drafting().unwrap();
    assert!(after.scenes[0].reference);
    assert_eq!(after.scenes[0].id, before.scenes[0].id);
    assert_eq!(
        reopened.read("ms/a.md").unwrap().text,
        "Exact — source.\r\n"
    );
    f.put("ms/a.md", "Newer author writing — preserved.");
    f.repo.undo_drafting(&undo, &f.recovery).unwrap();
    assert!(!f.repo.load_drafting().unwrap().scenes[0].reference);
    assert_eq!(
        f.repo.read("ms/a.md").unwrap().text,
        "Newer author writing — preserved."
    );
}

#[test]
fn reference_discovery_is_read_only_grouped_stable_and_can_become_regular() {
    let f = Fixture::new();
    f.initialize();
    f.create("ms/chapter/scene.md");
    let mut manifest: Manifest =
        serde_json::from_str(&fs::read_to_string(f.repo.root().join(MANIFEST)).unwrap()).unwrap();
    let group_id = uuid();
    manifest.groups.push(DraftingGroup {
        id: group_id.clone(),
        title: "Chapter".into(),
    });
    manifest.scenes[0].group_id = Some(group_id.clone());
    f.put(MANIFEST, &manifest_text(&manifest).unwrap());
    let path = "ms/chapter/reference/outline.md";
    f.put(path, "Outline — exact.");
    f.put("ms/chapter/BRIEF.md", "Unlisted support file");
    let bytes = fs::read(f.repo.root().join(MANIFEST)).unwrap();
    let state = f.repo.load_drafting().unwrap();
    assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), bytes);
    assert_eq!(state.reference_sheets.len(), 1);
    assert_eq!(state.reference_sheets[0].group_id, Some(group_id));
    assert_eq!(state.untracked_paths, vec!["ms/chapter/BRIEF.md"]);
    assert_eq!(
        Repository::open(f.repo.root())
            .unwrap()
            .load_drafting()
            .unwrap()
            .reference_sheets[0]
            .id,
        state.reference_sheets[0].id
    );
    let undo = f.apply(DraftingChange::SetSheetReference {
        path: path.into(),
        reference: false,
    });
    let reopened = Repository::open(f.repo.root())
        .unwrap()
        .load_drafting()
        .unwrap();
    assert!(reopened.reference_sheets.is_empty());
    let regular = reopened.scenes.iter().find(|s| s.path == path).unwrap();
    assert!(!regular.reference);
    assert_eq!(regular.id, state.reference_sheets[0].id);
    assert_eq!(f.repo.read(path).unwrap().text, "Outline — exact.");
    f.repo.undo_drafting(&undo, &f.recovery).unwrap();
    assert!(f.repo.load_drafting().unwrap().reference_sheets[0].reference);
}

#[test]
fn organizing_discovered_reference_preserves_bytes_and_classification() {
    let f = Fixture::new();
    f.initialize();
    f.create("ms/scene.md");
    let path = "ms/reference/outline.md";
    f.put(path, "Reference source");
    let state = f.repo.load_drafting().unwrap();
    let mut scenes = state.scenes;
    scenes.extend(state.reference_sheets);
    let mut entries = state.library;
    entries.push(LibraryEntry {
        id: scenes[1].id.clone(),
        kind: LibraryEntryKind::Scene,
        parent_id: None,
    });
    f.apply(DraftingChange::OrganizeLibrary {
        groups: state.groups,
        scene_titles: scenes
            .iter()
            .map(|s| LibrarySceneTitle {
                id: s.id.clone(),
                title: if s.reference {
                    "Renamed outline".into()
                } else {
                    s.title.clone()
                },
            })
            .collect(),
        entries,
    });
    let loaded = f.repo.load_drafting().unwrap();
    assert!(loaded.reference_sheets.is_empty());
    assert!(loaded.scenes[1].reference);
    assert_eq!(loaded.scenes[1].title, "Renamed outline");
    assert_eq!(f.repo.read(path).unwrap().text, "Reference source");
}
