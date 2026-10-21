//! Fixed-host REST client, no redirects, retries, or response bodies in errors.
use crate::{
    auth::{Credential, DeviceCode, Poll, TokenSet, User},
    registry::PullRequest,
    Error, RepoInfo, Result,
};
use serde_json::{json, Value};
use std::io::Read;
pub trait Provider: Send + Sync {
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
                403 | 404 => Error::Permission,
                429 => Error::RateLimit,
                301 | 302 | 307 | 308 => Error::Changed,
                422 => Error::Unsupported,
                _ => Error::Network,
            });
        }
        if response
            .content_length()
            .is_some_and(|len| len > 2 * 1024 * 1024)
        {
            return Err(Error::Limit);
        }
        let mut bytes = Vec::new();
        response
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Network)?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(Error::Limit);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::Network)
    }
    fn get(&self, credential: &Credential, path: &str) -> Result<Value> {
        self.json(
            self.client
                .get(format!("https://api.github.com{path}"))
                .bearer_auth(credential.value()?)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28"),
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
    fn repo(&self, c: &Credential, value: Value) -> Result<RepoInfo> {
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
        let repo = RepoInfo {
            id,
            owner: text(&value["owner"], "login")?,
            name: text(&value, "name")?,
            private: value["private"].as_bool().ok_or(Error::Permission)?,
            default_branch: text(&value, "default_branch")?,
            installation_id: installation_id.ok_or(Error::Permission)?,
        };
        repo.validate()?;
        if value["clone_url"] != repo.clone_url() {
            return Err(Error::InvalidUrl);
        }
        Ok(repo)
    }
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
        tokens(&self.form(
            "/login/oauth/access_token",
            &[
                ("client_id", client),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
            ],
        )?)
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
            return Err(Error::Limit);
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
        let u = server("200 OK", &"x".repeat(2 * 1024 * 1024 + 1), "");
        assert_eq!(api.json(api.client.get(u)).unwrap_err(), Error::Limit);
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
}
