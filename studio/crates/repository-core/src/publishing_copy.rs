//! One-way, text-only ms snapshot. No publisher, source mutation or reverse sync.
use crate::{content_hash, Error, RecoveryStore, Repository, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[cfg(unix)]
use {
    rustix::fs::{mkdirat, openat, renameat_with, unlinkat, AtFlags, Mode, OFlags, RenameFlags},
    std::{fs::File, io::Write},
};

const LIMIT: usize = 8 * 1024 * 1024;
const SEPARATOR: &str = "\n\n---\n\n";
const TREATMENT: &str = "All declared ms scenes, in manifest order; groups add no chapters. Exact scene bytes joined by two newlines, --- and two newlines. No scene frontmatter or references supported. A generated title/byline precedes scene text so the existing Python CLI strips only that generated block. No source headings are stripped. No cover; explicitly approved FREE PLAY imprint. Source remains canonical; copies never synchronize.";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishingMetadata {
    pub title: String,
    pub author: String,
    pub rights: String,
    pub language: String,
    pub formats: Vec<String>,
    pub folder_name: String,
    pub free_play_approved: bool,
    pub no_cover_approved: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishingSource {
    pub id: String,
    pub title: String,
    pub path: String,
    pub content_hash: String,
    pub size_bytes: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishingPreview {
    pub id: String,
    pub source_revision: String,
    pub manifest_revision: String,
    pub sources: Vec<PublishingSource>,
    pub manuscript: String,
    pub config: String,
    pub treatment: String,
    pub folder_name: String,
}
#[derive(Debug, Clone)]
pub struct PublishingPlan {
    pub preview: PublishingPreview,
    metadata: PublishingMetadata,
}

impl PublishingPlan {
    pub fn confirmation_summary(&self) -> String {
        format!(
            "Title: {}\nAuthor: {}\nRights: {}\nFormats: {}",
            self.metadata.title,
            self.metadata.author,
            self.metadata.rights,
            self.metadata.formats.join(", ")
        )
    }
}

fn validate_metadata(m: &PublishingMetadata) -> Result<()> {
    // The existing publisher interpolates these into Markdown headings/bylines.
    // Apply the scene boundary here too; never introduce uncopied asset references.
    if !text_only(&m.title) || !text_only(&m.author) {
        return Err(Error::PublishingText);
    }
    let fields = [
        (&m.title, 200),
        (&m.author, 200),
        (&m.rights, 2000),
        (&m.language, 40),
    ];
    if fields.iter().any(|(v, max)| {
        v.trim().is_empty()
            || v.len() > *max
            || v.chars().any(|c| c.is_control() || c == '<' || c == '>')
    }) || !m.free_play_approved
        || !m.no_cover_approved
        || m.formats.is_empty()
        || m.formats.len() > 5
        || m.formats
            .iter()
            .any(|f| !["html", "epub", "pdf", "docx", "text"].contains(&f.as_str()))
        || m.formats
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != m.formats.len()
        || m.folder_name.is_empty()
        || m.folder_name.len() > 100
        || m.folder_name.starts_with('.')
        || m.folder_name
            .chars()
            .any(|c| c.is_control() || "/\\:".contains(c))
    {
        return Err(Error::PublishingMetadata);
    }
    Ok(())
}
fn text_only(text: &str) -> bool {
    let start = text.trim_start_matches('\u{feff}');
    !start.starts_with("---")
        && !start.starts_with("+++")
        && !text.contains(['[', '<', '\\'])
        && !text
            .to_lowercase()
            .split_whitespace()
            .collect::<String>()
            .contains("url(")
}
impl Repository {
    fn story_sources(&self) -> Result<(String, Vec<PublishingSource>, Vec<String>)> {
        self.require_clean_structure()?;
        let state = self.load_drafting()?;
        let manifest = state.revision.ok_or(Error::InvalidManifest)?;
        if state.scenes.is_empty() || !state.missing_paths.is_empty() {
            return Err(Error::InvalidManifest);
        }
        if state.scenes.len() > 256 {
            return Err(Error::LimitExceeded);
        }
        let mut sources = Vec::new();
        let mut texts = Vec::new();
        let mut size = 0;
        for scene in state.scenes {
            let doc = self.read(&scene.path)?;
            if doc.generated_compatibility {
                return Err(Error::ReadOnly);
            }
            size += doc.text.len();
            if size > LIMIT {
                return Err(Error::TooLarge);
            }
            sources.push(PublishingSource {
                id: scene.id,
                title: scene.title,
                path: scene.path,
                content_hash: doc.content_hash,
                size_bytes: doc.size_bytes,
            });
            texts.push(doc.text);
        }
        self.check_story_sources(&manifest, &sources)?;
        Ok((manifest, sources, texts))
    }
    fn check_story_sources(&self, manifest: &str, sources: &[PublishingSource]) -> Result<()> {
        self.require_clean_structure()?;
        if self.load_drafting()?.revision.as_deref() != Some(manifest) {
            return Err(Error::DraftingChanged);
        }
        for source in sources {
            if self.read(&source.path)?.content_hash != source.content_hash {
                return Err(Error::Conflict);
            }
        }
        Ok(())
    }
    pub fn story_revision(&self) -> Result<String> {
        let (manifest, sources, _) = self.story_sources()?;
        Ok(revision(&manifest, &sources))
    }
    pub fn clean_story_revision(&self, recovery: &RecoveryStore) -> Result<String> {
        let _gate = self.save_gate.lock().map_err(|_| Error::Io)?;
        let (manifest, sources, _) = self.story_sources()?;
        let paths = sources.iter().map(|s| s.path.clone()).collect::<Vec<_>>();
        recovery.with_clean_paths(self, &paths, || {
            self.check_story_sources(&manifest, &sources)?;
            Ok(revision(&manifest, &sources))
        })
    }
    pub fn preview_publishing_copy(
        &self,
        metadata: PublishingMetadata,
        recovery: &RecoveryStore,
    ) -> Result<PublishingPlan> {
        validate_metadata(&metadata)?;
        let _gate = self.save_gate.lock().map_err(|_| Error::Io)?;
        let (manifest, sources, texts) = self.story_sources()?;
        if texts.iter().any(|text| !text_only(text)) {
            return Err(Error::PublishingText);
        }
        let paths = sources.iter().map(|s| s.path.clone()).collect::<Vec<_>>();
        recovery.with_clean_paths(self, &paths, || {
            self.check_story_sources(&manifest, &sources)?;
            // JSON is a YAML subset accepted by the existing publisher, with safe quoting.
            let front = serde_json::json!({"title": metadata.title, "author": metadata.author, "rights": metadata.rights});
            let manuscript = format!("---\n{}\n---\n# {}\n*by {}*\n\n{}", serde_json::to_string(&front).map_err(|_| Error::Io)?, metadata.title, metadata.author, texts.join(SEPARATOR));
            let config = serde_json::to_string_pretty(&serde_json::json!({
                "manuscript": "manuscript.md", "imprint": "free-play", "cover": null,
                "source_format": "markdown", "chapters": false, "formats": metadata.formats, "output": "dist",
                "metadata": {"title": metadata.title, "author": metadata.author, "rights": metadata.rights, "language": metadata.language}
            })).map_err(|_| Error::Io)?;
            Ok(PublishingPlan {preview: PublishingPreview {id: uuid::Uuid::new_v4().to_string(), source_revision: revision(&manifest, &sources), manifest_revision: manifest, sources, manuscript, config, treatment: TREATMENT.into(), folder_name: metadata.folder_name.clone()}, metadata})
        })
    }
    /// Parent is chosen by the native host. New directory is exposed only after all
    /// staged files are synced. NOREPLACE also rejects collisions racing confirmation.
    #[cfg(unix)]
    pub fn write_publishing_copy(
        &self,
        plan: &PublishingPlan,
        parent: &Path,
        recovery: &RecoveryStore,
        clean_editor: impl Fn() -> Result<()>,
    ) -> Result<()> {
        let _gate = self.save_gate.lock().map_err(|_| Error::Io)?;
        validate_metadata(&plan.metadata)?;
        let destination = Repository::open(parent)?;
        if destination.root().starts_with(self.root()) {
            return Err(Error::PublishingDestination);
        }
        let paths = plan
            .preview
            .sources
            .iter()
            .map(|s| s.path.clone())
            .collect::<Vec<_>>();
        recovery.with_clean_paths(self, &paths, || {
            clean_editor()?;
            self.check_story_sources(&plan.preview.manifest_revision, &plan.preview.sources)?;
            let stage = format!(".heinlein-publishing-{}", uuid::Uuid::new_v4());
            mkdirat(&destination.fd, stage.as_str(), Mode::from_raw_mode(0o700)).map_err(crate::errno)?;
            let result = (|| {
                let directory = openat(&destination.fd, stage.as_str(), OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty()).map_err(crate::errno)?;
                let receipt = serde_json::to_vec_pretty(&serde_json::json!({
                    "schemaVersion": 1, "sourceProjectKey": self.project_key(), "manifestPath": "ms/manuscript.json",
                    "manifestRevision": plan.preview.manifest_revision, "sourceRevision": plan.preview.source_revision,
                    "sources": plan.preview.sources, "manuscriptHash": content_hash(&plan.preview.manuscript),
                    "configHash": content_hash(&plan.preview.config), "treatment": plan.preview.treatment,
                })).map_err(|_| Error::Io)?;
                for (name, bytes) in [("manuscript.md", plan.preview.manuscript.as_bytes()), ("heinlein.yaml", plan.preview.config.as_bytes()), ("source-receipt.json", receipt.as_slice())] {
                    let fd = openat(&directory, name, OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::from_raw_mode(0o600)).map_err(crate::errno)?;
                    let mut file = File::from(fd); file.write_all(bytes).map_err(|_| Error::Io)?; file.sync_all().map_err(|_| Error::Io)?;
                }
                File::from(directory).sync_all().map_err(|_| Error::Io)?;
                self.check_story_sources(&plan.preview.manifest_revision, &plan.preview.sources)?;
                clean_editor()?;
                renameat_with(&destination.fd, stage.as_str(), &destination.fd, plan.metadata.folder_name.as_str(), RenameFlags::NOREPLACE).map_err(|_| Error::PublishingDestination)?;
                File::from(rustix::io::dup(&destination.fd).map_err(crate::errno)?).sync_all().map_err(|_| Error::SaveUncertain)
            })();
            if result.is_err() {
                if let Ok(directory) = openat(&destination.fd, stage.as_str(), OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW, Mode::empty()) {
                    for name in ["manuscript.md", "heinlein.yaml", "source-receipt.json"] { let _ = unlinkat(&directory, name, AtFlags::empty()); }
                    let _ = unlinkat(&destination.fd, stage.as_str(), AtFlags::REMOVEDIR);
                }
            }
            result
        })
    }
}
fn revision(manifest: &str, sources: &[PublishingSource]) -> String {
    content_hash(&serde_json::to_string(&(manifest, sources)).expect("serializable source receipt"))
}
#[cfg(all(test, unix))]
#[path = "publishing_copy_tests.rs"]
mod tests;
