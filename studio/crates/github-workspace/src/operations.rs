//! Exact-file author versions and explicit sharing with durable idempotent receipts.
use crate::{
    api::Provider,
    auth::Credential,
    hash,
    journal::Receipt,
    registry::{Registry, Workspace},
    transport::{self, Files},
    Error, Result,
};
use git2::{Oid, Repository};
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub name: String,
    pub email: String,
}
impl Identity {
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty()
            || self.email.trim().is_empty()
            || self.name.len() > 200
            || self.email.len() > 200
            || [&self.name, &self.email]
                .iter()
                .any(|s| s.chars().any(char::is_control))
            || !self.email.contains('@')
        {
            return Err(Error::Unsupported);
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: String,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionPreview {
    pub id: String,
    pub workspace_id: String,
    pub files: Vec<FileChange>,
    pub identity: Identity,
    pub message: String,
    pub head: String,
}
pub struct VersionPlan {
    pub preview: VersionPreview,
    pub(crate) files: Files,
    pub(crate) expected: Files,
    pub(crate) selected: Vec<String>,
}
pub fn author_path(path: &str) -> bool {
    transport::safe_path(path).is_ok()
        && (path == "ms/manuscript.json" || path.ends_with(".md") || path.ends_with(".markdown"))
        && !path.split('/').any(|s| s.starts_with('.'))
}
pub fn disk_files(root: &repository_core::Repository, tracked: &Files) -> Result<Files> {
    let mut disk = tracked.clone();
    for path in tracked.keys().filter(|p| author_path(p)) {
        match root.read(path) {
            Ok(d) => {
                if d.generated_compatibility {
                    continue;
                }
                disk.insert(path.clone(), d.text.into_bytes());
            }
            Err(repository_core::Error::NotFound) => {
                disk.remove(path);
            }
            Err(_) => return Err(Error::Changed),
        }
    }
    let mut dirs = vec![String::new()];
    let mut visited = 0;
    while let Some(dir) = dirs.pop() {
        for e in root.list(&dir).map_err(|_| Error::Changed)? {
            visited += 1;
            if visited > 8192 {
                return Err(Error::Limit);
            }
            if e.kind == "directory" {
                dirs.push(e.path)
            } else if author_path(&e.path) {
                let d = root.read(&e.path).map_err(|_| Error::Changed)?;
                if !d.generated_compatibility {
                    disk.insert(e.path, d.text.into_bytes());
                }
            }
        }
    }
    transport::validate_files(&disk)?;
    transport::validate_manuscript(&disk)?;
    Ok(disk)
}
pub fn changes(before: &Files, after: &Files) -> Vec<FileChange> {
    let keys = before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>();
    keys.into_iter()
        .filter(|p| before.get(*p) != after.get(*p))
        .map(|p| FileChange {
            path: p.clone(),
            kind: if !before.contains_key(p) {
                "add"
            } else if !after.contains_key(p) {
                "delete"
            } else {
                "edit"
            }
            .into(),
            before_hash: before.get(p).map(|b| hash(b)),
            after_hash: after.get(p).map(|b| hash(b)),
        })
        .collect()
}
pub fn version_preview(
    registry: &Registry,
    id: &str,
    selected: Vec<String>,
    identity: Identity,
    message: String,
) -> Result<VersionPlan> {
    identity.validate()?;
    if message.trim().is_empty()
        || message.len() > 4000
        || selected.is_empty()
        || selected.len() > 4096
    {
        return Err(Error::Unsupported);
    }
    let (w, repo) = registry.reopen(id)?;
    let _lock = registry.directory(id)?.lock("workspace.lock")?;
    let head = Oid::from_str(&w.head_oid)?;
    let before = transport::tree_files(&repo, head)?;
    let root =
        repository_core::Repository::open(registry.checkout(id)?).map_err(|_| Error::Storage)?;
    let expected = disk_files(&root, &before)?;
    let mut files = before.clone();
    let unique = selected.iter().collect::<std::collections::BTreeSet<_>>();
    if unique.len() != selected.len() {
        return Err(Error::Changed);
    }
    for path in &selected {
        if !author_path(path) {
            return Err(Error::Unsupported);
        }
        if let Some(b) = expected.get(path) {
            files.insert(path.clone(), b.clone());
        } else {
            files.remove(path);
        }
    }
    transport::validate_manuscript(&files)?;
    let files_changed = changes(&before, &files);
    if files_changed.is_empty() {
        return Err(Error::Changed);
    }
    // A scene move/delete/order change must include its manifest in the same version.
    if before.get("ms/manuscript.json") != expected.get("ms/manuscript.json")
        && files_changed.iter().any(|c| c.path.starts_with("ms/"))
        && !selected.iter().any(|p| p == "ms/manuscript.json")
    {
        return Err(Error::Changed);
    }
    Ok(VersionPlan {
        preview: VersionPreview {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: w.id,
            files: files_changed,
            identity,
            message,
            head: w.head_oid,
        },
        files,
        expected,
        selected,
    })
}
pub fn commit_version(
    registry: &Registry,
    plan: &VersionPlan,
    barrier: impl FnOnce(&[String]) -> Result<()>,
) -> Result<Receipt> {
    let id = &plan.preview.workspace_id;
    let dir = registry.directory(id)?;
    let _lock = dir.lock("workspace.lock")?;
    let mut w = registry.get(id)?;
    let repo = transport::open(&dir, &registry.checkout(id)?)?;
    if let Some(r) = Receipt::load(&dir, &plan.preview.id)? {
        return finish_commit(registry, &mut w, &repo, r);
    }
    if crate::incoming::pending(registry, id)?
        || crate::journal::receipts(&dir)?
            .iter()
            .any(|r| r.kind == "version" && r.status == "prepared")
    {
        return Err(Error::Recovery);
    }
    if repo.head()?.target().map(|o| o.to_string()).as_deref() != Some(&w.head_oid) {
        return Err(Error::Recovery);
    }
    if w.head_oid != plan.preview.head {
        return Err(Error::Changed);
    }
    barrier(&plan.selected)?;
    let root =
        repository_core::Repository::open(registry.checkout(id)?).map_err(|_| Error::Storage)?;
    if disk_files(
        &root,
        &transport::tree_files(&repo, Oid::from_str(&w.head_oid)?)?,
    )? != plan.expected
    {
        return Err(Error::Changed);
    }
    let parent = repo.find_commit(Oid::from_str(&w.head_oid)?)?;
    let tree = tree_preserving_modes(&repo, parent.id(), &plan.files)?;
    let tree = repo.find_tree(tree)?;
    let identity = &plan.preview.identity;
    let sig = git2::Signature::now(&identity.name, &identity.email)?;
    let oid = repo.commit(None, &sig, &sig, &plan.preview.message, &tree, &[&parent])?;
    let receipt = Receipt {
        id: plan.preview.id.clone(),
        workspace_id: id.clone(),
        kind: "version".into(),
        status: "prepared".into(),
        old_head: w.head_oid.clone(),
        head: oid.to_string(),
        branch: w.branch.clone(),
        remote_before: w.remote_oid.clone(),
        url: None,
        pr_number: None,
        message: "Local version prepared; nothing has been sent to GitHub.".into(),
    };
    receipt.save(&dir)?;
    finish_commit(registry, &mut w, &repo, receipt)
}
fn finish_commit(
    registry: &Registry,
    w: &mut Workspace,
    repo: &Repository,
    mut receipt: Receipt,
) -> Result<Receipt> {
    if receipt.workspace_id != w.id
        || receipt.kind != "version"
        || receipt.branch != w.branch
        || !matches!(receipt.status.as_str(), "prepared" | "succeeded")
    {
        return Err(Error::Recovery);
    }
    if receipt.status == "succeeded" {
        return Ok(receipt);
    }
    let reference = format!("refs/heads/{}", w.branch);
    let old = Oid::from_str(&receipt.old_head)?;
    let new = Oid::from_str(&receipt.head)?;
    let current = repo.refname_to_id(&reference)?;
    if current == old {
        repo.reference_matching(&reference, new, true, old, "Author saved version")?;
    } else if current != new {
        return Err(Error::Changed);
    }
    w.head_oid = receipt.head.clone();
    registry.save(w)?;
    receipt.status = "succeeded".into();
    receipt.message = "Version saved on this computer. Nothing has been sent to GitHub.".into();
    receipt.save(&registry.directory(&w.id)?)?;
    Ok(receipt)
}
pub fn tree_preserving_modes(repo: &Repository, base: Oid, files: &Files) -> Result<Oid> {
    transport::validate_files(files)?;
    let tree = repo.find_commit(base)?.tree()?;
    let mut index = git2::Index::new()?;
    index.read_tree(&tree)?;
    let modes = index
        .iter()
        .map(|e| (e.path, e.mode))
        .collect::<std::collections::BTreeMap<_, _>>();
    index.clear()?;
    for (path, bytes) in files {
        index.add(&git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: *modes.get(path.as_bytes()).unwrap_or(&0o100644),
            uid: 0,
            gid: 0,
            file_size: bytes.len() as u32,
            id: repo.blob(bytes)?,
            flags: 0,
            flags_extended: 0,
            path: path.as_bytes().to_vec(),
        })?;
    }
    Ok(index.write_tree_to(repo)?)
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreview {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub repository: crate::RepoInfo,
    pub account: crate::auth::User,
    pub branch: String,
    pub head: String,
    pub base: String,
    pub remote_before: Option<String>,
    pub commits: Vec<String>,
    pub files: Vec<FileChange>,
    pub title: String,
    pub body: String,
    pub warning: String,
}
pub struct SharePlan {
    pub preview: SharePreview,
    pub(crate) binding: String,
    pub(crate) base_oid: String,
}
pub fn check_remote(api: &dyn Provider, c: &Credential, w: &Workspace) -> Result<String> {
    if !c.valid() || c.account.id != w.account_id || c.binding != w.auth_binding {
        return Err(Error::Account);
    }
    let info = api.repository_by_id(c, w.repo.id)?;
    if info != w.repo {
        return Err(Error::Changed);
    }
    let base = api
        .head(c, &info, &info.default_branch)?
        .ok_or(Error::Changed)?;
    if base != w.base_oid {
        return Err(Error::Changed);
    }
    if let Some(pr) = &w.pr {
        let all = api.pulls(c, &info, &w.branch, &info.default_branch)?;
        let found = all
            .iter()
            .find(|(p, _)| p.number == pr.number)
            .ok_or(Error::Changed)?;
        if found.0.state != "open"
            || found.0.merged
            || found.0.base != pr.base
            || found.0.head != pr.head
        {
            return Err(Error::Changed);
        }
    }
    Ok(base)
}
pub fn share_preview(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    id: &str,
    kind: &str,
    title: String,
    body: String,
) -> Result<SharePlan> {
    if !["push", "feedback"].contains(&kind) || title.len() > 200 || body.len() > 8000 {
        return Err(Error::Unsupported);
    }
    let (w, repo) = registry.reopen(id)?;
    let _lock = registry.directory(id)?.lock("workspace.lock")?;
    if crate::journal::receipts(&registry.directory(id)?)?
        .iter()
        .any(|r| r.status == "unknown")
    {
        return Err(Error::Uncertain);
    }
    let base_oid = check_remote(api, c, &w)?;
    let remote_before = api.head(c, &w.repo, &w.branch)?;
    if remote_before != w.remote_oid {
        return Err(Error::Changed);
    }
    if kind == "feedback"
        && (remote_before.as_deref() != Some(&w.head_oid) || title.trim().is_empty())
    {
        return Err(Error::Changed);
    }
    let base = remote_before.as_deref().unwrap_or(&w.base_oid);
    let mut walk = repo.revwalk()?;
    walk.push(Oid::from_str(&w.head_oid)?)?;
    walk.hide(Oid::from_str(base)?)?;
    let commits = walk
        .take(101)
        .map(|oid| oid.map(|o| o.to_string()).map_err(Error::from))
        .collect::<Result<Vec<_>>>()?;
    if commits.len() > 100 {
        return Err(Error::Limit);
    }
    let files = changes(
        &transport::tree_files(&repo, Oid::from_str(base)?)?,
        &transport::tree_files(&repo, Oid::from_str(&w.head_oid)?)?,
    );
    Ok(SharePlan{binding:c.binding.clone(),base_oid,preview:SharePreview{id:uuid::Uuid::new_v4().to_string(),workspace_id:w.id,kind:kind.into(),repository:w.repo.clone(),account:c.account.clone(),branch:w.branch,head:w.head_oid,base: w.pr.as_ref().map(|p|p.base.clone()).unwrap_or_else(||w.repo.default_branch.clone()),remote_before,commits,files,title,body,warning:"Sending commits or requesting feedback can trigger repository-configured GitHub automation. This is an explicit sharing action.".into()}})
}
fn validate_share(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    p: &SharePlan,
) -> Result<(Workspace, Repository)> {
    let (w, repo) = registry.reopen(&p.preview.workspace_id)?;
    if w.head_oid != p.preview.head
        || w.repo != p.preview.repository
        || w.branch != p.preview.branch
        || c.binding != p.binding
        || check_remote(api, c, &w)? != p.base_oid
        || api.head(c, &w.repo, &w.branch)? != p.preview.remote_before
    {
        return Err(Error::Changed);
    }
    Ok((w, repo))
}
pub fn send(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    p: &SharePlan,
    transport: impl FnOnce(&Repository, &Workspace, &Credential) -> Result<()>,
) -> Result<Receipt> {
    let dir = registry.directory(&p.preview.workspace_id)?;
    let _lock = dir.lock("workspace.lock")?;
    if let Some(r) = Receipt::load(&dir, &p.preview.id)? {
        return Ok(r);
    }
    let (mut w, repo) = validate_share(registry, api, c, p)?;
    let mut r = Receipt {
        id: p.preview.id.clone(),
        workspace_id: w.id.clone(),
        kind: p.preview.kind.clone(),
        status: "unknown".into(),
        old_head: w.head_oid.clone(),
        head: w.head_oid.clone(),
        branch: w.branch.clone(),
        remote_before: p.preview.remote_before.clone(),
        url: None,
        pr_number: None,
        message: Error::Uncertain.to_string(),
    };
    r.save(&dir)?;
    if p.preview.kind == "push" {
        let result = transport(&repo, &w, c);
        if result.is_ok() && api.head(c, &w.repo, &w.branch)?.as_deref() == Some(&w.head_oid) {
            w.remote_oid = Some(w.head_oid.clone());
            registry.save(&w)?;
            r.status = "succeeded".into();
            r.message = "Sent to GitHub on your separate writing branch.".into();
        } else if matches!(result, Err(Error::Permission | Error::Changed)) {
            r.status = "failed".into();
            r.message="GitHub rejected this send. Review permissions and incoming changes; no bypass or force push is offered.".into();
        }
    } else {
        let marker = format!("<!-- heinlein-operation:{} -->", r.id);
        let existing = api.pulls(c, &w.repo, &w.branch, &p.preview.base)?;
        if let Some((pr, _)) = existing
            .iter()
            .find(|(pr, _)| pr.state == "open" && pr.head == w.branch && pr.base == p.preview.base)
        {
            if !pr.draft {
                r.status = "failed".into();
                r.message="An existing ready pull request cannot be substituted for draft feedback. No request was created.".into();
                r.save(&dir)?;
                return Ok(r);
            }
            w.pr = Some(pr.clone());
            r.url = Some(pr.url.clone());
            r.pr_number = Some(pr.number);
            r.status = "succeeded".into();
            r.message =
                "Feedback request already open; later versions continue on the same branch.".into();
        } else {
            let body = format!("{}\n\n{marker}", p.preview.body);
            match api.create_draft(
                c,
                &w.repo,
                &w.branch,
                &p.preview.base,
                &p.preview.title,
                &body,
            ) {
                Ok(pr) => {
                    w.pr = Some(pr.clone());
                    r.url = Some(pr.url);
                    r.pr_number = Some(pr.number);
                    r.status = "succeeded".into();
                    r.message = "Draft feedback request open.".into();
                }
                Err(Error::Unsupported | Error::Permission) => {
                    r.status = "failed".into();
                    r.message="GitHub could not create a draft request. No ready request was substituted.".into();
                }
                Err(_) => {}
            }
        }
        registry.save(&w)?;
    }
    r.save(&dir)?;
    Ok(r)
}
pub fn reconcile(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    id: &str,
    operation: &str,
) -> Result<Receipt> {
    let dir = registry.directory(id)?;
    let _lock = dir.lock("workspace.lock")?;
    let mut w = registry.get(id)?;
    if c.account.id != w.account_id
        || c.binding != w.auth_binding
        || api.repository_by_id(c, w.repo.id)? != w.repo
    {
        return Err(Error::Account);
    }
    let mut r = Receipt::load(&dir, operation)?.ok_or(Error::Missing)?;
    if r.status != "unknown" {
        return Ok(r);
    }
    if r.kind == "push" {
        if api.head(c, &w.repo, &r.branch)?.as_deref() == Some(&r.head) {
            r.status = "succeeded".into();
            r.message = "GitHub has this exact version. It was not sent again.".into();
            w.remote_oid = Some(r.head.clone());
            registry.save(&w)?;
        }
    } else if r.kind == "feedback" {
        let marker = format!("<!-- heinlein-operation:{} -->", r.id);
        let all = api.pulls(c, &w.repo, &r.branch, &w.repo.default_branch)?;
        let found = all
            .iter()
            .filter(|(p, b)| {
                p.head == r.branch && p.base == w.repo.default_branch && b.contains(&marker)
            })
            .collect::<Vec<_>>();
        if found.len() == 1 {
            let pr = &found[0].0;
            r.status = "succeeded".into();
            r.url = Some(pr.url.clone());
            r.pr_number = Some(pr.number);
            r.message =
                "Found the existing feedback request. No second request was created.".into();
            w.pr = Some(pr.clone());
            registry.save(&w)?;
        }
    }
    r.save(&dir)?;
    Ok(r)
}
/// Explicit account/repository confirmation; stable workspace ID and checkout do not move.
pub fn rebind(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    id: &str,
    approved: &crate::RepoInfo,
) -> Result<Workspace> {
    let dir = registry.directory(id)?;
    let _lock = dir.lock("workspace.lock")?;
    let (mut w, _) = registry.reopen(id)?;
    let info = api.repository_by_id(c, w.repo.id)?;
    if &info != approved || info.id != w.repo.id {
        return Err(Error::Changed);
    }
    w.repo = info;
    w.account_id = c.account.id;
    w.auth_binding = c.binding.clone();
    registry.save(&w)?;
    Ok(w)
}
/// Continue after closed/merged feedback only by explicit author choice, keeping history.
pub fn fresh_branch(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    id: &str,
) -> Result<Workspace> {
    let dir = registry.directory(id)?;
    let _lock = dir.lock("workspace.lock")?;
    let (mut w, repo) = registry.reopen(id)?;
    if c.account.id != w.account_id
        || c.binding != w.auth_binding
        || api.repository_by_id(c, w.repo.id)? != w.repo
    {
        return Err(Error::Account);
    }
    let prior = w.pr.as_ref().ok_or(Error::Changed)?;
    let all = api.pulls(c, &w.repo, &w.branch, &prior.base)?;
    let closed = all
        .iter()
        .find(|(p, _)| p.number == prior.number)
        .ok_or(Error::Changed)?;
    if closed.0.state == "open" && !closed.0.merged {
        return Err(Error::Changed);
    }
    let base = api
        .head(c, &w.repo, &w.repo.default_branch)?
        .ok_or(Error::Changed)?;
    if base != w.base_oid
        || !(w.head_oid == base
            || repo.graph_descendant_of(Oid::from_str(&w.head_oid)?, Oid::from_str(&base)?)?)
    {
        return Err(Error::Changed);
    }
    let branch = format!("heinlein/story-{}", uuid::Uuid::new_v4());
    let before = w.clone();
    w.branch = branch;
    w.remote_oid = None;
    w.pr = None;
    let record = BranchRecord {
        version: 1,
        before,
        after: w,
    };
    dir.write("branch-transaction.json", &record)?;
    finish_branch(registry, &dir, &repo, &record)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BranchRecord {
    version: u8,
    before: Workspace,
    after: Workspace,
}
pub fn branch_pending(registry: &Registry, id: &str) -> Result<bool> {
    Ok(registry
        .directory(id)?
        .read::<Option<BranchRecord>>("branch-transaction.json")?
        .flatten()
        .is_some())
}
fn finish_branch(
    registry: &Registry,
    dir: &crate::registry::StateDir,
    repo: &Repository,
    r: &BranchRecord,
) -> Result<Workspace> {
    if r.version != 1
        || r.before.id != r.after.id
        || r.before.repo != r.after.repo
        || r.before.head_oid != r.after.head_oid
        || !r.after.branch.starts_with("heinlein/story-")
    {
        return Err(Error::Recovery);
    }
    transport::valid_ref(&r.after.branch)?;
    let head = repo.head()?;
    let before = format!("refs/heads/{}", r.before.branch);
    let after = format!("refs/heads/{}", r.after.branch);
    if head.target().map(|o| o.to_string()).as_deref() != Some(&r.before.head_oid)
        || !matches!(head.name(),Ok(name)if name==before||name==after)
    {
        return Err(Error::Recovery);
    }
    let oid = Oid::from_str(&r.after.head_oid)?;
    match repo.find_reference(&after) {
        Ok(reference) if reference.target() == Some(oid) => {}
        Ok(_) => return Err(Error::Changed),
        Err(e) if e.code() == git2::ErrorCode::NotFound => {
            repo.reference(&after, oid, false, "Author chose fresh feedback branch")?;
        }
        Err(_) => return Err(Error::Storage),
    }
    repo.set_head(&after)?;
    registry.save(&r.after)?;
    dir.write("branch-transaction.json", &Option::<BranchRecord>::None)?;
    Ok(r.after.clone())
}
pub fn recover_branch(registry: &Registry, id: &str) -> Result<Workspace> {
    let dir = registry.directory(id)?;
    let _lock = dir.lock("workspace.lock")?;
    let r = dir
        .read::<Option<BranchRecord>>("branch-transaction.json")?
        .flatten()
        .ok_or(Error::Recovery)?;
    if r.before.id != id {
        return Err(Error::Recovery);
    }
    let repo = transport::open(&dir, &registry.checkout(id)?)?;
    finish_branch(registry, &dir, &repo, &r)
}
pub fn recover_local_version(registry: &Registry, id: &str, operation: &str) -> Result<Receipt> {
    let dir = registry.directory(id)?;
    let _lock = dir.lock("workspace.lock")?;
    let mut w = registry.get(id)?;
    let repo = transport::open(&dir, &registry.checkout(id)?)?;
    let r = Receipt::load(&dir, operation)?.ok_or(Error::Missing)?;
    if r.kind != "version" || r.workspace_id != id {
        return Err(Error::Changed);
    }
    finish_commit(registry, &mut w, &repo, r)
}
