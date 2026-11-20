use super::*;
use std::sync::{Arc, Mutex as StdMutex};

const KEY: &str = "sk-ant-unit-test-not-a-real-key-1a2b";

#[derive(Clone, Default)]
struct MemoryVault(Arc<StdMutex<Option<String>>>);
impl Vault for MemoryVault {
    fn load(&self) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, key: &str) -> Result<()> {
        *self.0.lock().unwrap() = Some(key.to_owned());
        Ok(())
    }
    fn delete(&self) -> Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Clone)]
struct FakeApi {
    reply: Arc<StdMutex<Result<Vec<Model>>>>,
    keys_seen: Arc<StdMutex<Vec<String>>>,
}
impl FakeApi {
    fn new(reply: Result<Vec<Model>>) -> Self {
        Self {
            reply: Arc::new(StdMutex::new(reply)),
            keys_seen: Arc::default(),
        }
    }
}
impl Transport for FakeApi {
    fn list_models<'a>(&'a self, api_key: &'a str) -> ModelsFuture<'a> {
        self.keys_seen.lock().unwrap().push(api_key.to_owned());
        let reply = self.reply.lock().unwrap().clone();
        Box::pin(async move { reply })
    }
}

fn model(slug: &str) -> Model {
    Model {
        slug: slug.into(),
        display_name: slug.replace('-', " "),
    }
}

fn catalog() -> Vec<Model> {
    vec![
        model("claude-sonnet-5-5"),
        model(DEFAULT_MODEL),
        model("claude-haiku-5-5"),
    ]
}

fn service(api: FakeApi, vault: MemoryVault) -> (tempfile::TempDir, ClaudeAuth) {
    let dir = tempfile::tempdir().unwrap();
    let auth = ClaudeAuth::with_parts(
        dir.path().join("claude-auth-v1"),
        Box::new(vault),
        Box::new(api),
    )
    .unwrap();
    (dir, auth)
}

#[tokio::test]
async fn a_good_key_is_saved_in_the_vault_and_claude_becomes_active() {
    let api = FakeApi::new(Ok(catalog()));
    let vault = MemoryVault::default();
    let (dir, auth) = service(api.clone(), vault.clone());
    let before = auth.status().unwrap();
    assert!(!before.configured && !before.active);
    let status = auth.connect(&format!("  {KEY}\n")).await.unwrap();
    assert!(status.configured && status.active);
    assert_eq!(status.selected_model.as_deref(), Some(DEFAULT_MODEL));
    assert_eq!(status.key_hint.as_deref(), Some("1a2b"));
    assert!(status
        .account_id
        .as_deref()
        .unwrap()
        .starts_with("anthropic-"));
    assert!(status.generation > before.generation);
    assert_eq!(api.keys_seen.lock().unwrap().as_slice(), [KEY]);
    assert_eq!(vault.load().unwrap().as_deref(), Some(KEY));
    // The key never reaches the status or the private settings file.
    assert!(!serde_json::to_string(&status).unwrap().contains(KEY));
    let file = std::fs::read_to_string(dir.path().join("claude-auth-v1/state.json")).unwrap();
    assert!(!file.contains("not-a-real-key"));
    // A reopened service restores the same settings.
    let reopened = ClaudeAuth::with_parts(
        dir.path().join("claude-auth-v1"),
        Box::new(vault),
        Box::new(api),
    )
    .unwrap()
    .status()
    .unwrap();
    assert_eq!(reopened.selected_model, status.selected_model);
    assert!(reopened.active);
}

#[tokio::test]
async fn a_rejected_or_malformed_key_changes_nothing() {
    let api = FakeApi::new(Err(ClaudeAuthError::Rejected));
    let vault = MemoryVault::default();
    let (_dir, auth) = service(api.clone(), vault.clone());
    assert_eq!(
        auth.connect(KEY).await.unwrap_err(),
        ClaudeAuthError::Rejected
    );
    for bad in ["", "   ", "has a space", &"x".repeat(600)] {
        assert_eq!(
            auth.connect(bad).await.unwrap_err(),
            ClaudeAuthError::InvalidKey
        );
    }
    assert_eq!(vault.load().unwrap(), None);
    assert!(!auth.status().unwrap().configured);
    // Malformed keys never reach the network.
    assert_eq!(api.keys_seen.lock().unwrap().len(), 1);
    let empty = FakeApi::new(Ok(vec![]));
    let (_dir, auth) = service(empty, vault.clone());
    assert_eq!(auth.connect(KEY).await.unwrap_err(), ClaudeAuthError::Model);
    assert_eq!(vault.load().unwrap(), None);
}

#[tokio::test]
async fn without_the_default_model_an_opus_model_is_preferred() {
    let api = FakeApi::new(Ok(vec![model("claude-haiku-5-5"), model("claude-opus-5")]));
    let (_dir, auth) = service(api, MemoryVault::default());
    let status = auth.connect(KEY).await.unwrap();
    assert_eq!(status.selected_model.as_deref(), Some("claude-opus-5"));
}

#[tokio::test]
async fn leases_end_when_the_model_provider_or_key_changes() {
    let (_dir, auth) = service(FakeApi::new(Ok(catalog())), MemoryVault::default());
    let status = auth.connect(KEY).await.unwrap();
    let lease = auth.credentials(status.generation).unwrap();
    assert_eq!(lease.api_key, KEY);
    assert_eq!(lease.model, DEFAULT_MODEL);
    assert!(!*lease.cancelled.borrow());
    let next = auth.select_model("claude-sonnet-5-5").unwrap();
    assert!(*lease.cancelled.borrow());
    assert!(!auth.is_current(status.generation));
    assert_eq!(
        auth.credentials(status.generation).err(),
        Some(ClaudeAuthError::Cancelled)
    );
    assert_eq!(
        auth.select_model("gpt-5").unwrap_err(),
        ClaudeAuthError::Model
    );
    let lease = auth.credentials(next.generation).unwrap();
    assert_eq!(lease.model, "claude-sonnet-5-5");
    let off = auth.set_active(false).unwrap();
    assert!(*lease.cancelled.borrow() || lease.cancelled.has_changed().is_err());
    assert!(!off.active && off.configured);
    // Choosing the current provider again is not a change.
    assert_eq!(auth.set_active(false).unwrap().generation, off.generation);
}

