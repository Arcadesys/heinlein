use crate::{http, AuthError, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::watch,
};

pub(crate) const DIRECT_SCOPE: &str = "chatgpt.tokens.use.direct";
pub(crate) const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
pub(crate) const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_CALLBACK: usize = 16 * 1024;

pub(crate) struct Attempt {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
    pub redirect_uri: String,
    pub client_id: String,
}
pub(crate) struct Callback {
    pub code: String,
    pub client_id: String,
}
impl Attempt {
    pub fn new(port: u16, client_id: String) -> Self {
        Self {
            state: secret(),
            nonce: secret(),
            verifier: secret(),
            redirect_uri: format!("http://127.0.0.1:{port}/auth/callback"),
            client_id,
        }
    }
    pub fn authorization_url(
        &self,
        host: &str,
        id_hint: Option<&str>,
        email: Option<&str>,
        consent: bool,
    ) -> Result<String> {
        let mut url = url::Url::parse(http::AUTHORIZE).map_err(|_| AuthError::Configuration)?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes()));
        {
            let mut query = url.query_pairs_mut();
            query.extend_pairs([
                ("client_id", self.client_id.as_str()),
                ("ext_agent_host_id", host),
                ("response_type", "code"),
                ("redirect_uri", &self.redirect_uri),
                ("scope", SCOPES),
                ("resource", http::RESOURCE),
                ("state", &self.state),
                ("nonce", &self.nonce),
                ("code_challenge_method", "S256"),
                ("code_challenge", &challenge),
            ]);
            if self.client_id == DYNAMIC_CLIENT {
                query.append_pair("agent_name_hint", "Heinlein");
            } else {
                if let Some(hint) = id_hint {
                    query.append_pair("id_token_hint", hint);
                }
                if let Some(email) = email {
                    query.append_pair("login_hint", email);
                }
            }
            if consent {
                query.append_pair("prompt", "consent");
            }
        }
        Ok(url.into())
    }
    pub fn parse_callback(&self, request: &[u8]) -> Result<Callback> {
        let request = std::str::from_utf8(request).map_err(|_| AuthError::Callback)?;
        if request.len() > MAX_CALLBACK || !request.ends_with("\r\n\r\n") {
            return Err(AuthError::Callback);
        }
        let mut lines = request.split("\r\n");
        let first = lines.next().ok_or(AuthError::Callback)?;
        let parts: Vec<_> = first.split(' ').collect();
        if parts.len() != 3 || parts[0] != "GET" || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0") {
            return Err(AuthError::Callback);
        }
        let mut host = None;
        for line in lines.filter(|line| !line.is_empty()) {
            let (name, value) = line.split_once(':').ok_or(AuthError::Callback)?;
            if name.eq_ignore_ascii_case("host") {
                if host.is_some() {
                    return Err(AuthError::Callback);
                }
                host = Some(value.trim());
            }
            // GET callbacks have no body; reject smuggling/extra requests.
            if name.eq_ignore_ascii_case("content-length")
                || name.eq_ignore_ascii_case("transfer-encoding")
            {
                return Err(AuthError::Callback);
            }
        }
        let expected_host = self
            .redirect_uri
            .strip_prefix("http://")
            .and_then(|s| s.split('/').next())
            .ok_or(AuthError::Callback)?;
        if host != Some(expected_host) {
            return Err(AuthError::Callback);
        }
        if !parts[1].starts_with("/auth/callback?") || parts[1].contains('#') {
            return Err(AuthError::Callback);
        }
        let query = parts[1]
            .strip_prefix("/auth/callback?")
            .ok_or(AuthError::Callback)?;
        let mut params = HashMap::new();
        for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
            if params.insert(k.into_owned(), v.into_owned()).is_some() {
                return Err(AuthError::Callback);
            }
        }
        if !params
            .get("state")
            .is_some_and(|s| constant_eq(s, &self.state))
        {
            return Err(AuthError::Callback);
        }
        if params.contains_key("error") {
            return Err(AuthError::Declined);
        }
        let code = params
            .remove("code")
            .filter(|s| secret_field(s))
            .ok_or(AuthError::Callback)?;
        let client = match (self.client_id == DYNAMIC_CLIENT, params.remove("client_id")) {
            (true, Some(id)) if valid_client_id(&id) => id,
            (false, None) => self.client_id.clone(),
            (false, Some(id)) if id == self.client_id => id,
            _ => return Err(AuthError::Callback),
        };
        Ok(Callback {
            code,
            client_id: client,
        })
    }
}
pub(crate) async fn listen(
    listener: TcpListener,
    attempt: &Attempt,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<Callback> {
    tokio::select! {
        biased;
        _ = cancellation(cancelled) => Err(AuthError::Cancelled),
        result = tokio::time::timeout(CALLBACK_TIMEOUT, async {
            loop {
                let (mut socket, peer) = listener.accept().await.map_err(|_| AuthError::Callback)?;
                if !peer.ip().is_loopback() { continue; }
                let request = tokio::time::timeout(Duration::from_secs(2), async {
                    let mut bytes = Vec::new(); let mut chunk = [0; 1024];
                    loop {
                        let n = socket.read(&mut chunk).await.map_err(|_| AuthError::Callback)?;
                        if n == 0 { return Err(AuthError::Callback); }
                        bytes.extend_from_slice(&chunk[..n]);
                        if bytes.len() > MAX_CALLBACK { return Err(AuthError::Callback); }
                        if bytes.windows(4).any(|w| w == b"\r\n\r\n") { return Ok(bytes); }
                    }
                }).await;
                let parsed = request.ok().and_then(|v| v.ok()).map(|bytes| attempt.parse_callback(&bytes)).unwrap_or(Err(AuthError::Callback));
                let terminal = parsed.is_ok() || matches!(parsed, Err(AuthError::Declined));
                let response: &[u8] = if parsed.is_ok() {
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\nYou can close this tab and return to Heinlein."
                } else { b"HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nThis sign-in callback was not accepted." };
                let _ = tokio::time::timeout(Duration::from_secs(1), socket.write_all(response)).await;
                if terminal { return parsed; }
            }
        }) => result.map_err(|_| AuthError::Timeout)?,
    }
}
pub(crate) async fn cancellation(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}
pub(crate) fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
pub(crate) fn valid_client_id(id: &str) -> bool {
    id != DYNAMIC_CLIENT
        && !id.is_empty()
        && id.len() <= 192
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}
pub(crate) fn secret_field(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 * 1024 && !value.chars().any(char::is_control)
}
fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |n, (a, b)| n | (a ^ b)) == 0
}

