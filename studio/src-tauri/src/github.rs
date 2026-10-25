//! GitHub authority stays native. Renderer plans are single-use, session/epoch bound.
use super::{check_window, guard_auth_repository_separation, BrowserState, Session};
use github_workspace::{
    self as gh,
    api::{HttpGitHub, Provider},
    auth::{Auth, OsStore},
    incoming::{self, IncomingPlan},
    journal,
    operations::{self, Identity},
    registry::{Registry, StateDir, Workspace},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
type Result<T> = std::result::Result<T, String>;
const CLIENT_ID: &str = "Iv23liSDqUlMHOEM7K9n";
const INSTALL: &str = "https://github.com/apps/heinlein-studio";
#[derive(Default)]
pub(crate) struct Host {
    operation: Mutex<()>,
    services: Mutex<Option<Arc<Services>>>,
    plans: Mutex<HashMap<String, Bound>>,
}
impl Host {
    pub(crate) fn close_guard(&self) -> Result<std::sync::MutexGuard<'_, ()>> {
        let guard = self
            .operation
            .try_lock()
            .map_err(|_| "Finish the GitHub operation before quitting")?;
        if let Some(s) = self
            .services
            .lock()
            .map_err(|_| "GitHub is unavailable")?
            .as_ref()
        {
            s.auth.ready_to_quit().map_err(|e| e.to_string())?;
        }
        Ok(guard)
    }
}
struct Services {
    registry: Registry,
    auth: Auth,
    api: HttpGitHub,
}
struct Bound {
    session: Option<String>,
    epoch: u64,
    expires: Instant,
    plan: Plan,
}
enum Plan {
    Repositories(gh::api::RepositoryList, u64, String),
    Open(gh::RepoInfo, u64, String),
    Version(operations::VersionPlan),
    Share(Box<operations::SharePlan>),
    Incoming(Box<IncomingPlan>),
    Branch(Box<gh::branches::Plan>),
    Pull(Box<gh::pull_actions::Plan>),
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Status,
    Connect,
    Poll,
    ConfirmAccount {
        user_id: u64,
    },
    SignOut,
    RetrySaved,
    Repositories,
    PreviewListedRepository {
        list_id: String,
        repository_id: u64,
    },
    OpenLink {
        kind: String,
    },
    PreviewOpen {
        url: String,
    },
    ConfirmOpen {
        preview_id: String,
    },
    Reopen {
        workspace_id: String,
    },
    OpenFeedback {
        repository_id: String,
    },
    Workspace {
        repository_id: String,
    },
    PullStatus {
        repository_id: String,
    },
    PreviewPullAction {
        repository_id: String,
        kind: String,
        method: String,
    },
    Branches {
        repository_id: String,
    },
    PreviewBranch {
        repository_id: String,
        starting_branch: String,
        name: String,
        create: bool,
    },
    PreviewVersion {
        repository_id: String,
        paths: Vec<String>,
        identity: Identity,
        message: String,
    },
    PreviewShare {
        repository_id: String,
        kind: String,
        title: String,
        body: String,
    },
    PreviewIncoming {
        repository_id: String,
        target: String,
    },
    Resolve {
        repository_id: String,
        preview_id: String,
        conflict_id: String,
        resolution: incoming::Resolution,
    },
    Confirm {
        repository_id: String,
        preview_id: String,
        identity: Option<Identity>,
    },
    Reconcile {
        repository_id: String,
        operation_id: String,
    },
    Recover {
        workspace_id: String,
        operation_id: Option<String>,
    },
    PreviewRebind {
        workspace_id: String,
    },
    FreshBranch {
        repository_id: String,
    },
    Cancel {
        preview_id: String,
    },
}
fn public_client(override_id: Option<String>) -> Result<String> {
    let s = override_id.unwrap_or_else(|| CLIENT_ID.into());
    if s.len() > 128 || !s.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("GitHub connection configuration is unavailable".into());
    }
    Ok(s)
}
fn data(app: &tauri::AppHandle) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|_| "GitHub storage is unavailable".into())
}
fn registry(app: &tauri::AppHandle) -> Result<Registry> {
    let p = data(app)?;
    Registry::open(&p.join("github-state-v1"), &p.join("github-sources-v1"))
        .map_err(|e| e.to_string())
}
fn services(app: &tauri::AppHandle) -> Result<Arc<Services>> {
    let state = app.state::<BrowserState>();
    let mut slot = state
        .github
        .services
        .lock()
        .map_err(|_| "GitHub is unavailable")?;
    if let Some(s) = slot.as_ref() {
        return Ok(s.clone());
    }
    let registry = registry(app)?;
    let client = public_client(std::env::var("HEINLEIN_GITHUB_CLIENT_ID").ok()).unwrap_or_default();
    let auth = Auth::new(
        client,
        Arc::new(
            OsStore::new(&format!("{}.github", app.config().identifier))
                .map_err(|e| e.to_string())?,
        ),
        StateDir::open(&data(app)?.join("github-auth-v1")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let s = Arc::new(Services {
        registry,
        auth,
        api: HttpGitHub::new().map_err(|e| e.to_string())?,
    });
    *slot = Some(s.clone());
    Ok(s)
}
/// Checked without opening a credential store. No private state can be selected as source.
pub(crate) fn selection(app: &tauri::AppHandle, path: &Path) -> Result<Option<Workspace>> {
    let root = path.canonicalize().map_err(|_| "Folder is unavailable")?;
    let d = data(app)?;
    for name in [
        "github-state-v1",
        "github-auth-v1",
        "chatgpt-auth",
        "draft-recovery-v1",
        "standalone-drafts-v1",
        "pending-proposals-v1",
        "proposal-receipts-v1",
        "first-story-v1",
        "drafting-state-v1",
    ] {
        guard_auth_repository_separation(&root, &d.join(name))?;
    }
    let sources = super::resolved_future_path(&d.join("github-sources-v1"))?;
    if root.starts_with(&sources) || sources.starts_with(&root) {
        let r = registry(app)?;
        let w = r
            .list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| r.checkout(&w.id).ok().as_deref() == Some(root.as_path()))
            .ok_or("Open this GitHub project from Heinlein's GitHub list")?;
        r.reopen(&w.id).map_err(|e| e.to_string())?;
        return Ok(Some(w));
    }
    Ok(None)
}
pub(crate) fn edit_lock(app: &tauri::AppHandle, root: &Path) -> Result<Option<gh::registry::Lock>> {
    let d = data(app)?;
    let sources = super::resolved_future_path(&d.join("github-sources-v1"))?;
    if !root.starts_with(&sources) {
        return Ok(None);
    }
    let r = registry(app)?;
    let w = r
        .list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| r.checkout(&w.id).ok().as_deref() == Some(root))
        .ok_or("Unknown managed project")?;
    let lock = r
        .directory(&w.id)
        .and_then(|d| d.lock("workspace.lock"))
        .map_err(|e| e.to_string())?;
    r.reopen(&w.id).map_err(|e| e.to_string())?;
    Ok(Some(lock))
}
fn selected(
    app: &tauri::AppHandle,
    s: &Services,
    session: &str,
) -> Result<(Workspace, Arc<repository_core::Repository>)> {
    let state = app.state::<BrowserState>();
    let selected = state
        .selected
        .lock()
        .map_err(|_| "Project is unavailable")?;
    let selected = selected
        .as_ref()
        .filter(|p| p.id == session)
        .ok_or("Project changed; reopen GitHub controls")?;
    let w = s
        .registry
        .list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| s.registry.checkout(&w.id).ok().as_deref() == Some(selected.repo.root()))
        .ok_or("Open a GitHub project first")?;
    s.registry.reopen(&w.id).map_err(|e| e.to_string())?;
    Ok((w, selected.repo.clone()))
}
fn current(state: &BrowserState, epoch: u64) -> Result<()> {
    if state.unsaved_changes.load(Ordering::SeqCst) || state.mutation_gate.generation() != epoch {
        Err("Your writing changed. Save it and prepare this action again.".into())
    } else {
        Ok(())
    }
}
fn put(
    app: &tauri::AppHandle,
    id: String,
    session: Option<String>,
    epoch: u64,
    plan: Plan,
) -> Result<()> {
    let state = app.state::<BrowserState>();
    let mut plans = state
        .github
        .plans
        .lock()
        .map_err(|_| "GitHub preview unavailable")?;
    plans.clear();
    plans.insert(
        id,
        Bound {
            session,
            epoch,
            expires: Instant::now() + Duration::from_secs(300),
            plan,
        },
    );
    Ok(())
}
fn binding_matches(b: &Bound, session: Option<&str>) -> bool {
    b.session.as_deref() == session && b.expires >= Instant::now()
}
fn take(app: &tauri::AppHandle, id: &str, session: Option<&str>) -> Result<Bound> {
    let state = app.state::<BrowserState>();
    let b = state
        .github
        .plans
        .lock()
        .map_err(|_| "GitHub preview unavailable")?
        .remove(id)
        .ok_or("Prepare this GitHub action again")?;
    if !binding_matches(&b, session) {
        return Err("GitHub preview expired or project changed".into());
    }
    Ok(b)
}
fn confirm(app: &tauri::AppHandle, title: &str, message: String) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}
fn serialized(v: impl Serialize) -> Result<Value> {
    serde_json::to_value(v).map_err(|_| "GitHub response unavailable".into())
}
fn listed_repository<'a>(
    list: &'a gh::api::RepositoryList,
    id: u64,
    account: u64,
    binding: &str,
    user: &gh::auth::User,
    current_binding: &str,
) -> Result<&'a gh::RepoInfo> {
    if account != user.id || binding != current_binding {
        return Err("GitHub account changed. Refresh the repository list.".into());
    }
    list.repositories
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "Choose a repository from a fresh list.".into())
}
fn open(app: &tauri::AppHandle, s: &Services, w: &Workspace) -> Result<Session> {
    s.registry.reopen(&w.id).map_err(|e| e.to_string())?;
    super::select(app, s.registry.checkout(&w.id).map_err(|e| e.to_string())?)
}
fn dispatch(app: &tauri::AppHandle, request: Request) -> Result<Value> {
    let state = app.state::<BrowserState>();
    let _operation = state
        .github
        .operation
        .try_lock()
        .map_err(|_| "Another GitHub operation is running")?;
    if state.quitting.load(Ordering::SeqCst) {
        return Err("Heinlein is quitting".into());
    }
    state.mutation_gate.note_activity();
    let started = state.mutation_gate.generation();
    if let Request::Cancel { preview_id } = request {
        state
            .github
            .plans
            .lock()
            .map_err(|_| "GitHub preview unavailable")?
            .remove(&preview_id);
        return Ok(Value::Null);
    }
    if let Request::OpenLink { kind } = request {
        let url = match kind.as_str() {
            "install" => INSTALL,
            "device" => "https://github.com/login/device",
            _ => return Err("Unknown GitHub link".into()),
        };
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "Open GitHub in your browser")?;
        return Ok(Value::Null);
    }
    // Opening an existing managed copy works even when auth/configuration is unavailable.
    if let Request::Reopen { workspace_id } = request {
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another project operation is running")?;
        let r = registry(app)?;
        let (w, _) = r.reopen(&workspace_id).map_err(|e| e.to_string())?;
        return serialized(super::select(
            app,
            r.checkout(&w.id).map_err(|e| e.to_string())?,
        )?);
    }
    if let Request::Recover {
        workspace_id,
        operation_id,
    } = request
    {
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another project operation is running")?;
        let _mutation = state.mutation_gate.author_operation()?;
        let epoch = state.mutation_gate.generation();
        current(&state, epoch)?;
        let r = registry(app)?;
        let w = r.get(&workspace_id).map_err(|e| e.to_string())?;
        if !confirm(app,"Recover GitHub project",format!("Recover the interrupted local operation for {}/{}? Known original files are restored, or an already completed version is retained. Changed external files are never overwritten. Nothing is sent to GitHub.",w.repo.owner,w.repo.name)){return Ok(Value::Null)}
        current(&state, epoch)?;
        let metadata_pending = r
            .metadata_pending(&workspace_id)
            .map_err(|e| e.to_string())?;
        if metadata_pending {
            r.recover_metadata(&workspace_id)
                .map_err(|e| e.to_string())?;
        }
        if let Some(id) = operation_id {
            operations::recover_local_version(&r, &workspace_id, &id).map_err(|e| e.to_string())?;
        } else if gh::branches::pending(&r, &workspace_id).map_err(|e| e.to_string())? {
            gh::branches::recover(&r, &workspace_id).map_err(|e| e.to_string())?;
        } else if incoming::pending(&r, &workspace_id).map_err(|e| e.to_string())? {
            incoming::rollback(&r, &workspace_id).map_err(|e| e.to_string())?;
        } else if operations::branch_pending(&r, &workspace_id).map_err(|e| e.to_string())? {
            operations::recover_branch(&r, &workspace_id).map_err(|e| e.to_string())?;
        }
        state.mutation_gate.invalidate();
        return Ok(Value::Null);
    }
    if let Request::Status = request {
        let r = registry(app)?;
        let workspaces=r.list().map_err(|e|e.to_string())?.into_iter().map(|w|{let error=r.reopen(&w.id).err().map(|e|e.to_string());let receipts=r.directory(&w.id).and_then(|d|journal::receipts(&d)).map_err(|e|e.to_string())?;Ok(json!({"workspace":w,"error":error,"incomingRecovery":incoming::pending(&r,&w.id).map_err(|e|e.to_string())?,"branchRecovery":(operations::branch_pending(&r,&w.id).map_err(|e|e.to_string())? || gh::branches::pending(&r,&w.id).map_err(|e|e.to_string())? || r.metadata_pending(&w.id).map_err(|e|e.to_string())?),"receipts":receipts}))}).collect::<Result<Vec<_>>>()?;
        let (auth, error) =
            match services(app).and_then(|s| s.auth.view().map_err(|e| e.to_string())) {
                Ok(a) => (Some(a), None),
                Err(e) => (None, Some(e)),
            };
        return Ok(
            json!({"auth":auth,"error":error,"workspaces":workspaces,"app":{"id":5412628,"clientId":CLIENT_ID,"slug":"heinlein-studio","owner":"Arcadesys","installUrl":INSTALL}}),
        );
    }
    let s = services(app)?;
    match request {
        Request::Repositories => {
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            let list = s.api.repositories(&c).map_err(|e| match e {
                gh::Error::Limit => "The repository list is too large to load safely. You can still paste a repository URL below.".into(),
                gh::Error::Permission => "GitHub denied repository access. Check the selected repositories, organization approval or SSO on GitHub, then refresh the list.".into(),
                other => other.to_string(),
            })?;
            current(&state, started)?;
            let id = super::id();
            let view = json!({"id":id,"account":c.account,"repositories":list.repositories,"unavailable":list.unavailable});
            put(
                app,
                id,
                None,
                started,
                Plan::Repositories(list, c.account.id, c.binding.clone()),
            )?;
            Ok(view)
        }
        Request::PreviewListedRepository {
            list_id,
            repository_id,
        } => {
            let bound = take(app, &list_id, None)?;
            current(&state, bound.epoch)?;
            let Plan::Repositories(list, account, binding) = bound.plan else {
                return Err("Refresh the repository list before choosing a project".into());
            };
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            let selected = listed_repository(
                &list,
                repository_id,
                account,
                &binding,
                &c.account,
                &c.binding,
            )?;
            let repo = s
                .api
                .repository_by_id(&c, selected.id)
                .map_err(|e| e.to_string())?;
            if &repo != selected {
                return Err(
                    "Repository access or details changed. Refresh the repository list.".into(),
                );
            }
            current(&state, bound.epoch)?;
            let id = super::id();
            let view = json!({"id":id,"repository":repo,"account":c.account,"treatment":"A separate copy on this computer. Saving stays local until you explicitly send versions to GitHub."});
            put(
                app,
                id,
                None,
                started,
                Plan::Open(repo, c.account.id, c.binding.clone()),
            )?;
            Ok(view)
        }
        Request::RetrySaved => serialized(s.auth.retry_saved().map_err(|e| e.to_string())?),
        Request::Connect => serialized(
            s.auth
                .begin(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?,
        ),
        Request::Poll => serialized(
            s.auth
                .poll(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?,
        ),
        Request::ConfirmAccount { user_id } => {
            let a = s.auth.view().map_err(|e| e.to_string())?;
            let user = a
                .account
                .filter(|u| u.id == user_id)
                .ok_or("GitHub account changed")?;
            if !confirm(app,"Use GitHub account",format!("Use GitHub account {} (ID {}) for GitHub projects? This is separate from your writing assistant account.",user.login,user.id)){return Ok(Value::Null)}
            serialized(s.auth.confirm(user_id).map_err(|e| e.to_string())?)
        }
        Request::SignOut => {
            state
                .github
                .plans
                .lock()
                .map_err(|_| "GitHub unavailable")?
                .clear();
            serialized(s.auth.sign_out().map_err(|e| e.to_string())?)
        }
        Request::PreviewOpen { url } => {
            let (owner, name) = gh::locator(&url).map_err(|e| e.to_string())?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            let repo = s
                .api
                .repository(&c, &owner, &name)
                .map_err(|e| e.to_string())?;
            let token = super::id();
            let view = json!({"id":token,"repository":repo,"account":c.account,"treatment":"A separate copy on this computer. Saving stays local until you explicitly send versions to GitHub."});
            put(
                app,
                token,
                None,
                started,
                Plan::Open(repo, c.account.id, c.binding.clone()),
            )?;
            Ok(view)
        }
        Request::ConfirmOpen { preview_id } => {
            let b = take(app, &preview_id, None)?;
            let Plan::Open(repo, account, binding) = b.plan else {
                return Err("Wrong GitHub preview".into());
            };
            if !confirm(app,"Open GitHub project",format!("Open {}/{} ({}) as a separate copy on this computer? No existing manuscript folder is replaced.",repo.owner,repo.name,if repo.private{"private"}else{"public"})){return Ok(Value::Null)}
            let _selection = state
                .selection_gate
                .try_lock()
                .map_err(|_| "Another project operation is running")?;
            let _mutation = state.mutation_gate.author_operation()?;
            current(&state, b.epoch)?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            if c.account.id != account
                || c.binding != binding
                || s.api
                    .repository_by_id(&c, repo.id)
                    .map_err(|e| e.to_string())?
                    != repo
            {
                return Err("GitHub repository changed; preview it again".into());
            }
            let w = s
                .registry
                .register(repo.clone(), c.account.id, &c.binding, |git| {
                    let head =
                        gh::transport::fetch(git, &repo.clone_url(), &repo.default_branch, &c)?;
                    if s.api.repository_by_id(&c, repo.id)? != repo
                        || s.api.head(&c, &repo, &repo.default_branch)?.as_deref()
                            != Some(&head.to_string())
                    {
                        return Err(gh::Error::Changed);
                    }
                    Ok(head)
                })
                .map_err(|e| e.to_string())?;
            serialized(open(app, &s, &w)?)
        }
        Request::OpenFeedback { repository_id } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            let pr =
                w.pr.ok_or("No feedback request is recorded for this branch")?;
            if pr.url != format!("{}/pull/{}", w.repo.url(), pr.number) || pr.number == 0 {
                return Err("Refresh the GitHub project before opening feedback".into());
            }
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(pr.url, None::<&str>)
                .map_err(|_| "Open the feedback request on GitHub".to_string())?;
            Ok(Value::Null)
        }
        Request::Workspace { repository_id } => {
            let (w, root) = selected(app, &s, &repository_id)?;
            let (_, git) = s.registry.reopen(&w.id).map_err(|e| e.to_string())?;
            let tracked =
                gh::transport::tree_files(&git, w.head_oid.parse().map_err(|_| "Invalid version")?)
                    .map_err(|e| e.to_string())?;
            let disk = operations::disk_files(&root, &tracked).map_err(|e| e.to_string())?;
            serialized(
                json!({"workspace":w,"changes":operations::changes(&tracked,&disk),"receipts":journal::receipts(&s.registry.directory(&w.id).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?}),
            )
        }
        Request::PullStatus { repository_id } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            serialized(
                gh::pull_actions::status(&s.registry, &s.api, &c, &w.id)
                    .map_err(|e| e.to_string())?,
            )
        }
        Request::PreviewPullAction {
            repository_id,
            kind,
            method,
        } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            current(&state, started)?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            let p = gh::pull_actions::preview(&s.registry, &s.api, &c, &w.id, &kind, &method)
                .map_err(|e| e.to_string())?;
            let view = serialized(&p.preview)?;
            put(
                app,
                p.preview.id.clone(),
                Some(repository_id),
                started,
                Plan::Pull(Box::new(p)),
            )?;
            Ok(view)
        }
        Request::Branches { repository_id } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            serialized(
                gh::branches::choices(&s.registry, &s.api, &c, &w.id).map_err(|e| e.to_string())?,
            )
        }
        Request::PreviewBranch {
            repository_id,
            starting_branch,
            name,
            create,
        } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            current(&state, started)?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            let p = gh::branches::preview(
                &s.registry,
                &s.api,
                &c,
                &w.id,
                &starting_branch,
                &name,
                create,
                |git, branch| gh::transport::fetch(git, &w.repo.clone_url(), branch, &c),
            )
            .map_err(|e| e.to_string())?;
            let view = serialized(&p.preview)?;
            put(
                app,
                p.preview.id.clone(),
                Some(repository_id),
                started,
                Plan::Branch(Box::new(p)),
            )?;
            Ok(view)
        }
        Request::PreviewVersion {
            repository_id,
            paths,
            identity,
            message,
        } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            current(&state, state.mutation_gate.generation())?;
            let p = operations::version_preview(&s.registry, &w.id, paths, identity, message)
                .map_err(|e| e.to_string())?;
            let v = serialized(&p.preview)?;
            put(
                app,
                p.preview.id.clone(),
                Some(repository_id),
                started,
                Plan::Version(p),
            )?;
            Ok(v)
        }
        Request::PreviewShare {
            repository_id,
            kind,
            title,
            body,
        } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            current(&state, state.mutation_gate.generation())?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            let p = operations::share_preview(&s.registry, &s.api, &c, &w.id, &kind, title, body)
                .map_err(|e| e.to_string())?;
            let v = serialized(&p.preview)?;
            put(
                app,
                p.preview.id.clone(),
                Some(repository_id),
                started,
                Plan::Share(Box::new(p)),
            )?;
            Ok(v)
        }
        Request::PreviewIncoming {
            repository_id,
            target,
        } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            if c.account.id != w.account_id
                || c.binding != w.auth_binding
                || s.api
                    .repository_by_id(&c, w.repo.id)
                    .map_err(|e| e.to_string())?
                    != w.repo
            {
                return Err("Confirm the GitHub account and repository again".into());
            }
            let branch = w.incoming_branch(&target).map_err(|e| e.to_string())?;
            let (_, git) = s.registry.reopen(&w.id).map_err(|e| e.to_string())?;
            let head = gh::transport::fetch(&git, &w.repo.clone_url(), &branch, &c)
                .map_err(|e| e.to_string())?;
            let p = IncomingPlan::create(&s.registry, &w.id, head, branch)
                .map_err(|e| e.to_string())?;
            let v = serialized(&p.preview)?;
            put(
                app,
                p.preview.id.clone(),
                Some(repository_id),
                started,
                Plan::Incoming(Box::new(p)),
            )?;
            Ok(v)
        }
        Request::Resolve {
            repository_id,
            preview_id,
            conflict_id,
            resolution,
        } => {
            let mut b = take(app, &preview_id, Some(&repository_id))?;
            current(&state, b.epoch)?;
            selected(app, &s, &repository_id)?;
            let Plan::Incoming(ref mut p) = b.plan else {
                return Err("Wrong GitHub preview".into());
            };
            let v = p.resolve(&conflict_id, resolution);
            state
                .github
                .plans
                .lock()
                .map_err(|_| "GitHub preview unavailable")?
                .insert(preview_id, b);
            serialized(v.map_err(|e| e.to_string())?)
        }
        Request::Confirm {
            repository_id,
            preview_id,
            identity,
        } => {
            let b = take(app, &preview_id, Some(&repository_id))?;
            let (w, root) = selected(app, &s, &repository_id)?;
            current(&state, b.epoch)?;
            let describe = |files: &[operations::FileChange]| {
                files
                    .iter()
                    .map(|f| format!("{} {}", f.kind, f.path))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let (title, message) = match &b.plan {
                Plan::Version(p) => {
                    let message=format!("Save only these files as a local version?\n{}\nAuthor: {} <{}>\nMessage: {}\nNothing is sent to GitHub.",
                        describe(&p.preview.files),p.preview.identity.name,p.preview.identity.email,p.preview.message);
                    ("Save local version", message)
                }
                Plan::Share(p) => {
                    let prompt = if p.preview.kind == "push" {
                        "Send these local versions?"
                    } else {
                        if p.preview.kind == "feedback" { "Create a draft feedback request?" } else { "Create a pull request ready for review?" }
                    };
                    let visibility = if w.repo.private { "private" } else { "public" };
                    let message=format!("{}\nAccount: {}\nRepository: {}/{} ({})\nBranch: {}\nBase: {}\n{} commits\nFiles:\n{}\nTitle: {}\nBody: {}\n{}",
                        prompt,p.preview.account.login,w.repo.owner,w.repo.name,visibility,w.branch,p.preview.base,p.preview.commits.len(),
                        describe(&p.preview.files),p.preview.title,p.preview.body,p.preview.warning);
                    ("Send to GitHub", message)
                }
                Plan::Pull(p) => ("Confirm pull request action",format!("Action: {}\nAccount: {}\nRepository: {}/{}\nPR: #{}\nHead: {} ({})\nTarget: {} ({})\nMethod: {}\n{}",p.preview.kind,p.preview.account.login,p.preview.repository.owner,p.preview.repository.name,p.preview.detail.pull.number,p.preview.detail.pull.head,p.preview.detail.head,p.preview.detail.pull.base,p.preview.detail.base,p.preview.method,p.preview.warning)),
                Plan::Branch(p)=>{
                    ("Switch local Git branch",format!("Account: {}\nRepository: {}/{}\nFrom: {}\nWorking branch: {}\nStarting branch: {}\nCommit: {}\nTarget for future PR: {}\nFiles:\n{}\n{}",p.preview.account.login,p.preview.repository.owner,p.preview.repository.name,p.preview.from_branch,p.preview.branch,p.preview.starting_branch,p.preview.head,p.preview.base,describe(&p.preview.files),p.preview.treatment))
                }
                Plan::Incoming(p) => {
                    let author = identity
                        .as_ref()
                        .ok_or("Confirm your version name and email")?;
                    author.validate().map_err(|e| e.to_string())?;
                    let message=format!("Apply this reviewed batch as a local version?\n{}\nAuthor: {} <{}>\nNothing is sent automatically.",
                        describe(&p.preview.files),author.name,author.email);
                    ("Apply reviewed GitHub changes", message)
                }
                _ => return Err("Wrong GitHub preview".into()),
            };
            if !confirm(app, title, message) {
                return Ok(Value::Null);
            }
            let _selection = state
                .selection_gate
                .try_lock()
                .map_err(|_| "Another project operation is running")?;
            let _mutation = state.mutation_gate.author_operation()?;
            current(&state, b.epoch)?;
            selected(app, &s, &repository_id)?;
            let recovery = super::recovery_store(app)?;
            let check = || current(&state, b.epoch);
            let v = match b.plan {
                Plan::Pull(p) => {
                    let tracked = gh::transport::tree_files(
                        &s.registry.reopen(&w.id).map_err(|e| e.to_string())?.1,
                        w.head_oid.parse().map_err(|_| "Invalid version")?,
                    )
                    .map_err(|e| e.to_string())?;
                    let paths = tracked
                        .keys()
                        .filter(|p| p.as_str() != "ms/manuscript.json")
                        .cloned()
                        .collect::<Vec<_>>();
                    root.check_workspace_clean(&paths, &recovery)
                        .map_err(|e| e.to_string())?;
                    let c = s
                        .auth
                        .credential(&s.api, gh::auth::now())
                        .map_err(|e| e.to_string())?;
                    serialized(
                        gh::pull_actions::apply(&s.registry, &s.api, &c, &p, || {
                            check().map_err(|_| gh::Error::Changed)
                        })
                        .map_err(|e| e.to_string())?,
                    )
                }
                Plan::Branch(p) => {
                    let paths = gh::transport::tree_files(
                        &s.registry.reopen(&w.id).map_err(|e| e.to_string())?.1,
                        w.head_oid.parse().map_err(|_| "Invalid version")?,
                    )
                    .map_err(|e| e.to_string())?
                    .keys()
                    .filter(|p| p.as_str() != "ms/manuscript.json")
                    .cloned()
                    .collect::<Vec<_>>();
                    root.check_workspace_clean(&paths, &recovery)
                        .map_err(|e| e.to_string())?;
                    let c = s
                        .auth
                        .credential(&s.api, gh::auth::now())
                        .map_err(|e| e.to_string())?;
                    let next = gh::branches::apply(&s.registry, &s.api, &c, &p, || {
                        check().map_err(|_| gh::Error::Changed)
                    })
                    .map_err(|e| e.to_string())?;
                    serialized(open(app, &s, &next)?)
                }
                Plan::Version(p) => serialized(
                    operations::commit_version(&s.registry, &p, |paths| {
                        check().map_err(|_| gh::Error::Changed)?;
                        let paths = paths
                            .iter()
                            .filter(|p| p.as_str() != "ms/manuscript.json")
                            .cloned()
                            .collect::<Vec<_>>();
                        root.check_workspace_clean(&paths, &recovery)
                            .map_err(|_| gh::Error::Recovery)
                    })
                    .map_err(|e| e.to_string())?,
                ),
                Plan::Share(p) => {
                    let (_, git) = s.registry.reopen(&w.id).map_err(|e| e.to_string())?;
                    let tracked = gh::transport::tree_files(
                        &git,
                        w.head_oid.parse().map_err(|_| "Invalid version")?,
                    )
                    .map_err(|e| e.to_string())?;
                    let paths = tracked
                        .keys()
                        .filter(|p| {
                            operations::author_path(p) && p.as_str() != "ms/manuscript.json"
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    root.check_workspace_clean(&paths, &recovery)
                        .map_err(|e| e.to_string())?;
                    let c = s
                        .auth
                        .credential(&s.api, gh::auth::now())
                        .map_err(|e| e.to_string())?;
                    check()?;
                    serialized(
                        operations::send(&s.registry, &s.api, &c, &p, |git, w, c| {
                            let authority = gh::branches::authority(&s.registry, w, c)?;
                            gh::transport::push(git, c, &authority)
                        })
                        .map_err(|e| e.to_string())?,
                    )
                }
                Plan::Incoming(p) => {
                    let c = s
                        .auth
                        .credential(&s.api, gh::auth::now())
                        .map_err(|e| e.to_string())?;
                    serialized(
                        incoming::apply(
                            &s.registry,
                            &s.api,
                            &c,
                            &p,
                            identity.ok_or("Confirm version identity")?,
                            &recovery,
                            |_| check().map_err(|_| repository_core::Error::EditorChanged),
                        )
                        .map_err(|e| e.to_string())?,
                    )
                }
                _ => unreachable!(),
            };
            state.mutation_gate.invalidate();
            v
        }
        Request::Reconcile {
            repository_id,
            operation_id,
        } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            serialized(
                {
                    let dir = s.registry.directory(&w.id).map_err(|e| e.to_string())?;
                    let receipt = journal::Receipt::load(&dir, &operation_id)
                        .map_err(|e| e.to_string())?
                        .ok_or("Operation not found")?;
                    if ["ready", "merge"].contains(&receipt.kind.as_str()) {
                        gh::pull_actions::reconcile(&s.registry, &s.api, &c, &w.id, &operation_id)
                    } else {
                        operations::reconcile(&s.registry, &s.api, &c, &w.id, &operation_id)
                    }
                }
                .map_err(|e| e.to_string())?,
            )
        }
        Request::PreviewRebind { workspace_id } => {
            let w = s.registry.get(&workspace_id).map_err(|e| e.to_string())?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            let repo = s
                .api
                .repository_by_id(&c, w.repo.id)
                .map_err(|e| e.to_string())?;
            if !confirm(app,"Confirm GitHub project account",format!("Use {} for {}/{} ({})? The immutable repository ID remains {}. Local writing and its folder stay in place.",c.account.login,repo.owner,repo.name,if repo.private{"private"}else{"public"},repo.id)){return Ok(Value::Null)}
            serialized(
                operations::rebind(&s.registry, &s.api, &c, &workspace_id, &repo)
                    .map_err(|e| e.to_string())?,
            )
        }
        Request::FreshBranch { repository_id } => {
            let (w, _) = selected(app, &s, &repository_id)?;
            let epoch = state.mutation_gate.generation();
            current(&state, epoch)?;
            if !confirm(app,"Start fresh feedback branch",format!("Keep your local versions and start a new working branch for {}/{} after closed or merged feedback? No remote branch is deleted or sent.",w.repo.owner,w.repo.name)){return Ok(Value::Null)}
            let _selection = state
                .selection_gate
                .try_lock()
                .map_err(|_| "Project operation running")?;
            let _mutation = state.mutation_gate.author_operation()?;
            current(&state, epoch)?;
            selected(app, &s, &repository_id)?;
            let c = s
                .auth
                .credential(&s.api, gh::auth::now())
                .map_err(|e| e.to_string())?;
            serialized(
                operations::fresh_branch(&s.registry, &s.api, &c, &w.id)
                    .map_err(|e| e.to_string())?,
            )
        }
        _ => Err("Unsupported GitHub action".into()),
    }
}
#[tauri::command]
pub(crate) async fn github_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<Value> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, request))
        .await
        .map_err(|_| {
            String::from("GitHub operation interrupted; check its receipt before trying again")
        })?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_configuration_override_missing_and_invalid() {
        assert_eq!(public_client(None).unwrap(), CLIENT_ID);
        assert_eq!(public_client(Some(String::new())).unwrap(), "");
        assert!(public_client(Some("secret/invalid".into())).is_err());
    }
    #[test]
    fn confirmation_rejects_edits_even_after_save() {
        let state = BrowserState::default();
        let epoch = state.mutation_gate.generation();
        assert!(current(&state, epoch).is_ok());
        state.unsaved_changes.store(true, Ordering::SeqCst);
        assert!(current(&state, epoch).is_err());
        state.unsaved_changes.store(false, Ordering::SeqCst);
        state.mutation_gate.invalidate();
        assert!(current(&state, epoch).is_err());
    }
}
#[cfg(test)]
mod authority_tests {
    use super::*;
    #[test]
    fn repository_choice_is_bound_to_native_list_account_and_connection() {
        let Plan::Open(repo, _, _) = bound().plan else {
            panic!()
        };
        let list = gh::api::RepositoryList {
            repositories: vec![repo],
            unavailable: 0,
        };
        let user = gh::auth::User {
            id: 9,
            login: "writer".into(),
        };
        assert_eq!(
            listed_repository(&list, 42, 9, "binding", &user, "binding")
                .unwrap()
                .id,
            42
        );
        assert!(listed_repository(&list, 43, 9, "binding", &user, "binding").is_err());
        assert!(listed_repository(&list, 42, 10, "binding", &user, "binding").is_err());
        assert!(listed_repository(&list, 42, 9, "old-connection", &user, "binding").is_err());
    }
    fn bound() -> Bound {
        Bound {
            session: Some("opaque-session".into()),
            epoch: 0,
            expires: Instant::now() + Duration::from_secs(30),
            plan: Plan::Open(
                gh::RepoInfo {
                    id: 42,
                    owner: "example".into(),
                    name: "story".into(),
                    private: true,
                    default_branch: "main".into(),
                    installation_id: 7,
                },
                9,
                "native-binding".into(),
            ),
        }
    }
    #[test]
    fn preview_binding_rejects_wrong_session_and_expiration() {
        let mut b = bound();
        assert!(binding_matches(&b, Some("opaque-session")));
        assert!(!binding_matches(&b, Some("other-session")));
        assert!(!binding_matches(&b, None));
        b.expires = Instant::now() - Duration::from_secs(1);
        assert!(!binding_matches(&b, Some("opaque-session")));
    }
    #[test]
    fn renderer_command_uses_camel_case_ids_and_rejects_roots_or_credentials() {
        let r:Request=serde_json::from_value(json!({"action":"previewVersion","repositoryId":"opaque-session","paths":["story.md"],"identity":{"name":"Writer","email":"privacy@example.test"},"message":"Version"})).unwrap();
        assert!(
            matches!(r,Request::PreviewVersion{repository_id,..} if repository_id=="opaque-session")
        );
        for extra in ["root", "token", "gitArgs"] {
            let mut request = json!({"action":"reopen","workspaceId":"opaque-workspace"});
            request[extra] = json!("forbidden");
            assert!(serde_json::from_value::<Request>(request).is_err());
        }
    }
}
