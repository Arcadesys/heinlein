use super::*;
use std::fs;
use tempfile::TempDir;
struct Fixture {
    temp: TempDir,
    repo: Repository,
    recovery: RecoveryStore,
    parent: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let source = root.join("source");
        fs::create_dir_all(source.join("ms")).unwrap();
        let group = uuid::Uuid::new_v4().to_string();
        let manifest = serde_json::json!({"schemaVersion":2,"id":uuid::Uuid::new_v4().to_string(),"project":"Synthetic story","groups":[{"id":group,"title":"Organization only"}],"scenes":[
            {"id":uuid::Uuid::new_v4().to_string(),"title":"First","path":"ms/z.md","groupId":group},
            {"id":uuid::Uuid::new_v4().to_string(),"title":"Second","path":"ms/a.md","groupId":null}
        ]});
        fs::write(
            source.join("ms/manuscript.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            source.join("ms/z.md"),
            "# Scene heading stays\n\nFirst — exact.\n",
        )
        .unwrap();
        fs::write(source.join("ms/a.md"), "Second\r\n\r\nThe end.").unwrap();
        let parent = root.join("copies");
        fs::create_dir(&parent).unwrap();
        Self {
            repo: Repository::open(&source).unwrap(),
            recovery: RecoveryStore::open(root.join("recovery")).unwrap(),
            parent,
            temp,
        }
    }
    fn metadata(&self) -> PublishingMetadata {
        PublishingMetadata {
            title: "Synthetic story".into(),
            author: "Example Author".into(),
            rights: "Example Author retains all rights.".into(),
            language: "en-US".into(),
            formats: vec!["html".into(), "epub".into()],
            folder_name: "new-copy".into(),
            free_play_approved: true,
            no_cover_approved: true,
        }
    }
    fn plan(&self) -> PublishingPlan {
        self.repo
            .preview_publishing_copy(self.metadata(), &self.recovery)
            .unwrap()
    }
    fn write(&self, p: &PublishingPlan) -> Result<()> {
        self.repo
            .write_publishing_copy(p, &self.parent, &self.recovery, || Ok(()))
    }
    fn sources(&self) -> Vec<Vec<u8>> {
        ["ms/manuscript.json", "ms/z.md", "ms/a.md"]
            .iter()
            .map(|p| fs::read(self.repo.root().join(p)).unwrap())
            .collect()
    }
}
#[test]
fn exact_order_bytes_receipt_and_sources_survive_snapshot() {
    let f = Fixture::new();
    let before = f.sources();
    let p = f.plan();
    assert_eq!(
        p.preview
            .sources
            .iter()
            .map(|s| s.path.as_str())
            .collect::<Vec<_>>(),
        ["ms/z.md", "ms/a.md"]
    );
    let body = format!(
        "{}{}{}",
        String::from_utf8(before[1].clone()).unwrap(),
        SEPARATOR,
        String::from_utf8(before[2].clone()).unwrap()
    );
    assert!(p.preview.manuscript.ends_with(&body));
    assert!(p.preview.treatment.contains("groups add no chapters"));
    assert!(!p.preview.manuscript.contains("Organization only"));
    f.write(&p).unwrap();
    let output = f.parent.join("new-copy");
    assert_eq!(
        fs::read(output.join("manuscript.md")).unwrap(),
        p.preview.manuscript.as_bytes()
    );
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(output.join("source-receipt.json")).unwrap()).unwrap();
    assert_eq!(receipt["sourceRevision"], p.preview.source_revision);
    assert_eq!(
        receipt["manuscriptHash"],
        content_hash(&p.preview.manuscript)
    );
    assert_eq!(
        receipt["sources"][0]["contentHash"],
        content_hash(&String::from_utf8(before[1].clone()).unwrap())
    );
    assert_eq!(receipt["configHash"], content_hash(&p.preview.config));
    assert_eq!(f.sources(), before);
    assert_eq!(fs::read_dir(&f.parent).unwrap().count(), 1);
}
#[test]
fn title_and_author_cannot_introduce_assets_or_references() {
    let f = Fixture::new();
    let before = f.sources();
    for field in ["title", "author"] {
        for value in [
            "![Story](missing.png)",
            "[Story](https://example.invalid)",
            "[Story][ref]",
            "\\include{missing}",
        ] {
            let mut metadata = f.metadata();
            if field == "title" {
                metadata.title = value.into();
            } else {
                metadata.author = value.into();
            }
            assert!(
                matches!(
                    f.repo.preview_publishing_copy(metadata, &f.recovery),
                    Err(Error::PublishingText)
                ),
                "{field}: {value}"
            );
        }
    }
    assert_eq!(f.sources(), before);
    assert_eq!(fs::read_dir(&f.parent).unwrap().count(), 0);
}
#[test]
fn empty_nonempty_file_and_symlink_destinations_are_never_replaced() {
    // NOREPLACE must reject even an empty directory on both macOS and Linux;
    // plain rename would silently replace it on Unix.
    for kind in ["empty", "nonempty", "file", "symlink"] {
        let f = Fixture::new();
        let p = f.plan();
        let dest = f.parent.join("new-copy");
        match kind {
            "empty" => fs::create_dir(&dest).unwrap(),
            "nonempty" => {
                fs::create_dir(&dest).unwrap();
                fs::write(dest.join("sentinel"), b"old").unwrap();
            }
            "file" => fs::write(&dest, b"old").unwrap(),
            _ => std::os::unix::fs::symlink(f.repo.root(), &dest).unwrap(),
        }
        let sources = f.sources();
        assert_eq!(f.write(&p), Err(Error::PublishingDestination));
        assert_eq!(f.sources(), sources);
        assert_eq!(fs::read_dir(&f.parent).unwrap().count(), 1);
        if kind == "nonempty" {
            assert_eq!(fs::read(dest.join("sentinel")).unwrap(), b"old");
        }
        if kind == "file" {
            assert_eq!(fs::read(dest).unwrap(), b"old");
        }
    }
}
#[test]
fn stale_source_manifest_or_missing_scene_leaves_no_output() {
    for kind in ["source", "manifest", "missing"] {
        let f = Fixture::new();
        let p = f.plan();
        match kind {
            "source" => fs::write(f.repo.root().join("ms/a.md"), b"Changed").unwrap(),
            "manifest" => {
                let path = f.repo.root().join("ms/manuscript.json");
                let mut value: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                value["scenes"].as_array_mut().unwrap().reverse();
                fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            _ => fs::remove_file(f.repo.root().join("ms/a.md")).unwrap(),
        }
        let source = f.sources_after_optional_missing();
        assert!(f.write(&p).is_err());
        assert_eq!(f.sources_after_optional_missing(), source);
        assert_eq!(fs::read_dir(&f.parent).unwrap().count(), 0);
    }
}
impl Fixture {
    fn sources_after_optional_missing(&self) -> Vec<Option<Vec<u8>>> {
        ["ms/manuscript.json", "ms/z.md", "ms/a.md"]
            .iter()
            .map(|p| fs::read(self.repo.root().join(p)).ok())
            .collect()
    }
}
#[test]
fn unsupported_frontmatter_assets_references_and_invalid_metadata_stop_preview() {
    for text in [
        "---\ntitle: Scene\n---\nBody",
        "![cover](cover.png)",
        "[note]: notes.md",
        "<img src='x'>",
        "\\include{other}",
        "+++\ntitle='Scene'\n+++\nBody",
    ] {
        let f = Fixture::new();
        fs::write(f.repo.root().join("ms/z.md"), text).unwrap();
        let before = f.sources();
        assert!(matches!(
            f.repo.preview_publishing_copy(f.metadata(), &f.recovery),
            Err(Error::PublishingText)
        ));
        assert_eq!(f.sources(), before);
    }
    let f = Fixture::new();
    for field in ["imprint", "cover", "folder", "format", "author", "rights"] {
        let mut m = f.metadata();
        match field {
            "imprint" => m.free_play_approved = false,
            "cover" => m.no_cover_approved = false,
            "folder" => m.folder_name = "../overwrite".into(),
            "format" => m.formats = vec!["invented".into()],
            "author" => m.author.clear(),
            _ => m.rights.clear(),
        }
        assert!(matches!(
            f.repo.preview_publishing_copy(m, &f.recovery),
            Err(Error::PublishingMetadata)
        ));
    }
}
#[test]
fn pending_recovery_and_dirty_confirmation_preserve_source_and_prior_copies() {
    let f = Fixture::new();
    let p = f.plan();
    let before = f.sources();
    assert_eq!(
        f.repo
            .write_publishing_copy(&p, &f.parent, &f.recovery, || Err(Error::EditorChanged)),
        Err(Error::EditorChanged)
    );
    let mut calls = 0; // Inject late edit via Cell: the final pre-rename barrier must also run.
    let count = std::cell::Cell::new(0);
    assert_eq!(
        f.repo
            .write_publishing_copy(&p, &f.parent, &f.recovery, || {
                count.set(count.get() + 1);
                if count.get() > 1 {
                    Err(Error::EditorChanged)
                } else {
                    Ok(())
                }
            }),
        Err(Error::EditorChanged)
    );
    calls += count.get();
    assert_eq!(calls, 2);
    assert_eq!(fs::read_dir(&f.parent).unwrap().count(), 0);
    let doc = f.repo.read("ms/a.md").unwrap();
    f.recovery
        .stage(
            &f.repo,
            "ms/a.md",
            &doc.content_hash,
            "Unsaved synthetic edit",
        )
        .unwrap();
    assert_eq!(f.write(&p), Err(Error::PendingRecovery));
    assert!(matches!(
        f.repo.preview_publishing_copy(f.metadata(), &f.recovery),
        Err(Error::PendingRecovery)
    ));
    assert_eq!(f.sources(), before);
    assert_eq!(fs::read_dir(&f.parent).unwrap().count(), 0);
}
#[test]
fn unsafe_parent_and_scene_paths_and_source_destination_are_rejected() {
    let f = Fixture::new();
    let p = f.plan();
    let before = f.sources();
    assert_eq!(
        f.repo
            .write_publishing_copy(&p, f.repo.root(), &f.recovery, || Ok(())),
        Err(Error::PublishingDestination)
    );
    let link = f.temp.path().join("linked-parent");
    std::os::unix::fs::symlink(&f.parent, &link).unwrap();
    assert!(f
        .repo
        .write_publishing_copy(&p, &link, &f.recovery, || Ok(()))
        .is_err());
    fs::remove_file(f.repo.root().join("ms/a.md")).unwrap();
    std::os::unix::fs::symlink(f.parent.join("absent"), f.repo.root().join("ms/a.md")).unwrap();
    assert!(f
        .repo
        .preview_publishing_copy(f.metadata(), &f.recovery)
        .is_err());
    assert_eq!(fs::read(f.repo.root().join("ms/z.md")).unwrap(), before[1]);
}
