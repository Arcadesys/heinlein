//! Native-only Claude (Anthropic API key) connection for drafting questions.
//!
//! The API key lives only in the OS credential vault. A small private JSON file
//! keeps non-secret state: whether Claude is the active provider, the last four
//! characters of the key for display, the model list and the selected model.
//! The key never appears in status, errors, logs or that file.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{future::Future, io::Write, path::PathBuf, pin::Pin, sync::Mutex, time::Duration};
use tokio::sync::watch;

/// The model selected after connecting when the account offers it.
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
const MODELS_URL: &str = "https://api.anthropic.com/v1/models?limit=100";
const API_VERSION: &str = "2026-10-21";
const STATE_FILE: &str = "state.json";
const MAX_STATE_BYTES: u64 = 256 * 1024;
const MAX_MODELS_BYTES: usize = 512 * 1024;
const MAX_MODELS: usize = 100;
const MAX_KEY_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeAuthError {
    /// The pasted text cannot be an API key (empty, too long or not printable).
    InvalidKey,
    /// Anthropic did not accept the key.
    Rejected,
    Network,
    Unavailable,
    Storage,
    NotConfigured,
    Model,
    Busy,
    Cancelled,
}

impl ClaudeAuthError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidKey => "claude_invalid_key",
            Self::Rejected => "claude_rejected",
            Self::Network => "claude_network",
            Self::Unavailable => "claude_unavailable",
            Self::Storage => "claude_storage",
            Self::NotConfigured => "claude_not_configured",
            Self::Model => "claude_model",
            Self::Busy => "claude_busy",
            Self::Cancelled => "claude_cancelled",
        }
    }
}

impl std::fmt::Display for ClaudeAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidKey => "That doesn't look like an Anthropic API key. Paste the whole key, which starts with sk-ant-.",
            Self::Rejected => "Anthropic did not accept this API key. Check it at console.anthropic.com and paste it again.",
            Self::Network => "Heinlein could not reach Anthropic. Check your internet connection and try again.",
            Self::Unavailable => "Anthropic could not check the key right now. Try again in a minute.",
            Self::Storage => "Heinlein could not use the Mac's Keychain or its private settings for Claude. Nothing was changed.",
            Self::NotConfigured => "Claude is not set up yet. Add your Anthropic API key first.",
            Self::Model => "That Claude model is not available for this key. Choose another model.",
            Self::Busy => "The Claude connection is already being updated. Wait a moment and try again.",
            Self::Cancelled => "The Claude connection changed. Check it and send again.",
        })
    }
}
impl std::error::Error for ClaudeAuthError {}

pub type Result<T> = std::result::Result<T, ClaudeAuthError>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub slug: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    active: bool,
    key_hint: Option<String>,
    account_id: Option<String>,
    models: Vec<Model>,
    selected_model: Option<String>,
}

/// A safe snapshot for the interface. Contains no secret.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// A key is saved and a model is selected.
    pub configured: bool,
    /// Claude is the chosen provider for Ask, Revise and Review.
    pub active: bool,
    /// The last four characters of the saved key, for recognition only.
    pub key_hint: Option<String>,
    pub account_id: Option<String>,
    pub models: Vec<Model>,
    pub selected_model: Option<String>,
    pub generation: u64,
}

/// Deliberately neither Debug nor Serialize. Native transport must select on
/// `cancelled` and discard results after its generation changes.
pub struct Credentials {
    pub api_key: String,
    pub model: String,
    pub account_id: String,
    pub generation: u64,
    pub cancelled: watch::Receiver<bool>,
}

