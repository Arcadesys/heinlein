#![cfg(unix)]
use repository_core::{mcp_selection::SelectionStore, Repository};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
};
#[test]
fn legacy_access_stays_narrow_until_explicit_project_grant_and_survives_restart() {
    let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let root = t.path().join("book");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("one.md"), "Exact — 🦊\r\n").unwrap();
    fs::write(root.join("two.md"), "Reference\n").unwrap();
    let repo = Repository::open(&root).unwrap();
    let dir = t.path().join("selection");
    let store = SelectionStore::open(&dir).unwrap();
    let old = store
        .select(&repo, vec!["one.md".into()], &t.path().join("proposals"))
        .unwrap();
    let before = fs::read(dir.join("selection-v1.json")).unwrap();
    let reopened = SelectionStore::open(&dir).unwrap();
    let legacy = reopened.load().unwrap().unwrap();
    assert!(!legacy.selection.unwrap().project_wide);
    assert_eq!(fs::read(dir.join("selection-v1.json")).unwrap(), before);
    let granted = store
        .select_project_checked(&repo, &t.path().join("proposals"), Some(&old.generation))
        .unwrap();
    assert_eq!(granted.schema_version, 2);
    assert!(granted.selection.as_ref().unwrap().scenes.is_empty());
    fs::write(root.join("three.markdown"), "New saved reference\n").unwrap();
    let shared = reopened.load().unwrap().unwrap().selection.unwrap();
    assert!(shared.project_wide);
    assert_eq!(
        shared.sources().unwrap(),
        vec!["one.md", "three.markdown", "two.md"]
    );
    assert_eq!(
        fs::read(root.join("one.md")).unwrap(),
        "Exact — 🦊\r\n".as_bytes()
    );
    store.revoke().unwrap();
    assert!(store
        .select_project_checked(
            &repo,
            &t.path().join("proposals"),
            Some(&granted.generation)
        )
        .is_err());
    assert!(reopened.load().unwrap().unwrap().selection.is_none());
}
#[test]
fn project_catalog_includes_future_sources_above_the_old_file_limit_but_excludes_private_and_generated_files(
) {
    let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let root = t.path().join("book");
    fs::create_dir(&root).unwrap();
    let repo = Repository::open(&root).unwrap();
    let store = SelectionStore::open(&t.path().join("selection")).unwrap();
    let grant = store
        .select_project_checked(&repo, &t.path().join("proposals"), None)
        .unwrap()
        .selection
        .unwrap();
    assert!(grant.sources().unwrap().is_empty());
    for i in 0..130 {
        fs::write(root.join(format!("{i:03}.md")), "Saved\n").unwrap();
    }
    fs::write(root.join(".private.md"), "Never expose").unwrap();
    fs::write(root.join("credentials.md"), "Never expose").unwrap();
    fs::write(root.join("ignored.md"), "Never expose").unwrap();
    fs::write(root.join(".gitignore"), "ignored.md\n").unwrap();
    fs::write(t.path().join("outside.md"), "Never expose").unwrap();
    symlink(t.path().join("outside.md"), root.join("link.md")).unwrap();
    fs::create_dir(root.join("legacy")).unwrap();
    fs::write(root.join("legacy/source.md"), "Original —\r\n").unwrap();
    fs::write(root.join("legacy/assembled.md"), "Generated\n").unwrap();
    fs::write(root.join("legacy/scene-manifest.json"),r#"{"schema_version":1,"project":"Synthetic","volumes":[{"chapters":[{"source":"assembled.md","scenes":["source.md"]}]}]}"#).unwrap();
    fs::write(root.join("invalid.md"), [0xff]).unwrap();
    fs::File::create(root.join("oversized.md"))
        .unwrap()
        .set_len(repository_core::MAX_FILE_BYTES + 1)
        .unwrap();
    let sources = grant.sources().unwrap();
    assert_eq!(sources.len(), 131);
    assert!(sources.contains(&"legacy/source.md".into()));
    assert!(!sources.iter().any(|s| s.contains("private")
        || s.contains("credentials")
        || s.contains("ignored")
        || s.contains("link")
        || s.contains("assembled")));
    fs::rename(root.join("000.md"), root.join("renamed.md")).unwrap();
    assert!(!grant.sources().unwrap().contains(&"000.md".into()));
    assert!(grant.sources().unwrap().contains(&"renamed.md".into()));
}
#[test]
fn schema_mismatch_and_root_replacement_never_expand_the_project_grant() {
    let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let root = t.path().join("book");
    fs::create_dir(&root).unwrap();
    let repo = Repository::open(&root).unwrap();
    let dir = t.path().join("selection");
    let store = SelectionStore::open(&dir).unwrap();
    let grant = store
        .select_project_checked(&repo, &t.path().join("proposals"), None)
        .unwrap();
    let path = dir.join("selection-v1.json");
    let before = fs::read(&path).unwrap();
    let mut wrong: serde_json::Value = serde_json::from_slice(&before).unwrap();
    wrong["schemaVersion"] = serde_json::json!(1);
    fs::write(&path, serde_json::to_vec(&wrong).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(store.load().is_err());
    fs::write(&path, &before).unwrap();
    fs::rename(&root, t.path().join("old-book")).unwrap();
    fs::create_dir(&root).unwrap();
    fs::write(root.join("not-approved.md"), "Different project").unwrap();
    assert!(grant.selection.unwrap().repository().is_err());
    let generation = store.load().unwrap().unwrap().generation;
    assert!(store
        .select_project_checked(&repo, &t.path().join("proposals"), Some(&generation))
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn project_catalog_keeps_manuscript_order_before_reference_material() {
    let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let root = t.path().join("book");
    fs::create_dir_all(root.join("ms")).unwrap();
    fs::create_dir(root.join("notes")).unwrap();
    for path in ["ms/z.md", "ms/a.md", "notes/reference.md"] {
        fs::write(root.join(path), "Exact saved source\r\n").unwrap();
    }
    let manifest = serde_json::json!({"schemaVersion":2,"id":uuid::Uuid::new_v4().to_string(),"project":"Synthetic","groups":[],"scenes":[{"id":uuid::Uuid::new_v4().to_string(),"title":"First","path":"ms/z.md","groupId":null},{"id":uuid::Uuid::new_v4().to_string(),"title":"Second","path":"ms/a.md","groupId":null}]});
    fs::write(
        root.join("ms/manuscript.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let repo = Repository::open(&root).unwrap();
    assert_eq!(
        repo.mcp_project_sources().unwrap(),
        vec!["ms/z.md", "ms/a.md", "notes/reference.md"]
    );
}
