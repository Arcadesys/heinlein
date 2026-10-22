//! Fixed-host REST client, no redirects, retries, or response bodies in errors.
use crate::{
    auth::{Credential, DeviceCode, Poll, TokenSet, User},
    registry::PullRequest,
    Error, RepoInfo, Result,
};
use serde_json::{json, Value};
use std::{collections::HashMap, io::Read};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryList {
    pub repositories: Vec<RepoInfo>,
    pub unavailable: usize,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub head: String,
    pub protected: bool,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullDetail {
    pub pull: PullRequest,
    pub node_id: String,
    pub head: String,
    pub base: String,
    pub head_repo_id: u64,
    pub base_repo_id: u64,
    pub mergeable: Option<bool>,
    pub merge_state: String,
    pub merge_commit: Option<String>,
    pub stack: StackState,
}
#[derive(Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StackState {
    Standalone,
    Present,
    Unknown,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
pub enum MergePolicy {
    Unknown,
    VerifiedNoBypass {
        repository_id: u64,
        account_id: u64,
        base_ref: String,
        base_oid: String,
        head_oid: String,
    },
}
pub trait Provider: Send + Sync {
    // The explicit draft flag extends the existing fixed PR request fields.
    #[allow(clippy::too_many_arguments)]
    fn create_pull(
        &self,
        c: &Credential,
        r: &RepoInfo,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<PullRequest> {
        if draft {
            self.create_draft(c, r, head, base, title, body)
        } else {
            Err(Error::Unsupported)
        }
    }
    fn pull_detail(&self, _: &Credential, _: &RepoInfo, _: u64) -> Result<PullDetail> {
        Err(Error::Unsupported)
    }
    fn mark_ready(&self, _: &Credential, _: &RepoInfo, _: &PullDetail, _: &str) -> Result<()> {
        Err(Error::Unsupported)
    }
    fn merge_policy(&self, _: &Credential, _: &RepoInfo, _: &PullDetail) -> Result<MergePolicy> {
        Ok(MergePolicy::Unknown)
    }
    fn merge_sync(&self, _: &Credential, _: &RepoInfo, _: &PullDetail, _: &str) -> Result<String> {
        Err(Error::Unsupported)
    }
    fn branches(&self, _: &Credential, _: &RepoInfo) -> Result<Vec<Branch>> {
        Err(Error::Unsupported)
    }
    fn device_start(&self, client: &str) -> Result<DeviceCode>;
    fn device_poll(&self, client: &str, code: &str) -> Result<Poll>;
    fn refresh(&self, client: &str, token: &str) -> Result<TokenSet>;
    fn user(&self, credential: &Credential) -> Result<User>;
    fn repository(&self, credential: &Credential, owner: &str, name: &str) -> Result<RepoInfo>;
    fn repository_by_id(&self, credential: &Credential, id: u64) -> Result<RepoInfo>;
    fn head(
        &self,
        credential: &Credential,
        repo: &RepoInfo,
        branch: &str,
    ) -> Result<Option<String>>;
    fn pulls(
        &self,
        credential: &Credential,
        repo: &RepoInfo,
        head: &str,
        base: &str,
    ) -> Result<Vec<(PullRequest, String)>>;
    fn create_draft(
        &self,
        credential: &Credential,
        repo: &RepoInfo,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
    ) -> Result<PullRequest>;
}
pub struct HttpGitHub {
    client: reqwest::blocking::Client,
}
impl HttpGitHub {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(25))
                .user_agent("Heinlein-Studio-GitHub/1")
                .build()
                .map_err(|_| Error::Network)?,
        })
    }
    fn json(&self, request: reqwest::blocking::RequestBuilder) -> Result<Value> {
        let response = request.send().map_err(|_| Error::Network)?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 => Error::Auth,
                403 if response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|v| v == "0") =>
                {
                    Error::RateLimit
                }
                403 if response.headers().contains_key("x-github-sso") => Error::Sso,
                403 | 404 => Error::Permission,
                429 => Error::RateLimit,
                301 | 302 | 307 | 308 => Error::Changed,
                405 => Error::MergeUnavailable,
                409 => Error::Changed,
                400 | 422 => Error::Unsupported,
                _ => Error::Network,
            });
        }
        if response
            .content_length()
            .is_some_and(|len| len > 2 * 1024 * 1024)
        {
            return Err(crate::transport::budget(
                "GitHub API",
                "response bytes",
                response.content_length().unwrap_or(0) as usize,
                2 * 1024 * 1024,
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Network)?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(crate::transport::budget(
                "GitHub API",
                "response bytes",
                bytes.len(),
                2 * 1024 * 1024,
            ));
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::Network)
    }
    fn get(&self, credential: &Credential, path: &str) -> Result<Value> {
        self.get_version(credential, path, "2022-11-28")
    }
    fn get_version(&self, credential: &Credential, path: &str, version: &str) -> Result<Value> {
        self.json(
            self.client
                .get(format!("https://api.github.com{path}"))
                .bearer_auth(credential.value()?)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", version),
        )
    }
    fn form(&self, path: &str, values: &[(&str, &str)]) -> Result<Value> {
        self.json(
            self.client
                .post(format!("https://github.com{path}"))
                .header("Accept", "application/json")
                .form(values),
        )
    }
    /// Read only repositories granted to this App and writable by the confirmed user.
    /// Numeric pagination never follows provider-controlled Link URLs.
    pub fn repositories(&self, c: &Credential) -> Result<RepositoryList> {
        discover_repositories(|path| self.get(c, path))
    }

    fn repo(&self, c: &Credential, value: Value) -> Result<RepoInfo> {
        if value["archived"] == true
            || value["disabled"] == true
            || value["default_branch"].as_str().is_none_or(str::is_empty)
        {
            return Err(Error::Unsupported);
        }
        if !value["permissions"]["push"].as_bool().unwrap_or(false) {
            return Err(Error::Permission);
        }
        let id = value["id"].as_u64().ok_or(Error::Permission)?;
        let mut installation_id = None;
        for page in 1..=10 {
            let installations =
                self.get(c, &format!("/user/installations?per_page=100&page={page}"))?;
            let list = installations["installations"]
                .as_array()
                .ok_or(Error::Permission)?;
            for installation in list {
                if installation["app_id"].as_u64() != Some(5412628)
                    || !installation["suspended_at"].is_null()
                    || installation["permissions"]["contents"] != "write"
                    || installation["permissions"]["pull_requests"] != "write"
                {
                    continue;
                }
                let candidate = installation["id"].as_u64().ok_or(Error::Permission)?;
                for repo_page in 1..=10 {
                    let repos=self.get(c,&format!("/user/installations/{candidate}/repositories?per_page=100&page={repo_page}"))?;
                    let items = repos["repositories"].as_array().ok_or(Error::Permission)?;
                    if items.iter().any(|r| r["id"].as_u64() == Some(id)) {
                        installation_id = Some(candidate);
                        break;
                    }
                    if items.len() < 100 {
                        break;
                    }
                }
            }
            if installation_id.is_some() || list.len() < 100 {
                break;
            }
        }
        repository_info(&value, installation_id.ok_or(Error::Permission)?)
    }
}
fn repository_info(value: &Value, installation_id: u64) -> Result<RepoInfo> {
    let repo = RepoInfo {
        id: value["id"].as_u64().ok_or(Error::Permission)?,
        owner: text(&value["owner"], "login")?,
        name: text(value, "name")?,
        private: value["private"].as_bool().ok_or(Error::Permission)?,
        default_branch: text(value, "default_branch")?,
        installation_id,
    };
    repo.validate()?;
    if value["clone_url"] != repo.clone_url() {
        return Err(Error::InvalidUrl);
    }
    Ok(repo)
}
fn discover_repositories(mut fetch: impl FnMut(&str) -> Result<Value>) -> Result<RepositoryList> {
    let mut requests = 0;
    let mut get = |path: &str| {
        requests += 1;
        if requests > 50 {
            return Err(crate::transport::budget(
                "repository discovery",
                "pagination or count",
                requests,
                50,
            ));
        }
        fetch(path)
    };
    let mut installations = HashMap::new();
    let mut repositories = HashMap::new();
    let mut unavailable = 0;
    for page in 1..=10 {
        let response = get(&format!("/user/installations?per_page=100&page={page}"))?;
        let items = response["installations"].as_array().ok_or(Error::Network)?;
        if items.len() > 100 {
            return Err(crate::transport::budget(
                "repository discovery",
                "page items",
                items.len(),
                100,
            ));
        }
        for installation in items {
            if installation["app_id"].as_u64() != Some(5412628) {
                continue;
            }
            let id = installation["id"]
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or(Error::Network)?;
            let grant = json!([installation["permissions"], installation["suspended_at"]]);
            if let Some(previous) = installations.insert(id, grant.clone()) {
                if previous != grant {
                    return Err(Error::Changed);
                }
                continue;
            }
            if !installation["suspended_at"].is_null()
                || installation["permissions"]["contents"] != "write"
                || installation["permissions"]["pull_requests"] != "write"
            {
                unavailable += 1;
                continue;
            }
            for repo_page in 1..=10 {
                let response = get(&format!(
                    "/user/installations/{id}/repositories?per_page=100&page={repo_page}"
                ))?;
                let entries = response["repositories"].as_array().ok_or(Error::Network)?;
                if entries.len() > 100 {
                    return Err(crate::transport::budget(
                        "repository discovery",
                        "page items",
                        entries.len(),
                        100,
                    ));
                }
                for entry in entries {
                    if entry["permissions"]["push"] != true
                        || entry["archived"] == true
                        || entry["disabled"] == true
                        || entry["default_branch"].as_str().is_none_or(str::is_empty)
                    {
                        unavailable += 1;
                        continue;
                    }
                    let repo = repository_info(entry, id)?;
                    if let Some(previous) = repositories.insert(repo.id, repo.clone()) {
                        if previous != repo {
                            return Err(Error::Changed);
                        }
                    }
                    if repositories.len() > 1000 {
                        return Err(crate::transport::budget(
                            "repository discovery",
                            "repository count",
                            repositories.len(),
                            1000,
                        ));
                    }
                }
                if entries.len() < 100 {
                    break;
                }
                if repo_page == 10 {
                    return Err(crate::transport::budget(
                        "repository discovery",
                        "repository pages",
                        11,
                        10,
                    ));
                }
            }
        }
        if items.len() < 100 {
            let mut repositories: Vec<RepoInfo> = repositories.into_values().collect();
            repositories.sort_by_key(|r| (r.owner.to_lowercase(), r.name.to_lowercase(), r.id));
            return Ok(RepositoryList {
                repositories,
                unavailable,
            });
        }
    }
    Err(crate::transport::budget(
        "repository discovery",
        "installation pages",
        11,
        10,
    ))
}

