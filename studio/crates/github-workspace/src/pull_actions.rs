//! Single-PR ready/merge intent and read-only recovery. No async/queue fallback.
use crate::{
    api::{MergePolicy, Provider, PullDetail, StackState},
    auth::{Credential, User},
    journal::Receipt,
    registry::{Registry, Workspace},
    Error, Result,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub detail: PullDetail,
    pub ready_allowed: bool,
    pub merge_allowed: bool,
    pub reason: String,
    pub checks: String,
}
fn identity(w: &Workspace, p: &PullDetail) -> Result<()> {
    let old = w.pr.as_ref().ok_or(Error::Changed)?;
    if p.node_id.is_empty()
        || p.node_id.len() > 256
        || p.node_id.chars().any(char::is_control)
        || !["open", "closed"].contains(&p.pull.state.as_str())
    {
        return Err(Error::Changed);
    }
    if p.pull.number != old.number
        || p.pull.url != format!("{}/pull/{}", w.repo.url(), old.number)
        || p.head_repo_id != w.repo.id
        || p.base_repo_id != w.repo.id
        || p.pull.head != w.branch
        || p.pull.base != old.base
        || p.pull.base != w.base_branch.as_deref().unwrap_or(&w.repo.default_branch)
    {
        return Err(Error::Changed);
    }
    git2::Oid::from_str(&p.head)?;
    git2::Oid::from_str(&p.base)?;
    Ok(())
}
fn bound(api: &dyn Provider, c: &Credential, w: &Workspace) -> Result<()> {
    if !c.valid() || c.account.id != w.account_id || c.binding != w.auth_binding {
        return Err(Error::Account);
    }
    if api.repository_by_id(c, w.repo.id)? != w.repo {
        return Err(Error::Changed);
    }
    Ok(())
}
fn eligibility(
    api: &dyn Provider,
    c: &Credential,
    w: &Workspace,
    p: &PullDetail,
) -> Result<(bool, String)> {
    let reason = if p.pull.merged || p.pull.state != "open" {
        Some("This pull request is closed or merged.")
    } else if p.stack != StackState::Standalone {
        Some("Stack membership is present or unknown. Use Open on GitHub; Heinlein will not merge a stack or rebase other branches.")
    } else if p.pull.draft {
        Some("Mark this draft ready for review as a separate action before merging.")
    } else if p.head != w.head_oid || w.remote_oid.as_deref() != Some(&p.head) {
        Some("Commit and send the intended branch head, then prepare a fresh pull-request preview.")
    } else if p.mergeable != Some(true) || p.merge_state != "clean" {
        Some("GitHub has not established a clean single-PR merge. Required queues, rules, conflicts or unknown state must be handled on GitHub.")
    } else {
        None
    };
    if let Some(reason) = reason {
        return Ok((false, reason.into()));
    }
    let policy = api.merge_policy(c, &w.repo, p)?;
    let proved = matches!(policy,MergePolicy::VerifiedNoBypass{repository_id,account_id,base_ref,base_oid,head_oid} if repository_id==w.repo.id && account_id==c.account.id && base_ref==p.pull.base && base_oid==p.base && head_oid==p.head);
    Ok(if proved {
        (true,"Only this reviewed head may be merged into the named target. No stack, queue, bypass or automatic retry is requested.".into())
    } else {
        (false,"This connection cannot establish that the single-PR endpoint will avoid this account's rule-bypass privileges. Merge is unavailable here; use Open on GitHub. Check details remain unknown, not passing.".into())
    })
}
pub fn status(registry: &Registry, api: &dyn Provider, c: &Credential, id: &str) -> Result<Status> {
    let (w, _) = registry.reopen(id)?;
    crate::branches::local_authorized(registry, &w)?;
    bound(api, c, &w)?;
    let p = api.pull_detail(c, &w.repo, w.pr.as_ref().ok_or(Error::Changed)?.number)?;
    identity(&w, &p)?;
    let (merge_allowed, reason) = eligibility(api, c, &w, &p)?;
    Ok(Status{ready_allowed:p.pull.state=="open"&&!p.pull.merged&&p.pull.draft&&p.stack==StackState::Standalone&&p.head==w.head_oid&&w.remote_oid.as_deref()==Some(&p.head),detail:p,merge_allowed,reason,checks:"Check details are unavailable to this connection. A mergeable result is not a passing-check receipt.".into()})
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub repository: crate::RepoInfo,
    pub account: User,
    pub detail: PullDetail,
    pub method: String,
    pub warning: String,
}
pub struct Plan {
    pub preview: Preview,
    before: Workspace,
    disk: crate::transport::Files,
}
fn ensure_action(
    api: &dyn Provider,
    c: &Credential,
    w: &Workspace,
    p: &PullDetail,
    kind: &str,
) -> Result<()> {
    identity(w, p)?;
    if p.head != w.head_oid
        || w.remote_oid.as_deref() != Some(&p.head)
        || p.pull.state != "open"
        || p.pull.merged
        || p.stack != StackState::Standalone
    {
        return Err(Error::Changed);
    }
    match kind {
        "ready" if p.pull.draft => Ok(()),
        "merge" if eligibility(api, c, w, p)?.0 => Ok(()),
        _ => Err(Error::MergeUnavailable),
    }
}
pub fn preview(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    id: &str,
    kind: &str,
    method: &str,
) -> Result<Plan> {
    if !["ready", "merge"].contains(&kind) || !["merge", "squash", "rebase"].contains(&method) {
        return Err(Error::Unsupported);
    }
    let (w, git) = registry.reopen(id)?;
    let _lock = registry.directory(id)?.lock("workspace.lock")?;
    crate::branches::local_authorized(registry, &w)?;
    bound(api, c, &w)?;
    if crate::journal::receipts(&registry.directory(id)?)?
        .iter()
        .any(|r| r.status == "unknown")
    {
        return Err(Error::Uncertain);
    }
    let p = api.pull_detail(c, &w.repo, w.pr.as_ref().ok_or(Error::Changed)?.number)?;
    ensure_action(api, c, &w, &p, kind)?;
    let tracked = crate::transport::tree_files(&git, w.head_oid.parse()?)?;
    let root =
        repository_core::Repository::open(registry.checkout(id)?).map_err(|_| Error::Storage)?;
    let disk = crate::operations::disk_files(&root, &tracked)?;
    Ok(Plan{preview:Preview{id:uuid::Uuid::new_v4().to_string(),workspace_id:w.id.clone(),kind:kind.into(),repository:w.repo.clone(),account:c.account.clone(),detail:p,method:method.into(),warning:if kind=="ready"{"Mark only this pull request ready for review. This does not merge or send new commits."}else{"Merge only this reviewed head into the named branch. GitHub automation may run. Checks shown as unknown are not green. The API cannot atomically pin the target branch tip or retargeting; it revalidates the head, while the named target can advance. No stack/queue/bypass request or automatic retry."}.into()},before:w,disk})
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    preview: Preview,
    binding: String,
}
fn intent_name(id: &str) -> Result<String> {
    crate::uuid_id(id)?;
    Ok(format!("pull-intent-{id}.json"))
}
fn same_scope(old: &PullDetail, new: &PullDetail) -> bool {
    old.node_id == new.node_id
        && old.head_repo_id == new.head_repo_id
        && old.base_repo_id == new.base_repo_id
        && old.head == new.head
        && old.base == new.base
        && old.pull.number == new.pull.number
        && old.pull.head == new.pull.head
        && old.pull.base == new.pull.base
        && old.pull.url == new.pull.url
        && old.pull.draft == new.pull.draft
        && old.stack == new.stack
}
pub fn apply(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    plan: &Plan,
    barrier: impl FnOnce() -> Result<()>,
) -> Result<Receipt> {
    let dir = registry.directory(&plan.before.id)?;
    let _lock = dir.lock("workspace.lock")?;
    if let Some(receipt) = Receipt::load(&dir, &plan.preview.id)? {
        return Ok(receipt);
    }
    let (w, _) = registry.reopen(&plan.before.id)?;
    crate::branches::local_authorized(registry, &w)?;
    bound(api, c, &w)?;
    if w != plan.before {
        return Err(Error::Changed);
    }
    let fresh = api.pull_detail(c, &w.repo, plan.preview.detail.pull.number)?;
    if !same_scope(&plan.preview.detail, &fresh) {
        return Err(Error::Changed);
    }
    ensure_action(api, c, &w, &fresh, &plan.preview.kind)?;
    let root =
        repository_core::Repository::open(registry.checkout(&w.id)?).map_err(|_| Error::Storage)?;
    if crate::operations::disk_files(&root, &plan.disk)? != plan.disk {
        return Err(Error::Changed);
    }
    barrier()?;
    let intent = Intent {
        version: 1,
        preview: plan.preview.clone(),
        binding: c.binding.clone(),
    };
    dir.write(&intent_name(&plan.preview.id)?, &intent)?;
    let mut receipt = Receipt {
        id: plan.preview.id.clone(),
        workspace_id: w.id.clone(),
        kind: plan.preview.kind.clone(),
        status: "unknown".into(),
        old_head: w.head_oid.clone(),
        head: w.head_oid.clone(),
        branch: w.branch.clone(),
        remote_before: Some(plan.preview.detail.base.clone()),
        url: Some(plan.preview.detail.pull.url.clone()),
        pr_number: Some(plan.preview.detail.pull.number),
        message: Error::Uncertain.to_string(),
    };
    receipt.save(&dir)?;
    let result = if plan.preview.kind == "ready" {
        api.mark_ready(c, &w.repo, &fresh, &plan.preview.id)
    } else {
        api.merge_sync(c, &w.repo, &fresh, &plan.preview.method)
            .map(|_| ())
    };
    if matches!(
        result,
        Err(Error::MergeUnavailable | Error::Permission | Error::Changed)
    ) {
        receipt.status = "failed".into();
        receipt.message="GitHub refused this action. No bypass or alternate endpoint was tried; local writing is unchanged.".into();
        receipt.save(&dir)?;
        return Ok(receipt);
    }
    // Even a successful response needs readback. A timeout/malformed response is
    // reconciled without replay; current state is not proof of which actor wrote.
    finish_readback(registry, api, c, &intent, receipt)
}
fn finish_readback(
    registry: &Registry,
    api: &dyn Provider,
    c: &Credential,
    intent: &Intent,
    mut receipt: Receipt,
) -> Result<Receipt> {
    let dir = registry.directory(&receipt.workspace_id)?;
    let mut w = registry.get(&receipt.workspace_id)?;
    crate::branches::local_authorized(registry, &w)?;
    bound(api, c, &w)?;
    if intent.version != 1
        || intent.binding != c.binding
        || intent.preview.workspace_id != w.id
        || intent.preview.repository != w.repo
        || intent.preview.account.id != c.account.id
        || intent.preview.id != receipt.id
        || intent.preview.kind != receipt.kind
        || intent.preview.detail.head != receipt.head
        || intent.preview.detail.pull.head != receipt.branch
        || receipt.pr_number != Some(intent.preview.detail.pull.number)
    {
        return Err(Error::Account);
    }
    match api.pull_detail(c, &w.repo, intent.preview.detail.pull.number) {
        Ok(actual) => {
            identity(&w, &actual)?;
            if actual.head != intent.preview.detail.head
                || actual.pull.base != intent.preview.detail.pull.base
            {
                return Err(Error::Changed);
            }
            let ready = intent.preview.kind == "ready"
                && !actual.pull.draft
                && actual.pull.state == "open"
                && !actual.pull.merged;
            let merged = intent.preview.kind == "merge"
                && actual.pull.merged
                && actual.merge_commit.is_some();
            if ready || merged {
                receipt.status = "succeeded".into();
                receipt.message=if merged{"GitHub reports this exact PR head merged. No action was retried; local branches and writing are retained."}else{"GitHub reports this pull request ready for review. No action was retried."}.into();
                w.pr = Some(actual.pull);
                registry.save(&w)?;
            } else {
                receipt.message="GitHub has not confirmed this action. Check the pull request again or open it on GitHub; no automatic retry or alternate merge is offered.".into();
            }
        }
        Err(Error::Network | Error::RateLimit) => {}
        Err(e) => return Err(e),
    }
    receipt.save(&dir)?;
    Ok(receipt)
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
    let receipt = Receipt::load(&dir, operation)?.ok_or(Error::Missing)?;
    if receipt.workspace_id != id || !["ready", "merge"].contains(&receipt.kind.as_str()) {
        return Err(Error::Changed);
    }
    if receipt.status != "unknown" {
        return Ok(receipt);
    }
    let intent = dir
        .read::<Intent>(&intent_name(operation)?)?
        .ok_or(Error::Recovery)?;
    finish_readback(registry, api, c, &intent, receipt)
}
