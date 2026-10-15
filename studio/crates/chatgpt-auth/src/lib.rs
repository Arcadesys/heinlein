//! Native-only Sign in with ChatGPT. No renderer token transport, model defaults,
//! environment credentials, startup network, API-key fallback, or inference here.
mod http;
mod oauth;
mod storage;

use oauth::{DIRECT_SCOPE, DYNAMIC_CLIENT};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

pub type Result<T> = std::result::Result<T, AuthError>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthError {
    Storage,
    Busy,
    Configuration,
    Network,
    Response,
    Identity,
    Callback,
    Declined,
    Timeout,
    Cancelled,
    Browser,
    NotSignedIn,
    Permission,
    Model,
    SessionExpired,
    Client,
}
impl AuthError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Storage => "chatgpt_storage",
            Self::Busy => "chatgpt_busy",
            Self::Configuration => "chatgpt_configuration",
            Self::Network => "chatgpt_network",
            Self::Response => "chatgpt_response",
            Self::Identity => "chatgpt_identity",
            Self::Callback => "chatgpt_callback",
            Self::Declined => "chatgpt_declined",
            Self::Timeout => "chatgpt_timeout",
            Self::Cancelled => "chatgpt_cancelled",
            Self::Browser => "chatgpt_browser",
            Self::NotSignedIn => "chatgpt_sign_in_required",
            Self::Permission => "chatgpt_plan_permission",
            Self::Model => "chatgpt_model_required",
            Self::SessionExpired => "chatgpt_session_expired",
            Self::Client => "chatgpt_client_configuration",
        }
    }
}
impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Storage => "ChatGPT credentials could not be safely read or saved. Check Heinlein's private app-data storage.",
            Self::Busy => "Another ChatGPT connection operation is in progress. Try again when it finishes.",
            Self::Configuration => "This ChatGPT connection configuration is not supported.",
            Self::Network => "The ChatGPT service could not be reached. Existing credentials were preserved.",
            Self::Response => "The ChatGPT service returned an unsupported response.",
            Self::Identity => "The ChatGPT account identity could not be verified. Sign in again.",
            Self::Callback => "The ChatGPT sign-in callback was not accepted.",
            Self::Declined => "ChatGPT sign-in was declined. No model request was made.",
            Self::Timeout => "ChatGPT sign-in timed out. Start a new sign-in.",
            Self::Cancelled => "The ChatGPT connection changed or was cancelled. Review the current account and try again.",
            Self::Browser => "The system browser could not be opened for ChatGPT sign-in.",
            Self::NotSignedIn => "Continue with ChatGPT to connect an account.",
            Self::Permission => "This ChatGPT account has not granted permission to use its plan. Continue with ChatGPT to enable it.",
            Self::Model => "Refresh the account's models and choose one before sending a question.",
            Self::SessionExpired => "This ChatGPT session can no longer be refreshed. Sign in again with the saved account.",
            Self::Client => "ChatGPT rejected this app registration. The client configuration needs attention.",
        })
    }
}
impl std::error::Error for AuthError {}

