//! Synthetic end-to-end acceptance producer, exercised by the normal Python suite.
//! Usage: cargo run -p repository-core --example first_story_handoff -- NEW_TEMP_PATH [METADATA_JSON]
use repository_core::{PublishingMetadata, RecoveryStore, Repository};
use std::{fs, path::PathBuf};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let target = PathBuf::from(args.next().ok_or("Pass a new synthetic temporary folder")?);
    fs::create_dir(&target)?;
    let root = target.canonicalize()?;
    let source = root.join("source");
    fs::create_dir_all(source.join("ms"))?;
    let group = uuid::Uuid::new_v4().to_string();
    let manifest = serde_json::json!({"schemaVersion":2,"id":uuid::Uuid::new_v4().to_string(),"project":"Synthetic First Story","groups":[{"id":group,"title":"Organization only"}],"scenes":[
        {"id":uuid::Uuid::new_v4().to_string(),"title":"Opening","path":"ms/z-opening.md","groupId":group},
        {"id":uuid::Uuid::new_v4().to_string(),"title":"Ending","path":"ms/a-ending.md","groupId":null}
    ]});
    fs::write(
        source.join("ms/manuscript.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::write(
        source.join("ms/z-opening.md"),
        "# Scene opening\n\nFirst scene — exact words.\n",
    )?;
    fs::write(
        source.join("ms/a-ending.md"),
        "Second scene follows the first.\n\nTHE END.\n",
    )?;
    let repo = Repository::open(&source)?;
    let recovery = RecoveryStore::open(root.join("recovery"))?;
    let parent = root.join("copies");
    fs::create_dir(&parent)?;
    let metadata = if let Some(path) = args.next() {
        serde_json::from_slice(&fs::read(path)?)?
    } else {
        PublishingMetadata {
            title: "Synthetic First Story".into(),
            author: "Example Author".into(),
            rights: "Example Author retains all rights.".into(),
            language: "en-US".into(),
            formats: vec!["html".into(), "epub".into()],
            folder_name: "release".into(),
            free_play_approved: true,
            no_cover_approved: true,
        }
    };
    let plan = repo.preview_publishing_copy(metadata, &recovery)?;
    repo.write_publishing_copy(&plan, &parent, &recovery, || Ok(()))?;
    println!("{}", parent.join("release").display());
    Ok(())
}