fn text(v: &Value, key: &str) -> Result<String> {
    v[key]
        .as_str()
        .filter(|s| s.len() <= 4096)
        .map(str::to_owned)
        .ok_or(Error::Network)
}
fn tokens(v: &Value) -> Result<TokenSet> {
    let token = text(v, "access_token")?;
    if token.is_empty() {
        return Err(Error::Auth);
    }
    Ok(TokenSet {
        access_token: token,
        refresh_token: v["refresh_token"].as_str().map(str::to_owned),
        expires_in: v["expires_in"].as_u64().unwrap_or(8 * 3600),
        refresh_expires_in: v["refresh_token_expires_in"].as_u64().unwrap_or(0),
    })
}
fn pull(v: &Value) -> Result<PullRequest> {
    let p = PullRequest {
        number: v["number"].as_u64().ok_or(Error::Network)?,
        url: text(v, "html_url")?,
        state: text(v, "state")?,
        merged: v["merged_at"].is_string() || v["merged"].as_bool().unwrap_or(false),
        draft: v["draft"].as_bool().ok_or(Error::Unsupported)?,
        head: text(&v["head"], "ref")?,
        base: text(&v["base"], "ref")?,
    };
    let url = url::Url::parse(&p.url).map_err(|_| Error::Network)?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || p.number == 0
    {
        return Err(Error::Network);
    }
    Ok(p)
}
fn validate_pull(repo: &RepoInfo, p: &PullRequest) -> Result<()> {
    if p.url != format!("{}/pull/{}", repo.url(), p.number) {
        Err(Error::Changed)
    } else {
        Ok(())
    }
}
fn segment(input: &str) -> String {
    url::form_urlencoded::byte_serialize(input.as_bytes()).collect()
}
impl Provider for HttpGitHub {
    fn create_pull(
        &self,
        c: &Credential,
        r: &RepoInfo,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<PullRequest> {
        r.validate()?;
        crate::transport::valid_ref(head)?;
        crate::transport::valid_ref(base)?;
        let v = self.json(
            self.client
                .post(format!(
                    "https://api.github.com/repos/{}/{}/pulls",
                    r.owner, r.name
                ))
                .bearer_auth(c.value()?)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2026-03-10")
                .json(&json!({"head":head,"base":base,"title":title,"body":body,"draft":draft})),
        )?;
        let p = pull(&v)?;
        validate_pull(r, &p)?;
        if p.draft != draft
            || p.head != head
            || p.base != base
            || v["head"]["repo"]["id"].as_u64() != Some(r.id)
            || v["base"]["repo"]["id"].as_u64() != Some(r.id)
        {
            return Err(Error::Uncertain);
        }
        Ok(p)
    }
    fn pull_detail(&self, c: &Credential, r: &RepoInfo, number: u64) -> Result<PullDetail> {
        r.validate()?;
        if number == 0 {
            return Err(Error::Unsupported);
        }
        let v = self.get_version(
            c,
            &format!("/repos/{}/{}/pulls/{number}", r.owner, r.name),
            "2026-03-10",
        )?;
        pull_detail_value(r, number, &v)
    }
    fn mark_ready(&self, c: &Credential, r: &RepoInfo, p: &PullDetail, id: &str) -> Result<()> {
        crate::uuid_id(id)?;
        r.validate()?;
        if p.head_repo_id != r.id || p.base_repo_id != r.id || !p.pull.draft {
            return Err(Error::Changed);
        }
        let v=self.json(self.client.post("https://api.github.com/graphql").bearer_auth(c.value()?).header("Accept","application/vnd.github+json").json(&json!({"query":"mutation($input:MarkPullRequestReadyForReviewInput!){markPullRequestReadyForReview(input:$input){clientMutationId pullRequest{id isDraft headRefOid}}}","variables":{"input":{"pullRequestId":p.node_id,"clientMutationId":id}}})))?;
        let result = &v["data"]["markPullRequestReadyForReview"];
        if v.get("errors").is_some()
            || result["clientMutationId"] != id
            || result["pullRequest"]["id"] != p.node_id
            || result["pullRequest"]["isDraft"] != false
            || result["pullRequest"]["headRefOid"] != p.head
        {
            return Err(Error::Uncertain);
        }
        Ok(())
    }
    fn merge_sync(
        &self,
        c: &Credential,
        r: &RepoInfo,
        p: &PullDetail,
        method: &str,
    ) -> Result<String> {
        r.validate()?;
        if p.head_repo_id != r.id
            || p.base_repo_id != r.id
            || p.stack != StackState::Standalone
            || !["merge", "squash", "rebase"].contains(&method)
        {
            return Err(Error::Unsupported);
        }
        // Caller must establish native no-bypass eligibility first. This is the
        // explicit single-PR endpoint, never a fallback to/from async merging.
        let v = self.json(
            self.client
                .put(format!(
                    "https://api.github.com/repos/{}/{}/pulls/{}/merge",
                    r.owner, r.name, p.pull.number
                ))
                .bearer_auth(c.value()?)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2026-03-10")
                .json(&json!({"sha":p.head,"merge_method":method})),
        )?;
        if v["merged"] != true {
            return Err(Error::Uncertain);
        }
        let oid = text(&v, "sha").map_err(|_| Error::Uncertain)?;
        git2::Oid::from_str(&oid).map_err(|_| Error::Uncertain)?;
        Ok(oid)
    }
    fn branches(&self, c: &Credential, r: &RepoInfo) -> Result<Vec<Branch>> {
        r.validate()?;
        let mut result = std::collections::BTreeMap::new();
        for page in 1..=10 {
            let data = self.get(
                c,
                &format!(
                    "/repos/{}/{}/branches?per_page=100&page={page}",
                    r.owner, r.name
                ),
            )?;
            let rows = data.as_array().ok_or(Error::Network)?;
            if rows.len() > 100 {
                return Err(crate::transport::budget(
                    "branch list",
                    "page items",
                    rows.len(),
                    100,
                ));
            }
            for row in rows {
                let name = text(row, "name")?;
                crate::transport::valid_ref(&name)?;
                let head = text(&row["commit"], "sha")?;
                git2::Oid::from_str(&head).map_err(|_| Error::Network)?;
                let protected = row["protected"].as_bool().ok_or(Error::Network)?;
                if let Some(old) = result.insert(
                    name.clone(),
                    Branch {
                        name,
                        head: head.clone(),
                        protected,
                    },
                ) {
                    if old.head != head || old.protected != protected {
                        return Err(Error::Changed);
                    }
                }
            }
            if rows.len() < 100 {
                return Ok(result.into_values().collect());
            }
        }
        Err(crate::transport::budget("branch list", "pages", 11, 10))
    }
    fn device_start(&self, client: &str) -> Result<DeviceCode> {
        let v = self.form(
            "/login/device/code",
            &[("client_id", client), ("scope", "offline_access")],
        )?;
        Ok(DeviceCode {
            device_code: text(&v, "device_code")?,
            user_code: text(&v, "user_code")?,
            verification_uri: text(&v, "verification_uri")?,
            expires_in: v["expires_in"].as_u64().ok_or(Error::Auth)?,
            interval: v["interval"].as_u64().unwrap_or(5),
        })
    }
    fn device_poll(&self, client: &str, code: &str) -> Result<Poll> {
        let v = self.form(
            "/login/oauth/access_token",
            &[
                ("client_id", client),
                ("device_code", code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )?;
        Ok(match v["error"].as_str() {
            Some("authorization_pending") => Poll::Pending,
            Some("slow_down") => Poll::SlowDown,
            Some("expired_token") => Poll::Expired,
            Some(_) => Poll::Denied,
            None => Poll::Authorized(tokens(&v)?),
        })
    }
    fn refresh(&self, client: &str, refresh: &str) -> Result<TokenSet> {
        let value = self.form(
            "/login/oauth/access_token",
            &[
                ("client_id", client),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
            ],
        )?;
        if matches!(
            value["error"].as_str(),
            Some("bad_refresh_token" | "expired_token" | "invalid_grant")
        ) {
            return Err(Error::Reconnect);
        }
        if value.get("error").is_some() {
            return Err(Error::Network);
        }
        tokens(&value).map_err(|_| Error::Network)
    }
    fn user(&self, c: &Credential) -> Result<User> {
        let v = self.get(c, "/user")?;
        Ok(User {
            id: v["id"].as_u64().ok_or(Error::Auth)?,
            login: text(&v, "login")?,
        })
    }
    fn repository(&self, c: &Credential, owner: &str, name: &str) -> Result<RepoInfo> {
        crate::locator(&format!("https://github.com/{owner}/{name}"))?;
        self.repo(c, self.get(c, &format!("/repos/{owner}/{name}"))?)
    }
    fn repository_by_id(&self, c: &Credential, id: u64) -> Result<RepoInfo> {
        self.repo(c, self.get(c, &format!("/repositories/{id}"))?)
    }
    fn head(&self, c: &Credential, r: &RepoInfo, branch: &str) -> Result<Option<String>> {
        r.validate()?;
        crate::transport::valid_ref(branch)?;
        let response = self
            .client
            .get(format!(
                "https://api.github.com/repos/{}/{}/git/ref/heads/{}",
                r.owner,
                r.name,
                segment(branch)
            ))
            .bearer_auth(c.value()?)
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(|_| Error::Network)?;
        if response.status() == 404 {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(Error::Permission);
        }
        let mut bytes = Vec::new();
        response
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Network)?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(crate::transport::budget(
                "GitHub API",
                "response bytes",
                bytes.len(),
                2 * 1024 * 1024,
            ));
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Network)?;
        let oid = text(&v["object"], "sha")?;
        git2::Oid::from_str(&oid).map_err(|_| Error::Network)?;
        Ok(Some(oid))
    }
    fn pulls(
        &self,
        c: &Credential,
        r: &RepoInfo,
        head: &str,
        base: &str,
    ) -> Result<Vec<(PullRequest, String)>> {
        r.validate()?;
        let v = self.get(
            c,
            &format!(
                "/repos/{}/{}/pulls?state=all&head={}&base={}&per_page=100",
                r.owner,
                r.name,
                segment(&format!("{}:{head}", r.owner)),
                segment(base)
            ),
        )?;
        let list = v.as_array().ok_or(Error::Network)?;
        if list.len() >= 100 {
            return Err(Error::Limit);
        }
        list.iter()
            .map(|v| {
                let p = pull(v)?;
                validate_pull(r, &p)?;
                Ok((p, v["body"].as_str().unwrap_or("").into()))
            })
            .collect()
    }
    fn create_draft(
        &self,
        c: &Credential,
        r: &RepoInfo,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
    ) -> Result<PullRequest> {
        r.validate()?;
        let v = self.json(
            self.client
                .post(format!(
                    "https://api.github.com/repos/{}/{}/pulls",
                    r.owner, r.name
                ))
                .bearer_auth(c.value()?)
                .header("Accept", "application/vnd.github+json")
                .json(&json!({"head":head,"base":base,"title":title,"body":body,"draft":true})),
        )?;
        let p = pull(&v)?;
        validate_pull(r, &p)?;
        if !p.draft || p.head != head || p.base != base {
            return Err(Error::Uncertain);
        }
        Ok(p)
    }
}
fn pull_detail_value(r: &RepoInfo, number: u64, v: &Value) -> Result<PullDetail> {
    let p = pull(v)?;
    validate_pull(r, &p)?;
    let head = text(&v["head"], "sha")?;
    let base = text(&v["base"], "sha")?;
    git2::Oid::from_str(&head)?;
    git2::Oid::from_str(&base)?;
    let head_repo_id = v["head"]["repo"]["id"].as_u64().ok_or(Error::Unsupported)?;
    let base_repo_id = v["base"]["repo"]["id"].as_u64().ok_or(Error::Unsupported)?;
    if p.number != number || head_repo_id != r.id || base_repo_id != r.id {
        return Err(Error::Changed);
    }
    let merge_commit = v["merge_commit_sha"].as_str().map(str::to_owned);
    if let Some(oid) = &merge_commit {
        git2::Oid::from_str(oid)?;
    }
    Ok(PullDetail {
        pull: p,
        node_id: text(v, "node_id")?,
        head,
        base,
        head_repo_id,
        base_repo_id,
        mergeable: v["mergeable"].as_bool(),
        merge_state: v["mergeable_state"].as_str().unwrap_or("unknown").into(),
        merge_commit,
        stack: match v.get("stack") {
            Some(Value::Null) => StackState::Standalone,
            Some(Value::Object(_)) => StackState::Present,
            _ => StackState::Unknown,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn server(status: &str, body: &str, headers: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(reply.as_bytes());
        });
        url
    }
    fn installation(id: u64) -> Value {
        json!({"id":id,"app_id":5412628,"suspended_at":null,"permissions":{"contents":"write","pull_requests":"write"}})
    }
    fn entry(id: u64) -> Value {
        json!({"id":id,"owner":{"login":"writer"},"name":format!("story-{id}"),"private":true,"default_branch":"main","clone_url":format!("https://github.com/writer/story-{id}.git"),"permissions":{"push":true}})
    }
    #[test]
    fn discovery_paginates_both_grants_and_repositories_without_broad_personal_listing() {
        let mut paths = Vec::new();
        let list = discover_repositories(|path| {
            paths.push(path.to_owned());
            Ok(match path {
                "/user/installations?per_page=100&page=1" => {
                    json!({"installations":vec![installation(7);100]})
                }
                "/user/installations?per_page=100&page=2" => {
                    json!({"installations":[installation(7),installation(8),{"id":9,"app_id":1}]})
                }
                "/user/installations/7/repositories?per_page=100&page=1" => {
                    json!({"repositories":vec![entry(42);100]})
                }
                "/user/installations/7/repositories?per_page=100&page=2" => {
                    json!({"repositories":[entry(43)]})
                }
                "/user/installations/8/repositories?per_page=100&page=1" => {
                    json!({"repositories":[entry(44)]})
                }
                _ => panic!("Unexpected discovery endpoint"),
            })
        })
        .unwrap();
        assert_eq!(
            list.repositories.iter().map(|r| r.id).collect::<Vec<_>>(),
            [42, 43, 44]
        );
        assert_eq!(paths.len(), 5);
        assert_eq!(list.repositories[2].installation_id, 8);
    }
    #[test]
    fn discovery_distinguishes_empty_inaccessible_and_provider_failure() {
        assert!(discover_repositories(|_| Ok(json!({"installations":[]})))
            .unwrap()
            .repositories
            .is_empty());
        let mut read_only = entry(42);
        read_only["permissions"]["push"] = json!(false);
        let mut archived = entry(43);
        archived["archived"] = json!(true);
        let mut suspended = installation(8);
        suspended["suspended_at"] = json!("2026-10-22");
        let list = discover_repositories(|p| {
            Ok(if p.starts_with("/user/installations?") {
                json!({"installations":[installation(7),suspended]})
            } else {
                json!({"repositories":[read_only,archived]})
            })
        })
        .unwrap();
        assert!(list.repositories.is_empty());
        assert_eq!(list.unavailable, 3);
        for error in [
            Error::Auth,
            Error::Permission,
            Error::RateLimit,
            Error::Network,
        ] {
            assert!(matches!(discover_repositories(|_|Err(error)),Err(e) if e==error));
        }
    }
    #[test]
    fn discovery_rejects_changed_grants_conflicting_identity_and_unbounded_pagination() {
        let mut changed = installation(7);
        changed["permissions"]["contents"] = json!("read");
        assert!(matches!(
            discover_repositories(|p| Ok(if p.starts_with("/user/installations?") {
                json!({"installations":[installation(7),changed]})
            } else {
                json!({"repositories":[]})
            })),
            Err(Error::Changed)
        ));
        let mut renamed = entry(42);
        renamed["private"] = json!(false);
        assert!(matches!(
            discover_repositories(|p| Ok(if p.starts_with("/user/installations?") {
                json!({"installations":[installation(7)]})
            } else {
                json!({"repositories":[entry(42),renamed]})
            })),
            Err(Error::Changed)
        ));
        let mut calls = 0;
        assert!(matches!(
            discover_repositories(|_| {
                calls += 1;
                Ok(json!({"installations":vec![json!({"app_id":1});100]}))
            }),
            Err(Error::Budget { .. })
        ));
        assert_eq!(calls, 10);
        let mut calls = 0;
        assert!(matches!(
            discover_repositories(|path| {
                calls += 1;
                Ok(if path.starts_with("/user/installations?") {
                    json!({"installations":(1..=50).map(installation).collect::<Vec<_>>()})
                } else {
                    json!({"repositories":[]})
                })
            }),
            Err(Error::Budget { .. })
        ));
        assert_eq!(calls, 50);
        assert!(matches!(
            discover_repositories(|path| if path.starts_with("/user/installations?") {
                Ok(json!({"installations":[installation(7)]}))
            } else {
                Err(Error::Permission)
            }),
            Err(Error::Permission)
        ));
    }
    #[test]
    fn actual_http_json_is_bounded_and_error_bodies_are_private() {
        let api = HttpGitHub::new().unwrap();
        let u = server("200 OK", "{\"id\":9}", "");
        assert_eq!(api.json(api.client.get(u)).unwrap()["id"], 9);
        for (code, error) in [
            ("401 Unauthorized", Error::Auth),
            ("403 Forbidden", Error::Permission),
            ("429 Too Many Requests", Error::RateLimit),
        ] {
            let u = server(code, "PRIVATE_TOKEN_OR_AUTHOR_TEXT", "");
            assert_eq!(api.json(api.client.get(u)).unwrap_err(), error);
        }
        for (headers, error) in [
            ("X-RateLimit-Remaining: 0\r\n", Error::RateLimit),
            ("X-GitHub-SSO: required\r\n", Error::Sso),
        ] {
            let u = server("403 Forbidden", "PRIVATE_PROVIDER_BODY", headers);
            assert_eq!(api.json(api.client.get(u)).unwrap_err(), error);
        }
        let u = server("200 OK", &"x".repeat(2 * 1024 * 1024 + 1), "");
        assert_eq!(
            api.json(api.client.get(u)).unwrap_err(),
            crate::transport::budget(
                "GitHub API",
                "response bytes",
                2 * 1024 * 1024 + 1,
                2 * 1024 * 1024
            )
        );
    }
    #[test]
    fn actual_http_redirect_is_never_followed() {
        let api = HttpGitHub::new().unwrap();
        let u = server(
            "302 Found",
            "",
            "Location: http://127.0.0.1:1/credential-trap\r\n",
        );
        assert_eq!(api.json(api.client.get(u)).unwrap_err(), Error::Changed);
    }
    #[test]
    fn draft_receipt_rejects_credential_urls_and_wrong_repository() {
        let mut v = json!({"number":1,"html_url":"https://github.com/example/story/pull/1","state":"open","draft":true,"head":{"ref":"heinlein/story-test"},"base":{"ref":"main"}});
        let p = pull(&v).unwrap();
        let r = RepoInfo {
            id: 42,
            owner: "example".into(),
            name: "story".into(),
            private: true,
            default_branch: "main".into(),
            installation_id: 7,
        };
        validate_pull(&r, &p).unwrap();
        v["html_url"] = json!("https://github.com/other/repository/pull/1");
        assert!(validate_pull(&r, &pull(&v).unwrap()).is_err());
        v["html_url"] = json!("https://name:secret@github.com/example/story/pull/1");
        assert!(pull(&v).is_err());
    }
    #[test]
    fn pull_metadata_decodes_explicit_standalone_and_fails_closed_for_unknown_stack() {
        let r = RepoInfo {
            id: 42,
            owner: "writer".into(),
            name: "story".into(),
            private: true,
            default_branch: "main".into(),
            installation_id: 7,
        };
        let mut v = json!({"number":1,"html_url":"https://github.com/writer/story/pull/1","state":"open","merged":false,"draft":false,"node_id":"PR_synthetic","head":{"ref":"revision/story","sha":"1111111111111111111111111111111111111111","repo":{"id":42}},"base":{"ref":"main","sha":"2222222222222222222222222222222222222222","repo":{"id":42}},"mergeable":true,"mergeable_state":"clean","merge_commit_sha":null});
        assert!(matches!(
            pull_detail_value(&r, 1, &v).unwrap().stack,
            StackState::Unknown
        ));
        v["stack"] = Value::Null;
        assert!(matches!(
            pull_detail_value(&r, 1, &v).unwrap().stack,
            StackState::Standalone
        ));
        for stack in [json!({"id":1}), json!({}), json!(true), json!([])] {
            v["stack"] = stack;
            assert!(!matches!(
                pull_detail_value(&r, 1, &v).unwrap().stack,
                StackState::Standalone
            ));
        }
        v["head"]["repo"]["id"] = json!(99);
        assert!(matches!(pull_detail_value(&r, 1, &v), Err(Error::Changed)));
    }
}