pub type AccountView = AccountStatus;
pub type ModelView = Model;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub id: String,
    pub label: String,
    pub signed_in: bool,
    pub plan_enabled: bool,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub slug: String,
    pub display_name: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub accounts: Vec<AccountStatus>,
    pub active_account_id: Option<String>,
    pub models: Vec<Model>,
    pub selected_model: Option<String>,
    pub sign_in_pending: bool,
    pub generation: u64,
    pub message: Option<String>,
}
/// Deliberately neither Debug nor Serialize. Native transport must select on
/// `cancelled` before transmitting and discard results after its generation changes.
pub struct Credentials {
    pub access_token: String,
    pub model: String,
    pub account_id: String,
    pub generation: u64,
    pub cancelled: watch::Receiver<bool>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    id_token: String,
    scopes: Vec<String>,
    expires_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Registration {
    client_id: String,
    subject: Option<String>,
    email: Option<String>,
    tokens: Option<Tokens>,
    selected_model: Option<String>,
    /// A write-ahead guard against replaying a consumed rotating refresh token
    /// after a crash, lost response, or failed atomic replacement.
    #[serde(default)]
    refresh_pending: bool,
}
impl Registration {
    fn plan_enabled(&self) -> bool {
        !self.refresh_pending
            && self
                .tokens
                .as_ref()
                .is_some_and(|t| t.scopes.iter().any(|s| s == DIRECT_SCOPE))
    }
    fn label(&self) -> String {
        format!(
            "{} ({})",
            self.email.as_deref().unwrap_or(if self.subject.is_some() {
                "ChatGPT account"
            } else {
                "Unfinished ChatGPT sign-in"
            }),
            self.client_id
        )
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Database {
    schema: u32,
    host_id: String,
    accounts: Vec<Registration>,
    active: Option<String>,
}
impl Database {
    fn new() -> Self {
        Self {
            schema: 1,
            host_id: uuid::Uuid::new_v4().urn().to_string(),
            accounts: Vec::new(),
            active: None,
        }
    }
    fn validate(&self) -> Result<()> {
        if self.schema != 1
            || uuid::Uuid::parse_str(&self.host_id).is_err()
            || self.accounts.len() > 64
        {
            return Err(AuthError::Storage);
        }
        let mut seen = std::collections::HashSet::new();
        for account in &self.accounts {
            if !oauth::valid_client_id(&account.client_id)
                || !seen.insert(&account.client_id)
                || account.subject.as_ref().is_some_and(|s| !plain(s, 256))
                || account.email.as_ref().is_some_and(|s| !plain(s, 320))
                || account
                    .selected_model
                    .as_ref()
                    .is_some_and(|s| !valid_slug(s))
            {
                return Err(AuthError::Storage);
            }
            if let Some(tokens) = &account.tokens {
                if account.subject.is_none()
                    || !oauth::secret_field(&tokens.access_token)
                    || !oauth::secret_field(&tokens.id_token)
                    || tokens
                        .refresh_token
                        .as_ref()
                        .is_some_and(|s| !oauth::secret_field(s))
                    || tokens.scopes.len() > 64
                    || tokens.scopes.iter().any(|s| !plain(s, 128))
                    || tokens.expires_at == 0
                {
                    return Err(AuthError::Storage);
                }
            }
        }
        if self.active.as_ref().is_some_and(|id| !seen.contains(id)) {
            return Err(AuthError::Storage);
        }
        Ok(())
    }
    fn account(&self, id: &str) -> Result<&Registration> {
        self.accounts
            .iter()
            .find(|a| a.client_id == id)
            .ok_or(AuthError::NotSignedIn)
    }
    fn account_mut(&mut self, id: &str) -> Result<&mut Registration> {
        self.accounts
            .iter_mut()
            .find(|a| a.client_id == id)
            .ok_or(AuthError::NotSignedIn)
    }
}
struct Runtime {
    db: Database,
    models: Vec<Model>,
    generation: u64,
    invalidation: watch::Sender<bool>,
    pending: Option<watch::Sender<bool>>,
    message: Option<String>,
}
impl Runtime {
    fn invalidate(&mut self) {
        self.invalidation.send_replace(true);
        self.invalidation = watch::channel(false).0;
        self.generation = self.generation.wrapping_add(1);
    }
    fn status(&self) -> AuthStatus {
        AuthStatus {
            accounts: self
                .db
                .accounts
                .iter()
                .map(|a| AccountStatus {
                    id: a.client_id.clone(),
                    label: a.label(),
                    signed_in: a.tokens.is_some() && !a.refresh_pending,
                    plan_enabled: a.plan_enabled(),
                })
                .collect(),
            active_account_id: self.db.active.clone(),
            models: self.models.clone(),
            selected_model: self
                .db
                .active
                .as_ref()
                .and_then(|id| self.db.account(id).ok())
                .and_then(|a| a.selected_model.clone()),
            sign_in_pending: self.pending.is_some(),
            generation: self.generation,
            message: self.message.clone(),
        }
    }
}
pub struct AuthService {
    store: storage::Store,
    state: Mutex<Runtime>,
    gate: tokio::sync::Mutex<()>,
    transport: Arc<dyn http::Transport>,
}
impl AuthService {
    /// Caller supplies a private native app-data directory outside all repositories.
    /// This only opens local storage; it never signs in, refreshes, or lists models.
    pub fn open(path: PathBuf) -> Result<Self> {
        Self::with_transport(path, Arc::new(http::Http::new()?))
    }
    fn with_transport(path: PathBuf, transport: Arc<dyn http::Transport>) -> Result<Self> {
        let store = storage::Store::open(path)?;
        let lock = store.lock()?;
        let db: Database = store.load()?.unwrap_or_else(Database::new);
        db.validate()?;
        drop(lock);
        Ok(Self {
            store,
            state: Mutex::new(Runtime {
                db,
                models: Vec::new(),
                generation: 1,
                invalidation: watch::channel(false).0,
                pending: None,
                message: None,
            }),
            gate: tokio::sync::Mutex::new(()),
            transport,
        })
    }
    fn runtime(&self) -> Result<std::sync::MutexGuard<'_, Runtime>> {
        self.state.lock().map_err(|_| AuthError::Storage)
    }
    fn load(&self) -> Result<Database> {
        let db: Database = self.store.load()?.ok_or(AuthError::NotSignedIn)?;
        db.validate()?;
        Ok(db)
    }
    pub fn status(&self) -> Result<AuthStatus> {
        Ok(self.runtime()?.status())
    }
    pub fn is_current(&self, generation: u64) -> bool {
        self.runtime()
            .is_ok_and(|r| r.generation == generation && r.pending.is_none())
    }
    pub fn cancel(&self) {
        if let Ok(mut r) = self.runtime() {
            if let Some(pending) = r.pending.take() {
                pending.send_replace(true);
            }
            r.invalidate();
        }
    }
    pub async fn connect<F>(&self, account_id: Option<&str>, open_browser: F) -> Result<AuthStatus>
    where
        F: FnOnce(&str) -> Result<()> + Send,
    {
        let _gate = self.gate.try_lock().map_err(|_| AuthError::Busy)?;
        let (pending, mut cancelled) = watch::channel(false);
        let generation = {
            let mut r = self.runtime()?;
            if r.pending.is_some() {
                return Err(AuthError::Busy);
            }
            r.invalidate();
            r.pending = Some(pending);
            r.message = None;
            r.generation
        };
        // Dropping this future (native teardown) also closes the listener and clears pending state.
        let cleanup = PendingCleanup {
            service: self,
            generation,
        };
        let result = tokio::select! {
            biased;
            _ = oauth::cancellation(&mut cancelled) => Err(AuthError::Cancelled),
            result = self.connect_inner(account_id, open_browser, generation) => result,
        };
        drop(cleanup);
        result?;
        self.status()
    }
    async fn connect_inner<F>(
        &self,
        account_id: Option<&str>,
        open_browser: F,
        generation: u64,
    ) -> Result<()>
    where
        F: FnOnce(&str) -> Result<()> + Send,
    {
        let (host, saved) = {
            let _lock = self.store.lock()?;
            let db: Database = self.store.load()?.unwrap_or(self.runtime()?.db.clone());
            db.validate()?;
            self.store.save(&db)?;
            let saved = account_id.map(|id| db.account(id).cloned()).transpose()?;
            (db.host_id, saved)
        };
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| AuthError::Callback)?;
        let attempt = oauth::Attempt::new(
            listener
                .local_addr()
                .map_err(|_| AuthError::Callback)?
                .port(),
            saved
                .as_ref()
                .map_or(DYNAMIC_CLIENT, |a| a.client_id.as_str())
                .to_string(),
        );
        let url = attempt.authorization_url(
            &host,
            saved
                .as_ref()
                .and_then(|a| a.tokens.as_ref())
                .map(|t| t.id_token.as_str()),
            saved.as_ref().and_then(|a| a.email.as_deref()),
            saved
                .as_ref()
                .is_some_and(|a| a.tokens.is_some() && !a.plan_enabled()),
        )?;
        self.check_generation(generation)?;
        open_browser(&url)?;
        let mut rx = self
            .runtime()?
            .pending
            .as_ref()
            .ok_or(AuthError::Cancelled)?
            .subscribe();
        let callback = oauth::listen(listener, &attempt, &mut rx).await?;
        self.check_generation(generation)?;
        let _lock = self.store.lock()?;
        let mut db = self.load()?;
        if saved.is_none() {
            if db
                .accounts
                .iter()
                .any(|a| a.client_id == callback.client_id)
                || db.accounts.len() >= 64
            {
                return Err(AuthError::Identity);
            }
            db.accounts.push(Registration {
                client_id: callback.client_id.clone(),
                subject: None,
                email: None,
                tokens: None,
                selected_model: None,
                refresh_pending: false,
            });
            // The issued registration survives invalid_grant, cancellation, crashes and sign-out.
            self.store.save(&db)?;
            self.runtime()?.db = db.clone();
        } else if db.account(&callback.client_id)?.subject
            != saved.as_ref().and_then(|a| a.subject.clone())
        {
            return Err(AuthError::Identity);
        }
        let reply = self
            .transport
            .execute(http::post(
                http::TOKEN,
                vec![
                    ("grant_type".into(), "authorization_code".into()),
                    ("client_id".into(), callback.client_id.clone()),
                    ("code".into(), callback.code),
                    ("code_verifier".into(), attempt.verifier),
                    ("redirect_uri".into(), attempt.redirect_uri),
                    ("resource".into(), http::RESOURCE.into()),
                ],
            ))
            .await?;
        let response = token_response(reply)?;
        let jwks = self.jwks().await?;
        let id_token = response.id_token.as_deref().ok_or(AuthError::Identity)?;
        let identity =
            oauth::validate_identity(id_token, &jwks, &callback.client_id, Some(&attempt.nonce))?;
        if saved
            .as_ref()
            .and_then(|a| a.subject.as_deref())
            .is_some_and(|s| s != identity.sub)
        {
            return Err(AuthError::Identity);
        }
        let tokens = response.into_tokens(None)?;
        {
            let mut runtime = self.runtime()?;
            if runtime.generation != generation {
                return Err(AuthError::Cancelled);
            }
            let account = db.account_mut(&callback.client_id)?;
            account.subject = Some(identity.sub);
            account.email = identity.email.filter(|s| plain(s, 320));
            account.tokens = Some(tokens);
            account.refresh_pending = false;
            account.selected_model = None;
            db.active = Some(callback.client_id.clone());
            self.store.save(&db)?;
            runtime.db = db.clone();
            runtime.models.clear();
        }
        if db.account(&callback.client_id)?.plan_enabled() {
            let token = &db
                .account(&callback.client_id)?
                .tokens
                .as_ref()
                .ok_or(AuthError::NotSignedIn)?
                .access_token;
            match self.models(token).await {
                Ok(models) => {
                    let mut r = self.runtime()?;
                    if r.generation != generation {
                        return Err(AuthError::Cancelled);
                    }
                    r.models = models;
                }
                Err(error) => {
                    let mut r = self.runtime()?;
                    if r.generation != generation {
                        return Err(AuthError::Cancelled);
                    }
                    r.message = Some(error.to_string());
                }
            }
        } else {
            self.runtime()?.message = Some(AuthError::Permission.to_string());
        }
        Ok(())
    }
    fn check_generation(&self, generation: u64) -> Result<()> {
        if self.runtime()?.generation != generation {
            Err(AuthError::Cancelled)
        } else {
            Ok(())
        }
    }
    pub async fn select_account(&self, account_id: &str) -> Result<AuthStatus> {
        let _gate = self.gate.try_lock().map_err(|_| AuthError::Busy)?;
        let generation = {
            let mut r = self.runtime()?;
            r.invalidate();
            r.models.clear();
            r.message = None;
            r.generation
        };
        let _lock = self.store.lock()?;
        let mut db = self.load()?;
        self.refresh(&mut db, account_id, generation).await?;
        {
            let mut r = self.runtime()?;
            if r.generation != generation {
                return Err(AuthError::Cancelled);
            }
            db.active = Some(account_id.to_string());
            self.store.save(&db)?;
            r.db = db.clone();
        }
        let account = db.account(account_id)?;
        if !account.plan_enabled() {
            self.runtime()?.message = Some(AuthError::Permission.to_string());
            return self.status();
        }
        match self
            .models(
                &account
                    .tokens
                    .as_ref()
                    .ok_or(AuthError::NotSignedIn)?
                    .access_token,
            )
            .await
        {
            Ok(models) => self.install_models(models, &mut db, generation)?,
            Err(error) => {
                let mut r = self.runtime()?;
                if r.generation != generation {
                    return Err(AuthError::Cancelled);
                }
                r.message = Some(error.to_string());
            }
        }
        self.status()
    }
    pub async fn refresh_models(&self) -> Result<AuthStatus> {
        let _gate = self.gate.try_lock().map_err(|_| AuthError::Busy)?;
        let generation = {
            let mut r = self.runtime()?;
            r.invalidate();
            r.models.clear();
            r.message = None;
            r.generation
        };
        let _lock = self.store.lock()?;
        let mut db = self.load()?;
        let id = db.active.clone().ok_or(AuthError::NotSignedIn)?;
        self.refresh(&mut db, &id, generation).await?;
        let account = db.account(&id)?;
        if !account.plan_enabled() {
            return Err(AuthError::Permission);
        }
        let models = self
            .models(
                &account
                    .tokens
                    .as_ref()
                    .ok_or(AuthError::NotSignedIn)?
                    .access_token,
            )
            .await?;
        self.install_models(models, &mut db, generation)?;
        self.status()
    }
    fn install_models(&self, models: Vec<Model>, db: &mut Database, generation: u64) -> Result<()> {
        let mut r = self.runtime()?;
        if r.generation != generation {
            return Err(AuthError::Cancelled);
        }
        let id = db.active.clone().ok_or(AuthError::NotSignedIn)?;
        let account = db.account_mut(&id)?;
        if account
            .selected_model
            .as_ref()
            .is_some_and(|s| !models.iter().any(|m| &m.slug == s))
        {
            account.selected_model = None;
        }
        self.store.save(db)?;
        r.db = db.clone();
        r.models = models;
        r.message = None;
        Ok(())
    }
    pub fn select_model(&self, slug: &str) -> Result<AuthStatus> {
        let _gate = self.gate.try_lock().map_err(|_| AuthError::Busy)?;
        let _lock = self.store.lock()?;
        let mut r = self.runtime()?;
        if !r.models.iter().any(|m| m.slug == slug) {
            return Err(AuthError::Model);
        }
        let mut db = self.load()?;
        if db.active != r.db.active {
            return Err(AuthError::Cancelled);
        }
        let id = db.active.clone().ok_or(AuthError::NotSignedIn)?;
        if !db.account(&id)?.plan_enabled() {
            return Err(AuthError::Permission);
        }
        db.account_mut(&id)?.selected_model = Some(slug.into());
        self.store.save(&db)?;
        r.invalidate();
        r.db = db;
        r.message = None;
        Ok(r.status())
    }
    pub async fn credentials(&self, expected_generation: u64) -> Result<Credentials> {
        let _gate = self.gate.try_lock().map_err(|_| AuthError::Busy)?;
        self.check_generation(expected_generation)?;
        let _lock = self.store.lock()?;
        let mut db = self.load()?;
        let id = db.active.clone().ok_or(AuthError::NotSignedIn)?;
        {
            let r = self.runtime()?;
            if r.pending.is_some() || r.db.active.as_deref() != Some(&id) {
                return Err(AuthError::Cancelled);
            }
            let model = db
                .account(&id)?
                .selected_model
                .as_deref()
                .ok_or(AuthError::Model)?;
            if r.db.account(&id)?.selected_model.as_deref() != Some(model)
                || !r.models.iter().any(|m| m.slug == model)
            {
                return Err(AuthError::Model);
            }
        }
        self.refresh(&mut db, &id, expected_generation).await?;
        self.check_generation(expected_generation)?;
        let account = db.account(&id)?;
        if !account.plan_enabled() {
            return Err(AuthError::Permission);
        }
        let mut r = self.runtime()?;
        if r.generation != expected_generation {
            return Err(AuthError::Cancelled);
        }
        r.db = db.clone();
        Ok(Credentials {
            access_token: account
                .tokens
                .as_ref()
                .ok_or(AuthError::NotSignedIn)?
                .access_token
                .clone(),
            model: account.selected_model.clone().ok_or(AuthError::Model)?,
            account_id: id,
            generation: expected_generation,
            cancelled: r.invalidation.subscribe(),
        })
    }
    async fn refresh(&self, db: &mut Database, id: &str, generation: u64) -> Result<()> {
        let account = db.account(id)?.clone();
        if account.refresh_pending {
            return Err(AuthError::SessionExpired);
        }
        let previous = account.tokens.as_ref().ok_or(AuthError::NotSignedIn)?;
        if previous.expires_at > now()?.saturating_add(60) {
            return Ok(());
        }
        let Some(refresh_token) = &previous.refresh_token else {
            return self.expire(db, id);
        };
        // Fetch signature-verification material before consuming a rotating token.
        // A discovery outage must never discard a newly issued replacement.
        let jwks = self.jwks().await?;
        self.check_generation(generation)?;
        db.account_mut(id)?.refresh_pending = true;
        if self.store.save(db).is_err() {
            self.block_uncertain_refresh(db)?;
            return Err(AuthError::Storage);
        }
        let reply = self
            .transport
            .execute(http::post(
                http::TOKEN,
                vec![
                    ("grant_type".into(), "refresh_token".into()),
                    ("client_id".into(), id.into()),
                    ("refresh_token".into(), refresh_token.clone()),
                    ("resource".into(), http::RESOURCE.into()),
                ],
            ))
            .await;
        let reply = match reply {
            Ok(reply) => reply,
            Err(_) => {
                // The server may have consumed the old refresh token. Keep the
                // durable marker and require a fresh authorization, never replay.
                self.block_uncertain_refresh(db)?;
                return Err(AuthError::SessionExpired);
            }
        };
        let rejection_status = reply.status;
        let successful_exchange = reply.status == 200;
        let response = match token_response(reply) {
            Err(AuthError::SessionExpired) => return self.expire(db, id),
            Err(_) if successful_exchange => return self.expire(db, id),
            Err(error @ AuthError::Client) if matches!(rejection_status, 400 | 401) => {
                db.account_mut(id)?.refresh_pending = false;
                if self.store.save(db).is_err() {
                    db.account_mut(id)?.refresh_pending = true;
                    self.block_uncertain_refresh(db)?;
                    return Err(AuthError::Storage);
                }
                return Err(error);
            }
            Err(_) => {
                // Even a 5xx response can follow a committed rotation. Retain
                // credentials and the write-ahead guard, but never replay them.
                self.block_uncertain_refresh(db)?;
                return Err(AuthError::SessionExpired);
            }
            Ok(response) => response,
        };
        if let Some(id_token) = &response.id_token {
            let identity = match oauth::validate_identity(id_token, &jwks, id, None) {
                Ok(identity) => identity,
                Err(_) => return self.expire(db, id),
            };
            if account.subject.as_deref() != Some(&identity.sub) {
                return self.expire(db, id);
            }
        }
        let tokens = match response.into_tokens(Some(previous)) {
            Ok(tokens) => tokens,
            Err(_) => return self.expire(db, id),
        };
        // Rotation is persisted even when the caller was cancelled while the response
        // arrived: dropping the replacement could permanently break this saved session.
        db.account_mut(id)?.tokens = Some(tokens);
        db.account_mut(id)?.refresh_pending = false;
        if self.store.save(db).is_err() {
            db.account_mut(id)?.refresh_pending = true;
            self.block_uncertain_refresh(db)?;
            return Err(AuthError::Storage);
        }
        let mut r = self.runtime()?;
        if r.generation != generation {
            return Err(AuthError::Cancelled);
        }
        r.db = db.clone();
        if !db.account(id)?.plan_enabled() {
            r.invalidate();
            return Err(AuthError::Permission);
        }
        Ok(())
    }
    fn expire(&self, db: &mut Database, id: &str) -> Result<()> {
        let account = db.account_mut(id)?;
        account.tokens = None;
        account.selected_model = None;
        account.refresh_pending = false;
        let saved = self.store.save(db);
        let mut r = self.runtime()?;
        r.db = db.clone();
        r.models.clear();
        r.invalidate();
        saved?;
        Err(AuthError::SessionExpired)
    }
    fn block_uncertain_refresh(&self, db: &Database) -> Result<()> {
        let mut r = self.runtime()?;
        r.db = db.clone();
        r.models.clear();
        r.invalidate();
        r.message = Some("This ChatGPT session could not be safely renewed. Sign in again using the saved account.".into());
        Ok(())
    }
    /// Local sign-out always clears all three tokens. A remote revocation failure
    /// is surfaced in status; the registered client and host identity are retained.
    pub async fn sign_out(&self, account_id: Option<&str>) -> Result<AuthStatus> {
        self.cancel();
        let _gate = self.gate.lock().await;
        let _lock = self.store.lock()?;
        let mut db = self.load()?;
        let id = account_id
            .map(str::to_string)
            .or_else(|| db.active.clone())
            .ok_or(AuthError::NotSignedIn)?;
        let account = db.account(&id)?.clone();
        // Clear durable local authority before awaiting a possibly failing revocation.
        let entry = db.account_mut(&id)?;
        entry.tokens = None;
        entry.selected_model = None;
        entry.refresh_pending = false;
        if db.active.as_deref() == Some(&id) {
            db.active = None;
        }
        self.store.save(&db)?;
        {
            let mut r = self.runtime()?;
            r.db = db;
            r.models.clear();
            r.message = None;
        }
        let confirmed = match account.tokens.and_then(|t| t.refresh_token) {
            Some(token) => self.revoke(&id, token).await.unwrap_or(false),
            None => true,
        };
        if !confirmed {
            self.runtime()?.message = Some("Signed out locally. Remote session revocation was not confirmed; disconnect Heinlein in ChatGPT Settings to end its access.".into());
        }
        self.status()
    }
    async fn revoke(&self, client_id: &str, refresh_token: String) -> Result<bool> {
        let response = self
            .transport
            .execute(http::get(http::DISCOVERY, None))
            .await?;
        if response.status != 200 {
            return Ok(false);
        }
        #[derive(Deserialize)]
        struct Discovery {
            issuer: String,
            revocation_endpoint: String,
        }
        let discovery: Discovery =
            serde_json::from_slice(&response.body).map_err(|_| AuthError::Response)?;
        if discovery.issuer != http::ISSUER
            || !http::valid_revocation_url(&discovery.revocation_endpoint)
        {
            return Ok(false);
        }
        for attempt in 0..3 {
            let response = self
                .transport
                .execute(http::post(
                    &discovery.revocation_endpoint,
                    vec![
                        ("client_id".into(), client_id.into()),
                        ("token".into(), refresh_token.clone()),
                        ("token_type_hint".into(), "refresh_token".into()),
                    ],
                ))
                .await;
            match response {
                Ok(reply) if reply.status == 200 => return Ok(true),
                Ok(reply) if reply.status < 500 => return Ok(false),
                _ => {}
            }
            if attempt < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(250 << attempt)).await;
            }
        }
        Ok(false)
    }
    async fn jwks(&self) -> Result<Vec<u8>> {
        let reply = self.transport.execute(http::get(http::JWKS, None)).await?;
        if reply.status != 200 {
            return Err(AuthError::Identity);
        }
        Ok(reply.body)
    }
    async fn models(&self, token: &str) -> Result<Vec<Model>> {
        let reply = self
            .transport
            .execute(http::get(http::MODELS, Some(token.into())))
            .await?;
        if reply.status != 200 {
            return Err(match reply.status {
                401 => AuthError::Identity,
                403 => AuthError::Permission,
                _ => AuthError::Network,
            });
        }
        #[derive(Deserialize)]
        struct Catalog {
            models: Vec<CatalogModel>,
        }
        #[derive(Deserialize)]
        struct CatalogModel {
            visibility: Option<String>,
            slug: Option<String>,
            display_name: Option<String>,
        }
        let catalog: Catalog =
            serde_json::from_slice(&reply.body).map_err(|_| AuthError::Response)?;
        if catalog.models.len() > 512 {
            return Err(AuthError::Response);
        }
        let mut seen = std::collections::HashSet::new();
        let mut result = Vec::new();
        for item in catalog
            .models
            .into_iter()
            .filter(|m| m.visibility.as_deref() == Some("list"))
        {
            let slug = item.slug.ok_or(AuthError::Response)?;
            let display_name = item.display_name.ok_or(AuthError::Response)?;
            if !valid_slug(&slug) || !plain(&display_name, 160) || !seen.insert(slug.clone()) {
                return Err(AuthError::Response);
            }
            result.push(Model { slug, display_name });
        }
        Ok(result)
    }
}
struct PendingCleanup<'a> {
    service: &'a AuthService,
    generation: u64,
}
impl Drop for PendingCleanup<'_> {
    fn drop(&mut self) {
        if let Ok(mut r) = self.service.runtime() {
            if r.generation == self.generation {
                r.pending = None;
            }
        }
    }
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    refresh_token: Option<String>,
    id_token: Option<String>,
    scope: Option<String>,
}
impl TokenResponse {
    fn into_tokens(self, old: Option<&Tokens>) -> Result<Tokens> {
        if !self.token_type.eq_ignore_ascii_case("Bearer")
            || !oauth::secret_field(&self.access_token)
            || self.expires_in == 0
            || self.expires_in > 604800
            || self
                .refresh_token
                .as_ref()
                .is_some_and(|s| !oauth::secret_field(s))
        {
            return Err(AuthError::Response);
        }
        let scopes = if let Some(scope) = self.scope {
            if scope.len() > 8192 || scope.chars().any(|c| c.is_control()) {
                return Err(AuthError::Response);
            }
            let scopes: Vec<String> = scope.split_ascii_whitespace().map(str::to_string).collect();
            if scopes.len() > 64 || scopes.iter().any(|s| !plain(s, 128)) {
                return Err(AuthError::Response);
            }
            scopes
        } else {
            old.map(|t| t.scopes.clone()).unwrap_or_default()
        };
        let id_token = self
            .id_token
            .or_else(|| old.map(|t| t.id_token.clone()))
            .ok_or(AuthError::Identity)?;
        if !oauth::secret_field(&id_token) {
            return Err(AuthError::Identity);
        }
        Ok(Tokens {
            access_token: self.access_token,
            refresh_token: self
                .refresh_token
                .or_else(|| old.and_then(|t| t.refresh_token.clone())),
            id_token,
            scopes,
            expires_at: now()?
                .checked_add(self.expires_in)
                .ok_or(AuthError::Response)?,
        })
    }
}
fn token_response(reply: http::Reply) -> Result<TokenResponse> {
    if reply.status != 200 {
        #[derive(Deserialize)]
        struct Failure {
            error: Option<String>,
        }
        let error = serde_json::from_slice::<Failure>(&reply.body)
            .ok()
            .and_then(|e| e.error);
        return Err(match error.as_deref() {
            Some(
                "invalid_grant"
                | "invalid_refresh_token"
                | "token_expired"
                | "refresh_token_expired"
                | "refresh_token_invalidated"
                | "refresh_token_reused",
            ) => AuthError::SessionExpired,
            Some("invalid_client") => AuthError::Client,
            _ if reply.status >= 500 => AuthError::Network,
            _ => AuthError::Response,
        });
    }
    serde_json::from_slice(&reply.body).map_err(|_| AuthError::Response)
}
fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| AuthError::Configuration)
}
fn plain(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':' | b'/'))
}

#[cfg(test)]
mod tests;
