//! Reviewed three-way candidates. Scene identities/ordering are semantic, not JSON lines.
use crate::{
    api::Provider,
    auth::Credential,
    hash,
    operations::{self, FileChange, Identity},
    registry::{Registry, Workspace},
    transport::{self, Files},
    Error, Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resolution {
    pub choice: String,
    pub result: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub original: String,
    pub yours: String,
    pub github: String,
    pub resolution: Option<Resolution>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDocument {
    pub path: String,
    pub original: Option<String>,
    pub result: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingPreview {
    pub id: String,
    pub workspace_id: String,
    pub branch: String,
    pub local_head: String,
    pub github_head: String,
    pub files: Vec<FileChange>,
    pub conflicts: Vec<Conflict>,
    pub ready: bool,
    pub treatment: String,
    pub documents: Vec<CandidateDocument>,
    pub reference_labels: BTreeMap<String, String>,
}
pub struct IncomingPlan {
    pub preview: IncomingPreview,
    pub(crate) before: Workspace,
    base: Files,
    ours: Files,
    theirs: Files,
    resolutions: BTreeMap<String, Resolution>,
    pub(crate) candidate: Files,
}
struct Builder<'a> {
    resolutions: &'a BTreeMap<String, Resolution>,
    conflicts: Vec<Conflict>,
}
fn display(value: &Option<Value>, kind: &str) -> String {
    match value {
        None => "(deleted)".into(),
        Some(Value::String(s)) if kind == "prose" => s.clone(),
        Some(v) => serde_json::to_string_pretty(v).unwrap_or_default(),
    }
}
impl Builder<'_> {
    fn choose(
        &mut self,
        key: &str,
        label: &str,
        kind: &str,
        base: Option<Value>,
        ours: Option<Value>,
        theirs: Option<Value>,
    ) -> Result<Option<Value>> {
        if ours == theirs {
            return Ok(ours);
        }
        if ours == base {
            return Ok(theirs);
        }
        if theirs == base {
            return Ok(ours);
        }
        if kind == "prose" {
            if let (Some(Value::String(b)), Some(Value::String(o)), Some(Value::String(t))) =
                (&base, &ours, &theirs)
            {
                let mut a = git2::MergeFileInput::new();
                a.content(b.as_bytes());
                let mut y = git2::MergeFileInput::new();
                y.content(o.as_bytes());
                let mut g = git2::MergeFileInput::new();
                g.content(t.as_bytes());
                let merged = git2::merge_file(&a, &y, &g, None)?;
                if merged.is_automergeable() {
                    return Ok(Some(Value::String(
                        String::from_utf8(merged.content().to_vec())
                            .map_err(|_| Error::Unsupported)?,
                    )));
                }
            }
        }
        let id = hash(key.as_bytes());
        let resolution = self.resolutions.get(&id).cloned();
        self.conflicts.push(Conflict {
            id,
            label: label.into(),
            kind: kind.into(),
            original: display(&base, kind),
            yours: display(&ours, kind),
            github: display(&theirs, kind),
            resolution: resolution.clone(),
        });
        Ok(match resolution {
            None => ours,
            Some(r) => match r.choice.as_str() {
                "mine" => ours,
                "github" => theirs,
                "combined" => {
                    let text = r.result.ok_or(Error::Conflict)?;
                    if text.len() > 2 * 1024 * 1024
                        || text.lines().any(|l| {
                            l.starts_with("<<<<<<<")
                                || l.starts_with("=======")
                                || l.starts_with(">>>>>>>")
                        })
                    {
                        return Err(Error::Conflict);
                    }
                    if kind == "prose" {
                        Some(Value::String(text))
                    } else {
                        let value: Value =
                            serde_json::from_str(&text).map_err(|_| Error::Conflict)?;
                        if value.is_null() {
                            None
                        } else {
                            Some(value)
                        }
                    }
                }
                _ => return Err(Error::Conflict),
            },
        })
    }
}
fn string(bytes: Option<&std::sync::Arc<Vec<u8>>>) -> Result<Option<Value>> {
    bytes
        .map(|b| {
            String::from_utf8(b.to_vec())
                .map(Value::String)
                .map_err(|_| Error::Unsupported)
        })
        .transpose()
}
fn bytes(value: Option<Value>) -> Result<Option<Vec<u8>>> {
    value
        .map(|v| {
            v.as_str()
                .map(|s| s.as_bytes().to_vec())
                .ok_or(Error::Conflict)
        })
        .transpose()
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scene {
    scene: repository_core::DraftingScene,
    text: String,
}
fn manifest(files: &Files) -> Result<Option<repository_core::WorkspaceManifest>> {
    files
        .get("ms/manuscript.json")
        .map(|b| {
            repository_core::parse_workspace_manifest(
                std::str::from_utf8(b).map_err(|_| Error::Unsupported)?,
            )
            .map_err(|_| Error::Unsupported)
        })
        .transpose()
}
fn scenes(
    m: &repository_core::WorkspaceManifest,
    files: &Files,
) -> Result<BTreeMap<String, Scene>> {
    m.scenes
        .iter()
        .map(|s| {
            Ok((
                s.id.clone(),
                Scene {
                    scene: s.clone(),
                    text: String::from_utf8(files.get(&s.path).ok_or(Error::Unsupported)?.to_vec())
                        .map_err(|_| Error::Unsupported)?,
                },
            ))
        })
        .collect()
}
fn as_value<T: Serialize>(v: Option<&T>) -> Result<Option<Value>> {
    v.map(serde_json::to_value)
        .transpose()
        .map_err(|_| Error::Unsupported)
}
fn reference_labels(versions: [&Files; 3]) -> Result<BTreeMap<String, String>> {
    let mut labels = BTreeMap::<String, String>::new();
    for files in versions {
        if let Some(m) = manifest(files)? {
            for scene in m.scenes {
                let label = format!("{} ({})", scene.title, scene.path);
                let entry = labels.entry(scene.id).or_default();
                if !entry.contains(&label) {
                    if !entry.is_empty() {
                        entry.push_str(" / ")
                    }
                    entry.push_str(&label);
                }
            }
            for group in m.groups {
                labels
                    .entry(group.id)
                    .or_insert(format!("Group: {}", group.title));
            }
        }
    }
    Ok(labels)
}
fn documents(ours: &Files, candidate: &Files) -> Vec<CandidateDocument> {
    operations::changes(ours, candidate)
        .into_iter()
        .map(|c| CandidateDocument {
            original: ours
                .get(&c.path)
                .and_then(|b| String::from_utf8(b.to_vec()).ok()),
            result: candidate
                .get(&c.path)
                .and_then(|b| String::from_utf8(b.to_vec()).ok()),
            path: c.path,
        })
        .collect()
}
fn merge(
    base: &Files,
    ours: &Files,
    theirs: &Files,
    resolutions: &BTreeMap<String, Resolution>,
) -> Result<(Files, Vec<Conflict>)> {
    // A prose review cannot consent to an asset or executable-mode mutation.
    // Keep the full tree in the snapshot and reject unsupported incoming changes
    // explicitly, instead of losing metadata through the bounded text projection.
    for path in base
        .entries
        .keys()
        .chain(ours.entries.keys())
        .chain(theirs.entries.keys())
        .collect::<BTreeSet<_>>()
    {
        let ancestor = base.entries.get(path);
        let own = ours.entries.get(path);
        let remote = theirs.entries.get(path);
        let passive = [ancestor, own, remote]
            .iter()
            .flatten()
            .any(|e| !e.editable);
        let mode_change = remote
            .is_some_and(|r| ancestor.map(|a| a.mode).unwrap_or(0o100644) != r.mode)
            && remote.map(|e| e.mode) != own.map(|e| e.mode);
        if (passive && remote != ancestor && remote != own) || mode_change {
            return Err(Error::UnsupportedTreeChange);
        }
    }
    let mut b = Builder {
        resolutions,
        conflicts: vec![],
    };
    let mut result = ours.clone();
    let mut semantic_paths = BTreeSet::new();
    if let (Some(bm), Some(om), Some(tm)) = (manifest(base)?, manifest(ours)?, manifest(theirs)?) {
        if bm.id != om.id || bm.id != tm.id {
            return Err(Error::Unsupported);
        }
        let bs = scenes(&bm, base)?;
        let os = scenes(&om, ours)?;
        let ts = scenes(&tm, theirs)?;
        for m in [&bm, &om, &tm] {
            for s in &m.scenes {
                semantic_paths.insert(s.path.clone());
                result.remove(&s.path);
            }
        }
        semantic_paths.insert("ms/manuscript.json".into());
        let mut selected = BTreeMap::new();
        for id in bs
            .keys()
            .chain(os.keys())
            .chain(ts.keys())
            .collect::<BTreeSet<_>>()
        {
            let ancestor = bs.get(id);
            let own = os.get(id);
            let remote = ts.get(id);
            let value = if let (Some(a), Some(o), Some(t)) = (ancestor, own, remote) {
                let mut scene = o.scene.clone();
                scene.title = b
                    .choose(
                        &format!("{id}:title"),
                        &format!("Scene title: {}", o.scene.title),
                        "structure",
                        Some(json!(a.scene.title)),
                        Some(json!(o.scene.title)),
                        Some(json!(t.scene.title)),
                    )?
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .ok_or(Error::Conflict)?;
                scene.path = b
                    .choose(
                        &format!("{id}:path"),
                        &format!("Scene move: {}", o.scene.title),
                        "structure",
                        Some(json!(a.scene.path)),
                        Some(json!(o.scene.path)),
                        Some(json!(t.scene.path)),
                    )?
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .ok_or(Error::Conflict)?;
                scene.group_id = serde_json::from_value(
                    b.choose(
                        &format!("{id}:group"),
                        &format!("Scene group: {}", o.scene.title),
                        "structure",
                        Some(json!(a.scene.group_id)),
                        Some(json!(o.scene.group_id)),
                        Some(json!(t.scene.group_id)),
                    )?
                    .ok_or(Error::Conflict)?,
                )
                .map_err(|_| Error::Conflict)?;
                let text = b
                    .choose(
                        &format!("{id}:text"),
                        &o.scene.title,
                        "prose",
                        Some(json!(a.text)),
                        Some(json!(o.text)),
                        Some(json!(t.text)),
                    )?
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .ok_or(Error::Conflict)?;
                Some(Scene { scene, text })
            } else {
                b.choose(
                    &format!("{id}:existence"),
                    &format!(
                        "Scene added, deleted or edited: {}",
                        own.or(remote)
                            .or(ancestor)
                            .map(|s| s.scene.title.as_str())
                            .unwrap_or("scene")
                    ),
                    "structure",
                    as_value(ancestor)?,
                    as_value(own)?,
                    as_value(remote)?,
                )?
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| Error::Conflict)?
            };
            if let Some(scene) = value {
                selected.insert(id.clone(), scene);
            }
        }
        let group_maps = [&bm, &om, &tm].map(|m| {
            m.groups
                .iter()
                .map(|g| (g.id.clone(), g))
                .collect::<BTreeMap<_, _>>()
        });
        let mut groups = BTreeMap::new();
        for id in group_maps
            .iter()
            .flat_map(|m| m.keys())
            .collect::<BTreeSet<_>>()
        {
            let value = b.choose(
                &format!("group:{id}"),
                "Group added, renamed or deleted",
                "structure",
                as_value(group_maps[0].get(id).copied())?,
                as_value(group_maps[1].get(id).copied())?,
                as_value(group_maps[2].get(id).copied())?,
            )?;
            if let Some(value) = value {
                let group: repository_core::DraftingGroup =
                    serde_json::from_value(value).map_err(|_| Error::Conflict)?;
                groups.insert(group.id.clone(), group);
            }
        }
        let order = |m: &repository_core::WorkspaceManifest| {
            Value::Array(
                m.scenes
                    .iter()
                    .filter(|s| selected.contains_key(&s.id))
                    .map(|s| json!(s.id))
                    .collect(),
            )
        };
        let ordered = b
            .choose(
                "scene-order",
                "Scene reading order",
                "order",
                Some(order(&bm)),
                Some(order(&om)),
                Some(order(&tm)),
            )?
            .ok_or(Error::Conflict)?;
        let mut ids: Vec<String> = serde_json::from_value(ordered).map_err(|_| Error::Conflict)?;
        // Both sides may add scenes. Neither side's partial order may silently
        // drop the other's additions. Offer complete alternatives for author choice.
        let mut missing = Vec::new();
        for m in [&tm, &om] {
            for scene in &m.scenes {
                if selected.contains_key(&scene.id)
                    && !ids.contains(&scene.id)
                    && !missing.contains(&scene.id)
                {
                    missing.push(scene.id.clone());
                }
            }
        }
        if !missing.is_empty() {
            let own_complete = ids
                .iter()
                .chain(missing.iter())
                .cloned()
                .collect::<Vec<_>>();
            let github_complete = missing
                .iter()
                .chain(ids.iter())
                .cloned()
                .collect::<Vec<_>>();
            ids = serde_json::from_value(
                b.choose(
                    "complete-scene-order",
                    "Place all added scenes in reading order",
                    "order",
                    Some(json!([])),
                    Some(json!(own_complete)),
                    Some(json!(github_complete)),
                )?
                .ok_or(Error::Conflict)?,
            )
            .map_err(|_| Error::Conflict)?;
        }
        let group_order = |m: &repository_core::WorkspaceManifest| {
            json!(m
                .groups
                .iter()
                .filter(|g| groups.contains_key(&g.id))
                .map(|g| g.id.clone())
                .collect::<Vec<_>>())
        };
        let mut group_ids: Vec<String> = serde_json::from_value(
            b.choose(
                "group-order",
                "Group order",
                "order",
                Some(group_order(&bm)),
                Some(group_order(&om)),
                Some(group_order(&tm)),
            )?
            .ok_or(Error::Conflict)?,
        )
        .map_err(|_| Error::Conflict)?;
        let mut missing = Vec::new();
        for m in [&tm, &om] {
            for group in &m.groups {
                if groups.contains_key(&group.id)
                    && !group_ids.contains(&group.id)
                    && !missing.contains(&group.id)
                {
                    missing.push(group.id.clone());
                }
            }
        }
        if !missing.is_empty() {
            let own = group_ids
                .iter()
                .chain(missing.iter())
                .cloned()
                .collect::<Vec<_>>();
            let remote = missing
                .iter()
                .chain(group_ids.iter())
                .cloned()
                .collect::<Vec<_>>();
            group_ids = serde_json::from_value(
                b.choose(
                    "complete-group-order",
                    "Place all added groups in order",
                    "order",
                    Some(json!([])),
                    Some(json!(own)),
                    Some(json!(remote)),
                )?
                .ok_or(Error::Conflict)?,
            )
            .map_err(|_| Error::Conflict)?;
        }
        let project = b
            .choose(
                "project-title",
                "Project title",
                "structure",
                Some(json!(bm.project)),
                Some(json!(om.project)),
                Some(json!(tm.project)),
            )?
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or(Error::Conflict)?;
        let mut merged = om.clone();
        merged.project = project;
        merged.scenes = ids
            .iter()
            .filter_map(|id| selected.get(id).map(|s| s.scene.clone()))
            .collect();
        merged.groups = group_ids
            .iter()
            .filter_map(|id| groups.get(id).cloned())
            .collect();
        let resolved = b.conflicts.iter().all(|c| c.resolution.is_some());
        if resolved
            && (ids.len() != selected.len()
                || ids.iter().collect::<BTreeSet<_>>().len() != selected.len()
                || group_ids.len() != groups.len()
                || group_ids.iter().collect::<BTreeSet<_>>().len() != groups.len())
        {
            return Err(Error::Conflict);
        }
        for entity in selected.values() {
            if result.contains_key(&entity.scene.path) {
                return Err(Error::Conflict);
            }
            result.insert(entity.scene.path.clone(), entity.text.as_bytes().to_vec());
        }
        let text = if merged == om {
            ours["ms/manuscript.json"].clone()
        } else {
            (serde_json::to_string_pretty(&merged)? + "\n").into_bytes()
        };
        result.insert("ms/manuscript.json".into(), text);
    }
    for path in base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect::<BTreeSet<_>>()
    {
        if semantic_paths.contains(path) {
            continue;
        }
        let ancestor = base.get(path);
        let own = ours.get(path);
        let remote = theirs.get(path);
        if !operations::author_path(path) {
            if remote != ancestor && remote != own {
                return Err(Error::Unsupported);
            }
            continue;
        }
        let kind = if path == "ms/manuscript.json" {
            "structure"
        } else {
            "prose"
        };
        let value = b.choose(
            path,
            path,
            kind,
            string(ancestor)?,
            string(own)?,
            string(remote)?,
        )?;
        if let Some(bytes) = bytes(value)? {
            result.insert(path.clone(), bytes);
        } else {
            result.remove(path);
        }
    }
    if b.conflicts.iter().all(|c| c.resolution.is_some()) {
        transport::validate_files(&result)?;
        transport::validate_manuscript(&result)?;
    }
    Ok((result, b.conflicts))
}
impl IncomingPlan {
    pub fn create(
        registry: &Registry,
        id: &str,
        remote: git2::Oid,
        branch: String,
    ) -> Result<Self> {
        let (w, repo) = registry.reopen(id)?;
        crate::branches::local_authorized(registry, &w)?;
        transport::valid_ref(&branch)?;
        if branch != w.base_branch.as_deref().unwrap_or(&w.repo.default_branch)
            && branch != w.branch
        {
            return Err(Error::InvalidRef);
        }
        let local = git2::Oid::from_str(&w.head_oid)?;
        let pinned = git2::Oid::from_str(&w.base_oid)?;
        if !(local == pinned || repo.graph_descendant_of(local, pinned)?)
            || !(remote == pinned || repo.graph_descendant_of(remote, pinned)?)
        {
            return Err(Error::Changed);
        }
        let common = repo.merge_base(local, remote).map_err(|_| Error::Changed)?;
        let base = transport::tree_files(&repo, common)?;
        let ours = transport::tree_files(&repo, local)?;
        let theirs = transport::tree_files(&repo, remote)?;
        let root = repository_core::Repository::open(registry.checkout(id)?)
            .map_err(|_| Error::Storage)?;
        if operations::disk_files(&root, &ours)? != ours {
            return Err(Error::Changed);
        }
        let (candidate, conflicts) = merge(&base, &ours, &theirs, &BTreeMap::new())?;
        let preview=IncomingPreview{reference_labels:reference_labels([&base,&ours,&theirs])?,documents:documents(&ours,&candidate),id:uuid::Uuid::new_v4().to_string(),workspace_id:id.into(),branch,local_head:w.head_oid.clone(),github_head:remote.to_string(),files:operations::changes(&ours,&candidate),ready:conflicts.is_empty(),conflicts,treatment:"Review every proposed change. Disjoint edits are a visible candidate; conflicting passages and manuscript order require your explicit choice. No conflict markers enter story files.".into()};
        Ok(Self {
            preview,
            before: w,
            base,
            ours,
            theirs,
            resolutions: BTreeMap::new(),
            candidate,
        })
    }
    pub fn resolve(&mut self, id: &str, resolution: Resolution) -> Result<IncomingPreview> {
        if !self.preview.conflicts.iter().any(|c| c.id == id) {
            return Err(Error::Conflict);
        }
        let mut resolutions = self.resolutions.clone();
        resolutions.insert(id.into(), resolution);
        let (candidate, conflicts) = merge(&self.base, &self.ours, &self.theirs, &resolutions)?;
        self.resolutions = resolutions;
        self.candidate = candidate;
        self.preview.ready = conflicts.iter().all(|c| c.resolution.is_some());
        self.preview.files = operations::changes(&self.ours, &self.candidate);
        self.preview.documents = documents(&self.ours, &self.candidate);
        self.preview.conflicts = conflicts;
        Ok(self.preview.clone())
    }
    pub fn core_plan(
        &self,
        root: &repository_core::Repository,
    ) -> Result<repository_core::workspace_update::UpdatePlan> {
        if !self.preview.ready {
            return Err(Error::Conflict);
        }
        let keys = self
            .ours
            .keys()
            .chain(self.candidate.keys())
            .filter(|p| operations::author_path(p))
            .collect::<BTreeSet<_>>();
        let expected = keys
            .iter()
            .map(|p| ((*p).clone(), self.ours.get(*p).map(|b| hash(b))))
            .collect();
        let replacements = operations::changes(&self.ours, &self.candidate)
            .into_iter()
            .map(|c| {
                let text = self
                    .candidate
                    .get(&c.path)
                    .map(|b| String::from_utf8(b.to_vec()).map_err(|_| Error::Unsupported))
                    .transpose()?;
                Ok((c.path, text))
            })
            .collect::<Result<_>>()?;
        root.preview_workspace_update(expected, replacements)
            .map_err(|_| Error::Changed)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyRecord {
    version: u8,
    operation: String,
    before: Workspace,
    after: Workspace,
    core_id: String,
}
pub fn apply(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    plan: &IncomingPlan,
    identity: Identity,
    recovery: &repository_core::RecoveryStore,
    check: impl Fn(usize) -> repository_core::Result<()>,
) -> Result<crate::journal::Receipt> {
    identity.validate()?;
    let id = &plan.before.id;
    let dir = registry.directory(id)?;
    let _lock = registry.workspace_lock(id)?;
    let (w, repo) = registry.reopen(id)?;
    crate::branches::local_authorized(registry, &w)?;
    if w.head_oid != plan.preview.local_head
        || w.repo != plan.before.repo
        || c.account.id != w.account_id
        || c.binding != w.auth_binding
        || api.repository_by_id(c, w.repo.id)? != w.repo
        || api.head(c, &w.repo, &plan.preview.branch)?.as_deref() != Some(&plan.preview.github_head)
    {
        return Err(Error::Changed);
    }
    let root =
        repository_core::Repository::open(registry.checkout(id)?).map_err(|_| Error::Storage)?;
    if operations::disk_files(&root, &plan.ours)? != plan.ours {
        return Err(Error::Changed);
    }
    let core = plan.core_plan(&root)?;
    let store =
        repository_core::workspace_update::UpdateStore::open(&dir.path().join("update-backups"))
            .map_err(|_| Error::Storage)?;
    let local = repo.find_commit(git2::Oid::from_str(&w.head_oid)?)?;
    let remote = repo.find_commit(git2::Oid::from_str(&plan.preview.github_head)?)?;
    let tree = repo.find_tree(operations::tree_preserving_modes(
        &repo,
        local.id(),
        &plan.candidate,
    )?)?;
    let sig = git2::Signature::now(&identity.name, &identity.email)?;
    let oid = repo.commit(
        None,
        &sig,
        &sig,
        "Author-reviewed GitHub changes",
        &tree,
        &[&local, &remote],
    )?;
    let mut after = w.clone();
    after.head_oid = oid.to_string();
    if plan.preview.branch == w.base_branch.as_deref().unwrap_or(&w.repo.default_branch) {
        after.base_oid = plan.preview.github_head.clone()
    } else {
        after.remote_oid = Some(plan.preview.github_head.clone())
    }
    let record = ApplyRecord {
        version: 1,
        operation: plan.preview.id.clone(),
        before: w.clone(),
        after: after.clone(),
        core_id: core.id().into(),
    };
    dir.write("incoming-transaction.json", &record)?;
    root.apply_workspace_update(&core, &store, recovery, &check)
        .map_err(|_| Error::Recovery)?;
    repo.reference_matching(
        &format!("refs/heads/{}", w.branch),
        oid,
        true,
        local.id(),
        "Author reviewed incoming changes",
    )?;
    check(10_001).map_err(|_| Error::Recovery)?;
    registry.save_locked(&_lock, &w, &after)?;
    check(10_002).map_err(|_| Error::Recovery)?;
    store
        .finalize(&root, core.id())
        .map_err(|_| Error::Recovery)?;
    check(10_003).map_err(|_| Error::Recovery)?;
    dir.write("incoming-transaction.json", &Option::<ApplyRecord>::None)?;
    let receipt = crate::journal::Receipt {
        id: plan.preview.id.clone(),
        workspace_id: id.clone(),
        kind: "incoming".into(),
        status: "succeeded".into(),
        old_head: w.head_oid,
        head: after.head_oid,
        branch: w.branch,
        remote_before: w.remote_oid,
        url: None,
        pr_number: None,
        message:
            "Reviewed GitHub changes applied as a local version. Nothing was sent automatically."
                .into(),
    };
    receipt.save(&dir)?;
    Ok(receipt)
}
pub fn pending(registry: &Registry, id: &str) -> Result<bool> {
    Ok(registry
        .directory(id)?
        .read::<Option<ApplyRecord>>("incoming-transaction.json")?
        .flatten()
        .is_some())
}
pub fn rollback(registry: &Registry, id: &str) -> Result<()> {
    let dir = registry.directory(id)?;
    let _lock = registry.workspace_lock(id)?;
    registry.recover_metadata_locked(&_lock)?;
    let before = registry.get(id)?;
    let r = dir
        .read::<Option<ApplyRecord>>("incoming-transaction.json")?
        .flatten()
        .ok_or(Error::Recovery)?;
    if r.version != 1 || r.before.id != id || r.after.id != id {
        return Err(Error::Recovery);
    }
    let repo = transport::open(&dir, &registry.checkout(id)?)?;
    let head = repo.head()?.target().ok_or(Error::Recovery)?;
    let old = git2::Oid::from_str(&r.before.head_oid)?;
    let new = git2::Oid::from_str(&r.after.head_oid)?;
    if head != old && head != new {
        return Err(Error::Changed);
    }
    let root =
        repository_core::Repository::open(registry.checkout(id)?).map_err(|_| Error::Storage)?;
    let store =
        repository_core::workspace_update::UpdateStore::open(&dir.path().join("update-backups"))
            .map_err(|_| Error::Storage)?;
    // A crash after backup finalization must finish the new version, never reset
    // its ref while leaving the newly applied writing on disk.
    if !store.pending(&root).map_err(|_| Error::Recovery)? {
        let old_files = transport::tree_files(&repo, old)?;
        let new_files = transport::tree_files(&repo, new)?;
        if operations::disk_files(&root, &old_files)? == old_files {
            if head == new {
                repo.reference_matching(
                    &format!("refs/heads/{}", r.before.branch),
                    old,
                    true,
                    new,
                    "Author recovered original version",
                )?;
            }
            registry.save_locked(&_lock, &before, &r.before)?;
        } else if head == new && operations::disk_files(&root, &new_files)? == new_files {
            registry.save_locked(&_lock, &before, &r.after)?;
        } else {
            return Err(Error::Recovery);
        }
        dir.write("incoming-transaction.json", &Option::<ApplyRecord>::None)?;
        return Ok(());
    }
    store.rollback(&root).map_err(|_| Error::Recovery)?;
    if head == new {
        repo.reference_matching(
            &format!("refs/heads/{}", r.before.branch),
            old,
            true,
            new,
            "Author rolled back interrupted update",
        )?;
    }
    registry.save_locked(&_lock, &before, &r.before)?;
    dir.write("incoming-transaction.json", &Option::<ApplyRecord>::None)?;
    Ok(())
}