/// Where the API key is kept. The production vault is the OS keychain.
pub trait Vault: Send + Sync {
    fn load(&self) -> Result<Option<String>>;
    fn save(&self, key: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

pub type ModelsFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<Model>>> + Send + 'a>>;

/// Lists the models a key can use. This is also how a key is checked.
pub trait Transport: Send + Sync {
    fn list_models<'a>(&'a self, api_key: &'a str) -> ModelsFuture<'a>;
}

struct OsVault;
impl OsVault {
    fn entry() -> Result<keyring::Entry> {
        keyring::Entry::new("me.thearcades.heinlein.studio.claude", "anthropic-api-key")
            .map_err(|_| ClaudeAuthError::Storage)
    }
}
impl Vault for OsVault {
    fn load(&self) -> Result<Option<String>> {
        match Self::entry()?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(ClaudeAuthError::Storage),
        }
    }
    fn save(&self, key: &str) -> Result<()> {
        Self::entry()?
            .set_password(key)
            .map_err(|_| ClaudeAuthError::Storage)
    }
    fn delete(&self) -> Result<()> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(ClaudeAuthError::Storage),
        }
    }
}

struct HttpTransport;
impl Transport for HttpTransport {
    fn list_models<'a>(&'a self, api_key: &'a str) -> ModelsFuture<'a> {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .https_only(true)
                .no_proxy()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|_| ClaudeAuthError::Unavailable)?;
            let mut key = reqwest::header::HeaderValue::from_str(api_key)
                .map_err(|_| ClaudeAuthError::InvalidKey)?;
            key.set_sensitive(true);
            let mut response = client
                .get(MODELS_URL)
                .header("x-api-key", key)
                .header("anthropic-version", API_VERSION)
                .send()
                .await
                .map_err(|_| ClaudeAuthError::Network)?;
            match response.status().as_u16() {
                200 => {}
                401 | 403 => return Err(ClaudeAuthError::Rejected),
                _ => return Err(ClaudeAuthError::Unavailable),
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ClaudeAuthError::Network)?
            {
                if chunk.len() > MAX_MODELS_BYTES.saturating_sub(body.len()) {
                    return Err(ClaudeAuthError::Unavailable);
                }
                body.extend_from_slice(&chunk);
            }
            parse_models(&body)
        })
    }
}

fn valid_slug(slug: &str) -> bool {
    slug.starts_with("claude-")
        && slug.len() <= 100
        && slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

/// Keep only well-formed Claude model entries from a `GET /v1/models` body.
pub fn parse_models(body: &[u8]) -> Result<Vec<Model>> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| ClaudeAuthError::Unavailable)?;
    let data = value["data"]
        .as_array()
        .ok_or(ClaudeAuthError::Unavailable)?;
    let mut models: Vec<Model> = Vec::new();
    for entry in data {
        let Some(slug) = entry["id"].as_str().filter(|slug| valid_slug(slug)) else {
            continue;
        };
        if models.iter().any(|model| model.slug == slug) || models.len() >= MAX_MODELS {
            continue;
        }
        let display_name = entry["display_name"]
            .as_str()
            .filter(|name| {
                !name.trim().is_empty()
                    && name.chars().count() <= 100
                    && !name.chars().any(char::is_control)
            })
            .unwrap_or(slug);
        models.push(Model {
            slug: slug.to_owned(),
            display_name: display_name.to_owned(),
        });
    }
    Ok(models)
}

fn default_model(models: &[Model]) -> Option<String> {
    models
        .iter()
        .find(|model| model.slug == DEFAULT_MODEL)
        .or_else(|| {
            models
                .iter()
                .find(|model| model.slug.starts_with("claude-opus-"))
        })
        .or_else(|| models.first())
        .map(|model| model.slug.clone())
}

fn clean_key(api_key: &str) -> Result<&str> {
    let key = api_key.trim();
    if key.is_empty() || key.len() > MAX_KEY_BYTES || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ClaudeAuthError::InvalidKey);
    }
    Ok(key)
}

/// A stable, non-reversible identifier for one key. Saved reviews pin it so a
/// review resumes only with the key it started with.
fn account_id(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("anthropic-{hex}")
}

