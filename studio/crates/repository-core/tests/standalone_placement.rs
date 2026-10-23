#![cfg(unix)]
use repository_core::{
    standalone::{DraftStore, PlacementIntent},
    standalone_placement::{verify_scene, DraftDestination},
    LiteralScene, RecoveryStore, Repository,
};
use sha2::{Digest, Sha256};
use std::fs;
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn fixture() -> (tempfile::TempDir, RecoveryStore) {
    let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let recovery = RecoveryStore::open(t.path().join("recovery")).unwrap();
    (t, recovery)
}
const TEXT: &str = "🐺 e\u{301} — story\r\n\nend\r\n  ";
#[test]
fn file_and_both_project_destinations_are_exact_single_scene_transactions() {
    let (t, recovery) = fixture();
    let file = DraftDestination::open(&t.path().join("copy.md")).unwrap();
    file.write_file(TEXT, || Ok(())).unwrap();
    assert_eq!(fs::read(file.path()).unwrap(), TEXT.as_bytes());
    assert!(file.write_file("overwrite", || Ok(())).is_err());
    let scene = uuid::Uuid::new_v4().to_string();
    let project = DraftDestination::open(&t.path().join("new-project")).unwrap();
    project
        .write_project(
            "Synthetic project",
            "Scene title",
            "draft.md",
            TEXT,
            &scene,
            &recovery,
            || Ok(()),
        )
        .unwrap();
    let repo = Repository::open(project.path()).unwrap();
    verify_scene(&repo, "ms/draft.md", &scene, &hash(TEXT)).unwrap();
    let first = repo.load_drafting().unwrap();
    assert_eq!(first.scenes.len(), 1);
    let next = uuid::Uuid::new_v4().to_string();
    let literal = LiteralScene {
        id: next.clone(),
        title: "Second scene".into(),
        path: "ms/second.md".into(),
        text: TEXT.into(),
    };
    let plan = repo
        .preview_literal_scene(first.revision.as_deref(), None, literal, &recovery)
        .unwrap();
    repo.apply_drafting(&plan, &recovery).unwrap();
    verify_scene(&repo, "ms/second.md", &next, &hash(TEXT)).unwrap();
    assert_eq!(repo.load_drafting().unwrap().scenes.len(), 2);
    assert!(repo.apply_drafting(&plan, &recovery).is_err());
    assert_eq!(
        fs::read(project.path().join("ms/draft.md")).unwrap(),
        TEXT.as_bytes()
    );
    assert!(!fs::read_to_string(file.path()).unwrap().contains("title:"));
}
#[test]
fn stale_manifest_cancel_collision_symlink_and_write_guard_preserve_source() {
    use std::os::unix::fs::symlink;
    let (t, recovery) = fixture();
    let source = t.path().join("source");
    fs::write(&source, TEXT).unwrap();
    let p = DraftDestination::open(&t.path().join("cancel.md")).unwrap();
    assert!(p.write_file(TEXT, || Err("cancel".into())).is_err());
    assert!(!p.path().exists());
    symlink(&source, t.path().join("link.md")).unwrap();
    let p = DraftDestination::open(&t.path().join("link.md")).unwrap();
    assert!(p.write_file("bad", || Ok(())).is_err());
    assert!(DraftDestination::open(&t.path().join("../escape")).is_err());
    let p = DraftDestination::open(&t.path().join("project")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    p.write_project(
        "Project",
        "Scene",
        "one.md",
        TEXT,
        &id,
        &recovery,
        || Ok(()),
    )
    .unwrap();
    let repo = Repository::open(p.path()).unwrap();
    let state = repo.load_drafting().unwrap();
    let plan = repo
        .preview_literal_scene(
            state.revision.as_deref(),
            None,
            LiteralScene {
                id: uuid::Uuid::new_v4().to_string(),
                title: "Other".into(),
                path: "ms/two.md".into(),
                text: TEXT.into(),
            },
            &recovery,
        )
        .unwrap();
    let manifest = p.path().join("ms/manuscript.json");
    let before = fs::read_to_string(&manifest).unwrap();
    fs::write(&manifest, format!("{before}\n")).unwrap();
    assert!(repo.apply_drafting(&plan, &recovery).is_err());
    assert!(!p.path().join("ms/two.md").exists());
    assert_eq!(fs::read(&source).unwrap(), TEXT.as_bytes());
}
#[test]
fn lost_receipt_reconciles_without_copy_replay_even_after_original_edits_and_restart() {
    let (t, _) = fixture();
    let root = t.path().join("private");
    let store = DraftStore::open(&root).unwrap();
    let (lease, d) = store.create(TEXT).unwrap();
    let path = t.path().join("placed.md");
    let intent = PlacementIntent {
        schema_version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        draft_id: d.id.clone(),
        source_revision: d.revision,
        source_hash: d.text_hash.clone(),
        kind: "file".into(),
        destination: path.to_string_lossy().into(),
        scene_id: None,
        project_key: None,
    };
    store.intent(&lease, &intent).unwrap();
    DraftDestination::open(&path)
        .unwrap()
        .write_file(TEXT, || Ok(()))
        .unwrap();
    let changed = store
        .save(&lease, d.revision, &d.text_hash, "newer original")
        .unwrap();
    drop(lease);
    drop(store);
    let store = DraftStore::open(&root).unwrap();
    let lease = store.acquire(&d.id).unwrap();
    let pending = store.pending(&d.id).unwrap();
    assert_eq!(pending.len(), 1);
    DraftDestination::open(&path)
        .unwrap()
        .verify_file(&pending[0].source_hash)
        .unwrap();
    let done = store.finish_placement(&lease, &pending[0]).unwrap();
    assert_eq!(done.text, changed.text);
    assert_eq!(done.placements[0].source_revision, 1);
    assert_eq!(
        store
            .finish_placement(&lease, &pending[0])
            .unwrap()
            .revision,
        done.revision
    );
    assert!(store.pending(&d.id).unwrap().is_empty());
    assert_eq!(fs::read(path).unwrap(), TEXT.as_bytes());
}
#[test]
fn declared_generated_output_and_pending_recovery_are_never_placement_targets() {
    let (t, recovery) = fixture();
    fs::write(t.path().join("scene-manifest.json"),r#"{"schema_version":1,"project":"Book","volumes":[{"number":1,"title":"V","directory":"v","chapters":[{"number":1,"title":"C","directory":"v/c","source":"generated.md","scenes":[]}]}]}"#).unwrap();
    let target = DraftDestination::open(&t.path().join("generated.md")).unwrap();
    assert!(target.write_file(TEXT, || Ok(())).is_err());
    assert!(!target.path().exists());
    fs::remove_file(t.path().join("scene-manifest.json")).unwrap();
    let p = DraftDestination::open(&t.path().join("project")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    p.write_project(
        "Project",
        "Scene",
        "one.md",
        TEXT,
        &id,
        &recovery,
        || Ok(()),
    )
    .unwrap();
    let repo = Repository::open(p.path()).unwrap();
    fs::write(p.path().join("ms/second.md"), "previous source").unwrap();
    let current = repo.read("ms/second.md").unwrap();
    recovery
        .stage(
            &repo,
            "ms/second.md",
            &current.content_hash,
            "unresolved recovery",
        )
        .unwrap();
    fs::remove_file(p.path().join("ms/second.md")).unwrap();
    let s = repo.load_drafting().unwrap();
    assert!(repo
        .preview_literal_scene(
            s.revision.as_deref(),
            None,
            LiteralScene {
                id: uuid::Uuid::new_v4().to_string(),
                title: "Second".into(),
                path: "ms/second.md".into(),
                text: TEXT.into()
            },
            &recovery
        )
        .is_err());
    assert!(!p.path().join("ms/second.md").exists());
}
