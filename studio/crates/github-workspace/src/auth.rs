//! Separate GitHub device credentials in the OS store only. No Debug/Serialize lease.
use crate::{registry::StateDir, Error, Result};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthView {
    pub configured: bool,
    pub account: Option<User>,
    pub confirmed: bool,
    pub pending: Option<DeviceView>,
    pub message: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct User {
    pub id: u64,
    pub login: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at: u64,
    pub next_poll_at: u64,
}
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub refresh_expires_in: u64,
}
pub enum Poll {
    Pending,
    SlowDown,
    Authorized(TokenSet),
    Denied,
    Expired,
}
pub trait SecretStore: Send + Sync {
    fn load(&self) -> Result<Option<Vec<u8>>>;
    fn save(&self, bytes: &[u8]) -> Result<()>;
    fn clear(&self) -> Result<()>;
}
pub struct OsStore {
    service: String,
}
impl OsStore {
    pub fn new(service: &str) -> Result<Self> {
        Ok(Self {
            service: service.to_owned(),
        })
    }
}
impl OsStore {
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, "github-device-user").map_err(store_error)
    }
}
impl SecretStore for OsStore {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        match self.entry()?.get_secret() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(store_error(error)),
        }
    }
    fn save(&self, bytes: &[u8]) -> Result<()> {
        self.entry()?.set_secret(bytes).map_err(store_error)
    }
    fn clear(&self) -> Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(store_error(error)),
        }
    }
}
fn store_error(error: keyring::Error) -> Error {
    #[cfg(target_os = "macos")]
    if let keyring::Error::PlatformFailure(ref inner) | keyring::Error::NoStorageAccess(ref inner) =
        error
    {
        if let Some(error) = inner.downcast_ref::<security_framework::base::Error>() {
            return match error.code() {
                -25308 => Error::StoreLocked,
                -25293 => Error::StoreDenied,
                -128 => Error::StoreCancelled,
                _ => Error::StoreUnavailable,
            };
        }
    }
    match error {
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            Error::StoreUnavailable
        }
        _ => Error::StoreInvalid,
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    client_id: String,
    user: User,
    binding: String,
    confirmed: bool,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
    refresh_expires_at: u64,
}
struct Pending {
    code: String,
    view: DeviceView,
    interval: u64,
}
pub struct Credential {
    token: String,
    epoch: Arc<AtomicU64>,
    generation: u64,
    pub account: User,
    pub binding: String,
}
impl Credential {
    pub(crate) fn value(&self) -> Result<&str> {
        if self.valid() {
            Ok(&self.token)
        } else {
            Err(Error::Auth)
        }
    }
    pub fn valid(&self) -> bool {
        self.epoch.load(Ordering::SeqCst) == self.generation
    }
}
pub struct Auth {
    client_id: String,
    store: Arc<dyn SecretStore>,
    private: StateDir,
    pending: Mutex<Option<Pending>>,
    pending_rotation: Mutex<Option<Record>>,
    epoch: Arc<AtomicU64>,
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
impl Auth {
    pub fn new(client_id: String, store: Arc<dyn SecretStore>, private: StateDir) -> Result<Self> {
        if !client_id.is_empty()
            && (client_id.len() > 128
                || !client_id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)))
        {
            return Err(Error::Unavailable);
        }
        Ok(Self {
            client_id,
            store,
            private,
            pending: Mutex::new(None),
            pending_rotation: Mutex::new(None),
            epoch: Arc::new(AtomicU64::new(0)),
        })
    }
    fn load(&self) -> Result<Option<Record>> {
        let Some(bytes) = self.store.load()? else {
            return Ok(None);
        };
        if bytes.len() > 65536 {
            return Err(Error::StoreInvalid);
        }
        let r: Record = serde_json::from_slice(&bytes).map_err(|_| Error::StoreInvalid)?;
        if r.version != 1
            || r.client_id != self.client_id
            || r.user.id == 0
            || r.access_token.is_empty()
            || uuid::Uuid::parse_str(&r.binding).is_err()
        {
            return Err(Error::StoreInvalid);
        }
        Ok(Some(r))
    }
    fn write(&self, record: &Record) -> Result<()> {
        self.store
            .save(&serde_json::to_vec(record).map_err(|_| Error::Auth)?)
    }
    fn lease(&self, r: &Record) -> Credential {
        Credential {
            token: r.access_token.clone(),
            account: r.user.clone(),
            binding: r.binding.clone(),
            generation: self.epoch.load(Ordering::SeqCst),
            epoch: Arc::clone(&self.epoch),
        }
    }
    /// Memory-only exit barrier: never query or modify the OS store on quit.
    pub fn ready_to_quit(&self) -> Result<()> {
        if self
            .pending_rotation
            .lock()
            .map_err(|_| Error::StoreUnavailable)?
            .is_some()
        {
            return Err(Error::RotationNotSaved);
        }
        Ok(())
    }
    pub fn retry_saved(&self) -> Result<AuthView> {
        {
            let _lock = self.private.lock("auth.lock")?;
            let old = self.load()?;
            let mut pending = self
                .pending_rotation
                .lock()
                .map_err(|_| Error::StoreUnavailable)?;
            if let Some(record) = pending.as_ref() {
                if !old
                    .as_ref()
                    .is_some_and(|r| r.binding == record.binding && r.user.id == record.user.id)
                {
                    return Err(Error::Account);
                }
                self.write(record).map_err(|_| Error::RotationNotSaved)?;
                *pending = None;
            }
        }
        self.view()
    }
    pub fn view(&self) -> Result<AuthView> {
        if self.client_id.is_empty() {
            return Ok(AuthView {
                configured: false,
                account: None,
                confirmed: false,
                pending: None,
                message: Error::Unavailable.to_string(),
            });
        }
        let _lock = self.private.lock("auth.lock")?;
        let r = self.load()?;
        if self
            .pending_rotation
            .lock()
            .map_err(|_| Error::StoreUnavailable)?
            .is_some()
        {
            return Err(Error::RotationNotSaved);
        }
        let pending = self
            .pending
            .lock()
            .map_err(|_| Error::Auth)?
            .as_ref()
            .map(|p| p.view.clone());
        Ok(AuthView {
            configured: true,
            account: r.as_ref().map(|r| r.user.clone()),
            confirmed: r.as_ref().is_some_and(|r| r.confirmed),
            pending,
            message: if r.as_ref().is_some_and(|r| r.confirmed) {
                "GitHub account saved on this computer. Remote access is checked only when you request a GitHub action. Local saves stay here until you choose Send."
            } else {
                "Connect GitHub, then confirm the account before choosing a project."
            }
            .into(),
        })
    }
    pub fn begin(&self, api: &dyn crate::api::Provider, time: u64) -> Result<AuthView> {
        if self.client_id.is_empty() {
            return Err(Error::Unavailable);
        }
        {
            let _lock = self.private.lock("auth.lock")?;
            self.load()?;
            if self
                .pending_rotation
                .lock()
                .map_err(|_| Error::StoreUnavailable)?
                .is_some()
            {
                return Err(Error::RotationNotSaved);
            }
            // Never start OAuth to work around an unreadable store.
            let code = api.device_start(&self.client_id)?;
            if code.verification_uri != "https://github.com/login/device"
                || code.user_code.len() > 40
                || code.device_code.is_empty()
                || code.expires_in > 3600
            {
                return Err(Error::Auth);
            }
            let interval = code.interval.clamp(5, 60);
            *self.pending.lock().map_err(|_| Error::Auth)? = Some(Pending {
                code: code.device_code,
                view: DeviceView {
                    user_code: code.user_code,
                    verification_uri: code.verification_uri,
                    expires_at: time + code.expires_in,
                    next_poll_at: time + interval,
                },
                interval,
            });
        }
        self.view()
    }
    pub fn poll(&self, api: &dyn crate::api::Provider, time: u64) -> Result<AuthView> {
        {
            let _lock = self.private.lock("auth.lock")?;
            self.load()?;
            let mut pending = self.pending.lock().map_err(|_| Error::Auth)?;
            let p = pending.as_mut().ok_or(Error::Auth)?;
            if time >= p.view.expires_at {
                *pending = None;
                return Err(Error::Auth);
            }
            if time < p.view.next_poll_at {
                return Err(Error::RateLimit);
            }
            p.view.next_poll_at = time + p.interval;
            match api.device_poll(&self.client_id, &p.code)? {
                Poll::Pending => {}
                Poll::SlowDown => {
                    p.interval += 5;
                    p.view.next_poll_at = time + p.interval
                }
                Poll::Denied | Poll::Expired => {
                    *pending = None;
                    return Err(Error::Auth);
                }
                Poll::Authorized(tokens) => {
                    let record = Record {
                        version: 1,
                        client_id: self.client_id.clone(),
                        user: User {
                            id: 0,
                            login: String::new(),
                        },
                        binding: uuid::Uuid::new_v4().to_string(),
                        confirmed: false,
                        access_token: tokens.access_token,
                        refresh_token: tokens.refresh_token,
                        expires_at: time.saturating_add(tokens.expires_in),
                        refresh_expires_at: time.saturating_add(tokens.refresh_expires_in),
                    };
                    let user = api.user(&self.lease(&record))?;
                    if user.id == 0 || user.login.is_empty() {
                        return Err(Error::Auth);
                    }
                    self.epoch.fetch_add(1, Ordering::SeqCst);
                    let record = Record { user, ..record };
                    self.write(&record)?;
                    *pending = None;
                }
            }
        }
        self.view()
    }
    pub fn confirm(&self, user_id: u64) -> Result<AuthView> {
        {
            let _lock = self.private.lock("auth.lock")?;
            let mut r = self.load()?.ok_or(Error::Reconnect)?;
            if r.user.id != user_id {
                return Err(Error::Account);
            }
            r.confirmed = true;
            self.write(&r)?;
        }
        self.view()
    }
    pub fn credential(&self, api: &dyn crate::api::Provider, time: u64) -> Result<Credential> {
        if self.client_id.is_empty() {
            return Err(Error::Unavailable);
        }
        let _lock = self.private.lock("auth.lock")?;
        let mut r = self.load()?.ok_or(Error::Reconnect)?;
        if !r.confirmed {
            return Err(Error::Account);
        }
        if self
            .pending_rotation
            .lock()
            .map_err(|_| Error::StoreUnavailable)?
            .is_some()
        {
            return Err(Error::RotationNotSaved);
        }
        if r.expires_at <= time + 60 {
            let refresh = r
                .refresh_token
                .as_deref()
                .filter(|_| r.refresh_expires_at > time)
                .ok_or(Error::Reconnect)?;
            let t = api.refresh(&self.client_id, refresh)?;
            r.access_token = t.access_token;
            r.refresh_token = t.refresh_token;
            r.expires_at = time.saturating_add(t.expires_in);
            r.refresh_expires_at = time.saturating_add(t.refresh_expires_in);
            let user = api.user(&self.lease(&r))?;
            if user.id != r.user.id {
                return Err(Error::Account);
            }
            r.user = user;
            if self.write(&r).is_err() {
                *self
                    .pending_rotation
                    .lock()
                    .map_err(|_| Error::StoreUnavailable)? = Some(r);
                return Err(Error::RotationNotSaved);
            }
        }
        Ok(self.lease(&r))
    }
    pub fn sign_out(&self) -> Result<AuthView> {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        {
            let _lock = self.private.lock("auth.lock")?;
            self.store.clear()?;
            *self
                .pending_rotation
                .lock()
                .map_err(|_| Error::StoreUnavailable)? = None;
            *self.pending.lock().map_err(|_| Error::Auth)? = None;
        }
        self.view()
    }
}
#[cfg(all(test, target_os = "macos"))]
mod storage_classification_tests {
    use super::*;
    #[test]
    fn native_statuses_are_distinct_without_reading_a_keychain() {
        for (code, expected) in [
            (-25308, Error::StoreLocked),
            (-25293, Error::StoreDenied),
            (-128, Error::StoreCancelled),
            (-25291, Error::StoreUnavailable),
        ] {
            assert_eq!(
                store_error(keyring::macos::decode_error(
                    security_framework::base::Error::from_code(code)
                )),
                expected
            );
        }
    }
}
