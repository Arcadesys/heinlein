#![cfg(unix)]
use heinlein_local_mcp::LocalMcp;
use repository_core::{mcp_selection::SelectionStore, Repository};
use serde_json::json;
use std::fs;
#[test]
fn a_project_connection_follows_new_saved_sources_and_revocation_without_resending_or_saving_text()
{
    let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let root = t.path().join("project");
    fs::create_dir(&root).unwrap();
    let original = "Exact — e\u{301} 🦊\r\n";
    fs::write(root.join("scene.md"), original).unwrap();
    let repo = Repository::open(&root).unwrap();
    let selection = t.path().join("selection");
    let author = SelectionStore::open(&selection).unwrap();
    let server = LocalMcp::follow_studio(&selection, "Synthetic client".into()).unwrap();
    assert_eq!(
        server.execute("list_projects", json!({})).unwrap()["projects"],
        json!([])
    );
    author
        .select_project_checked(&repo, &t.path().join("proposals"), None)
        .unwrap();
    let project = repo.project_key();
    let scenes = server
        .execute("list_scenes", json!({"projectId":project}))
        .unwrap();
    let scene = scenes["scenes"][0]["sceneId"].clone();
    let read = server
        .execute("read_scene", json!({"projectId":project,"sceneId":scene}))
        .unwrap();
    assert_eq!(read["text"], original);
    fs::write(root.join("reference.md"), "Saved reference\n").unwrap();
    let next = server
        .execute("list_scenes", json!({"projectId":project}))
        .unwrap();
    assert_eq!(next["scenes"].as_array().unwrap().len(), 2);
    assert_eq!(server.execute("propose_scene",json!({"projectId":project,"sceneId":scene,"snapshotId":read["snapshotId"],"baseHash":read["baseHash"],"replacementText":"Not applied"})).unwrap_err().0,"readRequired");
    let read = server
        .execute("read_scene", json!({"projectId":project,"sceneId":scene}))
        .unwrap();
    let proposal=server.execute("propose_scene",json!({"projectId":project,"sceneId":scene,"snapshotId":read["snapshotId"],"baseHash":read["baseHash"],"replacementText":"Advisory only —\r\n"})).unwrap();
    assert_eq!(proposal["requiresAuthorReview"], true);
    fs::remove_file(root.join("reference.md")).unwrap();
    assert_eq!(
        server
            .execute("list_scenes", json!({"projectId":project}))
            .unwrap()["scenes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    author.revoke().unwrap();
    assert_eq!(
        server.execute("list_projects", json!({})).unwrap()["projects"],
        json!([])
    );
    assert!(server
        .execute("read_scene", json!({"projectId":project,"sceneId":scene}))
        .is_err());
    assert_eq!(
        fs::read(root.join("scene.md")).unwrap(),
        original.as_bytes()
    );
}
#[test]
fn project_access_supports_large_catalogs_and_recovers_after_an_empty_project_gains_its_first_source(
) {
    let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let root = t.path().join("project");
    fs::create_dir(&root).unwrap();
    let repo = Repository::open(&root).unwrap();
    let dir = t.path().join("selection");
    let author = SelectionStore::open(&dir).unwrap();
    author
        .select_project_checked(&repo, &t.path().join("proposals"), None)
        .unwrap();
    let server = LocalMcp::follow_studio(&dir, "Synthetic client".into()).unwrap();
    let project = repo.project_key();
    assert_eq!(
        server.execute("list_projects", json!({})).unwrap()["projects"][0]["selectedSceneCount"],
        0
    );
    for i in 0..130 {
        fs::write(
            root.join(format!("scene-{i:03}.md")),
            "Synthetic saved source\n",
        )
        .unwrap();
    }
    assert_eq!(
        server
            .execute("list_scenes", json!({"projectId":project}))
            .unwrap()["scenes"]
            .as_array()
            .unwrap()
            .len(),
        130
    );
    fs::write(root.join(".gitignore"), "scene-001.md\n").unwrap();
    let scenes = server
        .execute("list_scenes", json!({"projectId":project}))
        .unwrap();
    assert_eq!(scenes["scenes"].as_array().unwrap().len(), 129);
    assert!(!scenes.to_string().contains("scene-001.md"));
}
