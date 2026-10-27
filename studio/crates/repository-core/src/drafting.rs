//! Explicit ms/ membership, stable scene identity, and guarded structural transactions.
//! Plans and external bytes stay in the native host. Renderer approval selects an opaque ID.
use crate::{
    content_hash, join, parent, parts, Error, RecoveryStore, Repository, Result, MAX_FILE_BYTES,
    MAX_MANIFEST_BYTES,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
#[cfg(unix)]
use {
    crate::errno,
    rustix::fs::{
        flock, mkdirat, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags,
    },
    std::{fs::File, io::Write, os::unix::fs::MetadataExt},
};

const MANIFEST: &str = "ms/manuscript.json";
const JOURNAL: &str = ".heinlein-drafting-transaction.json";
const MAX_BATCH_BYTES: usize = 32 * 1024 * 1024;
const MAX_BATCH_FILES: usize = 256;
const MAX_JOURNAL_BYTES: u64 = 2 * MAX_BATCH_BYTES as u64 * 6 + MAX_MANIFEST_BYTES * 12;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftingScene {
    pub id: String,
    pub title: String,
    pub path: String,
    pub group_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftingGroup {
    pub id: String,
    pub title: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub id: String,
    pub project: String,
    pub groups: Vec<DraftingGroup>,
    pub scenes: Vec<DraftingScene>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftingState {
    pub manifest_path: String,
    pub revision: Option<String>,
    pub project: String,
    pub groups: Vec<DraftingGroup>,
    pub scenes: Vec<DraftingScene>,
    pub untracked_paths: Vec<String>,
    pub missing_paths: Vec<String>,
    pub recovery_required: bool,
    pub group_move_issue: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SceneDestination {
    Before {
        scene_id: String,
        group_id: Option<String>,
    },
    After {
        scene_id: String,
        group_id: Option<String>,
    },
    GroupEnd {
        group_id: String,
    },
    UngroupedEnd {},
}
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DraftingChange {
    Initialize {
        project: String,
    },
    CreateScene {
        title: String,
        path: String,
        group_id: Option<String>,
        before_id: Option<String>,
    },
    SplitScene {
        scene_id: String,
        path: String,
        title: String,
        expected_hash: String,
        byte_offset: usize,
    },
    CreateGroup {
        title: String,
    },
    MoveScene {
        scene_id: String,
        path: String,
        group_id: Option<String>,
        before_id: Option<String>,
    },
    ReorderScene {
        scene_id: String,
        before_id: Option<String>,
        group_id: Option<String>,
    },
    PlaceScene {
        scene_id: String,
        destination: SceneDestination,
    },
    ReorderGroup {
        group_id: String,
        before_group_id: Option<String>,
    },
    ImportRepository {
        paths: Vec<String>,
        destination: String,
        mode: String,
        group_id: Option<String>,
        before_id: Option<String>,
    },
    ImportExternal {
        selection_id: String,
        destination: String,
        group_id: Option<String>,
        before_id: Option<String>,
    },
    Reconcile {},
    MigrateLegacy {
        manifest_path: String,
        project: String,
    },
    RecoverInterrupted {},
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftingChangeView {
    pub kind: String,
    pub source: Option<String>,
    pub destination: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftingPreview {
    pub id: String,
    pub summary: String,
    pub changes: Vec<DraftingChangeView>,
    pub warnings: Vec<String>,
}
/// Exact standalone snapshot supplied by trusted native placement authority.
#[derive(Debug, Clone)]
pub struct LiteralScene {
    pub id: String,
    pub title: String,
    pub path: String,
    pub text: String,
}
/// Only constructed by the native host from an OS-authorized file selection/drop.
#[derive(Debug, Clone)]
pub struct DraftingExternalFile {
    name: String,
    text: String,
    selected_path: PathBuf,
}
impl DraftingExternalFile {
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn size_bytes(&self) -> usize {
        self.text.len()
    }
    pub fn read_selected(path: &Path) -> Result<Self> {
        let directory = path.parent().ok_or(Error::InvalidPath)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(Error::InvalidPath)?;
        validate_markdown(name)?;
        let source = Repository::open(directory)?;
        source.check_write_manifests(name)?;
        // Parent authority metadata can classify a selected compatibility source.
        for ancestor in directory.ancestors().skip(1) {
            let root = Repository::open(ancestor)?;
            let relative = path
                .strip_prefix(ancestor)
                .map_err(|_| Error::InvalidPath)?;
            let relative = relative.to_str().ok_or(Error::InvalidPath)?;
            root.check_write_manifests(relative)?;
        }
        let doc = source.read(name)?;
        if doc.generated_compatibility {
            return Err(Error::ReadOnly);
        }
        Ok(Self {
            name: name.into(),
            text: doc.text,
            selected_path: path.to_path_buf(),
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Bytes {
    pub(crate) text: String,
    pub(crate) mode: u32,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Edit {
    pub(crate) path: String,
    pub(crate) before: Option<Bytes>,
    pub(crate) after: Option<Bytes>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    schema_version: u32,
    repository_key: String,
    id: String,
    edits: Vec<Edit>,
}
/// Not serializable: only the exact native-held preview can be applied.
#[derive(Debug, Clone)]
pub struct DraftingPlan {
    pub preview: DraftingPreview,
    repository_key: String,
    before_manifest: Option<String>,
    before_members: Vec<String>,
    edits: Vec<Edit>,
    read_guards: Vec<(String, String)>,
    recovery_paths: Vec<String>,
    recovery_journal_hash: Option<String>,
    external_guards: Vec<DraftingExternalFile>,
}
#[derive(Debug, Clone)]
pub struct DraftingUndo {
    pub id: String,
    plan: DraftingPlan,
    available: bool,
}
impl DraftingUndo {
    /// Reapplying an interrupted partial transaction is never an undo option.
    pub fn is_available(&self) -> bool {
        self.available
    }
}
fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn title(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(Error::InvalidManifest);
    }
    Ok(())
}
fn markdown(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown")
    )
}
fn validate_markdown(path: &str) -> Result<()> {
    parts(path)?;
    if !markdown(path) {
        return Err(Error::ReadOnly);
    }
    Ok(())
}
fn scene_path(path: &str) -> Result<()> {
    validate_markdown(path)?;
    if !path.starts_with("ms/") {
        return Err(Error::InvalidPath);
    }
    Ok(())
}
fn destination(path: &str) -> Result<String> {
    let path = path.strip_suffix('/').unwrap_or(path);
    parts(path)?;
    if path != "ms" && !path.starts_with("ms/") {
        return Err(Error::InvalidPath);
    }
    Ok(path.into())
}
/// Conservative syntax guard, not a complete Markdown/Pandoc asset resolver.
/// Reject ambiguous link-capable syntax instead of rewriting source or breaking assets.
fn reference_bearing(text: &str) -> bool {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let compact: String = text
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if text.starts_with("+++")
        || text.contains('[')
        || text.contains('<')
        || compact.contains("url(")
    {
        return true;
    }
    if let Some(frontmatter) = crate::frontmatter(text) {
        for line in frontmatter.lines() {
            if let Some((key, _)) = line.split_once(':') {
                let key = key.trim().trim_matches(['\'', '"']).to_ascii_lowercase();
                if [
                    "image",
                    "cover",
                    "logo",
                    "font",
                    "bibliograph",
                    "csl",
                    "css",
                    "resource",
                    "include",
                    "template",
                    "filter",
                    "link",
                    "file",
                    "path",
                    "asset",
                    "header",
                ]
                .iter()
                .any(|part| key.contains(part))
                {
                    return true;
                }
            }
        }
    }
    false
}
fn validate_manifest(value: &Manifest) -> Result<()> {
    if value.schema_version != 2
        || uuid::Uuid::parse_str(&value.id).is_err()
        || value.scenes.len() + value.groups.len() > crate::MAX_MANUSCRIPT_ITEMS
    {
        return Err(Error::InvalidManifest);
    }
    title(&value.project)?;
    let mut ids = HashSet::new();
    for group in &value.groups {
        if uuid::Uuid::parse_str(&group.id).is_err() || !ids.insert(group.id.clone()) {
            return Err(Error::InvalidManifest);
        }
        title(&group.title)?;
    }
    let groups = ids.clone();
    let mut paths = HashSet::new();
    for scene in &value.scenes {
        title(&scene.title)?;
        scene_path(&scene.path)?;
        if uuid::Uuid::parse_str(&scene.id).is_err()
            || !ids.insert(scene.id.clone())
            || !paths.insert(scene.path.to_lowercase())
            || scene.group_id.as_ref().is_some_and(|g| !groups.contains(g))
        {
            return Err(Error::InvalidManifest);
        }
    }
    Ok(())
}
/// Validate a GitHub incoming schema-v2 candidate without writing any files.
pub fn parse_workspace_manifest(text: &str) -> Result<Manifest> {
    if text.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(Error::TooLarge);
    }
    let manifest: Manifest = serde_json::from_str(text).map_err(|_| Error::InvalidManifest)?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}
fn manifest_text(value: &Manifest) -> Result<String> {
    validate_manifest(value)?;
    let text = serde_json::to_string_pretty(value).map_err(|_| Error::InvalidManifest)? + "\n";
    if text.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(text)
}
fn scene_title(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn insert_scene(
    manifest: &mut Manifest,
    scene: DraftingScene,
    before: &Option<String>,
) -> Result<()> {
    if scene
        .group_id
        .as_ref()
        .is_some_and(|id| !manifest.groups.iter().any(|g| &g.id == id))
    {
        return Err(Error::InvalidManifest);
    }
    let index = match before {
        Some(id) => manifest
            .scenes
            .iter()
            .position(|s| &s.id == id)
            .ok_or(Error::DraftingChanged)?,
        None => manifest.scenes.len(),
    };
    manifest.scenes.insert(index, scene);
    Ok(())
}
fn group_order_issue(manifest: &Manifest) -> Option<String> {
    let mut encountered = Vec::new();
    for group in &manifest.groups {
        let positions: Vec<_> = manifest
            .scenes
            .iter()
            .enumerate()
            .filter(|(_, s)| s.group_id.as_deref() == Some(&group.id))
            .map(|(i, _)| i)
            .collect();
        if let (Some(first), Some(last)) = (positions.first(), positions.last()) {
            if last - first + 1 != positions.len() {
                let gap = manifest.scenes[*first..=*last]
                    .iter()
                    .find(|s| s.group_id.as_deref() != Some(&group.id))
                    .unwrap();
                return Some(format!("“{}” is interrupted by “{}” ({}). Use Move scene to arrange scenes explicitly; no group was normalized.", group.title, gap.title,
                    gap.group_id.as_ref().and_then(|id| manifest.groups.iter().find(|g| &g.id == id)).map(|g| g.title.as_str()).unwrap_or("No chapter")));
            }
        }
    }
    for scene in &manifest.scenes {
        if let Some(id) = &scene.group_id {
            if encountered.last() != Some(id) {
                encountered.push(id.clone());
            }
        }
    }
    let expected: Vec<_> = manifest
        .groups
        .iter()
        .filter(|g| {
            manifest
                .scenes
                .iter()
                .any(|s| s.group_id.as_ref() == Some(&g.id))
        })
        .map(|g| g.id.clone())
        .collect();
    if encountered != expected {
        let names = |ids: &[String]| {
            ids.iter()
                .filter_map(|id| manifest.groups.iter().find(|g| &g.id == id))
                .map(|g| format!("“{}”", g.title))
                .collect::<Vec<_>>()
                .join(" → ")
        };
        return Some(format!("Group slots ({}) differ from reading order ({}). Use Move scene to arrange scenes explicitly; no group was normalized.", names(&expected), names(&encountered)));
    }
    None
}
fn next_group_anchor(manifest: &Manifest, id: &str) -> Result<Option<String>> {
    let slot = manifest
        .groups
        .iter()
        .position(|g| g.id == id)
        .ok_or(Error::DraftingChanged)?;
    if group_order_issue(manifest).is_some() {
        return Err(Error::DraftingGroupOrder);
    }
    Ok(manifest.groups[slot + 1..].iter().find_map(|g| {
        manifest
            .scenes
            .iter()
            .find(|s| s.group_id.as_ref() == Some(&g.id))
            .map(|s| s.id.clone())
    }))
}
fn group_name(manifest: &Manifest, id: Option<&str>) -> String {
    id.and_then(|id| manifest.groups.iter().find(|g| g.id == id))
        .map(|g| g.title.clone())
        .unwrap_or_else(|| "No chapter".into())
}
fn move_preview(plan: &mut DraftingPlan, manifest: &Manifest, moved: &[DraftingScene]) {
    let names = |scenes: &[DraftingScene]| {
        scenes
            .iter()
            .map(|s| format!("{} [{}]", s.title, s.id))
            .collect::<Vec<_>>()
            .join(" → ")
    };
    plan.preview.warnings.push(format!(
        "Moved scenes: {}. Scene text, filenames and identities stay unchanged.",
        if moved.is_empty() {
            "none (empty group)".into()
        } else {
            names(moved)
        }
    ));
    plan.preview.warnings.push(format!(
        "Exact reading order after this move: {}",
        names(&manifest.scenes)
    ));
    if let (Some(first), Some(last)) = (moved.first(), moved.last()) {
        let a = manifest
            .scenes
            .iter()
            .position(|s| s.id == first.id)
            .unwrap();
        let b = manifest
            .scenes
            .iter()
            .position(|s| s.id == last.id)
            .unwrap();
        plan.preview.warnings.push(format!(
            "The moved scenes follow {} and precede {}. Ungrouped scenes are not group cargo.",
            a.checked_sub(1)
                .map(|i| format!("“{}” [{}]", manifest.scenes[i].title, manifest.scenes[i].id))
                .unwrap_or_else(|| "the document beginning".into()),
            manifest
                .scenes
                .get(b + 1)
                .map(|s| format!("“{}” [{}]", s.title, s.id))
                .unwrap_or_else(|| "the document end".into())
        ));
    }
}
// Offsets are measured in the persisted UTF-8 bytes, including frontmatter.
// Leading metadata stays on the original scene; malformed metadata fails closed.
fn validate_split_offset(text: &str, offset: usize) -> Result<()> {
    if offset == 0
        || offset >= text.len()
        || !text.is_char_boundary(offset)
        || (text.as_bytes()[offset - 1] == b'\r' && text.as_bytes()[offset] == b'\n')
    {
        return Err(Error::InvalidManifest);
    }
    let mut position = 0;
    let mut opening = true;
    let mut metadata = false;
    while position < text.len() {
        let start = position;
        while position < text.len() && !matches!(text.as_bytes()[position], b'\r' | b'\n') {
            position += 1;
        }
        let line = &text[start..position];
        if position < text.len() {
            let cr = text.as_bytes()[position] == b'\r';
            position += 1;
            if cr && text.as_bytes().get(position) == Some(&b'\n') {
                position += 1;
            }
        }
        if opening {
            opening = false;
            metadata = line
                .trim_start_matches('\u{feff}')
                .trim_end_matches([' ', '\t'])
                == "---";
            if !metadata {
                break;
            }
        } else if matches!(line.trim_end_matches([' ', '\t']), "---" | "...") {
            if offset <= position {
                return Err(Error::InvalidManifest);
            }
            metadata = false;
            break;
        }
    }
    if metadata {
        return Err(Error::InvalidManifest);
    }
    Ok(())
}

// Existing journals only create/delete Markdown. Permit replacement exclusively
// for a lossless split (or its inverse), tied to the matching index transition.
fn validate_split_journal(journal: &Journal) -> Result<()> {
    let invalid = || Error::UntrustedTransaction;
    if journal.edits.len() != 3 {
        return Err(invalid());
    }
    let index = journal
        .edits
        .iter()
        .find(|e| e.path == MANIFEST)
        .ok_or_else(invalid)?;
    let mut before: Manifest =
        serde_json::from_str(&index.before.as_ref().ok_or_else(invalid)?.text)
            .map_err(|_| invalid())?;
    let mut after: Manifest = serde_json::from_str(&index.after.as_ref().ok_or_else(invalid)?.text)
        .map_err(|_| invalid())?;
    let inverse = before.scenes.len() > after.scenes.len();
    if inverse {
        std::mem::swap(&mut before, &mut after);
    }
    let source = journal
        .edits
        .iter()
        .find(|e| e.path != MANIFEST && e.before.is_some() && e.after.is_some())
        .ok_or_else(invalid)?;
    let target = journal
        .edits
        .iter()
        .find(|e| e.path != MANIFEST && e.path != source.path)
        .ok_or_else(invalid)?;
    let (whole, prefix, absent, suffix) = if inverse {
        (&source.after, &source.before, &target.after, &target.before)
    } else {
        (&source.before, &source.after, &target.before, &target.after)
    };
    let whole = whole.as_ref().ok_or_else(invalid)?;
    let prefix = prefix.as_ref().ok_or_else(invalid)?;
    let suffix = suffix.as_ref().ok_or_else(invalid)?;
    if absent.is_some()
        || whole.mode != prefix.mode
        || suffix.mode != whole.mode
        || whole.text.len() != prefix.text.len() + suffix.text.len()
        || !whole.text.starts_with(&prefix.text)
        || !whole.text.ends_with(&suffix.text)
        || validate_split_offset(&whole.text, prefix.text.len()).is_err()
    {
        return Err(invalid());
    }
    let position = before
        .scenes
        .iter()
        .position(|s| s.path == source.path)
        .ok_or_else(invalid)?;
    let new = after.scenes.get(position + 1).ok_or_else(invalid)?;
    if new.path != target.path
        || new.group_id != before.scenes[position].group_id
        || before.scenes.iter().any(|s| s.id == new.id)
    {
        return Err(invalid());
    }
    after.scenes.remove(position + 1);
    if before.scenes != after.scenes
        || before.groups != after.groups
        || before.id != after.id
        || before.project != after.project
    {
        return Err(invalid());
    }
    Ok(())
}
fn validate_journal(journal: &Journal, repository_key: &str) -> Result<()> {
    if journal.schema_version != 1
        || journal.repository_key != repository_key
        || uuid::Uuid::parse_str(&journal.id).is_err()
        || journal.edits.len() > MAX_BATCH_FILES * 2 + 1
    {
        return Err(Error::UntrustedTransaction);
    }
    if journal
        .edits
        .iter()
        .any(|e| e.path != MANIFEST && e.before.is_some() && e.after.is_some())
    {
        validate_split_journal(journal)?;
    }
    let mut paths = HashSet::new();
    let mut total = 0usize;
    for edit in &journal.edits {
        parts(&edit.path)?;
        if !paths.insert(&edit.path) {
            return Err(Error::UntrustedTransaction);
        }
        if edit.path == MANIFEST {
            if edit.before.is_none() && edit.after.is_none() {
                return Err(Error::UntrustedTransaction);
            }
        } else {
            validate_markdown(&edit.path)?;
            if edit.before.is_none() && edit.after.is_none() {
                return Err(Error::UntrustedTransaction);
            }
        }
        for bytes in [&edit.before, &edit.after].into_iter().flatten() {
            if bytes.mode & !0o777 != 0
                || bytes
                    .text
                    .bytes()
                    .any(|b| b == 0 || (b < 32 && !matches!(b, 9 | 10 | 13)))
            {
                return Err(Error::UntrustedTransaction);
            }
            let limit = if edit.path == MANIFEST {
                MAX_MANIFEST_BYTES
            } else {
                MAX_FILE_BYTES
            };
            if bytes.text.len() as u64 > limit {
                return Err(Error::TooLarge);
            }
            if edit.path == MANIFEST {
                let value: Manifest =
                    serde_json::from_str(&bytes.text).map_err(|_| Error::UntrustedTransaction)?;
                validate_manifest(&value)?;
            } else {
                total += bytes.text.len();
            }
        }
    }
    if total > MAX_BATCH_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(())
}
impl Repository {
    pub(crate) fn require_clean_structure(&self) -> Result<()> {
        match self.handle(JOURNAL, true) {
            Ok(_) => Err(Error::DraftingPending),
            Err(Error::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }
    fn drafting_manifest(&self) -> Result<(Option<Manifest>, Option<String>)> {
        self.allowed(MANIFEST, false)?;
        match self.raw(MANIFEST, MAX_MANIFEST_BYTES, false) {
            Ok(text) => {
                let value: Manifest =
                    serde_json::from_str(&text).map_err(|_| Error::InvalidManifest)?;
                validate_manifest(&value)?;
                for scene in &value.scenes {
                    self.allowed(&scene.path, false)?;
                }
                Ok((Some(value), Some(text)))
            }
            Err(Error::NotFound) => Ok((None, None)),
            Err(e) => Err(e),
        }
    }
    fn drafting_members(&self) -> Result<Vec<String>> {
        match self.handle("ms", false) {
            Err(Error::NotFound) => return Ok(vec![]),
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        let mut paths = vec![];
        let mut pending: Vec<String> = vec!["ms".into()];
        let mut count = 0;
        while let Some(directory) = pending.pop() {
            for entry in self.list(&directory)? {
                count += 1;
                if count > crate::MAX_SCAN {
                    return Err(Error::LimitExceeded);
                }
                if entry.kind == "directory" {
                    pending.push(entry.path);
                } else if markdown(&entry.path) {
                    self.check_write_manifests(&entry.path)?;
                    paths.push(entry.path);
                }
            }
        }
        paths.sort();
        Ok(paths)
    }
    pub fn load_drafting(&self) -> Result<DraftingState> {
        let (manifest, text) = self.drafting_manifest()?;
        let members = self.drafting_members()?;
        let scenes = manifest
            .as_ref()
            .map_or_else(Vec::new, |m| m.scenes.clone());
        let tracked: HashSet<_> = scenes.iter().map(|s| s.path.as_str()).collect();
        let actual: HashSet<_> = members.iter().map(String::as_str).collect();
        let recovery_required = match self.handle(JOURNAL, true) {
            Ok(_) => true,
            Err(Error::NotFound) => false,
            Err(e) => return Err(e),
        };
        Ok(DraftingState {
            manifest_path: MANIFEST.into(),
            revision: text.as_deref().map(content_hash),
            project: manifest
                .as_ref()
                .map_or_else(|| self.name(), |m| m.project.clone()),
            groups: manifest
                .as_ref()
                .map_or_else(Vec::new, |m| m.groups.clone()),
            untracked_paths: members
                .iter()
                .filter(|p| !tracked.contains(p.as_str()))
                .cloned()
                .collect(),
            missing_paths: scenes
                .iter()
                .filter(|s| !actual.contains(s.path.as_str()))
                .map(|s| s.path.clone())
                .collect(),
            scenes,
            recovery_required,
            group_move_issue: manifest.as_ref().and_then(group_order_issue),
        })
    }
    pub fn preview_drafting(
        &self,
        expected_revision: Option<&str>,
        change: DraftingChange,
        external: &[DraftingExternalFile],
        recovery: &RecoveryStore,
    ) -> Result<DraftingPlan> {
        self.preview_drafting_inner(expected_revision, change, external, recovery, None)
    }
    /// Native retained standalone text, never a pretend OS-selected external file.
    pub fn preview_literal_scene(
        &self,
        expected_revision: Option<&str>,
        project: Option<String>,
        scene: LiteralScene,
        recovery: &RecoveryStore,
    ) -> Result<DraftingPlan> {
        if uuid::Uuid::parse_str(&scene.id).is_err() {
            return Err(Error::InvalidManifest);
        }
        let change = match project {
            Some(project) => DraftingChange::Initialize { project },
            None => DraftingChange::CreateScene {
                title: scene.title.clone(),
                path: scene.path.clone(),
                group_id: None,
                before_id: None,
            },
        };
        self.preview_drafting_inner(expected_revision, change, &[], recovery, Some(scene))
    }
    fn preview_drafting_inner(
        &self,
        expected_revision: Option<&str>,
        change: DraftingChange,
        external: &[DraftingExternalFile],
        recovery: &RecoveryStore,
        literal: Option<LiteralScene>,
    ) -> Result<DraftingPlan> {
        let _gate = self.save_gate.lock().map_err(|_| Error::Io)?;
        let state = self.load_drafting()?;
        if state.revision.as_deref() != expected_revision {
            return Err(Error::DraftingChanged);
        }
        if matches!(change, DraftingChange::RecoverInterrupted {}) {
            return self.preview_interrupted(recovery);
        }
        if state.recovery_required {
            return Err(Error::DraftingPending);
        }
        let (existing, before_manifest) = self.drafting_manifest()?;
        let members = self.drafting_members()?;
        let mut manifest = existing.clone().unwrap_or(Manifest {
            schema_version: 2,
            id: uuid(),
            project: self.name(),
            groups: vec![],
            scenes: vec![],
        });
        if existing.is_none()
            && !matches!(
                change,
                DraftingChange::Initialize { .. } | DraftingChange::MigrateLegacy { .. }
            )
        {
            return Err(Error::InvalidManifest);
        }
        if existing.is_some()
            && matches!(
                change,
                DraftingChange::Initialize { .. } | DraftingChange::MigrateLegacy { .. }
            )
        {
            return Err(Error::DraftingCollision);
        }
        if (!state.untracked_paths.is_empty() || !state.missing_paths.is_empty())
            && !matches!(
                change,
                DraftingChange::Reconcile {} | DraftingChange::Initialize { .. }
            )
        {
            return Err(Error::DraftingChanged);
        }
        let mut plan = DraftingPlan {
            preview: DraftingPreview {
                id: uuid(),
                summary: String::new(),
                changes: vec![],
                warnings: vec![],
            },
            repository_key: self.project_key(),
            before_manifest,
            before_members: members.clone(),
            edits: vec![],
            read_guards: vec![],
            recovery_paths: vec![],
            recovery_journal_hash: None,
            external_guards: vec![],
        };
        match change {
            DraftingChange::Initialize { project } => {
                title(&project)?;
                manifest.project = project;
                self.reconcile_members(&mut manifest, &members, &mut plan)?;
                if let Some(scene) = &literal {
                    title(&scene.title)?;
                    scene_path(&scene.path)?;
                    self.add_new_file(&mut plan, &scene.path, scene.text.clone(), None)?;
                    insert_scene(
                        &mut manifest,
                        DraftingScene {
                            id: scene.id.clone(),
                            title: scene.title.clone(),
                            path: scene.path.clone(),
                            group_id: None,
                        },
                        &None,
                    )?;
                }
                plan.preview.summary = "Create the manuscript index for ms/".into();
            }
            DraftingChange::CreateScene {
                title: name,
                path,
                group_id,
                before_id,
            } => {
                title(&name)?;
                scene_path(&path)?;
                let before_id = if before_id.is_none()
                    && group_id.as_ref().is_some_and(|id| {
                        !manifest
                            .scenes
                            .iter()
                            .any(|s| s.group_id.as_ref() == Some(id))
                    }) {
                    next_group_anchor(&manifest, group_id.as_deref().unwrap())?
                } else {
                    before_id
                };
                self.add_new_file(
                    &mut plan,
                    &path,
                    literal.as_ref().map(|s| s.text.clone()).unwrap_or_default(),
                    None,
                )?;
                insert_scene(
                    &mut manifest,
                    DraftingScene {
                        id: literal.as_ref().map(|s| s.id.clone()).unwrap_or_else(uuid),
                        title: name,
                        path,
                        group_id,
                    },
                    &before_id,
                )?;
                plan.preview.summary = "Create an empty Markdown scene".into();
            }
            DraftingChange::SplitScene {
                scene_id,
                path,
                title: name,
                expected_hash,
                byte_offset,
            } => {
                title(&name)?;
                scene_path(&path)?;
                let index = manifest
                    .scenes
                    .iter()
                    .position(|s| s.id == scene_id)
                    .ok_or(Error::DraftingChanged)?;
                let scene = manifest.scenes[index].clone();
                self.allowed(&scene.path, false)?;
                self.check_write_manifests(&scene.path)?;
                self.refuse_legacy_scene_move(&scene.path)?;
                let before = self.snapshot(&scene.path)?.ok_or(Error::NotFound)?;
                if content_hash(&before.text) != expected_hash {
                    return Err(Error::DraftingChanged);
                }
                if before.mode & 0o222 == 0 {
                    return Err(Error::Denied);
                }
                validate_split_offset(&before.text, byte_offset)?;
                if parent(&scene.path) != parent(&path) && reference_bearing(&before.text) {
                    return Err(Error::AssetReferences);
                }
                let prefix = before.text[..byte_offset].to_owned();
                let suffix = before.text[byte_offset..].to_owned();
                self.add_new_file(&mut plan, &path, suffix, None)?;
                plan.edits
                    .last_mut()
                    .ok_or(Error::Io)?
                    .after
                    .as_mut()
                    .ok_or(Error::Io)?
                    .mode = before.mode;
                plan.edits.push(Edit {
                    path: scene.path.clone(),
                    after: Some(Bytes {
                        text: prefix,
                        mode: before.mode,
                    }),
                    before: Some(before),
                });
                plan.recovery_paths.push(scene.path.clone());
                plan.preview.changes.push(DraftingChangeView {
                    kind: "split".into(),
                    source: Some(scene.path),
                    destination: Some(path.clone()),
                });
                manifest.scenes.insert(
                    index + 1,
                    DraftingScene {
                        id: uuid(),
                        title: name,
                        path,
                        group_id: scene.group_id,
                    },
                );
                plan.preview.summary =
                    "Split a scene at the selected byte boundary, preserving every source byte"
                        .into();
                plan.preview.warnings.push("Frontmatter stays on the original scene and is not copied. The new scene contains the exact suffix. Review Markdown fences, reference definitions, and links across the split; they are not rewritten.".into());
            }
            DraftingChange::CreateGroup { title: name } => {
                title(&name)?;
                manifest.groups.push(DraftingGroup {
                    id: uuid(),
                    title: name,
                });
                plan.preview.summary = "Create an optional scene group".into();
            }
            DraftingChange::ReorderScene {
                scene_id,
                before_id,
                group_id,
            } => {
                let before_id = if before_id.is_none()
                    && group_id.as_ref().is_some_and(|id| {
                        !manifest
                            .scenes
                            .iter()
                            .any(|s| s.group_id.as_ref() == Some(id))
                    }) {
                    next_group_anchor(&manifest, group_id.as_deref().unwrap())?
                } else {
                    before_id
                };
                let index = manifest
                    .scenes
                    .iter()
                    .position(|s| s.id == scene_id)
                    .ok_or(Error::DraftingChanged)?;
                if before_id.as_deref() == Some(&scene_id) {
                    return Err(Error::InvalidManifest);
                }
                let mut scene = manifest.scenes.remove(index);
                scene.group_id = group_id;
                plan.recovery_paths.push(scene.path.clone());
                plan.preview.changes.push(DraftingChangeView {
                    kind: "reorder".into(),
                    source: Some(scene.path.clone()),
                    destination: Some(scene.path.clone()),
                });
                insert_scene(&mut manifest, scene, &before_id)?;
                plan.preview.summary = "Change scene order or group".into();
            }
            DraftingChange::ReorderGroup {
                group_id,
                before_group_id,
            } => {
                let source = manifest
                    .groups
                    .iter()
                    .position(|g| g.id == group_id)
                    .ok_or(Error::DraftingChanged)?;
                let mut groups = manifest.groups.clone();
                if before_group_id.as_deref() == Some(&group_id) {
                    plan.preview.summary = "No change to group position".into();
                    return Ok(plan);
                }
                let group = groups.remove(source);
                let slot = match &before_group_id {
                    Some(id) => groups
                        .iter()
                        .position(|g| &g.id == id)
                        .ok_or(Error::DraftingChanged)?,
                    None => groups.len(),
                };
                groups.insert(slot, group.clone());
                if groups == manifest.groups {
                    plan.preview.summary = "No change to group position".into();
                    return Ok(plan);
                }
                if group_order_issue(&manifest).is_some() {
                    return Err(Error::DraftingGroupOrder);
                }
                let moved: Vec<_> = manifest
                    .scenes
                    .iter()
                    .filter(|s| s.group_id.as_deref() == Some(&group_id))
                    .cloned()
                    .collect();
                manifest.groups = groups;
                manifest
                    .scenes
                    .retain(|s| s.group_id.as_deref() != Some(&group_id));
                let anchor = next_group_anchor(&manifest, &group_id)?;
                for scene in &moved {
                    let doc = self.read(&scene.path)?;
                    if doc.generated_compatibility {
                        return Err(Error::ReadOnly);
                    }
                    plan.read_guards
                        .push((scene.path.clone(), doc.content_hash));
                    plan.recovery_paths.push(scene.path.clone());
                    insert_scene(&mut manifest, scene.clone(), &anchor)?;
                }
                plan.preview.summary = format!(
                    "Move “{}” and its {} scenes to the reviewed group slot",
                    group.title,
                    moved.len()
                );
                plan.preview.warnings.push(format!(
                    "Group slots after move: {}. Empty groups add no source text.",
                    manifest
                        .groups
                        .iter()
                        .map(|g| format!("{} [{}]", g.title, g.id))
                        .collect::<Vec<_>>()
                        .join(" → ")
                ));
                if moved.is_empty() {
                    let next = anchor
                        .as_ref()
                        .and_then(|id| manifest.scenes.iter().find(|s| &s.id == id));
                    plan.preview.warnings.push(format!("This empty group changes metadata only. A later scene will be inserted before {}; ungrouped scenes stay in their own reading positions.", next.map(|s|format!("“{}” [{}]",s.title,s.id)).unwrap_or_else(||"the document end".into())));
                }
                move_preview(&mut plan, &manifest, &moved);
            }
            DraftingChange::PlaceScene {
                scene_id,
                destination,
            } => {
                let before = manifest.scenes.clone();
                let source = before
                    .iter()
                    .position(|s| s.id == scene_id)
                    .ok_or(Error::DraftingChanged)?;
                let mut scene = before[source].clone();
                let previous_group = group_name(&manifest, scene.group_id.as_deref());
                let is_after = matches!(&destination, SceneDestination::After { .. });
                let (membership, anchor) = match destination {
                    SceneDestination::Before {
                        scene_id: target,
                        group_id,
                    }
                    | SceneDestination::After {
                        scene_id: target,
                        group_id,
                    } => {
                        let target_scene = before
                            .iter()
                            .find(|s| s.id == target)
                            .ok_or(Error::DraftingChanged)?;
                        if target_scene.group_id != group_id {
                            return Err(Error::DraftingChanged);
                        }
                        if target == scene_id {
                            plan.preview.summary = "No change to scene position".into();
                            return Ok(plan);
                        }
                        // Resolve after-removal positions natively, never trust a renderer offset.
                        let after = is_after;
                        manifest.scenes.remove(source);
                        let index = manifest
                            .scenes
                            .iter()
                            .position(|s| s.id == target)
                            .ok_or(Error::DraftingChanged)?;
                        (
                            group_id,
                            if after {
                                manifest.scenes.get(index + 1).map(|s| s.id.clone())
                            } else {
                                Some(target)
                            },
                        )
                    }
                    SceneDestination::GroupEnd { group_id } => {
                        if !manifest.groups.iter().any(|g| g.id == group_id) {
                            return Err(Error::DraftingChanged);
                        }
                        if scene.group_id.as_deref() == Some(&group_id)
                            && before
                                .iter()
                                .filter(|s| s.group_id.as_deref() == Some(&group_id))
                                .count()
                                == 1
                        {
                            plan.preview.summary = "No change to scene position".into();
                            return Ok(plan);
                        }
                        let was_empty = !before
                            .iter()
                            .any(|s| s.group_id.as_deref() == Some(&group_id));
                        if was_empty && group_order_issue(&manifest).is_some() {
                            return Err(Error::DraftingGroupOrder);
                        }
                        manifest.scenes.remove(source);
                        let anchor = if was_empty {
                            next_group_anchor(&manifest, &group_id)?
                        } else {
                            manifest
                                .scenes
                                .iter()
                                .rposition(|s| s.group_id.as_deref() == Some(&group_id))
                                .and_then(|i| manifest.scenes.get(i + 1))
                                .map(|s| s.id.clone())
                        };
                        (Some(group_id), anchor)
                    }
                    SceneDestination::UngroupedEnd {} => {
                        manifest.scenes.remove(source);
                        (None, None)
                    }
                };
                scene.group_id = membership;
                insert_scene(&mut manifest, scene.clone(), &anchor)?;
                if manifest.scenes == before {
                    plan.preview.summary = "No change to scene position".into();
                    return Ok(plan);
                }
                let doc = self.read(&scene.path)?;
                if doc.generated_compatibility {
                    return Err(Error::ReadOnly);
                }
                plan.read_guards
                    .push((scene.path.clone(), doc.content_hash));
                plan.recovery_paths.push(scene.path.clone());
                plan.preview.summary = format!(
                    "Move “{}” from “{}” to “{}”",
                    scene.title,
                    previous_group,
                    group_name(&manifest, scene.group_id.as_deref())
                );
                move_preview(&mut plan, &manifest, &[scene]);
            }
            DraftingChange::MoveScene {
                scene_id,
                path,
                before_id,
                group_id,
            } => {
                let before_id = if before_id.is_none()
                    && group_id.as_ref().is_some_and(|id| {
                        !manifest
                            .scenes
                            .iter()
                            .any(|s| s.group_id.as_ref() == Some(id))
                    }) {
                    next_group_anchor(&manifest, group_id.as_deref().unwrap())?
                } else {
                    before_id
                };
                scene_path(&path)?;
                let index = manifest
                    .scenes
                    .iter()
                    .position(|s| s.id == scene_id)
                    .ok_or(Error::DraftingChanged)?;
                if before_id.as_deref() == Some(&scene_id) {
                    return Err(Error::InvalidManifest);
                }
                let mut scene = manifest.scenes.remove(index);
                if scene.path != path {
                    self.transfer(&mut plan, &scene.path, &path, true)?;
                }
                scene.path = path;
                scene.group_id = group_id;
                plan.recovery_paths.push(scene.path.clone());
                insert_scene(&mut manifest, scene, &before_id)?;
                plan.preview.summary =
                    "Move a scene, preserving its identity and exact bytes".into();
            }
            DraftingChange::ImportRepository {
                paths,
                destination: dir,
                mode,
                group_id,
                before_id,
            } => {
                if mode != "move" && mode != "copy" {
                    return Err(Error::InvalidManifest);
                }
                if paths.is_empty() || paths.len() > MAX_BATCH_FILES {
                    return Err(Error::LimitExceeded);
                }
                let dir = destination(&dir)?;
                let mut seen = HashSet::new();
                for path in paths {
                    if !seen.insert(path.clone()) {
                        return Err(Error::DraftingCollision);
                    }
                    let name = parts(&path)?.pop().ok_or(Error::InvalidPath)?.to_owned();
                    let target = join(&dir, &name)?;
                    if path == target {
                        return Err(Error::DraftingCollision);
                    }
                    self.transfer(&mut plan, &path, &target, mode == "move")?;
                    let scene = if mode == "move" {
                        if let Some(index) = manifest.scenes.iter().position(|s| s.path == path) {
                            let mut scene = manifest.scenes.remove(index);
                            scene.path = target;
                            scene.group_id = group_id.clone();
                            scene
                        } else {
                            DraftingScene {
                                id: uuid(),
                                title: scene_title(&target),
                                path: target,
                                group_id: group_id.clone(),
                            }
                        }
                    } else {
                        DraftingScene {
                            id: uuid(),
                            title: scene_title(&target),
                            path: target,
                            group_id: group_id.clone(),
                        }
                    };
                    insert_scene(&mut manifest, scene, &before_id)?;
                }
                plan.preview.summary = format!(
                    "{} repository scenes into ms/",
                    if mode == "move" { "Move" } else { "Copy" }
                );
            }
            DraftingChange::ImportExternal {
                selection_id: _,
                destination: dir,
                group_id,
                before_id,
            } => {
                let dir = destination(&dir)?;
                if external.is_empty() || external.len() > MAX_BATCH_FILES {
                    return Err(Error::LimitExceeded);
                }
                for source in external {
                    if reference_bearing(&source.text) {
                        return Err(Error::AssetReferences);
                    }
                    plan.external_guards.push(source.clone());
                    let target = join(&dir, &source.name)?;
                    self.add_new_file(
                        &mut plan,
                        &target,
                        source.text.clone(),
                        Some(source.name.clone()),
                    )?;
                    insert_scene(
                        &mut manifest,
                        DraftingScene {
                            id: uuid(),
                            title: scene_title(&target),
                            path: target,
                            group_id: group_id.clone(),
                        },
                        &before_id,
                    )?;
                }
                plan.preview.summary = "Copy selected external Markdown files into ms/".into();
                plan.preview.warnings.push("External originals stay unchanged. Imports use exact bytes captured by the native file selection.".into());
            }
            DraftingChange::Reconcile {} => {
                self.reconcile_members(&mut manifest, &members, &mut plan)?;
                plan.preview.summary =
                    "Update manuscript membership from the Markdown files in ms/".into();
            }
            DraftingChange::MigrateLegacy {
                manifest_path,
                project,
            } => {
                if !members.is_empty() {
                    return Err(Error::DraftingCollision);
                }
                title(&project)?;
                manifest.project = project;
                let legacy = self.manuscript(&manifest_path)?;
                let raw = self.raw(&manifest_path, MAX_MANIFEST_BYTES, false)?;
                plan.read_guards.push((manifest_path, content_hash(&raw)));
                for volume in legacy.volumes {
                    for chapter in volume.chapters {
                        let group = DraftingGroup {
                            id: uuid(),
                            title: format!("{} / {}", volume.title, chapter.title),
                        };
                        title(&group.title)?;
                        for scene in chapter.scenes {
                            let target = join("ms", &scene.path)?;
                            self.transfer(&mut plan, &scene.path, &target, false)?;
                            manifest.scenes.push(DraftingScene {
                                id: uuid(),
                                title: scene_title(&target),
                                path: target,
                                group_id: Some(group.id.clone()),
                            });
                        }
                        manifest.groups.push(group);
                    }
                }
                plan.preview.summary =
                    "Copy legacy scenes to ms/ in their existing manuscript order".into();
                plan.preview.warnings.push("Legacy scene-manifest.json, source scenes and generated compatibility documents stay unchanged.".into());
            }
            DraftingChange::RecoverInterrupted {} => unreachable!(),
        }
        let after = manifest_text(&manifest)?;
        let before = self.snapshot(MANIFEST)?;
        if before.as_ref().map(|b| &b.text) != Some(&after) {
            let mode = before.as_ref().map_or(0o600, |b| b.mode);
            plan.edits.push(Edit {
                path: MANIFEST.into(),
                before,
                after: Some(Bytes { text: after, mode }),
            });
            plan.preview.changes.push(DraftingChangeView {
                kind: "index".into(),
                source: plan.before_manifest.as_ref().map(|_| MANIFEST.into()),
                destination: Some(MANIFEST.into()),
            });
        }
        self.check_plan_limits(&plan)?;
        recovery.with_clean_paths(self, &plan.recovery_paths, || Ok(()))?;
        Ok(plan)
    }
    fn reconcile_members(
        &self,
        manifest: &mut Manifest,
        members: &[String],
        plan: &mut DraftingPlan,
    ) -> Result<()> {
        let actual: HashSet<_> = members.iter().map(String::as_str).collect();
        for scene in &manifest.scenes {
            if !actual.contains(scene.path.as_str()) {
                plan.recovery_paths.push(scene.path.clone());
                plan.preview.changes.push(DraftingChangeView {
                    kind: "unindex".into(),
                    source: Some(scene.path.clone()),
                    destination: None,
                });
            }
        }
        manifest.scenes.retain(|s| actual.contains(s.path.as_str()));
        for path in members {
            if !manifest.scenes.iter().any(|s| &s.path == path) {
                let doc = self.read(path)?;
                plan.read_guards.push((path.clone(), doc.content_hash));
                plan.recovery_paths.push(path.clone());
                manifest.scenes.push(DraftingScene {
                    id: uuid(),
                    title: scene_title(path),
                    path: path.clone(),
                    group_id: None,
                });
                plan.preview.changes.push(DraftingChangeView {
                    kind: "index".into(),
                    source: Some(path.clone()),
                    destination: Some(path.clone()),
                });
            }
        }
        Ok(())
    }
    fn add_new_file(
        &self,
        plan: &mut DraftingPlan,
        path: &str,
        text: String,
        source: Option<String>,
    ) -> Result<()> {
        scene_path(path)?;
        self.allowed(path, false)?;
        self.check_write_manifests(path)?;
        if self.snapshot(path)?.is_some()
            || plan.edits.iter().any(|e| e.path.eq_ignore_ascii_case(path))
            || plan
                .before_members
                .iter()
                .any(|p| p.eq_ignore_ascii_case(path))
        {
            return Err(Error::DraftingCollision);
        }
        self.check_case_collision(path)?;
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(Error::TooLarge);
        }
        if source.is_some()
            && !plan
                .preview
                .warnings
                .iter()
                .any(|w| w.starts_with("Linked assets"))
        {
            plan.preview.warnings.push("Linked assets are not copied or rewritten. Relative Markdown, HTML, CSS and frontmatter references may break at the new location; review and resolve those paths before applying. Links elsewhere to moved filenames also need review.".into());
        }
        plan.edits.push(Edit {
            path: path.into(),
            before: None,
            after: Some(Bytes { text, mode: 0o600 }),
        });
        plan.recovery_paths.push(path.into());
        plan.preview.changes.push(DraftingChangeView {
            kind: if source.is_some() { "copy" } else { "create" }.into(),
            source,
            destination: Some(path.into()),
        });
        Ok(())
    }
    fn transfer(
        &self,
        plan: &mut DraftingPlan,
        source: &str,
        target: &str,
        moving: bool,
    ) -> Result<()> {
        validate_markdown(source)?;
        self.allowed(source, false)?;
        self.check_write_manifests(source)?;
        if moving {
            self.refuse_legacy_scene_move(source)?;
        }
        let before = self.snapshot(source)?.ok_or(Error::NotFound)?;
        if parent(source) != parent(target) && reference_bearing(&before.text) {
            return Err(Error::AssetReferences);
        }
        self.add_new_file(plan, target, before.text.clone(), Some(source.into()))?;
        plan.read_guards
            .push((source.into(), content_hash(&before.text)));
        plan.recovery_paths.push(source.into());
        if moving {
            if before.mode & 0o222 == 0 {
                return Err(Error::Denied);
            }
            if let Some(view) = plan.preview.changes.last_mut() {
                view.kind = "move".into();
            }
            if let Some(edit) = plan.edits.last_mut() {
                edit.after.as_mut().ok_or(Error::Io)?.mode = before.mode;
            }
            plan.edits.push(Edit {
                path: source.into(),
                before: Some(before),
                after: None,
            });
        }
        Ok(())
    }
    fn refuse_legacy_scene_move(&self, path: &str) -> Result<()> {
        let mut base = parent(path);
        loop {
            match self.raw(
                &join(base, "scene-manifest.json")?,
                MAX_MANIFEST_BYTES,
                true,
            ) {
                Ok(text) => {
                    let raw: crate::RawManifest =
                        serde_json::from_str(&text).map_err(|_| Error::InvalidManifest)?;
                    if raw.schema_version != 1 {
                        return Err(Error::InvalidManifest);
                    }
                    if raw
                        .volumes
                        .iter()
                        .flat_map(|v| &v.chapters)
                        .flat_map(|c| &c.scenes)
                        .any(|s| join(base, s).as_deref() == Ok(path))
                    {
                        return Err(Error::LegacySceneMove);
                    }
                }
                Err(Error::NotFound) => {}
                Err(e) => return Err(e),
            }
            if base.is_empty() {
                break;
            }
            base = parent(base);
        }
        Ok(())
    }
    fn check_plan_limits(&self, plan: &DraftingPlan) -> Result<()> {
        if plan.edits.len() > MAX_BATCH_FILES * 2 + 1 {
            return Err(Error::LimitExceeded);
        }
        let bytes: usize = plan
            .edits
            .iter()
            .filter(|e| e.path != MANIFEST)
            .map(|e| {
                e.before.as_ref().map_or(0, |b| b.text.len())
                    + e.after.as_ref().map_or(0, |b| b.text.len())
            })
            .sum();
        if bytes > MAX_BATCH_BYTES {
            return Err(Error::TooLarge);
        }
        Ok(())
    }
    fn check_case_collision(&self, path: &str) -> Result<()> {
        let mut base = String::new();
        for component in parts(path)? {
            match self.list(&base) {
                Ok(entries) => {
                    if entries
                        .iter()
                        .any(|e| e.name.eq_ignore_ascii_case(component) && e.name != component)
                    {
                        return Err(Error::DraftingCollision);
                    }
                }
                Err(Error::NotFound) => return Ok(()),
                Err(e) => return Err(e),
            }
            base = join(&base, component)?;
        }
        Ok(())
    }
    pub(crate) fn snapshot(&self, path: &str) -> Result<Option<Bytes>> {
        let max = if path == MANIFEST {
            MAX_MANIFEST_BYTES
        } else {
            MAX_FILE_BYTES
        };
        match self.raw(path, max, false) {
            Ok(text) => {
                #[cfg(unix)]
                let mode = self
                    .handle(path, false)?
                    .metadata()
                    .map_err(|_| Error::Io)?
                    .mode()
                    & 0o777;
                #[cfg(not(unix))]
                let mode = 0o600;
                Ok(Some(Bytes { text, mode }))
            }
            Err(Error::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn verify_plan(&self, plan: &DraftingPlan) -> Result<()> {
        if plan.repository_key != self.project_key() {
            return Err(Error::DraftingChanged);
        }
        let (_, text) = self.drafting_manifest()?;
        if text != plan.before_manifest || self.drafting_members()? != plan.before_members {
            return Err(Error::DraftingChanged);
        }
        for source in &plan.external_guards {
            let current = DraftingExternalFile::read_selected(&source.selected_path)?;
            if current.name != source.name || current.text != source.text {
                return Err(Error::DraftingChanged);
            }
        }
        for (path, hash) in &plan.read_guards {
            let max = if path.ends_with("scene-manifest.json") {
                MAX_MANIFEST_BYTES
            } else {
                MAX_FILE_BYTES
            };
            if content_hash(&self.raw(path, max, false)?) != *hash {
                return Err(Error::DraftingChanged);
            }
        }
        for edit in &plan.edits {
            if self.snapshot(&edit.path)? != edit.before {
                return Err(Error::DraftingChanged);
            }
            self.allowed(&edit.path, false)?;
            if edit.path != MANIFEST {
                self.check_write_manifests(&edit.path)?;
            }
            if edit.path != MANIFEST && edit.before.is_some() {
                self.refuse_legacy_scene_move(&edit.path)?;
            }
        }
        Ok(())
    }
    pub fn apply_drafting(
        &self,
        plan: &DraftingPlan,
        recovery: &RecoveryStore,
    ) -> Result<DraftingUndo> {
        let _gate = self.save_gate.lock().map_err(|_| Error::Io)?;
        recovery.with_clean_paths(self, &plan.recovery_paths, || {
            self.apply_drafting_locked(plan, recovery)
        })
    }
    pub fn undo_drafting(
        &self,
        undo: &DraftingUndo,
        recovery: &RecoveryStore,
    ) -> Result<DraftingState> {
        if !undo.available {
            return Err(Error::DraftingChanged);
        }
        self.apply_drafting(&undo.plan, recovery)?;
        self.load_drafting()
    }
    #[cfg(unix)]
    fn apply_drafting_locked(
        &self,
        plan: &DraftingPlan,
        recovery: &RecoveryStore,
    ) -> Result<DraftingUndo> {
        // Independent descriptor needed: flock locks belong to open-file descriptions.
        let fd = openat(
            &self.fd,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(errno)?;
        let root = File::from(fd);
        flock(&root, FlockOperation::NonBlockingLockExclusive)
            .map_err(|_| Error::DraftingChanged)?;
        struct Unlock(File);
        impl Drop for Unlock {
            fn drop(&mut self) {
                let _ = flock(&self.0, FlockOperation::Unlock);
            }
        }
        let _lock = Unlock(root);
        self.verify_plan(plan)?;
        if plan.edits.is_empty() && plan.recovery_journal_hash.is_none() {
            match self.handle(JOURNAL, true) {
                Ok(_) => return Err(Error::DraftingPending),
                Err(Error::NotFound) => {
                    return Ok(DraftingUndo {
                        id: plan.preview.id.clone(),
                        plan: plan.clone(),
                        available: false,
                    })
                }
                Err(error) => return Err(error),
            }
        }
        if let Some(hash) = &plan.recovery_journal_hash {
            recovery.verify_structure_receipt_locked(self, hash)?;
            if content_hash(&self.raw(JOURNAL, MAX_JOURNAL_BYTES, true)?) != *hash {
                return Err(Error::DraftingChanged);
            }
            for edit in &plan.edits {
                self.write_transition(edit)?;
            }
            self.remove_journal()?;
            recovery.clear_structure_receipt_locked(self)?;
        } else {
            match self.handle(JOURNAL, true) {
                Ok(_) => return Err(Error::DraftingPending),
                Err(Error::NotFound) => {}
                Err(e) => return Err(e),
            }
            let journal = Journal {
                schema_version: 1,
                repository_key: self.project_key(),
                id: plan.preview.id.clone(),
                edits: plan
                    .edits
                    .iter()
                    .filter(|e| e.before != e.after)
                    .cloned()
                    .collect(),
            };
            self.write_journal(&journal, recovery)?;
            let result = (|| {
                for (index, edit) in plan.edits.iter().enumerate() {
                    self.write_transition(edit)?;
                    #[cfg(test)]
                    if FAIL_AFTER_EDIT.with(|slot| slot.get()) == Some(index + 1) {
                        return Err(Error::Io);
                    }
                    #[cfg(not(test))]
                    let _ = index;
                }
                Ok(())
            })();
            if let Err(error) = result {
                let mut rollback_ok = true;
                for edit in plan.edits.iter().rev() {
                    match self.snapshot(&edit.path) {
                        Ok(current) if current == edit.after && current != edit.before => {
                            if self
                                .write_transition(&Edit {
                                    path: edit.path.clone(),
                                    before: edit.after.clone(),
                                    after: edit.before.clone(),
                                })
                                .is_err()
                            {
                                rollback_ok = false;
                            }
                        }
                        Ok(current) if current == edit.before => {}
                        _ => rollback_ok = false,
                    }
                }
                if rollback_ok && self.remove_journal().is_ok() {
                    recovery.clear_structure_receipt_locked(self)?;
                    return Err(error);
                }
                return Err(Error::DraftingUncertain);
            }
            self.remove_journal()?;
            recovery.clear_structure_receipt_locked(self)?;
        }
        let (_, text) = self
            .drafting_manifest()
            .map_err(|_| Error::DraftingUncertain)?;
        let mut inverse = plan.clone();
        inverse.preview.id = uuid();
        inverse.preview.summary = "Undo the last manuscript structure change".into();
        inverse.before_manifest = text;
        inverse.before_members = self
            .drafting_members()
            .map_err(|_| Error::DraftingUncertain)?;
        inverse.read_guards.clear();
        inverse.external_guards.clear();
        inverse.recovery_journal_hash = None;
        inverse.edits = plan
            .edits
            .iter()
            .rev()
            .map(|e| Edit {
                path: e.path.clone(),
                before: e.after.clone(),
                after: e.before.clone(),
            })
            .collect();
        Ok(DraftingUndo {
            id: uuid(),
            plan: inverse,
            available: plan.recovery_journal_hash.is_none(),
        })
    }
    #[cfg(not(unix))]
    fn apply_drafting_locked(
        &self,
        _plan: &DraftingPlan,
        _recovery: &RecoveryStore,
    ) -> Result<DraftingUndo> {
        Err(Error::UnsupportedPlatform)
    }
    fn preview_interrupted(&self, recovery: &RecoveryStore) -> Result<DraftingPlan> {
        let text = self.raw(JOURNAL, MAX_JOURNAL_BYTES, true)?;
        recovery.verify_structure_receipt(self, &content_hash(&text))?;
        let journal: Journal = serde_json::from_str(&text).map_err(|_| Error::DraftingUncertain)?;
        validate_journal(&journal, &self.project_key())?;
        let (_, before_manifest) = self.drafting_manifest()?;
        let mut plan = DraftingPlan {
            preview: DraftingPreview {
                id: uuid(),
                summary: "Roll back the interrupted manuscript change".into(),
                changes: vec![],
                warnings: vec![
                    "Rollback only proceeds if every affected file still matches recorded bytes."
                        .into(),
                ],
            },
            repository_key: self.project_key(),
            before_manifest,
            before_members: self.drafting_members()?,
            edits: vec![],
            read_guards: vec![],
            recovery_paths: vec![],
            recovery_journal_hash: Some(content_hash(&text)),
            external_guards: vec![],
        };
        let mut seen = HashSet::new();
        for edit in journal.edits.iter().rev() {
            self.allowed(&edit.path, false)?;
            if edit.path != MANIFEST {
                validate_markdown(&edit.path)?;
                plan.recovery_paths.push(edit.path.clone());
            }
            if !seen.insert(edit.path.clone()) {
                return Err(Error::DraftingUncertain);
            }
            let current = self.snapshot(&edit.path)?;
            if current != edit.before && current != edit.after {
                return Err(Error::DraftingChanged);
            }
            plan.preview.changes.push(DraftingChangeView {
                kind: "rollback".into(),
                source: current.as_ref().map(|_| edit.path.clone()),
                destination: edit.before.as_ref().map(|_| edit.path.clone()),
            });
            plan.edits.push(Edit {
                path: edit.path.clone(),
                before: current,
                after: edit.before.clone(),
            });
        }
        self.check_plan_limits(&plan)?;
        recovery.with_clean_paths(self, &plan.recovery_paths, || Ok(()))?;
        Ok(plan)
    }
    #[cfg(unix)]
    fn ensure_directory(&self, path: &str) -> Result<File> {
        let mut base = String::new();
        let mut held = self.handle("", false)?;
        for component in parts(path)? {
            base = join(&base, component)?;
            self.allowed(&base, true)?;
            match openat(
                &held,
                component,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Ok(fd) => held = fd.into(),
                Err(rustix::io::Errno::NOENT) => {
                    mkdirat(&held, component, Mode::from_bits_truncate(0o700)).map_err(errno)?;
                    held.sync_all().map_err(|_| Error::Io)?;
                    held = openat(
                        &held,
                        component,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(errno)?
                    .into();
                }
                Err(e) => return Err(errno(e)),
            }
        }
        Ok(held)
    }
    #[cfg(unix)]
    pub(crate) fn write_transition(&self, edit: &Edit) -> Result<()> {
        if self.snapshot(&edit.path)? != edit.before {
            return Err(Error::DraftingChanged);
        }
        if edit.before == edit.after {
            return Ok(());
        }
        self.allowed(&edit.path, false)?;
        if edit.path != MANIFEST {
            self.check_write_manifests(&edit.path)?;
        }
        let directory = if edit.after.is_some() {
            self.ensure_directory(parent(&edit.path))?
        } else {
            self.handle(parent(&edit.path), false)?
        };
        let name = parts(&edit.path)?.pop().ok_or(Error::InvalidPath)?;
        if let Some(after) = &edit.after {
            let temporary = format!(".heinlein-structure-{}.tmp", uuid());
            let fd = openat(
                &directory,
                temporary.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(errno)?;
            let mut file = File::from(fd);
            let result = (|| {
                file.write_all(after.text.as_bytes())
                    .map_err(|_| Error::Io)?;
                // Journal validation restricts these bits to 0o777. mode_t is
                // u16 on macOS and u32 on Linux; both preserve every allowed bit.
                rustix::fs::fchmod(&file, Mode::from_bits_truncate(after.mode as _))
                    .map_err(errno)?;
                file.sync_all().map_err(|_| Error::Io)?;
                self.check_directory_identity(parent(&edit.path), &directory)?;
                if self.snapshot(&edit.path)? != edit.before {
                    return Err(Error::DraftingChanged);
                }
                if let Some(before) = &edit.before {
                    if before.mode & 0o222 == 0 {
                        return Err(Error::Denied);
                    }
                    renameat(&directory, temporary.as_str(), &directory, name).map_err(errno)?;
                } else {
                    self.check_case_collision(&edit.path)?;
                    // Atomic exclusive publish: POSIX link never overwrites a destination.
                    rustix::fs::linkat(
                        &directory,
                        temporary.as_str(),
                        &directory,
                        name,
                        AtFlags::empty(),
                    )
                    .map_err(|e| {
                        if e == rustix::io::Errno::EXIST {
                            Error::DraftingCollision
                        } else {
                            errno(e)
                        }
                    })?;
                }
                Ok(())
            })();
            let _ = unlinkat(&directory, temporary.as_str(), AtFlags::empty());
            result?;
        } else {
            if edit.before.as_ref().is_some_and(|b| b.mode & 0o222 == 0) {
                return Err(Error::Denied);
            }
            self.check_directory_identity(parent(&edit.path), &directory)?;
            if self.snapshot(&edit.path)? != edit.before {
                return Err(Error::DraftingChanged);
            }
            unlinkat(&directory, name, AtFlags::empty()).map_err(errno)?;
        }
        directory.sync_all().map_err(|_| Error::DraftingUncertain)?;
        Ok(())
    }
    #[cfg(unix)]
    fn check_directory_identity(&self, path: &str, held: &File) -> Result<()> {
        let current = self
            .handle(path, false)?
            .metadata()
            .map_err(|_| Error::Io)?;
        let held = held.metadata().map_err(|_| Error::Io)?;
        if (current.dev(), current.ino()) != (held.dev(), held.ino()) {
            return Err(Error::DraftingChanged);
        }
        Ok(())
    }
    #[cfg(unix)]
    fn write_journal(&self, journal: &Journal, recovery: &RecoveryStore) -> Result<()> {
        validate_journal(journal, &self.project_key())?;
        let root = self.handle("", false)?;
        let temporary = format!(".heinlein-journal-{}.tmp", uuid());
        let fd = openat(
            &root,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(errno)?;
        let mut file = File::from(fd);
        let bytes = serde_json::to_string(journal).map_err(|_| Error::Io)?;
        recovery.write_structure_receipt_locked(self, &content_hash(&bytes))?;
        let result = (|| {
            file.write_all(bytes.as_bytes()).map_err(|_| Error::Io)?;
            file.sync_all().map_err(|_| Error::Io)?;
            rustix::fs::linkat(&root, temporary.as_str(), &root, JOURNAL, AtFlags::empty())
                .map_err(|e| {
                    if e == rustix::io::Errno::EXIST {
                        Error::DraftingPending
                    } else {
                        errno(e)
                    }
                })?;
            root.sync_all().map_err(|_| Error::DraftingUncertain)
        })();
        let _ = unlinkat(&root, temporary.as_str(), AtFlags::empty());
        result
    }
    #[cfg(unix)]
    fn remove_journal(&self) -> Result<()> {
        let root = self.handle("", false)?;
        unlinkat(&root, JOURNAL, AtFlags::empty()).map_err(|_| Error::DraftingUncertain)?;
        root.sync_all().map_err(|_| Error::DraftingUncertain)
    }
}
#[cfg(test)]
thread_local! { static FAIL_AFTER_EDIT: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) }; }

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    struct Fixture {
        temp: TempDir,
        repo: Repository,
        recovery: RecoveryStore,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
            fs::create_dir(temp.path().join("repo")).unwrap();
            let repo = Repository::open(temp.path().join("repo").canonicalize().unwrap()).unwrap();
            let recovery = RecoveryStore::open(temp.path().join("private")).unwrap();
            Self {
                temp,
                repo,
                recovery,
            }
        }
        fn put(&self, path: &str, text: &str) {
            let file = self.repo.root().join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, text).unwrap();
        }
        fn preview(&self, change: DraftingChange) -> Result<DraftingPlan> {
            let revision = self.repo.load_drafting()?.revision;
            self.repo
                .preview_drafting(revision.as_deref(), change, &[], &self.recovery)
        }
        fn apply(&self, change: DraftingChange) -> DraftingUndo {
            let plan = self.preview(change).unwrap();
            self.repo.apply_drafting(&plan, &self.recovery).unwrap()
        }
        fn initialize(&self) {
            self.apply(DraftingChange::Initialize {
                project: "Synthetic story".into(),
            });
        }
        fn create(&self, path: &str) {
            self.apply(DraftingChange::CreateScene {
                title: scene_title(path),
                path: path.into(),
                group_id: None,
                before_id: None,
            });
        }
    }
    fn split_change(f: &Fixture, text: &str, offset: usize) -> DraftingChange {
        DraftingChange::SplitScene {
            scene_id: f.repo.load_drafting().unwrap().scenes[0].id.clone(),
            path: "ms/suffix.md".into(),
            title: "Second scene".into(),
            expected_hash: content_hash(text),
            byte_offset: offset,
        }
    }

    #[test]
    fn split_preserves_exact_bytes_metadata_identity_group_order_and_undo() {
        let f = Fixture::new();
        let text = "---\r\ntitle: Original\r\n---\r\nFirst—é.\r\nSecond 🐾.\r\n";
        f.put("ms/original.md", text);
        f.initialize();
        f.apply(DraftingChange::CreateGroup {
            title: "Act one".into(),
        });
        let state = f.repo.load_drafting().unwrap();
        f.apply(DraftingChange::ReorderScene {
            scene_id: state.scenes[0].id.clone(),
            before_id: None,
            group_id: Some(state.groups[0].id.clone()),
        });
        f.create("ms/later.md");
        let before = f.repo.load_drafting().unwrap();
        let original_index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
        let offset = text.find("Second").unwrap();
        let plan = f.preview(split_change(&f, text, offset)).unwrap();
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap(),
            text
        );
        assert!(!f.repo.root().join("ms/suffix.md").exists());
        let undo = f.repo.apply_drafting(&plan, &f.recovery).unwrap();
        let after = f.repo.load_drafting().unwrap();
        assert_eq!(after.scenes[0], before.scenes[0]);
        assert_eq!(after.scenes[2], before.scenes[1]);
        assert_ne!(after.scenes[1].id, before.scenes[0].id);
        assert_eq!(after.scenes[1].group_id, before.scenes[0].group_id);
        assert_eq!(after.scenes[1].title, "Second scene");
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap(),
            &text[..offset]
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/suffix.md")).unwrap(),
            &text[offset..]
        );
        f.repo.undo_drafting(&undo, &f.recovery).unwrap();
        assert_eq!(
            fs::read(f.repo.root().join(MANIFEST)).unwrap(),
            original_index
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap(),
            text
        );
        assert!(!f.repo.root().join("ms/suffix.md").exists());
    }

    #[test]
    fn split_rejects_endpoints_unicode_crlf_and_frontmatter_boundaries() {
        for (text, offset) in [
            ("abc", 0),
            ("abc", 3),
            ("abc", usize::MAX),
            ("éx", 1),
            ("a\r\nb", 2),
            ("---\ntitle: One\n---\nbody", 8),
            ("---\ntitle: One\nbody", 18),
            ("\u{feff}--- \rtitle: One\r...\rbody", 10),
            ("---\t\rtitle: One\rbody", 8),
            ("--- \ntitle: One\n... \nbody", 14),
        ] {
            let f = Fixture::new();
            f.put("ms/original.md", text);
            f.initialize();
            assert_eq!(
                f.preview(split_change(&f, text, offset)).unwrap_err(),
                Error::InvalidManifest
            );
        }
        assert!(validate_split_offset("aé🐾b", 3).is_ok());
        let metadata = "\u{feff}--- \rtitle: One\r...\r";
        let text = format!("{metadata}first second");
        assert!(validate_split_offset(&text, metadata.len()).is_err());
        assert!(validate_split_offset(&text, metadata.len() + 6).is_ok());
    }

    #[test]
    fn split_stale_hash_source_race_pending_recovery_and_edited_undo_fail_closed() {
        let f = Fixture::new();
        f.put("ms/original.md", "first second");
        f.initialize();
        assert_eq!(
            f.preview(split_change(&f, "stale", 5)).unwrap_err(),
            Error::DraftingChanged
        );
        let plan = f.preview(split_change(&f, "first second", 6)).unwrap();
        f.put("ms/original.md", "changed");
        assert_eq!(
            f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        f.put("ms/original.md", "first second");
        f.recovery
            .stage(
                &f.repo,
                "ms/original.md",
                &content_hash("first second"),
                "pending",
            )
            .unwrap();
        assert_eq!(
            f.preview(split_change(&f, "first second", 6)).unwrap_err(),
            Error::PendingRecovery
        );
        // Another fixture avoids discarding any pending recovery without review.
        let f = Fixture::new();
        f.put("ms/original.md", "first second");
        f.initialize();
        let undo = f.apply(split_change(&f, "first second", 6));
        f.put("ms/suffix.md", "edited suffix");
        assert_eq!(
            f.repo.undo_drafting(&undo, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/suffix.md")).unwrap(),
            "edited suffix"
        );
    }

    #[test]
    fn split_rejects_bad_paths_collisions_and_cross_directory_references() {
        let f = Fixture::new();
        let text = "first [link](asset.png) second";
        f.put("ms/original.md", text);
        f.initialize();
        for path in [
            "../escape.md",
            "outside.md",
            "ms/original.md",
            "ms/ORIGINAL.md",
            "ms/sub/suffix.md",
        ] {
            let mut change = split_change(&f, text, 6);
            if let DraftingChange::SplitScene {
                path: destination, ..
            } = &mut change
            {
                *destination = path.into();
            }
            assert!(f.preview(change).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn repeated_nested_splits_and_reverse_undos_preserve_the_manuscript() {
        let f = Fixture::new();
        let text = "First—é🐾\r\nsecond third fourth";
        f.put("ms/original.md", text);
        f.initialize();
        let original_manifest = fs::read(f.repo.root().join(MANIFEST)).unwrap();
        let mut undos = Vec::new();
        for step in 0..12 {
            let current = fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap();
            let offset = current.char_indices().last().unwrap().0;
            let mut change = split_change(&f, &current, offset);
            if let DraftingChange::SplitScene { path, .. } = &mut change {
                *path = format!("ms/suffix-{step}.md");
            }
            undos.push(f.apply(change));
            let state = f.repo.load_drafting().unwrap();
            let assembled: String = state
                .scenes
                .iter()
                .map(|scene| fs::read_to_string(f.repo.root().join(&scene.path)).unwrap())
                .collect();
            assert_eq!(assembled, text);
        }
        let state = f.repo.load_drafting().unwrap();
        let reorder_undo = f.apply(DraftingChange::ReorderScene {
            scene_id: state.scenes[0].id.clone(),
            before_id: None,
            group_id: None,
        });
        assert_eq!(
            f.repo
                .undo_drafting(undos.last().unwrap(), &f.recovery)
                .unwrap_err(),
            Error::DraftingChanged
        );
        f.repo.undo_drafting(&reorder_undo, &f.recovery).unwrap();
        for undo in undos.iter().rev() {
            f.repo.undo_drafting(undo, &f.recovery).unwrap();
        }
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap(),
            text
        );
        assert_eq!(
            fs::read(f.repo.root().join(MANIFEST)).unwrap(),
            original_manifest
        );
    }

    #[test]
    fn split_generated_and_legacy_authority_is_rechecked_at_apply() {
        for (authority, error) in [
            (
                r#"{"schema_version":1,"project":"Old","volumes":[],"sources":[{"path":"original.md"}]}"#,
                Error::ReadOnly,
            ),
            (
                r#"{"schema_version":1,"project":"Old","volumes":[{"number":1,"title":"Volume","directory":"v","chapters":[{"number":1,"title":"Chapter","directory":"v/c","source":"generated.md","scenes":["original.md"]}]}]}"#,
                Error::LegacySceneMove,
            ),
        ] {
            let f = Fixture::new();
            let text = "first second";
            f.put("ms/original.md", text);
            f.initialize();
            let plan = f.preview(split_change(&f, text, 6)).unwrap();
            let change = split_change(&f, text, 6);
            f.put("ms/scene-manifest.json", authority);
            assert_eq!(f.preview(change).unwrap_err(), error);
            assert_eq!(
                f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
                error
            );
            assert_eq!(
                fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap(),
                text
            );
            assert!(!f.repo.root().join("ms/suffix.md").exists());
        }
    }

    #[test]
    fn split_undo_failure_and_interruption_preserve_post_split_state() {
        for completed in 1..=3 {
            let f = Fixture::new();
            f.put("ms/original.md", "first second");
            f.initialize();
            let undo = f.apply(split_change(&f, "first second", 6));
            FAIL_AFTER_EDIT.with(|slot| slot.set(Some(completed)));
            let result = f.repo.undo_drafting(&undo, &f.recovery);
            FAIL_AFTER_EDIT.with(|slot| slot.set(None));
            assert_eq!(result.unwrap_err(), Error::Io);
            assert_eq!(
                fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap(),
                "first "
            );
            assert_eq!(
                fs::read_to_string(f.repo.root().join("ms/suffix.md")).unwrap(),
                "second"
            );
            let plan = &undo.plan;
            let journal = Journal {
                schema_version: 1,
                repository_key: f.repo.project_key(),
                id: plan.preview.id.clone(),
                edits: plan.edits.clone(),
            };
            f.recovery
                .with_clean_paths(&f.repo, &plan.recovery_paths, || {
                    f.repo.write_journal(&journal, &f.recovery)
                })
                .unwrap();
            for edit in plan.edits.iter().take(completed) {
                f.repo.write_transition(edit).unwrap();
            }
            let rollback = f.preview(DraftingChange::RecoverInterrupted {}).unwrap();
            f.repo.apply_drafting(&rollback, &f.recovery).unwrap();
            assert_eq!(
                fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap(),
                "first "
            );
            assert_eq!(
                fs::read_to_string(f.repo.root().join("ms/suffix.md")).unwrap(),
                "second"
            );
            assert_eq!(f.repo.load_drafting().unwrap().scenes.len(), 2);
        }
    }

    #[test]
    fn split_failure_rolls_back_each_transition_and_index() {
        for after in 1..=3 {
            let f = Fixture::new();
            let text = "first—\r\nsecond🐾";
            f.put("ms/original.md", text);
            f.initialize();
            let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
            let plan = f
                .preview(split_change(&f, text, text.find("second").unwrap()))
                .unwrap();
            FAIL_AFTER_EDIT.with(|slot| slot.set(Some(after)));
            let result = f.repo.apply_drafting(&plan, &f.recovery);
            FAIL_AFTER_EDIT.with(|slot| slot.set(None));
            assert_eq!(result.unwrap_err(), Error::Io);
            assert_eq!(
                fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap(),
                text
            );
            assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
            assert!(!f.repo.root().join("ms/suffix.md").exists());
            assert!(!f.repo.root().join(JOURNAL).exists());
        }
    }

    #[test]
    fn split_interruption_rolls_back_and_journal_rejects_non_lossless_replacement() {
        for completed in 1..=3 {
            let f = Fixture::new();
            let text = "first second";
            f.put("ms/original.md", text);
            f.initialize();
            let plan = f.preview(split_change(&f, text, 6)).unwrap();
            let journal = Journal {
                schema_version: 1,
                repository_key: f.repo.project_key(),
                id: plan.preview.id.clone(),
                edits: plan.edits.clone(),
            };
            validate_journal(&journal, &f.repo.project_key()).unwrap();
            let mut tampered = journal.clone();
            tampered.edits[1].after.as_mut().unwrap().text = "rewritten".into();
            assert_eq!(
                validate_journal(&tampered, &f.repo.project_key()),
                Err(Error::UntrustedTransaction)
            );
            f.recovery
                .with_clean_paths(&f.repo, &plan.recovery_paths, || {
                    f.repo.write_journal(&journal, &f.recovery)
                })
                .unwrap();
            for edit in plan.edits.iter().take(completed) {
                f.repo.write_transition(edit).unwrap();
            }
            let rollback = f.preview(DraftingChange::RecoverInterrupted {}).unwrap();
            f.repo.apply_drafting(&rollback, &f.recovery).unwrap();
            assert_eq!(
                fs::read_to_string(f.repo.root().join("ms/original.md")).unwrap(),
                text
            );
            assert!(!f.repo.root().join("ms/suffix.md").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn portable_permission_bits_preserve_every_allowed_mode() {
        for mode in 0u32..=0o777 {
            let native = rustix::fs::Mode::from_bits_truncate(mode as _);
            assert_eq!(u64::from(native.bits()), u64::from(mode));
        }
    }

    #[test]
    fn initialize_empty_create_order_move_identity_and_undo() {
        let f = Fixture::new();
        let plan = f
            .preview(DraftingChange::Initialize {
                project: "Draft".into(),
            })
            .unwrap();
        assert!(!f.repo.root().join("ms").exists());
        f.repo.apply_drafting(&plan, &f.recovery).unwrap();
        f.create("ms/b.md");
        f.create("ms/a.md");
        let state = f.repo.load_drafting().unwrap();
        let b = &state.scenes[0];
        let a = &state.scenes[1];
        assert_eq!(b.path, "ms/b.md");
        let undo = f.apply(DraftingChange::MoveScene {
            scene_id: a.id.clone(),
            path: "ms/group/a.md".into(),
            group_id: None,
            before_id: Some(b.id.clone()),
        });
        let state = f.repo.load_drafting().unwrap();
        assert_eq!(state.scenes[0].id, a.id);
        assert_eq!(state.scenes[0].path, "ms/group/a.md");
        assert!(!f.repo.root().join("ms/a.md").exists());
        f.repo.undo_drafting(&undo, &f.recovery).unwrap();
        assert_eq!(
            f.repo.load_drafting().unwrap().scenes,
            vec![b.clone(), a.clone()]
        );
        assert_eq!(fs::read(f.repo.root().join("ms/a.md")).unwrap(), b"");
    }
    #[test]
    fn empty_chapter_persists_then_new_empty_scene_uses_its_stable_identity() {
        let f = Fixture::new();
        f.initialize();
        f.apply(DraftingChange::CreateGroup {
            title: "Opening — chapter".into(),
        });
        let reopened = Repository::open(f.repo.root()).unwrap();
        let empty = reopened.load_drafting().unwrap();
        assert!(empty.scenes.is_empty());
        assert_eq!(empty.groups.len(), 1);
        let group = empty.groups[0].id.clone();
        assert_eq!(empty.groups[0].title, "Opening — chapter");
        f.apply(DraftingChange::CreateScene {
            title: "Arrival".into(),
            path: "ms/arrival.md".into(),
            group_id: Some(group.clone()),
            before_id: None,
        });
        let state = Repository::open(f.repo.root())
            .unwrap()
            .load_drafting()
            .unwrap();
        assert_eq!(state.groups[0].id, group);
        assert_eq!(state.scenes.len(), 1);
        assert_eq!(state.scenes[0].group_id.as_deref(), Some(group.as_str()));
        assert_eq!(fs::read(f.repo.root().join("ms/arrival.md")).unwrap(), b"");
        assert!(uuid::Uuid::parse_str(&state.scenes[0].id).is_ok());
    }
    #[test]
    fn repository_move_preserves_bytes_and_ids_copy_gets_new_identity() {
        let f = Fixture::new();
        f.initialize();
        let text = "---\r\ntitle: 'Exact'\r\n---\r\nEm dash—fragment.\r\n";
        f.put("draft/a.md", text);
        f.apply(DraftingChange::ImportRepository {
            paths: vec!["draft/a.md".into()],
            destination: "ms".into(),
            mode: "move".into(),
            group_id: None,
            before_id: None,
        });
        assert!(!f.repo.root().join("draft/a.md").exists());
        assert_eq!(
            fs::read(f.repo.root().join("ms/a.md")).unwrap(),
            text.as_bytes()
        );
        let original = f.repo.load_drafting().unwrap().scenes[0].id.clone();
        f.apply(DraftingChange::ImportRepository {
            paths: vec!["ms/a.md".into()],
            destination: "ms/copied".into(),
            mode: "copy".into(),
            group_id: None,
            before_id: None,
        });
        let state = f.repo.load_drafting().unwrap();
        assert_ne!(state.scenes[1].id, original);
        f.apply(DraftingChange::ImportRepository {
            paths: vec!["ms/a.md".into()],
            destination: "ms/moved".into(),
            mode: "move".into(),
            group_id: None,
            before_id: None,
        });
        let state = f.repo.load_drafting().unwrap();
        assert_eq!(state.scenes.len(), 2);
        assert_eq!(state.scenes[1].id, original);
    }
    #[test]
    fn collision_traversal_case_symlink_and_generated_sources_fail_without_writes() {
        let f = Fixture::new();
        f.initialize();
        f.create("ms/a.md");
        for path in [
            "ms/a.md",
            "ms/A.md",
            "ms/../outside.md",
            "/outside.md",
            "draft/no.md",
            "ms/.hidden/a.md",
        ] {
            assert!(
                f.preview(DraftingChange::CreateScene {
                    title: "No".into(),
                    path: path.into(),
                    group_id: None,
                    before_id: None
                })
                .is_err(),
                "{path}"
            );
        }
        std::os::unix::fs::symlink(f.temp.path(), f.repo.root().join("ms/link")).unwrap();
        assert!(f
            .preview(DraftingChange::CreateScene {
                title: "No".into(),
                path: "ms/link/escape.md".into(),
                group_id: None,
                before_id: None
            })
            .is_err());
        f.put("draft/source.md", "generated");
        f.put(
            "draft/scene-manifest.json",
            r#"{"schema_version":1,"project":"Old","volumes":[],"sources":[{"path":"source.md"}]}"#,
        );
        assert_eq!(
            f.preview(DraftingChange::ImportRepository {
                paths: vec!["draft/source.md".into()],
                destination: "ms".into(),
                mode: "copy".into(),
                group_id: None,
                before_id: None
            })
            .unwrap_err(),
            Error::ReadOnly
        );
        assert_eq!(f.repo.load_drafting().unwrap().scenes.len(), 1);
    }
    #[test]
    fn stale_manifest_source_membership_and_undo_do_not_overwrite() {
        let f = Fixture::new();
        f.initialize();
        f.put("draft/a.md", "before");
        let change = || DraftingChange::ImportRepository {
            paths: vec!["draft/a.md".into()],
            destination: "ms".into(),
            mode: "copy".into(),
            group_id: None,
            before_id: None,
        };
        let plan = f.preview(change()).unwrap();
        f.put("draft/a.md", "external");
        assert_eq!(
            f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        let plan = f.preview(change()).unwrap();
        f.put("ms/extra.md", "extra");
        assert_eq!(
            f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        f.apply(DraftingChange::Reconcile {});
        let plan = f.preview(change()).unwrap();
        f.apply(DraftingChange::CreateGroup {
            title: "Group".into(),
        });
        assert_eq!(
            f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        let undo = f.apply(change());
        f.put("ms/a.md", "new author edit");
        assert_eq!(
            f.repo.undo_drafting(&undo, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/a.md")).unwrap(),
            "new author edit"
        );
    }
    #[test]
    fn reconciliation_is_explicit_preserves_order_and_blocks_missing_recovery() {
        let f = Fixture::new();
        f.initialize();
        f.create("ms/first.md");
        f.put("ms/new.md", "new");
        let state = f.repo.load_drafting().unwrap();
        assert_eq!(state.untracked_paths, vec!["ms/new.md"]);
        assert_eq!(state.scenes.len(), 1);
        let original = state.scenes[0].id.clone();
        f.apply(DraftingChange::Reconcile {});
        let state = f.repo.load_drafting().unwrap();
        assert_eq!(state.scenes[0].id, original);
        let doc = f.repo.read("ms/first.md").unwrap();
        let recovery = f
            .recovery
            .stage(&f.repo, "ms/first.md", &doc.content_hash, "pending")
            .unwrap();
        fs::remove_file(f.repo.root().join("ms/first.md")).unwrap();
        assert_eq!(
            f.preview(DraftingChange::Reconcile {}).unwrap_err(),
            Error::PendingRecovery
        );
        f.recovery.read(&f.repo, "ms/first.md").unwrap();
        f.recovery
            .discard(&f.repo, "ms/first.md", &recovery.id)
            .unwrap();
        f.apply(DraftingChange::Reconcile {});
        assert_eq!(f.repo.load_drafting().unwrap().scenes.len(), 1);
    }
    #[test]
    fn pending_recovery_at_source_destination_or_other_owner_blocks_moves() {
        let f = Fixture::new();
        f.initialize();
        f.create("ms/a.md");
        let scene = f.repo.load_drafting().unwrap().scenes[0].clone();
        let change = || DraftingChange::MoveScene {
            scene_id: scene.id.clone(),
            path: "ms/b.md".into(),
            group_id: None,
            before_id: None,
        };
        let plan = f.preview(change()).unwrap();
        let doc = f.repo.read("ms/a.md").unwrap();
        let draft = f
            .recovery
            .stage(&f.repo, "ms/a.md", &doc.content_hash, "pending")
            .unwrap();
        assert_eq!(
            f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
            Error::PendingRecovery
        );
        f.recovery.discard(&f.repo, "ms/a.md", &draft.id).unwrap();
        f.put("ms/b.md", "destination");
        let doc = f.repo.read("ms/b.md").unwrap();
        f.recovery
            .stage(&f.repo, "ms/b.md", &doc.content_hash, "orphan pending")
            .unwrap();
        fs::remove_file(f.repo.root().join("ms/b.md")).unwrap();
        assert_eq!(f.preview(change()).unwrap_err(), Error::PendingRecovery);
        let other = RecoveryStore::open(f.temp.path().join("private")).unwrap();
        assert_eq!(
            f.repo
                .save_with_recovery(
                    "ms/a.md",
                    &f.repo.read("ms/a.md").unwrap().content_hash,
                    "other",
                    &other
                )
                .unwrap_err(),
            Error::RecoveryBusy
        );
    }
    #[test]
    fn explicit_legacy_copy_preserves_original_tree_and_order_move_is_refused() {
        let f = Fixture::new();
        f.put("old/v/c/b.md", "B\r\n");
        f.put("old/v/c/a.md", "A\n");
        f.put("old/generated.md", "generated");
        let json = r#"{"schema_version":1,"project":"Old","volumes":[{"number":1,"title":"Volume","directory":"v","chapters":[{"number":1,"title":"Chapter","directory":"v/c","source":"generated.md","scenes":["v/c/b.md","v/c/a.md"]}]}]}"#;
        f.put("old/scene-manifest.json", json);
        f.apply(DraftingChange::MigrateLegacy {
            manifest_path: "old/scene-manifest.json".into(),
            project: "Separate draft".into(),
        });
        let state = f.repo.load_drafting().unwrap();
        assert_eq!(state.scenes[0].path, "ms/old/v/c/b.md");
        assert_eq!(state.scenes[1].path, "ms/old/v/c/a.md");
        assert_eq!(
            fs::read_to_string(f.repo.root().join("old/scene-manifest.json")).unwrap(),
            json
        );
        assert_eq!(
            fs::read(f.repo.root().join("old/v/c/b.md")).unwrap(),
            b"B\r\n"
        );
        assert_eq!(
            f.preview(DraftingChange::ImportRepository {
                paths: vec!["old/v/c/b.md".into()],
                destination: "ms".into(),
                mode: "move".into(),
                group_id: None,
                before_id: None
            })
            .unwrap_err(),
            Error::LegacySceneMove
        );
    }
    #[test]
    fn reference_syntax_blocks_directory_changes_and_external_imports() {
        let samples = [
            "![a](images/a.png)",
            "[ref](../a.md \"title\")",
            "![a](<images/a b.png>)",
            "[id]: ../a.png",
            "[a](\n./a.png)",
            "<IMG SRC='../a.png'>",
            "<img src=img/a.png>",
            "<img srcset='a.png 1x' poster='b.png'>",
            "url('../a.png')",
            "URL ( 'a.png')",
            "![[asset.png]]",
            "---\ncover-image: cover.png\n---\nBody",
            "---\nbibliography:\n - refs.bib\n---\nBody",
            "\u{feff}---\nimage: cover.png\n---\nBody",
            "+++\nimage = 'cover.png'\n+++\nBody",
        ];
        for sample in samples {
            assert!(reference_bearing(sample), "{sample}");
        }
        assert!(!reference_bearing(
            "---\ntitle: Draft\n---\nAn em dash—kept.\n"
        ));
        let f = Fixture::new();
        f.initialize();
        f.put("assets/scene.md", samples[0]);
        assert_eq!(
            f.preview(DraftingChange::ImportRepository {
                paths: vec!["assets/scene.md".into()],
                destination: "ms".into(),
                mode: "copy".into(),
                group_id: None,
                before_id: None
            })
            .unwrap_err(),
            Error::AssetReferences
        );
        f.put("ms/existing.md", samples[0]);
        f.apply(DraftingChange::Reconcile {});
        let scene = f.repo.load_drafting().unwrap().scenes[0].clone();
        f.apply(DraftingChange::MoveScene {
            scene_id: scene.id,
            path: "ms/renamed.md".into(),
            group_id: None,
            before_id: None,
        });
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/renamed.md")).unwrap(),
            samples[0]
        );
    }
    #[test]
    fn external_native_selection_is_revision_guarded_and_original_is_untouched() {
        let f = Fixture::new();
        f.initialize();
        let path = f.temp.path().join("external.md");
        fs::write(&path, "exact\r\n").unwrap();
        let file = DraftingExternalFile::read_selected(&path).unwrap();
        let preview = |files: &[DraftingExternalFile]| {
            f.repo.preview_drafting(
                f.repo.load_drafting().unwrap().revision.as_deref(),
                DraftingChange::ImportExternal {
                    selection_id: uuid(),
                    destination: "ms".into(),
                    group_id: None,
                    before_id: None,
                },
                files,
                &f.recovery,
            )
        };
        let plan = preview(std::slice::from_ref(&file)).unwrap();
        fs::write(&path, "changed").unwrap();
        assert_eq!(
            f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        let file = DraftingExternalFile::read_selected(&path).unwrap();
        let plan = preview(&[file]).unwrap();
        f.repo.apply_drafting(&plan, &f.recovery).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "changed");
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/external.md")).unwrap(),
            "changed"
        );
    }
    #[test]
    fn injected_failure_rolls_back_every_file_and_index_with_original_bytes() {
        for after in 1..=3 {
            let f = Fixture::new();
            f.initialize();
            f.put("draft/a.md", "original\r\n");
            let index = fs::read(f.repo.root().join(MANIFEST)).unwrap();
            let plan = f
                .preview(DraftingChange::ImportRepository {
                    paths: vec!["draft/a.md".into()],
                    destination: "ms".into(),
                    mode: "move".into(),
                    group_id: None,
                    before_id: None,
                })
                .unwrap();
            FAIL_AFTER_EDIT.with(|slot| slot.set(Some(after)));
            let result = f.repo.apply_drafting(&plan, &f.recovery);
            FAIL_AFTER_EDIT.with(|slot| slot.set(None));
            assert_eq!(result.unwrap_err(), Error::Io);
            assert_eq!(
                fs::read(f.repo.root().join("draft/a.md")).unwrap(),
                b"original\r\n"
            );
            assert_eq!(fs::read(f.repo.root().join(MANIFEST)).unwrap(), index);
            assert!(!f.repo.root().join("ms/a.md").exists());
            assert!(!f.repo.root().join(JOURNAL).exists());
        }
    }
    #[test]
    fn authenticated_interrupted_journal_rolls_back_and_untrusted_or_changed_journal_does_not() {
        let f = Fixture::new();
        f.initialize();
        f.put("draft/a.md", "original");
        let plan = f
            .preview(DraftingChange::ImportRepository {
                paths: vec!["draft/a.md".into()],
                destination: "ms".into(),
                mode: "move".into(),
                group_id: None,
                before_id: None,
            })
            .unwrap();
        let journal = Journal {
            schema_version: 1,
            repository_key: f.repo.project_key(),
            id: plan.preview.id.clone(),
            edits: plan.edits.clone(),
        };
        f.recovery
            .with_clean_paths(&f.repo, &plan.recovery_paths, || {
                f.repo.write_journal(&journal, &f.recovery)
            })
            .unwrap();
        f.repo.write_transition(&plan.edits[0]).unwrap();
        f.repo.write_transition(&plan.edits[1]).unwrap();
        assert!(f.repo.load_drafting().unwrap().recovery_required);
        assert_eq!(
            f.repo
                .save("ms/a.md", &content_hash("original"), "new")
                .unwrap_err(),
            Error::DraftingPending
        );
        assert_eq!(
            f.recovery
                .stage(&f.repo, "ms/a.md", &content_hash("original"), "new")
                .unwrap_err(),
            Error::DraftingPending
        );
        let rollback = f.preview(DraftingChange::RecoverInterrupted {}).unwrap();
        f.repo.apply_drafting(&rollback, &f.recovery).unwrap();
        assert_eq!(
            fs::read_to_string(f.repo.root().join("draft/a.md")).unwrap(),
            "original"
        );
        assert!(!f.repo.root().join("ms/a.md").exists());
        f.put(JOURNAL, &serde_json::to_string(&journal).unwrap());
        assert_eq!(
            f.preview(DraftingChange::RecoverInterrupted {})
                .unwrap_err(),
            Error::UntrustedTransaction
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("draft/a.md")).unwrap(),
            "original"
        );
    }
    #[test]
    fn interrupted_rollback_never_overwrites_unexpected_author_edits() {
        let f = Fixture::new();
        f.initialize();
        f.put("draft/a.md", "original");
        let plan = f
            .preview(DraftingChange::ImportRepository {
                paths: vec!["draft/a.md".into()],
                destination: "ms".into(),
                mode: "move".into(),
                group_id: None,
                before_id: None,
            })
            .unwrap();
        let journal = Journal {
            schema_version: 1,
            repository_key: f.repo.project_key(),
            id: plan.preview.id.clone(),
            edits: plan.edits.clone(),
        };
        f.recovery
            .with_clean_paths(&f.repo, &plan.recovery_paths, || {
                f.repo.write_journal(&journal, &f.recovery)
            })
            .unwrap();
        f.repo.write_transition(&plan.edits[0]).unwrap();
        f.put("ms/a.md", "external edit");
        assert_eq!(
            f.preview(DraftingChange::RecoverInterrupted {})
                .unwrap_err(),
            Error::DraftingChanged
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("ms/a.md")).unwrap(),
            "external edit"
        );
        assert!(f.repo.root().join(JOURNAL).exists());
    }
    #[test]
    fn scene_reorder_group_and_stale_expected_revision_are_guarded() {
        let f = Fixture::new();
        f.initialize();
        f.create("ms/a.md");
        f.create("ms/b.md");
        let before = f.repo.load_drafting().unwrap();
        f.apply(DraftingChange::CreateGroup {
            title: "Part one".into(),
        });
        assert_eq!(
            f.repo
                .preview_drafting(
                    before.revision.as_deref(),
                    DraftingChange::Reconcile {},
                    &[],
                    &f.recovery
                )
                .unwrap_err(),
            Error::DraftingChanged
        );
        let group = f.repo.load_drafting().unwrap().groups[0].id.clone();
        f.apply(DraftingChange::ReorderScene {
            scene_id: before.scenes[1].id.clone(),
            before_id: Some(before.scenes[0].id.clone()),
            group_id: Some(group.clone()),
        });
        let state = f.repo.load_drafting().unwrap();
        assert_eq!(state.scenes[0].id, before.scenes[1].id);
        assert_eq!(state.scenes[0].group_id.as_deref(), Some(group.as_str()));
        assert_eq!(state.scenes[0].path, "ms/b.md");
    }
    #[test]
    fn corrupt_private_receipt_and_tampered_authenticated_journal_fail_closed() {
        let f = Fixture::new();
        f.initialize();
        f.put("draft/a.md", "original");
        let plan = f
            .preview(DraftingChange::ImportRepository {
                paths: vec!["draft/a.md".into()],
                destination: "ms".into(),
                mode: "move".into(),
                group_id: None,
                before_id: None,
            })
            .unwrap();
        let journal = Journal {
            schema_version: 1,
            repository_key: f.repo.project_key(),
            id: plan.preview.id.clone(),
            edits: plan.edits.clone(),
        };
        f.recovery
            .with_clean_paths(&f.repo, &plan.recovery_paths, || {
                f.repo.write_journal(&journal, &f.recovery)
            })
            .unwrap();
        let original_journal = fs::read_to_string(f.repo.root().join(JOURNAL)).unwrap();
        f.put(JOURNAL, &(original_journal.clone() + " "));
        assert_eq!(
            f.preview(DraftingChange::RecoverInterrupted {})
                .unwrap_err(),
            Error::UntrustedTransaction
        );
        f.put(JOURNAL, &original_journal);
        let receipt = f
            .temp
            .path()
            .join("private")
            .join(format!(".heinlein-structure-{}.json", f.repo.project_key()));
        fs::write(receipt, "invalid").unwrap();
        assert_eq!(
            f.preview(DraftingChange::RecoverInterrupted {})
                .unwrap_err(),
            Error::UntrustedTransaction
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("draft/a.md")).unwrap(),
            "original"
        );
    }
    #[test]
    fn journal_structure_and_text_are_validated_even_with_private_provenance() {
        let f = Fixture::new();
        let bytes = Bytes {
            text: "text".into(),
            mode: 0o600,
        };
        let mut journal = Journal {
            schema_version: 1,
            repository_key: f.repo.project_key(),
            id: uuid(),
            edits: vec![Edit {
                path: "scene.md".into(),
                before: Some(bytes.clone()),
                after: Some(bytes.clone()),
            }],
        };
        assert_eq!(
            validate_journal(&journal, &f.repo.project_key()),
            Err(Error::UntrustedTransaction)
        );
        journal.edits[0].after = None;
        journal.edits[0].before.as_mut().unwrap().mode = 0o4777;
        assert_eq!(
            validate_journal(&journal, &f.repo.project_key()),
            Err(Error::UntrustedTransaction)
        );
        journal.edits[0].before.as_mut().unwrap().mode = 0o600;
        journal.edits[0].before.as_mut().unwrap().text = "bad\0bytes".into();
        assert_eq!(
            validate_journal(&journal, &f.repo.project_key()),
            Err(Error::UntrustedTransaction)
        );
    }
    #[test]
    fn captured_external_generated_sources_symlinks_and_reference_text_are_denied() {
        let f = Fixture::new();
        f.initialize();
        f.put("outside/chapter/generated.md", "generated");
        f.put("outside/scene-manifest.json", r#"{"schema_version":1,"project":"Old","volumes":[],"sources":[{"path":"chapter/generated.md"}]}"#);
        assert_eq!(
            DraftingExternalFile::read_selected(
                &f.repo.root().join("outside/chapter/generated.md")
            )
            .unwrap_err(),
            Error::ReadOnly
        );
        let external = f.temp.path().join("external.md");
        fs::write(&external, "![image](image.png)").unwrap();
        let selected = DraftingExternalFile::read_selected(&external).unwrap();
        assert_eq!(
            f.repo
                .preview_drafting(
                    f.repo.load_drafting().unwrap().revision.as_deref(),
                    DraftingChange::ImportExternal {
                        selection_id: uuid(),
                        destination: "ms".into(),
                        group_id: None,
                        before_id: None
                    },
                    &[selected],
                    &f.recovery
                )
                .unwrap_err(),
            Error::AssetReferences
        );
        let link = f.temp.path().join("linked.md");
        std::os::unix::fs::symlink(external, &link).unwrap();
        assert_eq!(
            DraftingExternalFile::read_selected(&link).unwrap_err(),
            Error::Denied
        );
    }
    #[test]
    #[ignore = "subprocess helper for abrupt_structure_exit_requires_explicit_authenticated_rollback"]
    fn structure_crash_helper() {
        let root = std::env::var_os("HEINLEIN_STRUCTURE_TEST_ROOT").unwrap();
        let root = PathBuf::from(root);
        let repo = Repository::open(root.join("repo")).unwrap();
        let recovery = RecoveryStore::open(root.join("private")).unwrap();
        let plan = repo
            .preview_drafting(
                repo.load_drafting().unwrap().revision.as_deref(),
                DraftingChange::ImportRepository {
                    paths: vec!["draft/a.md".into()],
                    destination: "ms".into(),
                    mode: "move".into(),
                    group_id: None,
                    before_id: None,
                },
                &[],
                &recovery,
            )
            .unwrap();
        let journal = Journal {
            schema_version: 1,
            repository_key: repo.project_key(),
            id: plan.preview.id.clone(),
            edits: plan.edits.clone(),
        };
        recovery
            .with_clean_paths(&repo, &plan.recovery_paths, || {
                repo.write_journal(&journal, &recovery)
            })
            .unwrap();
        repo.write_transition(&plan.edits[0]).unwrap();
        repo.write_transition(&plan.edits[1]).unwrap();
        // SIGKILL deliberately bypasses Rust drop handlers and normal rollback.
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &std::process::id().to_string()])
            .status();
        panic!("SIGKILL did not terminate helper");
    }
    #[test]
    fn abrupt_structure_exit_requires_explicit_authenticated_rollback() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        fs::create_dir(temp.path().join("repo")).unwrap();
        {
            let repo = Repository::open(temp.path().join("repo")).unwrap();
            let recovery = RecoveryStore::open(temp.path().join("private")).unwrap();
            let plan = repo
                .preview_drafting(
                    None,
                    DraftingChange::Initialize {
                        project: "Crash fixture".into(),
                    },
                    &[],
                    &recovery,
                )
                .unwrap();
            repo.apply_drafting(&plan, &recovery).unwrap();
            fs::create_dir(repo.root().join("draft")).unwrap();
            fs::write(repo.root().join("draft/a.md"), "Exact—bytes.\r\n").unwrap();
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "drafting::tests::structure_crash_helper",
                "--ignored",
            ])
            .env("HEINLEIN_STRUCTURE_TEST_ROOT", temp.path())
            .output()
            .unwrap();
        assert!(!status.status.success());
        let repo = Repository::open(temp.path().join("repo")).unwrap();
        let recovery = RecoveryStore::open(temp.path().join("private")).unwrap();
        assert!(repo.load_drafting().unwrap().recovery_required);
        assert!(!repo.root().join("draft/a.md").exists());
        assert_eq!(
            fs::read(repo.root().join("ms/a.md")).unwrap(),
            "Exact—bytes.\r\n".as_bytes()
        );
        let plan = repo
            .preview_drafting(
                repo.load_drafting().unwrap().revision.as_deref(),
                DraftingChange::RecoverInterrupted {},
                &[],
                &recovery,
            )
            .unwrap();
        repo.apply_drafting(&plan, &recovery).unwrap();
        assert_eq!(
            fs::read(repo.root().join("draft/a.md")).unwrap(),
            "Exact—bytes.\r\n".as_bytes()
        );
        assert!(!repo.root().join("ms/a.md").exists());
        assert!(!repo.load_drafting().unwrap().recovery_required);
    }
    #[test]
    fn partial_first_step_recovery_has_no_undo_that_recreates_interrupted_state() {
        let f = Fixture::new();
        f.initialize();
        f.put("draft/a.md", "original");
        let plan = f
            .preview(DraftingChange::ImportRepository {
                paths: vec!["draft/a.md".into()],
                destination: "ms".into(),
                mode: "move".into(),
                group_id: None,
                before_id: None,
            })
            .unwrap();
        let journal = Journal {
            schema_version: 1,
            repository_key: f.repo.project_key(),
            id: plan.preview.id.clone(),
            edits: plan.edits.clone(),
        };
        f.recovery
            .with_clean_paths(&f.repo, &plan.recovery_paths, || {
                f.repo.write_journal(&journal, &f.recovery)
            })
            .unwrap();
        f.repo.write_transition(&plan.edits[0]).unwrap();
        let rollback = f.preview(DraftingChange::RecoverInterrupted {}).unwrap();
        let undo = f.repo.apply_drafting(&rollback, &f.recovery).unwrap();
        assert!(!undo.is_available());
        assert_eq!(
            f.repo.undo_drafting(&undo, &f.recovery).unwrap_err(),
            Error::DraftingChanged
        );
        assert_eq!(
            fs::read_to_string(f.repo.root().join("draft/a.md")).unwrap(),
            "original"
        );
        assert!(!f.repo.root().join("ms/a.md").exists());
        assert!(!f.repo.load_drafting().unwrap().recovery_required);
    }
    include!("drafting_moves_tests.rs");
}

#[cfg(all(test, unix))]
#[path = "drafting_fuzz.rs"]
mod fuzz;
