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
    pub read_error: Mutex<Option<Error>>,
    pub write_error: Mutex<Option<Error>>,
    pub writes: AtomicUsize,
    pub deletes: AtomicUsize,
}
impl SecretStore for MemorySecrets {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        if let Some(error) = *self.read_error.lock().unwrap() {
            return Err(error);
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::Auth);
        }
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn save(&self, b: &[u8]) -> Result<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = *self.write_error.lock().unwrap() {
            return Err(error);
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::Auth);
        }
        *self.bytes.lock().unwrap() = Some(b.to_vec());
        Ok(())
    }
    fn clear(&self) -> Result<()> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        *self.bytes.lock().unwrap() = None;
        Ok(())
    }
}
pub struct MockApi {
    pub repo: Mutex<github_workspace::RepoInfo>,
    pub polls: AtomicUsize,
    pub refreshes: AtomicUsize,
    pub refresh_error: Mutex<Option<Error>>,
    pub user_id: AtomicUsize,
    pub remote: Mutex<Option<String>>,
    pub base: Mutex<Option<String>>,
    pub heads: Mutex<std::collections::BTreeMap<String, Option<String>>>,
    pub prs: Mutex<Vec<(PullRequest, String)>>,
    pub create_calls: AtomicUsize,
    pub fail_create: AtomicBool,
    pub denied: AtomicBool,
    pub detail: Mutex<Option<github_workspace::api::PullDetail>>,
    pub detail_error: Mutex<Option<Error>>,
    pub proved: AtomicBool,
    pub mutations: AtomicUsize,
    pub mutation_mode: AtomicUsize,
}
impl Default for MockApi {
    fn default() -> Self {
        Self {
            repo: Mutex::new(info()),
            polls: AtomicUsize::new(0),
            refreshes: AtomicUsize::new(0),
            refresh_error: Mutex::new(None),
            user_id: AtomicUsize::new(9),
            remote: Mutex::new(None),
            base: Mutex::new(None),
            heads: Mutex::new(Default::default()),
            prs: Mutex::new(vec![]),
            create_calls: AtomicUsize::new(0),
            fail_create: AtomicBool::new(false),
            denied: AtomicBool::new(false),
            detail: Mutex::new(None),
            detail_error: Mutex::new(None),
            proved: AtomicBool::new(false),
            mutations: AtomicUsize::new(0),
            mutation_mode: AtomicUsize::new(0),
        }
    }
}
impl Provider for MockApi {
    fn pull_detail(
        &self,
        _: &Credential,
        _: &github_workspace::RepoInfo,
        _: u64,
    ) -> Result<github_workspace::api::PullDetail> {
        if let Some(error) = *self.detail_error.lock().unwrap() {
            return Err(error);
        }
        self.detail.lock().unwrap().clone().ok_or(Error::Missing)
    }
    fn merge_policy(
        &self,
        c: &Credential,
        r: &github_workspace::RepoInfo,
        p: &github_workspace::api::PullDetail,
    ) -> Result<github_workspace::api::MergePolicy> {
        use github_workspace::api::MergePolicy;
        Ok(if self.proved.load(Ordering::SeqCst) {
            MergePolicy::VerifiedNoBypass {
                repository_id: r.id,
                account_id: c.account.id,
                base_ref: p.pull.base.clone(),
                base_oid: p.base.clone(),
                head_oid: p.head.clone(),
            }
        } else {
            MergePolicy::Unknown
        })
    }
    fn mark_ready(
        &self,
        _: &Credential,
        _: &github_workspace::RepoInfo,
        _: &github_workspace::api::PullDetail,
        _: &str,
    ) -> Result<()> {
        self.mutations.fetch_add(1, Ordering::SeqCst);
        match self.mutation_mode.load(Ordering::SeqCst) {
            1 => return Err(Error::Network),
            3 => return Err(Error::Permission),
            _ => {}
        }
        self.detail.lock().unwrap().as_mut().unwrap().pull.draft = false;
        if self.mutation_mode.load(Ordering::SeqCst) == 4 {
            *self.detail_error.lock().unwrap() = Some(Error::Network);
            return Err(Error::Network);
        }
        if self.mutation_mode.load(Ordering::SeqCst) == 2 {
            Err(Error::Network)
        } else {
            Ok(())
        }
    }
    fn merge_sync(
        &self,
        _: &Credential,
        _: &github_workspace::RepoInfo,
        p: &github_workspace::api::PullDetail,
        _: &str,
    ) -> Result<String> {
        self.mutations.fetch_add(1, Ordering::SeqCst);
        match self.mutation_mode.load(Ordering::SeqCst) {
            1 => return Err(Error::Network),
            3 => return Err(Error::Permission),
            _ => {}
        }
        let mut detail = self.detail.lock().unwrap();
        let d = detail.as_mut().unwrap();
        d.pull.merged = true;
        d.pull.state = "closed".into();
        d.merge_commit = Some(p.head.clone());
        if self.mutation_mode.load(Ordering::SeqCst) == 2 {
            Err(Error::Network)
        } else {
            Ok(p.head.clone())
        }
    }
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
        if let Some(error) = *self.refresh_error.lock().unwrap() {
            return Err(error);
        }
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
        if let Some(head) = self.heads.lock().unwrap().get(branch) {
            return Ok(head.clone());
        }
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
    fn create_pull(
        &self,
        c: &Credential,
        r: &github_workspace::RepoInfo,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<PullRequest> {
        let result = self.create_draft(c, r, head, base, title, body);
        let mut prs = self.prs.lock().unwrap();
        let p = &mut prs.last_mut().unwrap().0;
        p.draft = draft;
        result.map(|_| p.clone())
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
