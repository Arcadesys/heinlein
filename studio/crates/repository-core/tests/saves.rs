#![cfg(unix)]
use repository_core::{Error, Repository, MAX_FILE_BYTES};
use std::{
    fs,
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
};
use tempfile::TempDir;

const ORIGINAL: &str =
    "---\r\nid: scene-001\r\nquoted: 'Keep: this'\r\n---\r\n\r\nQueer—furry.\r\nFragments.\r\n";
fn fixture() -> (TempDir, Repository) {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    fs::write(dir.path().join("scene.md"), ORIGINAL).unwrap();
    let repo = Repository::open(dir.path()).unwrap();
    (dir, repo)
}
#[test]
fn noop_preserves_exact_bytes_metadata_and_inode() {
    let (dir, repo) = fixture();
    let path = dir.path().join("scene.md");
    let before = fs::metadata(&path).unwrap();
    let doc = repo.read("scene.md").unwrap();
    assert_eq!(doc.content_hash.len(), 64);
    let result = repo.save("scene.md", &doc.content_hash, &doc.text).unwrap();
    let after = fs::metadata(&path).unwrap();
    assert_eq!(doc.content_hash, result.content_hash);
    assert_eq!(
        (before.ino(), before.modified().unwrap()),
        (after.ino(), after.modified().unwrap())
    );
    assert_eq!(fs::read(path).unwrap(), ORIGINAL.as_bytes());
}
#[test]
fn repeated_saves_preserve_frontmatter_crlf_and_authorial_text() {
    let (dir, repo) = fixture();
    fs::set_permissions(
        dir.path().join("scene.md"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    let mut doc = repo.read("scene.md").unwrap();
    for n in 0..5 {
        let text = format!("{ORIGINAL}\r\nAddition {n}.\r\n");
        let saved = repo.save("scene.md", &doc.content_hash, &text).unwrap();
        assert_eq!(saved.frontmatter, doc.frontmatter);
        assert_eq!(
            fs::read(dir.path().join("scene.md")).unwrap(),
            text.as_bytes()
        );
        assert_eq!(
            repo.read("scene.md").unwrap().content_hash,
            saved.content_hash
        );
        doc = saved;
    }
    assert_eq!(
        fs::metadata(dir.path().join("scene.md")).unwrap().mode() & 0o777,
        0o640
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}
#[test]
fn stale_hash_cannot_overwrite_external_edits_even_for_noop() {
    let (dir, repo) = fixture();
    let doc = repo.read("scene.md").unwrap();
    fs::write(dir.path().join("scene.md"), "External edit\n").unwrap();
    for text in [&doc.text[..], "External edit\n", "My edit\n"] {
        assert_eq!(
            repo.save("scene.md", &doc.content_hash, text).unwrap_err(),
            Error::Conflict
        );
    }
    assert_eq!(
        fs::read_to_string(dir.path().join("scene.md")).unwrap(),
        "External edit\n"
    );
}
#[test]
fn unsafe_paths_types_and_content_never_change_original() {
    let (dir, repo) = fixture();
    let hash = repo.read("scene.md").unwrap().content_hash;
    fs::write(dir.path().join("data.json"), "{}").unwrap();
    fs::create_dir(dir.path().join("directory.md")).unwrap();
    symlink(dir.path().join("scene.md"), dir.path().join("link.md")).unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("scene.md"), "outside").unwrap();
    symlink(outside.path(), dir.path().join("outside")).unwrap();
    fs::write(dir.path().join(".gitignore"), "ignored.md\n").unwrap();
    fs::write(dir.path().join("ignored.md"), ORIGINAL).unwrap();
    for path in [
        "../scene.md",
        "/tmp/scene.md",
        "x/../scene.md",
        "link.md",
        "outside/scene.md",
        "ignored.md",
        "data.json",
        "missing.md",
        "directory.md",
        ".hidden.md",
    ] {
        assert!(repo.save(path, &hash, "changed").is_err(), "{path}");
    }
    assert_eq!(
        repo.save("scene.md", &hash, "binary\0").unwrap_err(),
        Error::UnsupportedText
    );
    assert_eq!(
        repo.save("scene.md", &hash, &"x".repeat(MAX_FILE_BYTES as usize + 1))
            .unwrap_err(),
        Error::TooLarge
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("scene.md")).unwrap(),
        ORIGINAL
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("scene.md")).unwrap(),
        "outside"
    );
}
#[test]
fn compatibility_and_unsupported_manifests_fail_closed() {
    for manifest in [
        r#"{"schema_version":1,"project":"Book","volumes":[],"sources":[{"path":"scene.md"}]}"#,
        r#"{"schema_version":1,"project":"Book","volumes":[{"number":1,"title":"V","directory":"v","chapters":[{"number":1,"title":"C","directory":"v/c","source":"scene.md","scenes":[]}]}]}"#,
        r#"{"schema_version":2,"project":"Book","volumes":[]}"#,
        "malformed",
    ] {
        let (dir, repo) = fixture();
        let hash = repo.read("scene.md").unwrap().content_hash;
        fs::write(dir.path().join("scene-manifest.json"), manifest).unwrap();
        // Even an ignored manifest must protect generated sources.
        fs::write(dir.path().join(".gitignore"), "scene-manifest.json\n").unwrap();
        assert!(repo.save("scene.md", &hash, "edited").is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("scene.md")).unwrap(),
            ORIGINAL
        );
    }
}
#[test]
fn readonly_file_failure_preserves_original_and_leaves_no_temporary() {
    let (dir, repo) = fixture();
    let hash = repo.read("scene.md").unwrap().content_hash;
    fs::set_permissions(
        dir.path().join("scene.md"),
        fs::Permissions::from_mode(0o444),
    )
    .unwrap();
    assert_eq!(
        repo.save("scene.md", &hash, "edited").unwrap_err(),
        Error::Denied
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("scene.md")).unwrap(),
        ORIGINAL
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn chapter_entry_scene_is_editable_but_explicit_outputs_stay_protected() {
    let (dir, repo) = fixture();
    // Mirrors manifests where chapter.source names the first source scene.
    let manifest = r#"{"schema_version":1,"project":"Book","volumes":[{"number":1,"title":"V","directory":"v","chapters":[{"number":1,"title":"C","directory":"v/c","source":"scene.md","scenes":["scene.md","second.md"]}]}],"sources":[]}"#;
    fs::write(dir.path().join("scene-manifest.json"), manifest).unwrap();
    let before = repo.read("scene.md").unwrap();
    assert!(!before.generated_compatibility);
    let saved = repo
        .save(
            "scene.md",
            &before.content_hash,
            "Author edit—preserved.\r\n",
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("scene.md")).unwrap(),
        saved.text
    );
    assert!(!saved.generated_compatibility);
    // An explicit generated declaration cannot be bypassed by listing it as a scene.
    fs::write(
        dir.path().join("scene-manifest.json"),
        manifest.replace("\"sources\":[]", "\"sources\":[{\"path\":\"scene.md\"}]"),
    )
    .unwrap();
    assert!(repo.read("scene.md").unwrap().generated_compatibility);
    assert_eq!(
        repo.save("scene.md", &saved.content_hash, "Must not write")
            .unwrap_err(),
        Error::ReadOnly
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("scene.md")).unwrap(),
        saved.text
    );
}
