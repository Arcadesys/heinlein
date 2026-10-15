#![cfg(unix)]
use repository_core::{Error, Repository, MAX_FILE_BYTES};
use std::fs;
use tempfile::TempDir;
fn fixture() -> TempDir {
    let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    fs::write(
        t.path().join("draft.md"),
        "---\r\n{\"id\":\"scene-id\"}\r\n---\r\n\r\n# Voice\r\nFragments. Queer—furry.\r\n",
    )
    .unwrap();
    t
}
fn repo(t: &TempDir) -> Repository {
    Repository::open(t.path()).unwrap()
}
fn manifest(t: &TempDir) {
    fs::create_dir_all(t.path().join("book/vol/chapter")).unwrap();
    for name in ["scene-010.md", "scene-002.md"] {
        fs::write(
            t.path().join("book/vol/chapter").join(name),
            "# Scene\nUnchanged—always.\n",
        )
        .unwrap()
    }
    fs::write(t.path().join("book/vol/compat.md"), "# Generated chapter\n").unwrap();
    fs::write(t.path().join("book/scene-manifest.json"),r#"{"schema_version":1,"project":"Test","volumes":[{"number":9,"title":"V","directory":"vol","chapters":[{"number":3,"title":"C","directory":"vol/chapter","source":"vol/compat.md","scenes":["vol/chapter/scene-010.md","vol/chapter/scene-002.md"]}]}],"sources":[{"path":"vol/compat.md"}]}"#).unwrap();
}
#[test]
fn preserves_bytes_and_frontmatter_without_writing() {
    let t = fixture();
    let before = fs::read(t.path().join("draft.md")).unwrap();
    let r = repo(&t);
    let doc = r.read("draft.md").unwrap();
    assert_eq!(doc.text.as_bytes(), before);
    assert_eq!(
        doc.frontmatter.as_deref(),
        Some("{\"id\":\"scene-id\"}\r\n")
    );
    assert!(!doc.generated_compatibility);
    assert_eq!(fs::read(t.path().join("draft.md")).unwrap(), before);
    assert_eq!(doc.size_bytes, before.len() as u64);
}
#[test]
fn rejects_traversal_absolute_and_ambiguous_paths() {
    let t = fixture();
    let r = repo(&t);
    for p in [
        "../draft.md",
        "/etc/passwd",
        "x/../draft.md",
        "./draft.md",
        "C:/draft.md",
        "x\\draft.md",
        "draft.md/",
        "x//draft.md",
        "x\0.md",
    ] {
        assert!(r.read(p).is_err(), "{p:?}");
        assert!(r.list(p).is_err(), "{p:?}");
    }
    assert!(r.list("").is_ok());
    assert!(r.read("").is_err());
}
#[test]
fn hides_and_denies_internal_secret_build_and_ignored_files() {
    let t = fixture();
    for name in [".git", ".ssh", "node_modules", "target", "dist", "secrets"] {
        fs::create_dir(t.path().join(name)).unwrap();
        fs::write(t.path().join(name).join("leak.md"), "secret").unwrap();
    }
    fs::write(t.path().join(".env"), "secret").unwrap();
    fs::write(t.path().join("key.pem"), "secret").unwrap();
    fs::write(t.path().join("ignore-me.md"), "secret").unwrap();
    fs::write(t.path().join(".gitignore"), "ignore-me.md\n").unwrap();
    let r = repo(&t);
    let entries = r.list("").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "draft.md");
    for p in [
        ".git/leak.md",
        ".ssh/leak.md",
        "node_modules/leak.md",
        "target/leak.md",
        "dist/leak.md",
        "secrets/leak.md",
        ".env",
        "key.pem",
        "ignore-me.md",
    ] {
        assert!(r.read(p).is_err(), "{p}")
    }
}
#[test]
fn respects_nested_gitignore_and_never_reincludes_prohibited_paths() {
    let t = fixture();
    fs::create_dir(t.path().join("sub")).unwrap();
    fs::write(t.path().join(".gitignore"), "*.txt\n!.env\n").unwrap();
    fs::write(t.path().join("sub/.gitignore"), "draft.md\n").unwrap();
    fs::write(t.path().join("sub/draft.md"), "hidden").unwrap();
    fs::write(t.path().join("sub/a.txt"), "hidden").unwrap();
    fs::write(t.path().join("sub/ok.md"), "ok").unwrap();
    let r = repo(&t);
    assert!(r.read("sub/draft.md").is_err());
    assert!(r.read("sub/a.txt").is_err());
    assert!(r.read("sub/ok.md").is_ok());
    assert_eq!(r.list("sub").unwrap().len(), 1);
}
#[test]
fn denies_all_symlinks_even_internal_links_and_manifest_links() {
    use std::os::unix::fs::symlink;
    let t = fixture();
    let outside = fixture();
    symlink(t.path().join("draft.md"), t.path().join("internal.md")).unwrap();
    symlink(outside.path(), t.path().join("outside")).unwrap();
    let r = repo(&t);
    assert!(r.read("internal.md").is_err());
    assert!(r.read("outside/draft.md").is_err());
    assert!(r.list("outside").is_err());
    assert_eq!(r.list("").unwrap().len(), 1);
    symlink(outside.path().join("draft.md"), t.path().join(".gitignore")).unwrap();
    assert!(r.read("draft.md").is_err());
}
#[test]
fn rejects_binary_non_utf8_oversize_and_devices() {
    let t = fixture();
    fs::write(t.path().join("nul.md"), b"hello\0world").unwrap();
    fs::write(t.path().join("bad.md"), [0xff, 0xfe]).unwrap();
    fs::write(t.path().join("image.png"), "plain").unwrap();
    fs::write(
        t.path().join("large.md"),
        vec![b'a'; MAX_FILE_BYTES as usize + 1],
    )
    .unwrap();
    let r = repo(&t);
    for p in ["nul.md", "bad.md", "image.png", "large.md"] {
        assert!(r.read(p).is_err())
    }
}
#[test]
fn manifest_order_relative_paths_and_generated_flags() {
    let t = fixture();
    manifest(&t);
    let r = repo(&t);
    assert_eq!(r.discover().unwrap(), vec!["book/scene-manifest.json"]);
    let m = r.manuscript("book/scene-manifest.json").unwrap();
    assert_eq!(m.volumes[0].number, 9);
    assert_eq!(m.volumes[0].chapters[0].number, 3);
    let scenes = &m.volumes[0].chapters[0].scenes;
    assert!(scenes[0].path.ends_with("scene-010.md"));
    assert!(scenes[1].path.ends_with("scene-002.md"));
    assert!(
        r.read("book/vol/compat.md")
            .unwrap()
            .generated_compatibility
    );
    assert!(!r.read(&scenes[0].path).unwrap().generated_compatibility);
    let j = serde_json::to_value(r.read("draft.md").unwrap()).unwrap();
    assert!(j.get("sizeBytes").is_some());
    assert!(j.get("generatedCompatibility").is_some());
}
#[test]
fn manifest_rejects_escapes_duplicates_missing_or_unknown_schema() {
    for (old, new) in [
        ("vol/chapter/scene-002.md", "../draft.md"),
        ("vol/chapter/scene-002.md", "vol/chapter/scene-010.md"),
        ("vol/chapter/scene-002.md", "vol/chapter/missing.md"),
        ("\"schema_version\":1", "\"schema_version\":2"),
    ] {
        let t = fixture();
        manifest(&t);
        let p = t.path().join("book/scene-manifest.json");
        let s = fs::read_to_string(&p).unwrap();
        fs::write(&p, s.replace(old, new)).unwrap();
        assert!(repo(&t).manuscript("book/scene-manifest.json").is_err());
    }
}
#[test]
fn bounded_directory_and_depth() {
    let t = fixture();
    for n in 0..4100 {
        fs::write(t.path().join(format!("{n}.md")), "").unwrap();
    }
    assert_eq!(repo(&t).list("").unwrap_err(), Error::LimitExceeded);
    let path = std::iter::repeat_n("x", 33).collect::<Vec<_>>().join("/");
    assert_eq!(repo(&t).read(&path).unwrap_err(), Error::LimitExceeded);
}
#[test]
#[ignore = "requires private archive fixture; set HEINLEIN_ARCHIVE_ROOT"]
fn real_archive_acceptance() {
    let root = std::env::var("HEINLEIN_ARCHIVE_ROOT").expect("fixture root");
    let r = Repository::open(root).unwrap();
    let p = "essays/singularity-log/scene-manifest.json";
    let m = r.manuscript(p).unwrap();
    let chapters: Vec<_> = m.volumes.iter().flat_map(|v| &v.chapters).collect();
    let scenes: Vec<_> = chapters.iter().flat_map(|c| &c.scenes).collect();
    assert_eq!(scenes.len(), 95);
    for s in scenes {
        let d = r.read(&s.path).unwrap();
        assert!(d.frontmatter.is_some());
        assert!(!d.generated_compatibility);
        assert!(d.text.contains("---"));
    }
    for c in chapters {
        assert!(r.read(&c.source).unwrap().generated_compatibility)
    }
}

