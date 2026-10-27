//! Project inventory and hints, never manuscript/Git/account authority.
use crate::{id, recents::RecentStore};
use github_workspace::registry::{Registry, StateDir, Workspace};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
type Result<T> = std::result::Result<T, String>;
const RECORD: &str = "library-v1.json";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RootId {
    device: u64,
    inode: u64,
}
#[cfg(unix)]
fn root_id(path: &Path) -> Result<RootId> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path).map_err(|_| "Writing folder is missing")?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err("Writing folder is unavailable".into());
    }
    Ok(RootId {
        device: m.dev(),
        inode: m.ino(),
    })
}
#[cfg(not(unix))]
fn root_id(_: &Path) -> Result<RootId> {
    Err("Project locations are unsupported on this platform".into())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Location {
    Local {
        root: PathBuf,
        identity: Option<RootId>,
    },
    Managed {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Resume {
    pub path: String,
    pub source_hash: String,
    pub scene_id: Option<String>,
    pub anchor: usize,
    pub head: usize,
    pub scroll_top: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Project {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub location: Location,
    pub resume: Option<Resume>,
    #[serde(default)]
    pub last_used: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Library {
    schema_version: u32,
    revision: u64,
    legacy_imported: bool,
    projects: Vec<Project>,
}
impl Default for Library {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            legacy_imported: false,
            projects: vec![],
        }
    }
}
pub(crate) struct Store {
    dir: StateDir,
}
fn label(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.len() > 240 || name.chars().any(char::is_control) {
        Err("Use a project name of 1–240 bytes without control characters".into())
    } else {
        Ok(())
    }
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            dir: StateDir::open(path).map_err(|_| "Project library unavailable")?,
        })
    }
    fn load(&self) -> Result<Library> {
        let v = self
            .dir
            .read::<Library>(RECORD)
            .map_err(|_| "Project library needs recovery; its original data was preserved")?
            .unwrap_or_default();
        if v.schema_version != 1 || v.projects.len() > 4096 {
            return Err("Unsupported project library; original data preserved".into());
        }
        let mut ids = std::collections::HashSet::new();
        let mut locations = std::collections::HashSet::new();
        for p in &v.projects {
            if !locations
                .insert(serde_json::to_string(&p.location).map_err(|_| "Invalid project location")?)
            {
                return Err("Duplicate project location; original library preserved".into());
            }
            if let Some(h) = &p.resume {
                if github_workspace::transport::safe_path(&h.path).is_err()
                    || h.source_hash.len() != 64
                    || !h.source_hash.bytes().all(|b| b.is_ascii_hexdigit())
                    || h.scene_id
                        .as_ref()
                        .is_some_and(|s| s.len() > 200 || s.chars().any(char::is_control))
                {
                    return Err("Invalid project resume hint; original library preserved".into());
                }
            }
            if uuid::Uuid::parse_str(&p.id).is_err()
                || !ids.insert(&p.id)
                || p.revision == 0
                || label(&p.name).is_err()
            {
                return Err("Invalid project library; original data preserved".into());
            }
        }
        Ok(v)
    }
    fn write(&self, mut v: Library) -> Result<()> {
        v.revision = v
            .revision
            .checked_add(1)
            .ok_or("Project revision exhausted")?;
        if v.projects.len() > 4096 {
            return Err("Project library is full; no project was removed".into());
        }
        self.dir.write(RECORD, &v).map_err(|_| {
            "Project metadata could not be durably saved; refresh before retrying".into()
        })
    }
    pub fn list(&self) -> Result<Vec<Project>> {
        let _lock = self
            .dir
            .lock("library.lock")
            .map_err(|_| "Project library is busy")?;
        let mut projects = self.load()?.projects;
        projects.sort_by_key(|p| std::cmp::Reverse(p.last_used));
        Ok(projects)
    }
    pub fn get(&self, id: &str) -> Result<Project> {
        self.list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("Unknown project".into())
    }
    fn add(v: &mut Library, location: Location, name: String) -> Result<Project> {
        if let Some(p) = v.projects.iter().find(|p| p.location == location) {
            return Ok(p.clone());
        }
        label(&name)?;
        let p = Project {
            id: id(),
            name,
            revision: 1,
            location,
            resume: None,
            last_used: v.revision + 1,
        };
        v.projects.push(p.clone());
        Ok(p)
    }
    pub fn register(&self, root: &Path, workspace: Option<&Workspace>) -> Result<Project> {
        let _lock = self
            .dir
            .lock("library.lock")
            .map_err(|_| "Project library is busy")?;
        let mut v = self.load()?;
        let location = if let Some(w) = workspace {
            Location::Managed {
                workspace_id: w.id.clone(),
            }
        } else {
            Location::Local {
                root: root.to_path_buf(),
                identity: Some(root_id(root)?),
            }
        };
        let name = workspace.map(|w| w.repo.name.clone()).unwrap_or_else(|| {
            root.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
        if let Some(p) = v.projects.iter_mut().find(|p| p.location == location) {
            p.revision = p
                .revision
                .checked_add(1)
                .ok_or("Project revision exhausted")?;
            p.last_used = v.revision + 1;
            let result = p.clone();
            self.write(v)?;
            return Ok(result);
        }
        let p = Self::add(&mut v, location, name)?;
        self.write(v)?;
        Ok(p)
    }
    pub fn migrate(&self, legacy: &Path, workspaces: &[Workspace], sources: &Path) -> Result<()> {
        let _lock = self
            .dir
            .lock("library.lock")
            .map_err(|_| "Project library is busy")?;
        let mut v = self.load()?;
        let mut changed = false;
        if !v.legacy_imported {
            if legacy
                .try_exists()
                .map_err(|_| "Older folder history unavailable")?
            {
                let m = std::fs::symlink_metadata(legacy)
                    .map_err(|_| "Older folder history unavailable")?;
                if !m.is_file() || m.file_type().is_symlink() || m.len() >= 65536 {
                    return Err("Older folder history needs recovery; originals preserved".into());
                }
                let old: RecentStore = serde_json::from_slice(
                    &std::fs::read(legacy).map_err(|_| "Older folder history unavailable")?,
                )
                .map_err(|_| "Older folder history needs recovery; originals preserved")?;
                if old.schema_version != 1 {
                    return Err(
                        "Older folder history version unsupported; originals preserved".into(),
                    );
                }
                for r in old.folders {
                    if !r.path.is_absolute() {
                        return Err("Older folder location is invalid; originals preserved".into());
                    }
                    let root = r.path.canonicalize().unwrap_or(r.path);
                    if root.starts_with(sources) {
                        continue;
                    }
                    let identity = root_id(&root).ok();
                    Self::add(&mut v, Location::Local { root, identity }, r.name)?;
                }
            }
            v.legacy_imported = true;
            changed = true;
        }
        for w in workspaces {
            let n = v.projects.len();
            Self::add(
                &mut v,
                Location::Managed {
                    workspace_id: w.id.clone(),
                },
                w.repo.name.clone(),
            )?;
            changed |= n != v.projects.len();
        }
        if changed {
            self.write(v)?
        }
        Ok(())
    }
    pub fn update(
        &self,
        id: &str,
        revision: u64,
        name: Option<String>,
        resume: Option<Resume>,
    ) -> Result<Project> {
        let _lock = self
            .dir
            .lock("library.lock")
            .map_err(|_| "Project library is busy")?;
        let mut v = self.load()?;
        let p = v
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("Unknown project")?;
        if p.revision != revision {
            return Err("Project settings changed in another window. Refresh and try again".into());
        }
        if let Some(n) = name {
            label(&n)?;
            p.name = n.trim().into()
        }
        if let Some(r) = resume {
            p.resume = Some(r)
        }
        p.revision = p
            .revision
            .checked_add(1)
            .ok_or("Project revision exhausted")?;
        let result = p.clone();
        self.write(v)?;
        Ok(result)
    }
    pub fn local_root(p: &Project) -> Result<PathBuf> {
        match &p.location{Location::Local{root,identity:Some(expected)} if root.canonicalize().ok().as_ref()==Some(root)&&root_id(root).ok().as_ref()==Some(expected)=>Ok(root.clone()),_=>Err("The original writing folder is missing or changed. It has not been recreated or replaced".into())}
    }
}
fn store(app: &tauri::AppHandle) -> Result<Store> {
    Store::open(
        &app.path()
            .app_data_dir()
            .map_err(|_| "Project library unavailable")?
            .join("projects-v1"),
    )
}
pub(crate) fn inventory(app: &tauri::AppHandle) -> Result<(Store, Registry)> {
    let d = app
        .path()
        .app_data_dir()
        .map_err(|_| "Project library unavailable")?;
    let r = Registry::open(&d.join("github-state-v1"), &d.join("github-sources-v1"))
        .map_err(|_| "Managed project registry unavailable")?;
    let s = store(app)?;
    s.migrate(
        &d.join("recent-folders-v1.json"),
        &r.list()
            .map_err(|_| "Managed project registry needs recovery")?,
        &d.join("github-sources-v1"),
    )?;
    Ok((s, r))
}
fn target(p: &Project, r: &Registry) -> Result<PathBuf> {
    match &p.location {
        Location::Local { .. } => Store::local_root(p),
        Location::Managed { workspace_id } => {
            r.reopen(workspace_id).map_err(|_| {
                "Managed writing copy unavailable or needs recovery; it was not re-cloned"
            })?;
            r.checkout(workspace_id)
                .map_err(|_| "Managed writing copy unavailable".into())
        }
    }
}
fn view(p: &Project, r: &Registry) -> serde_json::Value {
    let (kind,wid,github)=match &p.location{Location::Local{..}=>("local",None,None),Location::Managed{workspace_id}=>("managed",Some(workspace_id),r.get(workspace_id).ok().map(|w|serde_json::json!({"owner":w.repo.owner,"repository":w.repo.name,"accountId":w.account_id,"branch":w.branch})))};
    serde_json::json!({"id":p.id,"name":p.name,"revision":p.revision,"kind":kind,"workspaceId":wid,"github":github,"resume":p.resume,"unavailable":target(p,r).err()})
}
pub(crate) fn validate_resume(repo: &repository_core::Repository, h: &Resume) -> Result<()> {
    let d = repo
        .read(&h.path)
        .map_err(|_| "Last document is unavailable; open the project overview")?;
    if d.generated_compatibility || d.content_hash != h.source_hash {
        return Err("Last document changed; open it from Writing instead".into());
    }
    let text = d.text.replace("\r\n", "\n").replace('\r', "\n");
    let mut boundaries = std::collections::HashSet::from([0]);
    let mut n = 0;
    for c in text.chars() {
        n += c.len_utf16();
        boundaries.insert(n);
    }
    if !boundaries.contains(&h.anchor)
        || !boundaries.contains(&h.head)
        || h.scroll_top > 100_000_000
    {
        return Err("Last writing position is invalid; open the project overview".into());
    }
    Ok(())
}
struct OpenPlan {
    project: Project,
    root: PathBuf,
    epoch: u64,
    source: Option<String>,
    expires: Instant,
}
#[derive(Default)]
pub(crate) struct Host {
    plans: Mutex<HashMap<String, OpenPlan>>,
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    List,
    Settings {
        id: String,
    },
    PreviewOpen {
        id: String,
    },
    Activate {
        preview_id: String,
    },
    Cancel {
        preview_id: String,
    },
    Rename {
        id: String,
        revision: u64,
        name: String,
    },
    SaveResume {
        repository_id: String,
        project_id: String,
        revision: u64,
        resume: Resume,
    },
}
#[tauri::command]
pub(crate) async fn project_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<serde_json::Value> {
    crate::check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, request))
        .await
        .map_err(|_| "Project operation unavailable")?
}
fn dispatch(app: &tauri::AppHandle, request: Request) -> Result<serde_json::Value> {
    let state = app.state::<crate::BrowserState>();
    if state.quitting.load(Ordering::SeqCst) {
        return Err("Heinlein is quitting".into());
    }
    let (s, r) = inventory(app)?;
    match request {
        Request::List => Ok(serde_json::Value::Array(
            s.list()?.iter().map(|p| view(p, &r)).collect(),
        )),
        Request::Settings { id } => {
            let p = s.get(&id)?;
            let mut v = view(&p, &r);
            v["writingLocation"] = serde_json::json!(match &p.location {
                Location::Local { root, .. } => root.clone(),
                Location::Managed { workspace_id } => r
                    .checkout(workspace_id)
                    .map_err(|_| "Managed project unavailable")?,
            }
            .to_string_lossy());
            Ok(v)
        }
        Request::Rename { id, revision, name } => {
            Ok(view(&s.update(&id, revision, Some(name), None)?, &r))
        }
        Request::Cancel { preview_id } => {
            state
                .projects
                .plans
                .lock()
                .map_err(|_| "Project switch unavailable")?
                .remove(&preview_id);
            Ok(serde_json::Value::Null)
        }
        Request::PreviewOpen { id } => {
            let _selection = state
                .selection_gate
                .try_lock()
                .map_err(|_| "A project switch is already running")?;
            if state.unsaved_changes.load(Ordering::SeqCst) {
                return Err("Keep your latest writing on this Mac before switching".into());
            }
            let p = s.get(&id)?;
            let path = target(&p, &r)?;
            let repo = repository_core::Repository::open(&path)
                .map_err(|_| "Writing folder unavailable")?;
            let _ = repo.root();
            let token = crate::id();
            let source = state
                .selected
                .lock()
                .map_err(|_| "Project unavailable")?
                .as_ref()
                .map(|s| s.id.clone());
            let plan = OpenPlan {
                project: p,
                root: path,
                epoch: state.mutation_gate.generation(),
                source,
                expires: Instant::now() + Duration::from_secs(300),
            };
            let mut plans = state
                .projects
                .plans
                .lock()
                .map_err(|_| "Project switch unavailable")?;
            plans.clear();
            plans.insert(token.clone(), plan);
            Ok(serde_json::json!({"id":token}))
        }
        Request::Activate { preview_id } => {
            let _selection = state
                .selection_gate
                .try_lock()
                .map_err(|_| "A project switch is already running")?;
            let plan = state
                .projects
                .plans
                .lock()
                .map_err(|_| "Project switch unavailable")?
                .remove(&preview_id)
                .ok_or("Project switch expired")?;
            let _mutation = state
                .mutation_gate
                .author_operation()
                .map_err(|e| e.to_string())?;
            if state.unsaved_changes.load(Ordering::SeqCst)
                || state.mutation_gate.generation() != plan.epoch
                || Instant::now() > plan.expires
                || state
                    .selected
                    .lock()
                    .map_err(|_| "Project unavailable")?
                    .as_ref()
                    .map(|s| s.id.clone())
                    != plan.source
            {
                return Err("Writing changed. Keep it locally and choose the project again".into());
            }
            let current = s.get(&plan.project.id)?;
            if current.revision != plan.project.revision
                || current.location != plan.project.location
                || target(&current, &r)? != plan.root
            {
                return Err("Project changed. Refresh the library".into());
            }
            let session = crate::select(app, plan.root)?;
            serde_json::to_value(session).map_err(|_| "Project session unavailable".into())
        }
        Request::SaveResume {
            repository_id,
            project_id,
            revision,
            resume,
        } => {
            let _selection = state
                .selection_gate
                .try_lock()
                .map_err(|_| "Project switch in progress")?;
            if state.unsaved_changes.load(Ordering::SeqCst) {
                return Err("Keep the document locally before remembering its position".into());
            }
            let p = s.get(&project_id)?;
            let path = target(&p, &r)?;
            crate::with_repository(app, &repository_id, |repo| {
                if repo.root() != path {
                    return Err("Project changed".into());
                }
                validate_resume(repo, &resume)?;
                Ok(())
            })?;
            Ok(view(
                &s.update(&project_id, revision, None, Some(resume))?,
                &r,
            ))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    fn setup() -> (TempDir, Store, PathBuf) {
        let t = TempDir::new().unwrap();
        let root = t.path().canonicalize().unwrap();
        let s = Store::open(&root.join("private-library")).unwrap();
        (t, s, root)
    }
    fn folder(root: &Path, name: &str) -> PathBuf {
        let p = root.join(name);
        std::fs::create_dir(&p).unwrap();
        std::fs::write(p.join("scene.md"), "A — e\u{301} 🦊\r\nB\nC\r\n").unwrap();
        p
    }
    fn workspace(id: &str, account: u64) -> Workspace {
        Workspace {
            id: id.into(),
            repo: github_workspace::RepoInfo {
                id: account + 100,
                owner: format!("writer{account}"),
                name: "Novel".into(),
                private: true,
                default_branch: "main".into(),
                installation_id: account,
            },
            account_id: account,
            auth_binding: format!("synthetic-{account}"),
            branch: format!("story/{account}"),
            base_branch: None,
            base_oid: "a".repeat(40),
            head_oid: "a".repeat(40),
            remote_oid: None,
            pr: None,
        }
    }
    #[test]
    fn two_local_two_managed_rename_and_resume_restart() {
        let (_t, s, root) = setup();
        let a = folder(&root, "A");
        let b = folder(&root, "B");
        let p = s.register(&a, None).unwrap();
        let q = s.register(&b, None).unwrap();
        let w1 = workspace(&id(), 9);
        let w2 = workspace(&id(), 19);
        let g = s.register(&root, Some(&w1)).unwrap();
        let h = s.register(&root, Some(&w2)).unwrap();
        assert_ne!(g.id, h.id);
        assert_ne!(p.id, q.id);
        let repo = repository_core::Repository::open(&a).unwrap();
        let d = repo.read("scene.md").unwrap();
        let hint = Resume {
            path: "scene.md".into(),
            source_hash: d.content_hash,
            scene_id: None,
            anchor: 2,
            head: 2,
            scroll_top: 80,
        };
        validate_resume(&repo, &hint).unwrap();
        let p = s
            .update(
                &p.id,
                p.revision,
                Some("Novel A".into()),
                Some(hint.clone()),
            )
            .unwrap();
        drop(s);
        let s = Store::open(&root.join("private-library")).unwrap();
        let back = s.get(&p.id).unwrap();
        assert_eq!(back.name, "Novel A");
        assert_eq!(back.resume, Some(hint));
        assert_eq!(Store::local_root(&back).unwrap(), a);
        assert_eq!(s.register(&a, None).unwrap().id, p.id);
        assert_eq!(s.list().unwrap().len(), 4);
        assert_eq!(
            s.get(&g.id).unwrap().location,
            Location::Managed {
                workspace_id: w1.id
            }
        );
    }
    #[test]
    fn migrate_dedup_retains_original_and_does_not_reimport() {
        let (_t, s, root) = setup();
        let a = folder(&root, "A");
        let legacy = root.join("recents.json");
        let bytes=serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"folders":[{"id":"old","name":"A","path":a},{"id":"duplicate","name":"same","path":a},{"id":"missing","name":"Missing","path":root.join("gone")}]})).unwrap();
        std::fs::write(&legacy, &bytes).unwrap();
        s.migrate(&legacy, &[], &root.join("managed")).unwrap();
        assert_eq!(s.list().unwrap().len(), 2);
        assert_eq!(std::fs::read(&legacy).unwrap(), bytes);
        let p = s
            .list()
            .unwrap()
            .into_iter()
            .find(|p| p.name == "A")
            .unwrap();
        s.update(&p.id, p.revision, Some("Renamed".into()), None)
            .unwrap();
        s.migrate(&legacy, &[], &root.join("managed")).unwrap();
        assert_eq!(s.get(&p.id).unwrap().name, "Renamed");
    }
    #[test]
    fn stale_concurrent_cas_and_locked_library_preserve_other_entries() {
        let (_t, s, root) = setup();
        let p = s.register(&folder(&root, "A"), None).unwrap();
        let q = s.register(&folder(&root, "B"), None).unwrap();
        let other = Store::open(&root.join("private-library")).unwrap();
        other
            .update(&q.id, q.revision, Some("B2".into()), None)
            .unwrap();
        s.update(&p.id, p.revision, Some("A2".into()), None)
            .unwrap();
        assert!(other
            .update(&p.id, p.revision, Some("stale".into()), None)
            .is_err());
        assert_eq!(s.get(&q.id).unwrap().name, "B2");
        let lock = s.dir.lock("library.lock").unwrap();
        assert!(other.list().is_err());
        drop(lock);
        assert_eq!(other.list().unwrap().len(), 2);
    }
    #[test]
    fn corrupt_future_library_and_legacy_never_overwritten() {
        let (_t, s, root) = setup();
        let legacy = root.join("recents.json");
        for bytes in [
            b"{".to_vec(),
            br#"{"schemaVersion":8,"revision":0,"legacyImported":false,"projects":[]}"#.to_vec(),
        ] {
            s.dir.write_bytes(RECORD, &bytes).unwrap();
            assert!(s.list().is_err());
            assert_eq!(std::fs::read(s.dir.path().join(RECORD)).unwrap(), bytes);
        }
        std::fs::remove_file(s.dir.path().join(RECORD)).unwrap();
        std::fs::write(&legacy, b"{").unwrap();
        assert!(s.migrate(&legacy, &[], &root.join("managed")).is_err());
        assert!(!s.dir.path().join(RECORD).exists());
        assert_eq!(std::fs::read(legacy).unwrap(), b"{");
    }
    #[test]
    fn missing_replaced_or_symlink_root_never_adopted_or_created() {
        let (_t, s, root) = setup();
        let a = folder(&root, "A");
        let p = s.register(&a, None).unwrap();
        std::fs::rename(&a, root.join("original")).unwrap();
        assert!(Store::local_root(&p).is_err());
        assert!(!a.exists());
        std::fs::create_dir(&a).unwrap();
        assert!(Store::local_root(&p).is_err());
        assert_eq!(s.get(&p.id).unwrap().id, p.id);
        #[cfg(unix)]
        {
            std::fs::remove_dir(&a).unwrap();
            std::os::unix::fs::symlink(root.join("original"), &a).unwrap();
            assert!(Store::local_root(&p).is_err());
        }
    }
    #[test]
    fn resume_hash_unicode_boundary_and_missing_file_refuse_guessing() {
        let (_t, _s, root) = setup();
        let a = folder(&root, "A");
        let repo = repository_core::Repository::open(&a).unwrap();
        let d = repo.read("scene.md").unwrap();
        let mut h = Resume {
            path: "scene.md".into(),
            source_hash: d.content_hash,
            scene_id: None,
            anchor: 0,
            head: 0,
            scroll_top: 1,
        };
        validate_resume(&repo, &h).unwrap();
        h.anchor = 8;
        assert!(validate_resume(&repo, &h).is_err());
        h.anchor = 0;
        std::fs::write(a.join("scene.md"), "external change").unwrap();
        assert!(validate_resume(&repo, &h).is_err());
        std::fs::remove_file(a.join("scene.md")).unwrap();
        assert!(validate_resume(&repo, &h).is_err());
    }
    #[test]
    fn symlink_or_failed_write_preserves_library() {
        let (_t, s, root) = setup();
        let p = s.register(&folder(&root, "A"), None).unwrap();
        let path = s.dir.path().join(RECORD);
        let before = std::fs::read(&path).unwrap();
        std::fs::rename(&path, root.join("safe.json")).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(s
            .update(&p.id, p.revision, Some("Not persisted".into()), None)
            .is_err());
        assert_eq!(std::fs::read(root.join("safe.json")).unwrap(), before);
    }
    #[test]
    #[ignore = "subprocess helper; invoked by process_lock_and_restart"]
    fn process_library_child() {
        let path = std::env::var_os("HEINLEIN_PROJECT_TEST_ROOT").expect("isolated test root");
        let store = Store::open(Path::new(&path)).unwrap();
        if std::env::var_os("HEINLEIN_PROJECT_TEST_LOCKED").is_some() {
            assert!(store.list().err().unwrap().contains("busy"));
        } else {
            let projects = store.list().unwrap();
            assert_eq!(projects.len(), 1);
            assert_eq!(projects[0].name, "Retained after restart");
        }
    }
    #[test]
    fn process_lock_and_restart() {
        let (_t, store, root) = setup();
        let p = store.register(&folder(&root, "A"), None).unwrap();
        store
            .update(
                &p.id,
                p.revision,
                Some("Retained after restart".into()),
                None,
            )
            .unwrap();
        let child = |locked: bool| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "projects::tests::process_library_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("HEINLEIN_PROJECT_TEST_ROOT", store.dir.path());
            if locked {
                command.env("HEINLEIN_PROJECT_TEST_LOCKED", "1");
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "child failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        };
        let lock = store.dir.lock("library.lock").unwrap();
        child(true);
        drop(lock);
        child(false);
    }
}