#[tokio::test]
async fn a_key_replaced_outside_heinlein_is_never_used_under_the_old_identity() {
    let vault = MemoryVault::default();
    let (_dir, auth) = service(FakeApi::new(Ok(catalog())), vault.clone());
    let status = auth.connect(KEY).await.unwrap();
    vault.save("sk-ant-someone-elses-key").unwrap();
    assert_eq!(
        auth.credentials(status.generation).err(),
        Some(ClaudeAuthError::Cancelled)
    );
    vault.delete().unwrap();
    assert_eq!(
        auth.credentials(status.generation).err(),
        Some(ClaudeAuthError::NotConfigured)
    );
}

#[tokio::test]
async fn sign_out_removes_the_key_and_every_setting() {
    let vault = MemoryVault::default();
    let (dir, auth) = service(FakeApi::new(Ok(catalog())), vault.clone());
    auth.connect(KEY).await.unwrap();
    let status = auth.sign_out().unwrap();
    assert!(!status.configured && !status.active);
    assert_eq!(status.key_hint, None);
    assert_eq!(vault.load().unwrap(), None);
    assert_eq!(
        auth.set_active(true).unwrap_err(),
        ClaudeAuthError::NotConfigured
    );
    let file = std::fs::read_to_string(dir.path().join("claude-auth-v1/state.json")).unwrap();
    assert!(!file.contains("anthropic-"));
}

#[tokio::test]
async fn refresh_keeps_a_still_offered_selection_and_replaces_a_withdrawn_one() {
    let api = FakeApi::new(Ok(catalog()));
    let (_dir, auth) = service(api.clone(), MemoryVault::default());
    auth.connect(KEY).await.unwrap();
    auth.select_model("claude-haiku-5-5").unwrap();
    assert_eq!(
        auth.refresh_models()
            .await
            .unwrap()
            .selected_model
            .as_deref(),
        Some("claude-haiku-5-5")
    );
    *api.reply.lock().unwrap() = Ok(vec![model(DEFAULT_MODEL)]);
    assert_eq!(
        auth.refresh_models()
            .await
            .unwrap()
            .selected_model
            .as_deref(),
        Some(DEFAULT_MODEL)
    );
}

#[test]
fn unreadable_or_newer_settings_are_reported_and_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("claude-auth-v1");
    std::fs::create_dir_all(&path).unwrap();
    for content in [
        "{not json",
        r#"{"version":2,"active":true,"key_hint":null,"account_id":null,"models":[],"selected_model":null}"#,
    ] {
        std::fs::write(path.join("state.json"), content).unwrap();
        let opened = ClaudeAuth::with_parts(
            path.clone(),
            Box::new(MemoryVault::default()),
            Box::new(FakeApi::new(Ok(vec![]))),
        );
        assert_eq!(
            opened.err().map(ClaudeAuthError::code),
            Some("claude_storage")
        );
        assert_eq!(
            std::fs::read_to_string(path.join("state.json")).unwrap(),
            content
        );
    }
    assert!(ClaudeAuth::with_parts(
        PathBuf::from("relative"),
        Box::new(MemoryVault::default()),
        Box::new(FakeApi::new(Ok(vec![]))),
    )
    .is_err());
}

#[test]
fn private_settings_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, auth) = service(FakeApi::new(Ok(catalog())), MemoryVault::default());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(auth.connect(KEY)).unwrap();
    let base = dir.path().join("claude-auth-v1");
    assert_eq!(
        std::fs::metadata(&base).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(base.join("state.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn model_lists_keep_only_well_formed_claude_entries() {
    let body = serde_json::json!({"data":[
        {"id":"claude-opus-5-5","display_name":"Claude Opus 5.5","type":"model"},
        {"id":"claude-opus-5-5","display_name":"duplicate"},
        {"id":"gpt-5","display_name":"Not Claude"},
        {"id":"claude-bad id","display_name":"space"},
        {"id":"claude-sonnet-5-5","display_name":"line\nbreak"},
        {"display_name":"no id"}
    ],"has_more":false});
    let models = parse_models(body.to_string().as_bytes()).unwrap();
    assert_eq!(
        models,
        vec![
            Model {
                slug: "claude-opus-5-5".into(),
                display_name: "Claude Opus 5.5".into()
            },
            Model {
                slug: "claude-sonnet-5-5".into(),
                display_name: "claude-sonnet-5-5".into()
            },
        ]
    );
    assert!(parse_models(b"{}").is_err());
    assert!(parse_models(b"nope").is_err());
}

#[test]
fn errors_are_plain_language_with_stable_codes() {
    for error in [
        ClaudeAuthError::InvalidKey,
        ClaudeAuthError::Rejected,
        ClaudeAuthError::Network,
        ClaudeAuthError::Unavailable,
        ClaudeAuthError::Storage,
        ClaudeAuthError::NotConfigured,
        ClaudeAuthError::Model,
        ClaudeAuthError::Busy,
        ClaudeAuthError::Cancelled,
    ] {
        assert!(error.code().starts_with("claude_"));
        assert!(error.to_string().ends_with('.'));
    }
}
