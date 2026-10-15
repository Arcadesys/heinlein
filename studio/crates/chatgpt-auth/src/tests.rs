//! All keys, tokens, accounts and HTTP responses here are synthetic. No real home,
//! browser, sign-in server, token exchange, model catalog, or inference is used.
use super::*;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use std::collections::VecDeque;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const KEY: &[u8] = include_bytes!("../tests/fixtures/test-only-rsa-key.der");
const JWKS: &[u8] = include_bytes!("../tests/fixtures/test-only-jwks.json");
const CLIENT: &str = "oaiapp_synthetic_registration";

type RequestHook = Box<dyn Fn(&http::Request) + Send>;
#[derive(Default)]
struct FakeHttp {
    replies: Mutex<VecDeque<Result<http::Reply>>>,
    requests: Mutex<Vec<http::Request>>,
    registration_path: Mutex<Option<PathBuf>>,
    on_request: Mutex<Option<RequestHook>>,
}
impl FakeHttp {
    fn push(&self, status: u16, value: Value) {
        self.replies.lock().unwrap().push_back(Ok(http::Reply {
            status,
            body: serde_json::to_vec(&value).unwrap(),
        }));
    }
    fn keys(&self) {
        self.push(200, serde_json::from_slice(JWKS).unwrap());
    }
    fn catalog(&self) {
        self.push(200, json!({"models":[{"slug":"synthetic-hidden","display_name":"Hidden","visibility":"hide"},{"slug":"synthetic-model","display_name":"Synthetic model","visibility":"list"}]}));
    }
}
impl http::Transport for FakeHttp {
    fn execute(
        &self,
        request: http::Request,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<http::Reply>> + Send + '_>> {
        Box::pin(async move {
            assert!(http::allowed_url(&request.url));
            if let Some(hook) = &*self.on_request.lock().unwrap() {
                hook(&request);
            }
            if request.form.as_ref().is_some_and(|f| {
                f.iter()
                    .any(|(k, v)| k == "grant_type" && v == "authorization_code")
            }) {
                if let Some(path) = &*self.registration_path.lock().unwrap() {
                    let db: Database =
                        serde_json::from_slice(&std::fs::read(path.join("auth.json")).unwrap())
                            .unwrap();
                    assert!(
                        db.accounts.iter().any(|a| a.client_id == CLIENT),
                        "registration must be durable before code exchange"
                    );
                }
            }
            self.requests.lock().unwrap().push(request);
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected network request")
        })
    }
}
fn claims(nonce: &str) -> Value {
    json!({"iss":http::ISSUER,"aud":CLIENT,"sub":"synthetic-subject","email":"synthetic@example.invalid","nonce":nonce,"iat":now().unwrap()-1,"exp":now().unwrap()+3600})
}
fn jwt(claims: Value) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("synthetic-test-key".into());
    encode(&header, &claims, &EncodingKey::from_rsa_der(KEY)).unwrap()
}
fn token(nonce: &str, scopes: &str) -> Value {
    json!({"access_token":"synthetic-access-token","refresh_token":"synthetic-refresh-token","id_token":jwt(claims(nonce)),"token_type":"Bearer","expires_in":3600,"scope":scopes})
}
fn fixture() -> (tempfile::TempDir, Arc<AuthService>, Arc<FakeHttp>) {
    let temp = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeHttp::default());
    let path = temp.path().join("auth");
    *fake.registration_path.lock().unwrap() = Some(path.clone());
    let service = Arc::new(AuthService::with_transport(path, fake.clone()).unwrap());
    (temp, service, fake)
}
fn browser_callback(url: &str, fake: &FakeHttp, scopes: &str, catalog: bool) -> Result<()> {
    let url = url::Url::parse(url).unwrap();
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let redirect = url::Url::parse(&pairs["redirect_uri"]).unwrap();
    let state = pairs["state"].clone();
    fake.push(200, token(&pairs["nonce"], scopes));
    fake.keys();
    if catalog {
        fake.catalog();
    }
    tokio::spawn(async move {
        let host = format!("127.0.0.1:{}", redirect.port().unwrap());
        let mut socket = tokio::net::TcpStream::connect(&host).await.unwrap();
        let request=format!("GET /auth/callback?state={state}&code=synthetic-code&client_id={CLIENT} HTTP/1.1\r\nHost: {host}\r\n\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        assert!(response.starts_with(b"HTTP/1.1 200"));
    });
    Ok(())
}
async fn connected() -> (tempfile::TempDir, Arc<AuthService>, Arc<FakeHttp>) {
    let (temp, service, fake) = fixture();
    let status = service
        .connect(None, |url| {
            browser_callback(url, &fake, oauth::SCOPES, true)
        })
        .await
        .unwrap();
    assert!(!status.sign_in_pending);
    assert_eq!(status.accounts.len(), 1);
    assert_eq!(status.models.len(), 1);
    assert!(status.selected_model.is_none());
    service.select_model("synthetic-model").unwrap();
    (temp, service, fake)
}
fn expire_soon(service: &AuthService) {
    let _lock = service.store.lock().unwrap();
    let mut db = service.load().unwrap();
    db.account_mut(CLIENT)
        .unwrap()
        .tokens
        .as_mut()
        .unwrap()
        .expires_at = now().unwrap() + 10;
    service.store.save(&db).unwrap();
    service.runtime().unwrap().db = db;
}
#[test]
fn local_status_never_creates_registration_or_uses_network() {
    let (temp, service, fake) = fixture();
    assert!(service.status().unwrap().accounts.is_empty());
    assert!(fake.requests.lock().unwrap().is_empty());
    assert!(!temp.path().join("auth/auth.json").exists());
}
#[test]
fn pkce_is_s256_and_every_attempt_is_fresh() {
    use base64::Engine;
    use sha2::Digest;
    let first = oauth::Attempt::new(14000, DYNAMIC_CLIENT.into());
    let second = oauth::Attempt::new(14000, DYNAMIC_CLIENT.into());
    assert_ne!(first.state, second.state);
    assert_ne!(first.nonce, second.nonce);
    assert_ne!(first.verifier, second.verifier);
    let url = url::Url::parse(
        &first
            .authorization_url("urn:uuid:synthetic", None, None, false)
            .unwrap(),
    )
    .unwrap();
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["agent_name_hint"], "Heinlein");
    assert_eq!(
        q["code_challenge"],
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(first.verifier.as_bytes()))
    );
    assert_eq!(q["redirect_uri"], "http://127.0.0.1:14000/auth/callback");
    let returning = oauth::Attempt::new(14001, CLIENT.into());
    let url = returning
        .authorization_url(
            "host",
            Some("synthetic-id-hint"),
            Some("synthetic@example.invalid"),
            true,
        )
        .unwrap();
    assert!(!url.contains("agent_name_hint"));
    assert!(url.contains("prompt=consent"));
}
fn request(attempt: &oauth::Attempt, query: &str) -> Vec<u8> {
    format!(
        "GET /auth/callback?{query} HTTP/1.1\r\nHost: {}\r\n\r\n",
        attempt
            .redirect_uri
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap()
    )
    .into_bytes()
}
#[test]
fn callback_rejects_wrong_state_method_path_host_duplicates_and_client_mismatch() {
    let attempt = oauth::Attempt::new(10000, DYNAMIC_CLIENT.into());
    let query = format!(
        "state={}&code=synthetic-code&client_id={CLIENT}",
        attempt.state
    );
    assert!(attempt.parse_callback(&request(&attempt, &query)).is_ok());
    let valid = String::from_utf8(request(&attempt, &query)).unwrap();
    for invalid in [
        valid.replace(&attempt.state, "wrong-state"),
        valid.replace("GET ", "POST "),
        valid.replace("/auth/callback?", "/callback?"),
        valid.replace("127.0.0.1", "localhost"),
        valid.replace("code=synthetic-code", "code=first&code=second"),
        valid.replace(" HTTP/1.1", "#fragment HTTP/1.1"),
        valid.replace("\r\n\r\n", "\r\nContent-Length: 0\r\n\r\n"),
        format!("{valid}second request"),
    ] {
        assert!(matches!(
            attempt.parse_callback(invalid.as_bytes()),
            Err(AuthError::Callback)
        ));
    }
    assert!(matches!(
        attempt.parse_callback(&request(
            &attempt,
            &format!("state={}&error=access_denied", attempt.state)
        )),
        Err(AuthError::Declined)
    ));
    assert!(matches!(
        attempt.parse_callback(&request(&attempt, "state=wrong&error=access_denied")),
        Err(AuthError::Callback)
    ));
    let returning = oauth::Attempt::new(10000, CLIENT.into());
    assert!(returning
        .parse_callback(&request(
            &returning,
            &format!("state={}&code=abc", returning.state)
        ))
        .is_ok());
    assert!(returning
        .parse_callback(&request(
            &returning,
            &format!("state={}&code=abc&client_id=oaiapp_other", returning.state)
        ))
        .is_err());
}
#[test]
fn strict_jwt_validation_rejects_every_identity_confusion() {
    let base = claims("synthetic-nonce");
    assert!(
        oauth::validate_identity(&jwt(base.clone()), JWKS, CLIENT, Some("synthetic-nonce")).is_ok()
    );
    for (key, value) in [
        ("iss", json!("https://evil.invalid")),
        ("aud", json!("wrong-client")),
        ("exp", json!(now().unwrap() - 10)),
        ("nonce", json!("wrong")),
        ("iat", json!(now().unwrap() + 3600)),
        ("sub", json!("")),
        ("azp", json!("other")),
    ] {
        let mut c = base.clone();
        c[key] = value;
        assert!(
            oauth::validate_identity(&jwt(c), JWKS, CLIENT, Some("synthetic-nonce")).is_err(),
            "accepted {key}"
        );
    }
    for key in ["iat", "exp", "aud", "iss", "sub", "nonce"] {
        let mut c = base.clone();
        c.as_object_mut().unwrap().remove(key);
        assert!(
            oauth::validate_identity(&jwt(c), JWKS, CLIENT, Some("synthetic-nonce")).is_err(),
            "missing {key}"
        );
    }
    let mut multi = base.clone();
    multi["aud"] = json!([CLIENT, "another-client"]);
    assert!(
        oauth::validate_identity(&jwt(multi.clone()), JWKS, CLIENT, Some("synthetic-nonce"))
            .is_err()
    );
    multi["azp"] = json!(CLIENT);
    assert!(oauth::validate_identity(&jwt(multi), JWKS, CLIENT, Some("synthetic-nonce")).is_ok());
    let mut bad_key: Value = serde_json::from_slice(JWKS).unwrap();
    bad_key["keys"][0]["use"] = json!("enc");
    assert!(oauth::validate_identity(
        &jwt(base.clone()),
        &serde_json::to_vec(&bad_key).unwrap(),
        CLIENT,
        Some("synthetic-nonce")
    )
    .is_err());
    let mut duplicate: Value = serde_json::from_slice(JWKS).unwrap();
    let key = duplicate["keys"][0].clone();
    duplicate["keys"].as_array_mut().unwrap().push(key);
    assert!(oauth::validate_identity(
        &jwt(base.clone()),
        &serde_json::to_vec(&duplicate).unwrap(),
        CLIENT,
        Some("synthetic-nonce")
    )
    .is_err());
    let mut signed = jwt(base).into_bytes();
    let last = signed.len() - 5;
    signed[last] = if signed[last] == b'A' { b'B' } else { b'A' };
    assert!(oauth::validate_identity(
        std::str::from_utf8(&signed).unwrap(),
        JWKS,
        CLIENT,
        Some("synthetic-nonce")
    )
    .is_err());
}
#[tokio::test]
async fn connection_requires_explicit_model_and_returns_only_native_secret_lease() {
    let (_temp, service, fake) = connected().await;
    let status = service.status().unwrap();
    let serialized = serde_json::to_string(&status).unwrap();
    assert!(!serialized.contains("synthetic-access-token"));
    assert!(!serialized.contains("synthetic-refresh-token"));
    let lease = service.credentials(status.generation).await.unwrap();
    assert_eq!(lease.access_token, "synthetic-access-token");
    assert_eq!(lease.model, "synthetic-model");
    assert_eq!(fake.requests.lock().unwrap().len(), 3);
    assert!(!*lease.cancelled.borrow());
    service.cancel();
    assert!(*lease.cancelled.borrow());
    assert!(!service.is_current(status.generation));
    assert!(matches!(
        service.credentials(status.generation).await,
        Err(AuthError::Cancelled)
    ));
}
#[tokio::test]
async fn missing_plan_scope_preserves_identity_but_never_lists_models_or_allows_inference() {
    let (_temp, service, fake) = fixture();
    let status = service
        .connect(None, |url| {
            browser_callback(url, &fake, "openid email profile", false)
        })
        .await
        .unwrap();
    assert!(status.accounts[0].signed_in);
    assert!(!status.accounts[0].plan_enabled);
    assert!(status.models.is_empty());
    assert_eq!(fake.requests.lock().unwrap().len(), 2);
    assert!(service.select_model("synthetic-model").is_err());
}
#[tokio::test]
async fn cancelled_connection_closes_listener_and_does_not_exchange() {
    let (_temp, service, fake) = fixture();
    let cancel = service.clone();
    let result = service
        .connect(None, move |_url| {
            cancel.cancel();
            Ok(())
        })
        .await;
    assert!(matches!(result, Err(AuthError::Cancelled)));
    assert!(!service.status().unwrap().sign_in_pending);
    assert!(fake.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn refresh_rotates_atomically_without_changing_account_generation() {
    let (_temp, service, fake) = connected().await;
    expire_soon(&service);
    let generation = service.status().unwrap().generation;
    fake.keys();
    fake.push(200,json!({"access_token":"replacement-access","refresh_token":"replacement-refresh","token_type":"Bearer","expires_in":3600}));
    let lease = service.credentials(generation).await.unwrap();
    assert_eq!(lease.access_token, "replacement-access");
    assert_eq!(lease.generation, generation);
    let db = service.load().unwrap();
    let tokens = db.account(CLIENT).unwrap().tokens.as_ref().unwrap();
    assert_eq!(tokens.refresh_token.as_deref(), Some("replacement-refresh"));
    assert!(tokens.scopes.iter().any(|s| s == DIRECT_SCOPE));
    let requests = fake.requests.lock().unwrap();
    assert_eq!(requests[3].url, http::JWKS);
    assert_eq!(requests[4].url, http::TOKEN);
    let form = requests[4].form.as_ref().unwrap();
    assert!(form
        .iter()
        .any(|(k, v)| k == "refresh_token" && v == "synthetic-refresh-token"));
    assert!(!form.iter().any(|(k, _)| k == "scope"));
}
#[tokio::test]
async fn jwks_failure_happens_before_rotating_refresh_token() {
    let (_temp, service, fake) = connected().await;
    expire_soon(&service);
    let generation = service.status().unwrap().generation;
    fake.replies
        .lock()
        .unwrap()
        .push_back(Err(AuthError::Network));
    assert!(matches!(
        service.credentials(generation).await,
        Err(AuthError::Network)
    ));
    assert_eq!(fake.requests.lock().unwrap().len(), 4);
    assert_eq!(
        fake.requests.lock().unwrap().last().unwrap().url,
        http::JWKS
    );
    assert_eq!(
        service
            .load()
            .unwrap()
            .account(CLIENT)
            .unwrap()
            .tokens
            .as_ref()
            .unwrap()
            .refresh_token
            .as_deref(),
        Some("synthetic-refresh-token")
    );
}
#[tokio::test]
async fn terminal_refresh_error_clears_tokens_but_keeps_registration_and_host() {
    let (_temp, service, fake) = connected().await;
    expire_soon(&service);
    let before = service.load().unwrap();
    let generation = service.status().unwrap().generation;
    fake.keys();
    fake.push(
        400,
        json!({"error":"refresh_token_reused","error_description":"DO NOT EXPOSE"}),
    );
    assert!(matches!(
        service.credentials(generation).await,
        Err(AuthError::SessionExpired)
    ));
    let after = service.load().unwrap();
    assert_eq!(before.host_id, after.host_id);
    assert!(after.account(CLIENT).unwrap().tokens.is_none());
    assert!(after.account(CLIENT).unwrap().subject.is_some());
    assert_ne!(service.status().unwrap().generation, generation);
}
#[tokio::test]
async fn malformed_rotated_token_response_fails_closed_instead_of_reusing_old_token() {
    let (_temp, service, fake) = connected().await;
    expire_soon(&service);
    let generation = service.status().unwrap().generation;
    fake.keys();
    fake.push(200,json!({"access_token":"replacement","refresh_token":"new","token_type":"MAC","expires_in":3600}));
    assert!(matches!(
        service.credentials(generation).await,
        Err(AuthError::SessionExpired)
    ));
    assert!(service
        .load()
        .unwrap()
        .account(CLIENT)
        .unwrap()
        .tokens
        .is_none());
}
#[tokio::test]
async fn sign_out_retains_mapping_revokes_session_and_invalidates_lease() {
    let (_temp, service, fake) = connected().await;
    let status = service.status().unwrap();
    let lease = service.credentials(status.generation).await.unwrap();
    let host = service.load().unwrap().host_id;
    fake.push(200,json!({"issuer":http::ISSUER,"revocation_endpoint":"https://auth.openai.com/api/accounts/oauth/revoke"}));
    fake.push(200, json!({}));
    let status = service.sign_out(None).await.unwrap();
    assert!(*lease.cancelled.borrow());
    assert!(status.active_account_id.is_none());
    assert!(!status.accounts[0].signed_in);
    assert!(status.message.is_none());
    let db = service.load().unwrap();
    assert_eq!(db.host_id, host);
    assert!(db.account(CLIENT).unwrap().tokens.is_none());
    assert_eq!(
        db.account(CLIENT).unwrap().subject.as_deref(),
        Some("synthetic-subject")
    );
}
#[tokio::test]
async fn untrusted_revocation_endpoint_never_receives_token_and_warns_after_local_signout() {
    let (_temp, service, fake) = connected().await;
    fake.push(200,json!({"issuer":http::ISSUER,"revocation_endpoint":"https://evil.invalid/api/accounts/oauth/revoke"}));
    let status = service.sign_out(None).await.unwrap();
    assert!(!status.accounts[0].signed_in);
    assert!(status.message.unwrap().contains("not confirmed"));
    assert_eq!(fake.requests.lock().unwrap().len(), 4);
}
#[test]
fn endpoint_allowlist_and_safe_errors_never_accept_arbitrary_origins() {
    for url in [
        "http://auth.openai.com/api/accounts/oauth/revoke",
        "https://auth.openai.com.evil.invalid/api/accounts/oauth/revoke",
        "https://evil@auth.openai.com/api/accounts/oauth/revoke",
        "https://auth.openai.com/api/accounts/oauth/revoke?token=secret",
        "https://api.openai.com/v1/responses",
        "https://localhost/v1/models",
    ] {
        assert!(!http::allowed_url(url));
    }
    assert!(!AuthError::Network.to_string().contains("http"));
    assert_eq!(AuthError::Identity.code(), "chatgpt_identity");
}
#[test]
fn service_and_connect_future_are_send() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<AuthService>();
    fn assert_send<T: Send>(_: T) {}
    let (_temp, service, _fake) = fixture();
    assert_send(service.connect(None, |_| Ok(())));
}

#[tokio::test]
async fn callback_listener_is_single_use_and_closed_after_success() {
    let (_temp, service, fake) = fixture();
    let endpoint = std::sync::Mutex::new(String::new());
    service
        .connect(None, |url| {
            let url_parsed = url::Url::parse(url).unwrap();
            let q: std::collections::HashMap<_, _> =
                url_parsed.query_pairs().into_owned().collect();
            let redirect = url::Url::parse(&q["redirect_uri"]).unwrap();
            *endpoint.lock().unwrap() = format!("127.0.0.1:{}", redirect.port().unwrap());
            browser_callback(url, &fake, oauth::SCOPES, true)
        })
        .await
        .unwrap();
    let endpoint = endpoint.lock().unwrap().clone();
    assert!(tokio::net::TcpStream::connect(endpoint).await.is_err());
    assert_eq!(
        fake.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.url == http::TOKEN)
            .count(),
        1
    );
}
#[tokio::test(start_paused = true)]
async fn callback_listener_has_bounded_timeout() {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let attempt = oauth::Attempt::new(listener.local_addr().unwrap().port(), DYNAMIC_CLIENT.into());
    let (_tx, mut rx) = watch::channel(false);
    let task = tokio::spawn(async move { oauth::listen(listener, &attempt, &mut rx).await });
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_secs(301)).await;
    assert!(matches!(task.await.unwrap(), Err(AuthError::Timeout)));
}
#[tokio::test]
async fn failed_code_exchange_keeps_issued_client_for_fresh_authorization() {
    let (_temp, service, fake) = fixture();
    let result = service
        .connect(None, |url| {
            browser_callback(url, &fake, oauth::SCOPES, false)?;
            let mut queue = fake.replies.lock().unwrap();
            queue.clear();
            queue.push_back(Ok(http::Reply {
                status: 400,
                body: br#"{"error":"invalid_grant"}"#.to_vec(),
            }));
            Ok(())
        })
        .await;
    assert!(matches!(result, Err(AuthError::SessionExpired)));
    let retained = service.load().unwrap();
    assert_eq!(retained.accounts.len(), 1);
    assert!(retained.account(CLIENT).unwrap().tokens.is_none());
    let host = retained.host_id;
    let status = service
        .connect(Some(CLIENT), |url| {
            let parsed = url::Url::parse(url).unwrap();
            let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
            assert_eq!(q["client_id"], CLIENT);
            assert_eq!(q["ext_agent_host_id"], host);
            assert!(!q.contains_key("agent_name_hint"));
            assert!(!q.contains_key("id_token_hint"));
            browser_callback(url, &fake, oauth::SCOPES, true)
        })
        .await
        .unwrap();
    assert!(status.accounts[0].signed_in);
    assert_eq!(status.accounts.len(), 1);
}
#[tokio::test]
async fn wrong_identity_never_replaces_saved_account_credentials() {
    let (_temp, service, fake) = connected().await;
    let result = service
        .connect(Some(CLIENT), |url| {
            browser_callback(url, &fake, oauth::SCOPES, false)?;
            let parsed = url::Url::parse(url).unwrap();
            let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
            assert!(q.contains_key("id_token_hint"));
            let mut identity = claims(&q["nonce"]);
            identity["sub"] = json!("different-subject");
            let mut response = token(&q["nonce"], oauth::SCOPES);
            response["id_token"] = json!(jwt(identity));
            response["access_token"] = json!("wrong-account-token");
            fake.replies.lock().unwrap()[0] = Ok(http::Reply {
                status: 200,
                body: serde_json::to_vec(&response).unwrap(),
            });
            Ok(())
        })
        .await;
    assert!(matches!(result, Err(AuthError::Identity)));
    assert_eq!(
        service
            .load()
            .unwrap()
            .account(CLIENT)
            .unwrap()
            .tokens
            .as_ref()
            .unwrap()
            .access_token,
        "synthetic-access-token"
    );
}
#[tokio::test]
async fn lost_refresh_response_blocks_replay_after_restart_without_erasing_identity() {
    let (temp, service, fake) = connected().await;
    expire_soon(&service);
    let generation = service.status().unwrap().generation;
    fake.keys();
    fake.replies
        .lock()
        .unwrap()
        .push_back(Err(AuthError::Network));
    assert!(matches!(
        service.credentials(generation).await,
        Err(AuthError::SessionExpired)
    ));
    let saved = service.load().unwrap();
    assert!(saved.account(CLIENT).unwrap().refresh_pending);
    assert!(saved.account(CLIENT).unwrap().tokens.is_some());
    let reopened = AuthService::with_transport(temp.path().join("auth"), fake.clone()).unwrap();
    let status = reopened.status().unwrap();
    assert!(!status.accounts[0].signed_in);
    assert!(!status.accounts[0].plan_enabled);
    let before = fake.requests.lock().unwrap().len();
    assert!(matches!(
        reopened.select_account(CLIENT).await,
        Err(AuthError::SessionExpired)
    ));
    assert_eq!(before, fake.requests.lock().unwrap().len());
}
#[cfg(unix)]
#[tokio::test]
async fn failed_rotated_token_commit_leaves_durable_replay_guard() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, service, fake) = connected().await;
    expire_soon(&service);
    let generation = service.status().unwrap().generation;
    let record = temp.path().join("auth/auth.json");
    let hook_path = record.clone();
    *fake.on_request.lock().unwrap() = Some(Box::new(move |request| {
        if request.url == http::TOKEN {
            std::fs::set_permissions(&hook_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
    }));
    fake.keys();
    fake.push(200,json!({"access_token":"rotated-access","refresh_token":"rotated-refresh","token_type":"Bearer","expires_in":3600}));
    assert!(matches!(
        service.credentials(generation).await,
        Err(AuthError::Storage)
    ));
    std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o600)).unwrap();
    let db = service.load().unwrap();
    assert!(db.account(CLIENT).unwrap().refresh_pending);
    assert_eq!(
        db.account(CLIENT)
            .unwrap()
            .tokens
            .as_ref()
            .unwrap()
            .refresh_token
            .as_deref(),
        Some("synthetic-refresh-token")
    );
    let status = service.status().unwrap();
    assert!(!status.accounts[0].signed_in);
    assert!(!status.accounts[0].plan_enabled);
    let before = fake.requests.lock().unwrap().len();
    assert!(matches!(
        service.select_account(CLIENT).await,
        Err(AuthError::SessionExpired)
    ));
    assert_eq!(before, fake.requests.lock().unwrap().len());
}
#[tokio::test]
async fn cancellation_before_identity_commit_never_installs_tokens() {
    let (_temp, service, fake) = fixture();
    let weak = Arc::downgrade(&service);
    *fake.on_request.lock().unwrap() = Some(Box::new(move |request| {
        if request.url == http::JWKS {
            weak.upgrade().unwrap().cancel();
        }
    }));
    let result = service
        .connect(None, |url| {
            browser_callback(url, &fake, oauth::SCOPES, false)
        })
        .await;
    assert!(matches!(result, Err(AuthError::Cancelled)));
    let db = service.load().unwrap();
    assert!(db.active.is_none());
    assert!(db.account(CLIENT).unwrap().tokens.is_none());
}

