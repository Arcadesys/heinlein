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
const TREATMENT: &str = "All declared ms scenes, in manifest order; groups add no chapters. Exact scene bytes joined by two newlines, --- and two newlines. No scene frontmatter or references supported. A generated title/byline precedes scene text so the existing Python CLI strips only that generated block. No source headings are stripped. Source remains canonical; copies never synchronize.";
/// Largest cover image copied into a publishing copy.
pub const COVER_LIMIT: usize = 25 * 1024 * 1024;
// These lists mirror the Python publisher (heinlein/config.py). A value the
// publisher would reject never reaches heinlein.yaml.
pub const BOOK_STYLES: [&str; 2] = ["plain", "free-play"];
pub const PAGE_SIZES: [&str; 6] = ["digest", "trade", "small", "a5", "mass", "letter"];
pub const BOOK_FONTS: [&str; 7] = [
    "Lora",
    "Inter",
    "EB Garamond",
    "Crimson Pro",
    "Source Serif 4",
    "Libre Baskerville",
    "Atkinson Hyperlegible",
];
pub const COVER_CHOICES: [&str; 3] = ["typographic", "none", "image"];

/// Author-chosen book design, written into the copy's heinlein.yaml.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct BookDesign {
    pub style: String,
    pub page_size: String,
    pub large_print: bool,
    pub body_font: String,
    pub display_font: String,
    pub cover: String,
    pub copyright_page: bool,
    pub title_page: bool,
    pub subtitle: String,
    pub dedication: String,
}
impl Default for BookDesign {
    fn default() -> Self {
        Self {
            style: "plain".into(),
            page_size: "digest".into(),
            large_print: false,
            body_font: "Lora".into(),
            display_font: "Inter".into(),
            cover: "typographic".into(),
            copyright_page: true,
            title_page: true,
            subtitle: String::new(),
            dedication: String::new(),
        }
    }
}
impl BookDesign {
    pub fn summary(&self) -> String {
        let style = if self.style == "free-play" {
            "FREE PLAY Publishing branding"
        } else {
            "Plain style, no imprint branding"
        };
        let cover = match self.cover.as_str() {
            "image" => "cover image you chose",
            "none" => "no cover page",
            _ => "typographic cover",
        };
        format!(
            "{style}; {} page; {} body, {} headings{}; {cover}",
            self.page_size,
            self.body_font,
            self.display_font,
            if self.large_print {
                "; large print"
            } else {
                ""
            }
        )
    }
    fn dedication_lines(&self) -> Vec<String> {
        self.dedication
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishingMetadata {
    pub title: String,
    pub author: String,
    pub rights: String,
    pub language: String,
    pub formats: Vec<String>,
    pub folder_name: String,
    #[serde(default)]
    pub free_play_approved: bool,
    /// Legacy guide field from before cover choices; kept so saved guides load.
    #[serde(default)]
    pub no_cover_approved: bool,
    #[serde(default)]
    pub design: BookDesign,
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
    /// File name of the attached cover image, once one is attached.
    pub cover_file: Option<String>,
    pub design_summary: String,
}
#[derive(Debug, Clone)]
pub struct PublishingPlan {
    pub preview: PublishingPreview,
    metadata: PublishingMetadata,
    cover: Option<Vec<u8>>,
}

impl PublishingPlan {
    pub fn confirmation_summary(&self) -> String {
        format!(
            "Title: {}\nAuthor: {}\nRights: {}\nFormats: {}\nDesign: {}",
            self.metadata.title,
            self.metadata.author,
            self.metadata.rights,
            self.metadata.formats.join(", "),
            self.metadata.design.summary()
        )
    }
    pub fn needs_cover_image(&self) -> bool {
        self.metadata.design.cover == "image"
    }
    /// Attach the author's chosen cover. Only JPEG and PNG are copied, and only
    /// when the design asks for an image cover.
    pub fn attach_cover(&mut self, bytes: Vec<u8>) -> Result<()> {
        if !self.needs_cover_image() {
            return Err(Error::PublishingMetadata);
        }
        let name = cover_file_name(&bytes).ok_or(Error::PublishingCover)?;
        self.preview.config = config_json(&self.metadata, Some(name))?;
        self.preview.cover_file = Some(name.into());
        self.cover = Some(bytes);
        Ok(())
    }
}
fn cover_file_name(bytes: &[u8]) -> Option<&'static str> {
    if bytes.is_empty() || bytes.len() > COVER_LIMIT {
        None
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("cover.jpg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("cover.png")
    } else {
        None
    }
}
fn config_json(m: &PublishingMetadata, cover: Option<&str>) -> Result<String> {
    let d = &m.design;
    let mut metadata = serde_json::json!({"title": m.title, "author": m.author, "rights": m.rights, "language": m.language});
    if !d.subtitle.trim().is_empty() {
        metadata["subtitle"] = d.subtitle.trim().into();
    }
    let dedication = d.dedication_lines();
    if !dedication.is_empty() {
        metadata["dedication"] = dedication.into();
    }
    // JSON is a YAML subset accepted by the existing publisher, with safe quoting.
    serde_json::to_string_pretty(&serde_json::json!({
        "manuscript": "manuscript.md", "imprint": d.style, "cover": cover,
        "source_format": "markdown", "chapters": false, "formats": m.formats, "output": "dist",
        "page": {"size": d.page_size, "large_print": d.large_print},
        "fonts": {"body": d.body_font, "display": d.display_font},
        "front_matter": {"cover": d.cover != "none", "copyright": d.copyright_page, "title_page": d.title_page},
        "metadata": metadata
    }))
    .map_err(|_| Error::Io)
}
fn validate_design(d: &BookDesign) -> bool {
    let plain = |v: &str, max: usize, newlines: bool| {
        v.len() <= max
            && text_only(v)
            && !v
                .chars()
                .any(|c| (c.is_control() && !(newlines && c == '\n')) || c == '<' || c == '>')
    };
    BOOK_STYLES.contains(&d.style.as_str())
        && PAGE_SIZES.contains(&d.page_size.as_str())
        && BOOK_FONTS.contains(&d.body_font.as_str())
        && BOOK_FONTS.contains(&d.display_font.as_str())
        && COVER_CHOICES.contains(&d.cover.as_str())
        && plain(&d.subtitle, 200, false)
        && plain(&d.dedication, 1000, true)
}

fn validate_metadata(m: &PublishingMetadata) -> Result<()> {
    // The existing publisher interpolates these into Markdown headings/bylines.
    // Apply the scene boundary here too; never introduce uncopied asset references.
    if !text_only(&m.title) || !text_only(&m.author) {
        return Err(Error::PublishingText);
    }
    if !validate_design(&m.design) {
        return Err(Error::PublishingMetadata);
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
    }) || (m.design.style == "free-play" && !m.free_play_approved)
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
        let scenes: Vec<_> = state
            .scenes
            .into_iter()
            .filter(|scene| !scene.reference)
            .collect();
        if scenes.is_empty() || !state.missing_paths.is_empty() {
            return Err(Error::InvalidManifest);
        }
        if scenes.len() > 256 {
            return Err(Error::LimitExceeded);
        }
        let mut sources = Vec::new();
        let mut texts = Vec::new();
        let mut size = 0;
        for scene in scenes {
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
            let config = config_json(&metadata, None)?;
            let design_summary = metadata.design.summary();
            Ok(PublishingPlan {preview: PublishingPreview {id: uuid::Uuid::new_v4().to_string(), source_revision: revision(&manifest, &sources), manifest_revision: manifest, sources, manuscript, config, treatment: format!("{TREATMENT} Design: {design_summary}."), folder_name: metadata.folder_name.clone(), cover_file: None, design_summary}, metadata, cover: None})
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
        // An image cover must be attached, and nothing else may carry one.
        let cover = match (&plan.cover, &plan.preview.cover_file) {
            (Some(bytes), Some(name))
                if plan.needs_cover_image() && cover_file_name(bytes) == Some(name.as_str()) =>
            {
                Some((name.as_str(), bytes.as_slice()))
            }
            (None, None) if !plan.needs_cover_image() => None,
            _ => return Err(Error::PublishingCover),
        };
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
                    "cover": cover.map(|(name, bytes)| serde_json::json!({"file": name, "sha256": sha256_hex(bytes), "sizeBytes": bytes.len()})),
                })).map_err(|_| Error::Io)?;
                let mut files = vec![("manuscript.md", plan.preview.manuscript.as_bytes()), ("heinlein.yaml", plan.preview.config.as_bytes()), ("source-receipt.json", receipt.as_slice())];
                if let Some(cover) = cover { files.push(cover); }
                for (name, bytes) in files {
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
                    for name in ["manuscript.md", "heinlein.yaml", "source-receipt.json", "cover.jpg", "cover.png"] { let _ = unlinkat(&directory, name, AtFlags::empty()); }
                    let _ = unlinkat(&destination.fd, stage.as_str(), AtFlags::REMOVEDIR);
                }
            }
            result
        })
    }
}
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
fn revision(manifest: &str, sources: &[PublishingSource]) -> String {
    content_hash(&serde_json::to_string(&(manifest, sources)).expect("serializable source receipt"))
}
#[cfg(all(test, unix))]
#[path = "publishing_copy_tests.rs"]
mod tests;