fn key_hint(key: &str) -> String {
    key.chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

struct Inner {
    state: State,
    generation: u64,
    lease: watch::Sender<bool>,
}

impl Inner {
    /// Any change to the key, model or provider choice ends every lease.
    fn bump(&mut self) {
        self.generation += 1;
        let _ = self.lease.send(true);
        self.lease = watch::channel(false).0;
    }
    fn status(&self) -> Status {
        let state = &self.state;
        Status {
            configured: state.account_id.is_some()
                && state
                    .selected_model
                    .as_ref()
                    .is_some_and(|slug| state.models.iter().any(|model| &model.slug == slug)),
            active: state.active,
            key_hint: state.key_hint.clone(),
            account_id: state.account_id.clone(),
            models: state.models.clone(),
            selected_model: state.selected_model.clone(),
            generation: self.generation,
        }
    }
}

pub struct ClaudeAuth {
    dir: PathBuf,
    vault: Box<dyn Vault>,
    transport: Box<dyn Transport>,
    inner: Mutex<Inner>,
    gate: tokio::sync::Mutex<()>,
}

impl ClaudeAuth {
    /// Open the production service: OS keychain and the real Anthropic API.
    pub fn open(dir: PathBuf) -> Result<Self> {
        Self::with_parts(dir, Box::new(OsVault), Box::new(HttpTransport))
    }

    pub fn with_parts(
        dir: PathBuf,
        vault: Box<dyn Vault>,
        transport: Box<dyn Transport>,
    ) -> Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        if !dir.is_absolute() {
            return Err(ClaudeAuthError::Storage);
        }
        std::fs::create_dir_all(&dir).map_err(|_| ClaudeAuthError::Storage)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| ClaudeAuthError::Storage)?;
        let state = Self::load(&dir)?;
        Ok(Self {
            dir,
            vault,
            transport,
            inner: Mutex::new(Inner {
                state,
                generation: 1,
                lease: watch::channel(false).0,
            }),
            gate: tokio::sync::Mutex::new(()),
        })
    }

    fn load(dir: &std::path::Path) -> Result<State> {
        use std::io::Read;
        let file = match std::fs::File::open(dir.join(STATE_FILE)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(State::default())
            }
            Err(_) => return Err(ClaudeAuthError::Storage),
        };
        let mut bytes = Vec::new();
        file.take(MAX_STATE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ClaudeAuthError::Storage)?;
        if bytes.len() as u64 > MAX_STATE_BYTES {
            return Err(ClaudeAuthError::Storage);
        }
        // An unreadable or newer file is kept as it is and reported.
        let state: State = serde_json::from_slice(&bytes).map_err(|_| ClaudeAuthError::Storage)?;
        if state.version != 1 {
            return Err(ClaudeAuthError::Storage);
        }
        Ok(state)
    }

    fn save(&self, state: &State) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let path = self.dir.join(STATE_FILE);
        let mut state = state.clone();
        state.version = 1;
        let bytes = serde_json::to_vec_pretty(&state).map_err(|_| ClaudeAuthError::Storage)?;
        let mut temp =
            tempfile::NamedTempFile::new_in(&self.dir).map_err(|_| ClaudeAuthError::Storage)?;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| ClaudeAuthError::Storage)?;
        temp.write_all(&bytes)
            .map_err(|_| ClaudeAuthError::Storage)?;
        temp.as_file()
            .sync_all()
            .map_err(|_| ClaudeAuthError::Storage)?;
        temp.persist(path).map_err(|_| ClaudeAuthError::Storage)?;
        Ok(())
    }

    fn inner(&self) -> Result<std::sync::MutexGuard<'_, Inner>> {
        self.inner.lock().map_err(|_| ClaudeAuthError::Storage)
    }

    /// Commit a new state: write it first, then publish it and end old leases.
    fn commit(&self, state: State) -> Result<Status> {
        self.save(&state)?;
        let mut inner = self.inner()?;
        inner.state = state;
        inner.bump();
        Ok(inner.status())
    }

    pub fn status(&self) -> Result<Status> {
        Ok(self.inner()?.status())
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.inner()
            .is_ok_and(|inner| inner.generation == generation)
    }

    /// Check a pasted key with Anthropic, then save it and make Claude the
    /// active provider. A rejected key changes nothing.
    pub async fn connect(&self, api_key: &str) -> Result<Status> {
        let _gate = self.gate.try_lock().map_err(|_| ClaudeAuthError::Busy)?;
        let key = clean_key(api_key)?;
        let models = self.transport.list_models(key).await?;
        let selected_model = default_model(&models).ok_or(ClaudeAuthError::Model)?;
        self.vault.save(key)?;
        self.commit(State {
            version: 1,
            active: true,
            key_hint: Some(key_hint(key)),
            account_id: Some(account_id(key)),
            models,
            selected_model: Some(selected_model),
        })
    }

    /// Reload the model list for the saved key, keeping the selection if it
    /// is still offered.
    pub async fn refresh_models(&self) -> Result<Status> {
        let _gate = self.gate.try_lock().map_err(|_| ClaudeAuthError::Busy)?;
        let key = self.vault.load()?.ok_or(ClaudeAuthError::NotConfigured)?;
        let models = self.transport.list_models(&key).await?;
        let mut state = self.inner()?.state.clone();
        if state.account_id.as_deref() != Some(account_id(&key).as_str()) {
            return Err(ClaudeAuthError::Cancelled);
        }
        if !state
            .selected_model
            .as_ref()
            .is_some_and(|slug| models.iter().any(|model| &model.slug == slug))
        {
            state.selected_model = default_model(&models);
        }
        state.models = models;
        self.commit(state)
    }

    pub fn select_model(&self, slug: &str) -> Result<Status> {
        let mut state = self.inner()?.state.clone();
        if state.account_id.is_none() {
            return Err(ClaudeAuthError::NotConfigured);
        }
        if !state.models.iter().any(|model| model.slug == slug) {
            return Err(ClaudeAuthError::Model);
        }
        state.selected_model = Some(slug.to_owned());
        self.commit(state)
    }

    /// Choose whether Claude (true) or ChatGPT (false) answers.
    pub fn set_active(&self, active: bool) -> Result<Status> {
        let mut state = self.inner()?.state.clone();
        if active && state.account_id.is_none() {
            return Err(ClaudeAuthError::NotConfigured);
        }
        if state.active == active {
            return self.status();
        }
        state.active = active;
        self.commit(state)
    }

    /// Remove the key from the vault and forget every Claude setting.
    pub fn sign_out(&self) -> Result<Status> {
        self.vault.delete()?;
        self.commit(State::default())
    }

    /// A lease for one request. It is cancelled by any later change.
    pub fn credentials(&self, expected_generation: u64) -> Result<Credentials> {
        let (account, model, generation, cancelled) = {
            let inner = self.inner()?;
            if inner.generation != expected_generation {
                return Err(ClaudeAuthError::Cancelled);
            }
            let status = inner.status();
            if !status.configured {
                return Err(ClaudeAuthError::NotConfigured);
            }
            (
                inner
                    .state
                    .account_id
                    .clone()
                    .ok_or(ClaudeAuthError::NotConfigured)?,
                inner
                    .state
                    .selected_model
                    .clone()
                    .ok_or(ClaudeAuthError::Model)?,
                inner.generation,
                inner.lease.subscribe(),
            )
        };
        let key = self.vault.load()?.ok_or(ClaudeAuthError::NotConfigured)?;
        // The vault entry could have been replaced outside Heinlein.
        if account_id(&key) != account {
            return Err(ClaudeAuthError::Cancelled);
        }
        if !self.is_current(generation) {
            return Err(ClaudeAuthError::Cancelled);
        }
        Ok(Credentials {
            api_key: key,
            model,
            account_id: account,
            generation,
            cancelled,
        })
    }
}

#[cfg(test)]
mod tests;