#[derive(Deserialize)]
pub(crate) struct Identity {
    pub sub: String,
    pub email: Option<String>,
    nonce: Option<String>,
    iat: u64,
}
pub(crate) fn validate_identity(
    token: &str,
    jwks: &[u8],
    client_id: &str,
    nonce: Option<&str>,
) -> Result<Identity> {
    if !secret_field(token) {
        return Err(AuthError::Identity);
    }
    let header = decode_header(token).map_err(|_| AuthError::Identity)?;
    if !matches!(header.alg, Algorithm::RS256) {
        return Err(AuthError::Identity);
    }
    let kid = header
        .kid
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or(AuthError::Identity)?;
    let keys: JwkSet = serde_json::from_slice(jwks).map_err(|_| AuthError::Identity)?;
    let matching: Vec<_> = keys
        .keys
        .iter()
        .filter(|key| key.common.key_id.as_deref() == Some(kid))
        .collect();
    if matching.len() != 1 {
        return Err(AuthError::Identity);
    }
    let jwk = matching[0];
    if jwk
        .common
        .public_key_use
        .as_ref()
        .is_some_and(|v| !matches!(v, jsonwebtoken::jwk::PublicKeyUse::Signature))
    {
        return Err(AuthError::Identity);
    }
    if jwk
        .common
        .key_operations
        .as_ref()
        .is_some_and(|v| !v.contains(&jsonwebtoken::jwk::KeyOperations::Verify))
    {
        return Err(AuthError::Identity);
    }
    if jwk
        .common
        .key_algorithm
        .as_ref()
        .is_some_and(|alg| alg.to_string() != format!("{:?}", header.alg))
    {
        return Err(AuthError::Identity);
    }
    let key = DecodingKey::from_jwk(jwk).map_err(|_| AuthError::Identity)?;
    let mut validation = Validation::new(header.alg);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&[http::ISSUER]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "iat"]);
    validation.leeway = 0;
    validation.validate_nbf = true;
    let identity = decode::<Identity>(token, &key, &validation)
        .map_err(|_| AuthError::Identity)?
        .claims;
    if identity.iat > crate::now()?.saturating_add(60) {
        return Err(AuthError::Identity);
    }
    if identity.sub.is_empty()
        || identity.sub.len() > 256
        || identity.sub.chars().any(char::is_control)
    {
        return Err(AuthError::Identity);
    }
    if nonce.is_some_and(|expected| {
        !identity
            .nonce
            .as_ref()
            .is_some_and(|v| constant_eq(v, expected))
    }) {
        return Err(AuthError::Identity);
    }
    // A multiple-audience ID token must also identify this authorized party.
    #[derive(Deserialize)]
    struct Audience {
        aud: serde_json::Value,
        azp: Option<String>,
    }
    let aud = decode::<Audience>(token, &key, &validation)
        .map_err(|_| AuthError::Identity)?
        .claims;
    if aud.azp.as_ref().is_some_and(|azp| azp != client_id)
        || (aud.aud.as_array().is_some_and(|a| a.len() > 1)
            && aud.azp.as_deref() != Some(client_id))
    {
        return Err(AuthError::Identity);
    }
    Ok(identity)
}