#[tokio::test]
async fn ambiguous_refresh_500_keeps_material_but_blocks_rotation_replay() {
    let (_temp, service, fake) = connected().await;
    expire_soon(&service);
    let generation = service.status().unwrap().generation;
    fake.keys();
    fake.push(
        500,
        json!({"detail":"synthetic infrastructure failure after possible rotation"}),
    );
    assert!(matches!(
        service.credentials(generation).await,
        Err(AuthError::SessionExpired)
    ));
    let saved = service.load().unwrap();
    let account = saved.account(CLIENT).unwrap();
    assert!(account.refresh_pending);
    assert!(account.tokens.is_some());
    assert!(!service.status().unwrap().accounts[0].signed_in);
    let before = fake.requests.lock().unwrap().len();
    assert!(matches!(
        service.select_account(CLIENT).await,
        Err(AuthError::SessionExpired)
    ));
    assert_eq!(before, fake.requests.lock().unwrap().len());
}
#[tokio::test]
async fn absent_granted_scopes_keep_signin_but_never_enable_plan_use() {
    let (_temp, service, fake) = fixture();
    let status = service
        .connect(None, |url| {
            browser_callback(url, &fake, oauth::SCOPES, false)?;
            let mut queue = fake.replies.lock().unwrap();
            let response = queue[0].as_mut().unwrap();
            let mut body: Value = serde_json::from_slice(&response.body).unwrap();
            body.as_object_mut().unwrap().remove("scope");
            response.body = serde_json::to_vec(&body).unwrap();
            Ok(())
        })
        .await
        .unwrap();
    assert!(status.accounts[0].signed_in);
    assert!(!status.accounts[0].plan_enabled);
    assert_eq!(fake.requests.lock().unwrap().len(), 2);
}
#[test]
fn all_native_command_futures_are_send() {
    fn assert_send<T: Send>(_: T) {}
    let (_temp, service, _fake) = fixture();
    assert_send(service.connect(None, |_| Ok(())));
    assert_send(service.select_account(CLIENT));
    assert_send(service.refresh_models());
    assert_send(service.credentials(1));
    assert_send(service.sign_out(None));
}

#[tokio::test]
async fn cancelled_refresh_still_persists_rotation_without_returning_stale_lease() {
    let (_temp, service, fake) = connected().await;
    expire_soon(&service);
    let generation = service.status().unwrap().generation;
    let weak = Arc::downgrade(&service);
    *fake.on_request.lock().unwrap() = Some(Box::new(move |request| {
        if request.url == http::TOKEN {
            weak.upgrade().unwrap().cancel();
        }
    }));
    fake.keys();
    fake.push(200,json!({"access_token":"replacement-after-cancel","refresh_token":"replacement-refresh-after-cancel","token_type":"Bearer","expires_in":3600}));
    assert!(matches!(
        service.credentials(generation).await,
        Err(AuthError::Cancelled)
    ));
    let db = service.load().unwrap();
    let account = db.account(CLIENT).unwrap();
    assert!(!account.refresh_pending);
    let tokens = account.tokens.as_ref().unwrap();
    assert_eq!(tokens.access_token, "replacement-after-cancel");
    assert_eq!(
        tokens.refresh_token.as_deref(),
        Some("replacement-refresh-after-cancel")
    );
    assert!(!service.is_current(generation));
}
