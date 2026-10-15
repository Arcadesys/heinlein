use crate::{AuthError, Result};
use std::{future::Future, pin::Pin, time::Duration};

pub(crate) const ISSUER: &str = "https://auth.openai.com";
pub(crate) const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
pub(crate) const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
pub(crate) const JWKS: &str = "https://auth.openai.com/.well-known/jwks.json";
pub(crate) const DISCOVERY: &str = "https://auth.openai.com/.well-known/openid-configuration";
pub(crate) const MODELS: &str = "https://api.openai.com/v1/models";
pub(crate) const RESOURCE: &str = "https://api.openai.com/v1";
const MAX_RESPONSE: usize = 1024 * 1024;

pub(crate) struct Request {
    pub url: String,
    pub form: Option<Vec<(String, String)>>,
    pub bearer: Option<String>,
}
pub(crate) struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}
pub(crate) trait Transport: Send + Sync {
    fn execute(&self, request: Request)
        -> Pin<Box<dyn Future<Output = Result<Reply>> + Send + '_>>;
}
pub(crate) struct Http(reqwest::Client);
impl Http {
    pub fn new() -> Result<Self> {
        Ok(Self(
            reqwest::Client::builder()
                .https_only(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| AuthError::Network)?,
        ))
    }
}
impl Transport for Http {
    fn execute(
        &self,
        request: Request,
    ) -> Pin<Box<dyn Future<Output = Result<Reply>> + Send + '_>> {
        Box::pin(async move {
            if !allowed_url(&request.url) {
                return Err(AuthError::Configuration);
            }
            let mut builder = if let Some(form) = request.form {
                self.0.post(&request.url).form(&form)
            } else {
                self.0.get(&request.url)
            };
            if let Some(bearer) = request.bearer {
                builder = builder.bearer_auth(bearer);
            }
            let mut response = builder.send().await.map_err(|_| AuthError::Network)?;
            if response
                .content_length()
                .is_some_and(|n| n > MAX_RESPONSE as u64)
            {
                return Err(AuthError::Response);
            }
            let status = response.status().as_u16();
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| AuthError::Network)? {
                if body.len().saturating_add(chunk.len()) > MAX_RESPONSE {
                    return Err(AuthError::Response);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(Reply { status, body })
        })
    }
}
pub(crate) fn allowed_url(value: &str) -> bool {
    matches!(value, TOKEN | JWKS | DISCOVERY | MODELS) || valid_revocation_url(value)
}
pub(crate) fn valid_revocation_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("auth.openai.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with("/api/accounts/")
        && url.path().ends_with("/revoke")
}
pub(crate) fn get(url: &str, bearer: Option<String>) -> Request {
    Request {
        url: url.into(),
        form: None,
        bearer,
    }
}
pub(crate) fn post(url: &str, form: Vec<(String, String)>) -> Request {
    Request {
        url: url.into(),
        form: Some(form),
        bearer: None,
    }
}
