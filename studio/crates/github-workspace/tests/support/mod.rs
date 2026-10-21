#![allow(dead_code)]
use github_workspace::{
    api::Provider,
    auth::{Auth, Credential, DeviceCode, Poll, SecretStore, TokenSet, User},
    registry::{PullRequest, Registry, StateDir},
    transport::{tree_from_files, Files},
    Error, Result,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
pub fn info() -> github_workspace::RepoInfo {
    github_workspace::RepoInfo {
        id: 42,
        owner: "example".into(),
        name: "story".into(),
        private: true,
        default_branch: "main".into(),
        installation_id: 7,
    }
}
pub struct Fixture {
    pub temp: tempfile::TempDir,
    pub registry: Registry,
    pub root: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let registry = Registry::open(&root.join("private"), &root.join("sources")).unwrap();
        Self {
            temp,
            registry,
            root,
        }
    }
    pub fn register(&self) -> github_workspace::registry::Workspace {
        self.registry
            .register(info(), 9, "00000000-0000-4000-8000-000000000009", |repo| {
                Ok(commit(
                    repo,
                    &Files::from([("story.md".into(), b"Original story.\n".to_vec())]),
                    &[],
                ))
            })
            .unwrap()
    }
}
pub fn commit(repo: &git2::Repository, files: &Files, parents: &[git2::Oid]) -> git2::Oid {
    let tree = tree_from_files(repo, files).unwrap();
    let tree = repo.find_tree(tree).unwrap();
    let sig = git2::Signature::new(
        "Example Author",
        "example@users.noreply.github.com",
        &git2::Time::new(1_000, 0),
    )
    .unwrap();
    let parents = parents
        .iter()
        .map(|id| repo.find_commit(*id).unwrap())
        .collect::<Vec<_>>();
    repo.commit(
        None,
        &sig,
        &sig,
        "Synthetic version",
        &tree,
        &parents.iter().collect::<Vec<_>>(),
    )
    .unwrap()
}
#[derive(Default)]
pub struct MemorySecrets {
    pub bytes: Mutex<Option<Vec<u8>>>,
    pub fail: AtomicBool,
}
impl SecretStore for MemorySecrets {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::Auth);
        }
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn save(&self, b: &[u8]) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::Auth);
        }
        *self.bytes.lock().unwrap() = Some(b.to_vec());
        Ok(())
    }
    fn clear(&self) -> Result<()> {
        *self.bytes.lock().unwrap() = None;
        Ok(())
    }
}
pub struct MockApi {
    pub repo: Mutex<github_workspace::RepoInfo>,
    pub polls: AtomicUsize,
    pub refreshes: AtomicUsize,
    pub user_id: AtomicUsize,
    pub remote: Mutex<Option<String>>,
    pub base: Mutex<Option<String>>,
    pub prs: Mutex<Vec<(PullRequest, String)>>,
    pub create_calls: AtomicUsize,
    pub fail_create: AtomicBool,
    pub denied: AtomicBool,
}
impl Default for MockApi {
    fn default() -> Self {
        Self {
            repo: Mutex::new(info()),
            polls: AtomicUsize::new(0),
            refreshes: AtomicUsize::new(0),
            user_id: AtomicUsize::new(9),
            remote: Mutex::new(None),
            base: Mutex::new(None),
            prs: Mutex::new(vec![]),
            create_calls: AtomicUsize::new(0),
            fail_create: AtomicBool::new(false),
            denied: AtomicBool::new(false),
        }
    }
}
impl Provider for MockApi {
    fn device_start(&self, _: &str) -> Result<DeviceCode> {
        Ok(DeviceCode {
            device_code: "device-secret".into(),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://github.com/login/device".into(),
            expires_in: 900,
            interval: 5,
        })
    }
    fn device_poll(&self, _: &str, _: &str) -> Result<Poll> {
        self.polls.fetch_add(1, Ordering::SeqCst);
        Ok(Poll::Authorized(TokenSet {
            access_token: "access-secret".into(),
            refresh_token: Some("refresh-secret".into()),
            expires_in: 3600,
            refresh_expires_in: 100_000,
        }))
    }
    fn refresh(&self, _: &str, _: &str) -> Result<TokenSet> {
        self.refreshes.fetch_add(1, Ordering::SeqCst);
        Ok(TokenSet {
            access_token: "rotated-secret".into(),
            refresh_token: Some("next-refresh-secret".into()),
            expires_in: 3600,
            refresh_expires_in: 100_000,
        })
    }
    fn user(&self, _: &Credential) -> Result<User> {
        Ok(User {
            id: self.user_id.load(Ordering::SeqCst) as u64,
            login: "example-writer".into(),
        })
    }
    fn repository(&self, _: &Credential, _: &str, _: &str) -> Result<github_workspace::RepoInfo> {
        if self.denied.load(Ordering::SeqCst) {
            Err(Error::Permission)
        } else {
            Ok(self.repo.lock().unwrap().clone())
        }
    }
    fn repository_by_id(&self, c: &Credential, _: u64) -> Result<github_workspace::RepoInfo> {
        self.repository(c, "example", "story")
    }
    fn head(
        &self,
        _: &Credential,
        _: &github_workspace::RepoInfo,
        branch: &str,
    ) -> Result<Option<String>> {
        Ok(if branch == "main" {
            self.base.lock().unwrap().clone()
        } else {
            self.remote.lock().unwrap().clone()
        })
    }
    fn pulls(
        &self,
        _: &Credential,
        _: &github_workspace::RepoInfo,
        _: &str,
        _: &str,
    ) -> Result<Vec<(PullRequest, String)>> {
        Ok(self.prs.lock().unwrap().clone())
    }
    fn create_draft(
        &self,
        _: &Credential,
        r: &github_workspace::RepoInfo,
        head: &str,
        base: &str,
        _: &str,
        body: &str,
    ) -> Result<PullRequest> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        let p = PullRequest {
            number: 1,
            url: format!("{}/pull/1", r.url()),
            state: "open".into(),
            merged: false,
            draft: true,
            head: head.into(),
            base: base.into(),
        };
        self.prs.lock().unwrap().push((p.clone(), body.into()));
        if self.fail_create.load(Ordering::SeqCst) {
            Err(Error::Network)
        } else {
            Ok(p)
        }
    }
}
pub fn connected(root: &std::path::Path, api: &MockApi) -> (Auth, Arc<MemorySecrets>) {
    let secrets = Arc::new(MemorySecrets::default());
    let auth = Auth::new(
        "public-client".into(),
        secrets.clone(),
        StateDir::open(&root.join("auth")).unwrap(),
    )
    .unwrap();
    auth.begin(api, 1000).unwrap();
    auth.poll(api, 1005).unwrap();
    auth.confirm(9).unwrap();
    (auth, secrets)
}
