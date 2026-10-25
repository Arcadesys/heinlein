//! Explicit branch capabilities and recoverable full-tree local switches.
//! Existing catalog-v1 IDs/roots are retained; no clone, stash, reset or deletion.
use crate::{
    api::Provider,
    auth::Credential,
    operations,
    registry::{Registry, Workspace},
    transport::{self, Files},
    Error, Result,
};
use git2::{Oid, Repository};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
const BOOK: &str = "branch-capabilities-v1.json";
const JOURNAL: &str = "branch-switch-v1.json";
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Book {
    pub(crate) version: u8,
    pub(crate) workspace_id: String,
    pub(crate) repo_id: u64,
    pub(crate) branches: BTreeMap<String, Workspace>,
}
pub(crate) fn read_book(registry: &Registry, w: &Workspace) -> Result<Option<Book>> {
    let book = registry.directory(&w.id)?.read::<Book>(BOOK)?;
    if let Some(book) = &book {
        if book.version != 1
            || book.workspace_id != w.id
            || book.repo_id != w.repo.id
            || book.branches.len() > 64
        {
            return Err(Error::Storage);
        }
        crate::uuid_id(&book.workspace_id)?;
        for (branch, state) in &book.branches {
            transport::valid_ref(branch)?;
            if state.id != w.id || state.repo.id != w.repo.id || state.branch != *branch {
                return Err(Error::Storage);
            }
            Oid::from_str(&state.head_oid)?;
            Oid::from_str(&state.base_oid)?;
            if let Some(remote) = &state.remote_oid {
                Oid::from_str(remote)?;
            }
            if let Some(base) = &state.base_branch {
                transport::valid_ref(base)?;
            }
            crate::uuid_id(&state.auth_binding)?;
            if state.account_id == 0 {
                return Err(Error::Storage);
            }
        }
    }
    Ok(book)
}
fn book_for(registry: &Registry, w: &Workspace) -> Result<Book> {
    let saved = read_book(registry, w)?;
    match &saved {
        Some(book) if book.branches.get(&w.branch) != Some(w) => return Err(Error::Recovery),
        None if !w.branch.starts_with("heinlein/story-") => return Err(Error::InvalidRef),
        _ => {}
    }
    Ok(saved.unwrap_or_else(|| Book {
        version: 1,
        workspace_id: w.id.clone(),
        repo_id: w.repo.id,
        branches: BTreeMap::from([(w.branch.clone(), w.clone())]),
    }))
}
pub(crate) fn grant_legacy_transition(
    registry: &Registry,
    before: &Workspace,
    after: &Workspace,
) -> Result<Option<Book>> {
    if read_book(registry, before)?.is_none() {
        return Ok(None);
    }
    if before.id != after.id
        || before.repo != after.repo
        || before.head_oid != after.head_oid
        || !after.branch.starts_with("heinlein/story-")
    {
        return Err(Error::Recovery);
    }
    let mut book = book_for(registry, before)?;
    book.branches.insert(after.branch.clone(), after.clone());
    Ok(Some(book))
}
/// Private fields prevent arbitrary renderer refs from becoming transport authority.
pub struct Authority {
    pub(crate) url: String,
    pub(crate) branch: String,
    pub(crate) head: Oid,
    pub(crate) remote: Option<Oid>,
    pub(crate) account_id: u64,
    pub(crate) binding: String,
}
pub fn local_authorized(registry: &Registry, w: &Workspace) -> Result<()> {
    if registry.metadata_pending(&w.id)? {
        return Err(Error::Recovery);
    }
    if w.branch == w.repo.default_branch {
        return Err(Error::InvalidRef);
    }
    match read_book(registry, w)? {
        Some(book) if book.branches.get(&w.branch) != Some(w) => Err(Error::Recovery),
        None if !w.branch.starts_with("heinlein/story-") => Err(Error::InvalidRef),
        _ => Ok(()),
    }
}
pub fn authority(registry: &Registry, w: &Workspace, c: &Credential) -> Result<Authority> {
    if !c.valid()
        || c.account.id != w.account_id
        || c.binding != w.auth_binding
        || w.branch == w.repo.default_branch
    {
        return Err(Error::Account);
    }
    local_authorized(registry, w)?;
    Ok(Authority {
        url: w.repo.clone_url(),
        branch: w.branch.clone(),
        head: w.head_oid.parse()?,
        remote: w.remote_oid.as_ref().map(|s| s.parse()).transpose()?,
        account_id: c.account.id,
        binding: c.binding.clone(),
    })
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub name: String,
    pub head: String,
    pub local: bool,
    pub default_branch: bool,
}
pub fn choices(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    id: &str,
) -> Result<Vec<Choice>> {
    let (w, _) = registry.reopen(id)?;
    check(api, c, &w)?;
    let mut choices = BTreeMap::new();
    for branch in api.branches(c, &w.repo)? {
        choices.insert(
            branch.name.clone(),
            Choice {
                name: branch.name.clone(),
                head: branch.head,
                local: false,
                default_branch: branch.name == w.repo.default_branch,
            },
        );
    }
    for state in book_for(registry, &w)?.branches.values() {
        choices.insert(
            state.branch.clone(),
            Choice {
                name: state.branch.clone(),
                head: state.head_oid.clone(),
                local: true,
                default_branch: state.branch == w.repo.default_branch,
            },
        );
    }
    Ok(choices.into_values().collect())
}
fn check(api: &dyn Provider, c: &Credential, w: &Workspace) -> Result<()> {
    if !c.valid() || c.account.id != w.account_id || c.binding != w.auth_binding {
        return Err(Error::Account);
    }
    if api.repository_by_id(c, w.repo.id)? != w.repo {
        return Err(Error::Changed);
    }
    Ok(())
}
/// No untracked bytes or empty author folders may be implicitly discarded.
fn clean(registry: &Registry, w: &Workspace, repo: &Repository) -> Result<Files> {
    let files = transport::tree_files(repo, w.head_oid.parse()?)?;
    clean_root(&registry.checkout(&w.id)?, &files)?;
    Ok(files)
}
fn clean_root(path: &Path, files: &Files) -> Result<()> {
    let root = repository_core::Repository::open(path).map_err(|_| Error::Storage)?;
    if operations::disk_files(&root, files)? != *files {
        return Err(Error::Uncommitted);
    }
    let mut expected: BTreeSet<String> = files.entries.keys().cloned().collect();
    for path in files.entries.keys() {
        let mut parent = Path::new(path).parent();
        while let Some(p) = parent {
            if p.as_os_str().is_empty() {
                break;
            }
            expected.insert(p.to_str().ok_or(Error::UnsafeTree)?.into());
            parent = p.parent();
        }
    }
    let mut seen = BTreeSet::new();
    let mut pending = vec![root.root().to_owned()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                return Err(Error::UnsafeTree);
            }
            let relative = entry
                .path()
                .strip_prefix(root.root())
                .map_err(|_| Error::UnsafeTree)?
                .to_str()
                .ok_or(Error::UnsafeTree)?
                .to_owned();
            transport::safe_path(&relative)?;
            if !expected.contains(&relative) {
                return Err(Error::Uncommitted);
            }
            seen.insert(relative);
            if meta.is_dir() {
                pending.push(entry.path())
            }
        }
    }
    if seen != expected {
        return Err(Error::Uncommitted);
    }
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub workspace_id: String,
    pub from_branch: String,
    pub branch: String,
    pub starting_branch: String,
    pub head: String,
    pub base: String,
    pub files: Vec<operations::FileChange>,
    pub treatment: String,
    pub account: crate::auth::User,
    pub repository: crate::RepoInfo,
}
pub struct Plan {
    pub preview: Preview,
    before: Workspace,
    after: Workspace,
    book: Book,
    expected: Files,
    pins: Vec<(String, String)>,
    target_before: Option<String>,
}
// All independent capability bindings remain explicit; fetch is an injected transport.
#[allow(clippy::too_many_arguments)]
pub fn preview(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    id: &str,
    start: &str,
    name: &str,
    create: bool,
    mut fetch: impl FnMut(&Repository, &str) -> Result<Oid>,
) -> Result<Plan> {
    let dir = registry.directory(id)?;
    let _lock = registry.workspace_lock(id)?;
    let (w, repo) = registry.reopen(id)?;
    check(api, c, &w)?;
    transport::valid_ref(start)?;
    transport::valid_ref(name)?;
    if name == w.repo.default_branch || name == w.branch {
        return Err(Error::InvalidRef);
    }
    if crate::journal::receipts(&dir)?
        .iter()
        .any(|r| r.status == "unknown" || r.status == "pending" || r.status == "enqueued")
    {
        return Err(Error::Uncertain);
    }
    let expected = clean(registry, &w, &repo)?;
    let mut book = book_for(registry, &w)?;
    book.branches.insert(w.branch.clone(), w.clone());
    if !book.branches.contains_key(name) && book.branches.len() >= 64 {
        return Err(Error::Limit);
    }
    let mut pins = Vec::new();
    let target_before = repo
        .find_reference(&format!("refs/heads/{name}"))
        .ok()
        .and_then(|r| r.target())
        .map(|o| o.to_string());
    let mut after = if create {
        if book.branches.contains_key(name)
            || repo.find_reference(&format!("refs/heads/{name}")).is_ok()
            || api.head(c, &w.repo, name)?.is_some()
        {
            return Err(Error::Changed);
        }
        let mut after = if let Some(local) = book.branches.get(start) {
            local.clone()
        } else {
            let before = api.head(c, &w.repo, start)?.ok_or(Error::Changed)?;
            let fetched = fetch(&repo, start)?;
            if fetched.to_string() != before
                || api.head(c, &w.repo, start)?.as_deref() != Some(&before)
            {
                return Err(Error::Changed);
            }
            pins.push((start.into(), before.clone()));
            let mut after = w.clone();
            after.head_oid = before.clone();
            after.base_oid = before;
            after.base_branch = Some(start.into());
            after
        };
        after.branch = name.into();
        after.remote_oid = None;
        after.pr = None;
        after
    } else if let Some(local) = book.branches.get(name) {
        if target_before.as_deref() != Some(&local.head_oid) {
            return Err(Error::Changed);
        }
        local.clone()
    } else {
        if target_before.is_some() {
            return Err(Error::Changed);
        }
        let before = api.head(c, &w.repo, name)?.ok_or(Error::Changed)?;
        let fetched = fetch(&repo, name)?;
        if fetched.to_string() != before || api.head(c, &w.repo, name)?.as_deref() != Some(&before)
        {
            return Err(Error::Changed);
        }
        let base = api
            .head(c, &w.repo, &w.repo.default_branch)?
            .ok_or(Error::Changed)?;
        if repo.find_commit(base.parse()?).is_err()
            && fetch(&repo, &w.repo.default_branch)?.to_string() != base
        {
            return Err(Error::Changed);
        }
        if api.head(c, &w.repo, &w.repo.default_branch)?.as_deref() != Some(&base) {
            return Err(Error::Changed);
        }
        let base_oid = fetch_base(&repo, &base, fetched)?;
        pins.push((name.into(), before.clone()));
        pins.push((w.repo.default_branch.clone(), base.clone()));
        let mut after = w.clone();
        after.branch = name.into();
        after.head_oid = before.clone();
        after.remote_oid = Some(before);
        after.base_oid = base_oid.to_string();
        after.base_branch = None;
        after.pr = None;
        after
    };
    if after.remote_oid.is_some() {
        // Selecting retained local work does not adopt a collaborator's head.
        // Pin the current observation for this switch, retaining the previous
        // shared OID so sending still requires explicit incoming review.
        let observed = api.head(c, &w.repo, &after.branch)?.ok_or(Error::Changed)?;
        pins.push((after.branch.clone(), observed));
    }
    after.repo = w.repo.clone();
    after.account_id = w.account_id;
    after.auth_binding = w.auth_binding.clone();
    let candidate = transport::tree_files(&repo, after.head_oid.parse()?)?;
    let files = operations::changes(&expected, &candidate);
    let p=Preview{account:c.account.clone(),repository:w.repo.clone(),id:uuid::Uuid::new_v4().to_string(),workspace_id:w.id.clone(),from_branch:w.branch.clone(),branch:name.into(),starting_branch:start.into(),head:after.head_oid.clone(),base:after.base_branch.clone().unwrap_or_else(||w.repo.default_branch.clone()),files,treatment:"Switch the complete saved working tree. Every local commit remains in its branch; nothing is sent to GitHub. Uncommitted files, recovery and uncertain remote actions must be resolved first.".into()};
    book.branches.insert(after.branch.clone(), after.clone());
    if book.branches.len() > 64 {
        return Err(transport::budget(
            "branches",
            "local branch count",
            book.branches.len(),
            64,
        ));
    }
    Ok(Plan {
        preview: p,
        before: w,
        after,
        book,
        expected,
        pins,
        target_before,
    })
}
fn fetch_base(repo: &Repository, base: &str, head: Oid) -> Result<Oid> {
    let base: Oid = base.parse()?;
    if repo.find_commit(base).is_err() {
        return Err(Error::Changed);
    }
    repo.merge_base(head, base).map_err(|_| Error::Changed)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    id: String,
    before: Workspace,
    after: Workspace,
    book: Book,
    target_before: Option<String>,
}
pub fn pending(registry: &Registry, id: &str) -> Result<bool> {
    Ok(registry
        .directory(id)?
        .read::<Option<Record>>(JOURNAL)?
        .flatten()
        .is_some())
}
pub fn apply(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    plan: &Plan,
    barrier: impl FnOnce() -> Result<()>,
) -> Result<Workspace> {
    apply_with_hook(registry, api, c, plan, barrier, |_| Ok(()))
}
/// Synthetic fault seam: each numbered hook follows an actual durable boundary.
pub fn apply_with_hook(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    plan: &Plan,
    barrier: impl FnOnce() -> Result<()>,
    mut hook: impl FnMut(usize) -> Result<()>,
) -> Result<Workspace> {
    let dir = registry.directory(&plan.before.id)?;
    let _lock = registry.workspace_lock(&plan.before.id)?;
    let (w, repo) = registry.reopen(&plan.before.id)?;
    check(api, c, &w)?;
    if w != plan.before || clean(registry, &w, &repo)? != plan.expected {
        return Err(Error::Changed);
    }
    for (branch, head) in &plan.pins {
        if api.head(c, &w.repo, branch)?.as_deref() != Some(head) {
            return Err(Error::Changed);
        }
    }
    if plan.after.remote_oid.is_none() && api.head(c, &w.repo, &plan.after.branch)?.is_some() {
        return Err(Error::Changed);
    }
    let target = repo
        .find_reference(&format!("refs/heads/{}", plan.after.branch))
        .ok()
        .and_then(|r| r.target())
        .map(|o| o.to_string());
    if target != plan.target_before {
        return Err(Error::Changed);
    }
    barrier()?;
    let r = Record {
        version: 1,
        id: plan.preview.id.clone(),
        before: w,
        after: plan.after.clone(),
        book: plan.book.clone(),
        target_before: plan.target_before.clone(),
    };
    let stage = registry
        .sources_root()
        .join(format!("branch-stage-{}", r.id));
    fs::create_dir(&stage)?;
    let candidate = transport::tree_files(&repo, r.after.head_oid.parse()?)?;
    if let Err(e) = transport::materialize(&repo, &stage, &candidate) {
        let _ = fs::remove_dir_all(&stage);
        return Err(e);
    }
    if clean(registry, &r.before, &repo)? != plan.expected {
        let _ = fs::remove_dir_all(&stage);
        return Err(Error::Changed);
    }
    if let Err(e) = dir.write(JOURNAL, &Some(r.clone())) {
        if matches!(dir.read::<Option<Record>>(JOURNAL), Ok(None | Some(None))) {
            let _ = fs::remove_dir_all(&stage);
        }
        return Err(e);
    }
    hook(0)?;
    finish(registry, &_lock, &repo, &r, &mut hook)
}
fn finish(
    registry: &Registry,
    lock: &crate::registry::WorkspaceLock,
    repo: &Repository,
    r: &Record,
    hook: &mut impl FnMut(usize) -> Result<()>,
) -> Result<Workspace> {
    crate::uuid_id(&r.id)?;
    if r.version != 1
        || r.before.id != r.after.id
        || r.before.repo != r.after.repo
        || r.before.account_id != r.after.account_id
        || r.before.auth_binding != r.after.auth_binding
        || r.book.version != 1
        || r.book.workspace_id != r.before.id
        || r.book.repo_id != r.before.repo.id
        || r.book.branches.len() > 64
        || r.after.branch == r.after.repo.default_branch
        || r.book.branches.get(&r.after.branch) != Some(&r.after)
    {
        return Err(Error::Recovery);
    }
    let dir = registry.directory(&r.before.id)?;
    let root = registry.checkout(&r.before.id)?;
    let stage = registry
        .sources_root()
        .join(format!("branch-stage-{}", r.id));
    let backup = registry
        .sources_root()
        .join(format!("branch-backup-{}", r.id));
    for path in [&root, &stage, &backup] {
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::Recovery);
        }
    }
    if !backup.exists() && !stage.exists() && registry.get(&r.after.id)? == r.after {
        let target = transport::tree_files(repo, r.after.head_oid.parse()?)?;
        clean_root(&root, &target)?;
        if repo.head()?.target() != Some(r.after.head_oid.parse()?) {
            return Err(Error::Recovery);
        }
        dir.write(JOURNAL, &Option::<Record>::None)?;
        return Ok(r.after.clone());
    }
    if !backup.exists() {
        let target = repo
            .find_reference(&format!("refs/heads/{}", r.after.branch))
            .ok()
            .and_then(|r| r.target())
            .map(|o| o.to_string());
        if target != r.target_before {
            return Err(Error::Recovery);
        }
        if !stage.is_dir() || clean(registry, &r.before, repo).is_err() {
            return Err(Error::Recovery);
        }
        fs::rename(&root, &backup)?;
        fs::File::open(registry.sources_root())?.sync_all()?;
        hook(1)?;
    }
    if stage.exists() {
        if root.exists() {
            return Err(Error::Recovery);
        }
        fs::rename(&stage, &root)?;
        fs::File::open(registry.sources_root())?.sync_all()?;
        hook(2)?;
    }
    let target = transport::tree_files(repo, r.after.head_oid.parse()?)?;
    let current = repository_core::Repository::open(&root).map_err(|_| Error::Recovery)?;
    if operations::disk_files(&current, &target)? != target {
        return Err(Error::Recovery);
    }
    let reference = format!("refs/heads/{}", r.after.branch);
    match repo.find_reference(&reference) {
        Ok(existing) if existing.target() == Some(r.after.head_oid.parse()?) => {}
        Ok(_) => return Err(Error::Recovery),
        Err(e) if e.code() == git2::ErrorCode::NotFound => {
            repo.reference(
                &reference,
                r.after.head_oid.parse()?,
                false,
                "Author selected working branch",
            )?;
        }
        Err(_) => return Err(Error::Storage),
    }
    repo.set_head(&reference)?;
    hook(3)?;
    registry.save_branch_locked(lock, &r.before, &r.after, Some(r.book.clone()), false)?;
    hook(4)?;
    // Original saved bytes remain available in Git. Refuse unexpected backup
    // edits; never silently remove an interrupted writer's data.
    let prior = transport::tree_files(repo, r.before.head_oid.parse()?)?;
    clean_root(&backup, &prior).map_err(|_| Error::Recovery)?;
    fs::remove_dir_all(&backup)?;
    fs::File::open(registry.sources_root())?.sync_all()?;
    hook(5)?;
    dir.write(JOURNAL, &Option::<Record>::None)?;
    Ok(r.after.clone())
}
pub fn recover(registry: &Registry, id: &str) -> Result<Workspace> {
    let dir = registry.directory(id)?;
    let _lock = registry.workspace_lock(id)?;
    registry.recover_metadata_locked(&_lock)?;
    let record = dir
        .read::<Option<Record>>(JOURNAL)?
        .flatten()
        .ok_or(Error::Recovery)?;
    if record.before.id != id {
        return Err(Error::Recovery);
    }
    crate::uuid_id(&record.id)?;
    let root = registry.checkout(id)?;
    let location = if root.exists() {
        root
    } else {
        registry
            .sources_root()
            .join(format!("branch-backup-{}", record.id))
    };
    let repo = transport::open(&dir, &location)?;
    finish(registry, &_lock, &repo, &record, &mut |_| Ok(()))
}