#[test]
fn rejects_fifo_without_blocking() {
    let t = fixture();
    assert!(std::process::Command::new("mkfifo")
        .arg(t.path().join("pipe.md"))
        .status()
        .unwrap()
        .success());
    let r = repo(&t);
    assert_eq!(r.read("pipe.md").unwrap_err(), Error::NotFile);
    assert!(!r.list("").unwrap().iter().any(|e| e.name == "pipe.md"));
}

#[test]
fn root_and_ancestor_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;
    let t = fixture();
    let owner = fixture();
    symlink(t.path(), owner.path().join("root-link")).unwrap();
    assert!(Repository::open(owner.path().join("root-link")).is_err());
    fs::create_dir(t.path().join("nested")).unwrap();
    assert!(Repository::open(owner.path().join("root-link/nested")).is_err());
    assert!(Repository::open("relative").is_err());
}

#[test]
fn concurrent_symlink_replacement_never_reads_outside_root() {
    use std::os::unix::fs::symlink;
    let t = fixture();
    let outside = fixture();
    fs::write(outside.path().join("draft.md"), "OUTSIDE SECRET").unwrap();
    let r = repo(&t);
    let root = t.path().to_owned();
    let target = outside.path().join("draft.md");
    let worker = std::thread::spawn(move || {
        for _ in 0..500 {
            symlink(&target, root.join("swap-link")).unwrap();
            fs::rename(root.join("swap-link"), root.join("draft.md")).unwrap();
            fs::write(root.join("safe-tmp"), "safe").unwrap();
            fs::rename(root.join("safe-tmp"), root.join("draft.md")).unwrap();
        }
    });
    for _ in 0..500 {
        if let Ok(doc) = r.read("draft.md") {
            assert!(!doc.text.contains("OUTSIDE SECRET"));
        }
    }
    worker.join().unwrap();
}

#[test]
fn unrepresentable_unix_names_do_not_break_listing() {
    let t = fixture();
    for name in ["colon:name.md", "back\\slash.md"] {
        fs::write(t.path().join(name), "skip me").unwrap();
    }
    let r = repo(&t);
    assert_eq!(r.list("").unwrap().len(), 1);
    assert!(r.discover().unwrap().is_empty());
}

#[test]
fn chapter_source_without_sources_array_is_readonly_even_when_manifest_ignored() {
    let t = fixture();
    manifest(&t);
    let path = t.path().join("book/scene-manifest.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("sources");
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let r = repo(&t);
    assert!(
        r.read("book/vol/compat.md")
            .unwrap()
            .generated_compatibility
    );
    assert!(
        !r.read("book/vol/chapter/scene-010.md")
            .unwrap()
            .generated_compatibility
    );
    fs::write(t.path().join(".gitignore"), "book/scene-manifest.json\n").unwrap();
    assert!(
        r.read("book/vol/compat.md")
            .unwrap()
            .generated_compatibility
    );
    assert_eq!(
        fs::read_to_string(t.path().join("book/vol/compat.md")).unwrap(),
        "# Generated chapter\n"
    );
}
