//! Credential bytes live only in the OS vault. The existing private lock spans
//! migration and token rotation; the JSON file retains non-secret preferences.
use crate::{storage, AuthError, Database, Result, Tokens};
use serde::{Deserialize, Serialize};
#[cfg(not(test))]
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};

const MAX_SECRET_BYTES: usize = 2 * 1024 * 1024;
pub(crate) trait Vault: Send + Sync {
    fn load(&self) -> Result<Option<Vec<u8>>>;
    fn save(&self, bytes: &[u8]) -> Result<()>;
}
#[cfg(not(test))]
struct OsVault {
    account: String,
}
#[cfg(not(test))]
impl OsVault {
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new("me.thearcades.heinlein.studio.chatgpt", &self.account)
            .map_err(|_| AuthError::Storage)
    }
}
#[cfg(not(test))]
impl Vault for OsVault {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        match self.entry()?.get_secret() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AuthError::Storage),
        }
    }
    fn save(&self, bytes: &[u8]) -> Result<()> {
        self.entry()?
            .set_secret(bytes)
            .map_err(|_| AuthError::Storage)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Secrets {
    version: u32,
    host_id: String,
    accounts: Vec<AccountSecrets>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountSecrets {
    client_id: String,
    subject: Option<String>,
    tokens: Option<Tokens>,
    refresh_pending: bool,
}
impl Secrets {
    fn capture(db: &Database) -> Self {
        Self {
            version: 1,
            host_id: db.host_id.clone(),
            accounts: db
                .accounts
                .iter()
                .map(|a| AccountSecrets {
                    client_id: a.client_id.clone(),
                    subject: a.subject.clone(),
                    tokens: a.tokens.clone(),
                    refresh_pending: a.refresh_pending,
                })
                .collect(),
        }
    }
    fn merge(self, db: &mut Database) -> Result<()> {
        if self.version != 1 || self.host_id != db.host_id || self.accounts.len() > 64 {
            return Err(AuthError::Storage);
        }
        let mut ids = std::collections::HashSet::new();
        for a in &mut db.accounts {
            a.tokens = None;
            a.refresh_pending = false;
        }
        for secret in self.accounts {
            if !ids.insert(secret.client_id.clone()) {
                return Err(AuthError::Storage);
            }
            let Some(account) = db
                .accounts
                .iter_mut()
                .find(|a| a.client_id == secret.client_id)
            else {
                if secret.tokens.is_some() || secret.refresh_pending {
                    return Err(AuthError::Storage);
                }
                continue;
            };
            if account.subject.is_some()
                && secret.subject.is_some()
                && account.subject != secret.subject
            {
                return Err(AuthError::Storage);
            }
            if account.subject.is_none() {
                account.subject = secret.subject;
            }
            account.tokens = secret.tokens;
            account.refresh_pending = secret.refresh_pending;
        }
        db.validate()
    }
}

pub(crate) struct Store {
    file: storage::Store,
    vault: Arc<dyn Vault>,
}
impl Store {
    pub(crate) fn open(path: PathBuf) -> Result<Self> {
        let file = storage::Store::open(path.clone())?;
        #[cfg(test)]
        let vault: Arc<dyn Vault> = test_vault(&path);
        #[cfg(not(test))]
        let vault: Arc<dyn Vault> = Arc::new(OsVault {
            account: format!(
                "profile-{:x}",
                Sha256::digest(
                    path.canonicalize()
                        .map_err(|_| AuthError::Storage)?
                        .as_os_str()
                        .as_encoded_bytes()
                )
            ),
        });
        Ok(Self { file, vault })
    }
    #[cfg(test)]
    fn with_vault(path: PathBuf, vault: Arc<dyn Vault>) -> Result<Self> {
        Ok(Self {
            file: storage::Store::open(path)?,
            vault,
        })
    }
    pub(crate) fn lock(&self) -> Result<storage::StoreGuard> {
        self.file.lock()
    }
    fn secrets(&self) -> Result<Option<Secrets>> {
        self.vault
            .load()?
            .map(|bytes| {
                if bytes.len() > MAX_SECRET_BYTES {
                    return Err(AuthError::Storage);
                }
                serde_json::from_slice(&bytes).map_err(|_| AuthError::Storage)
            })
            .transpose()
    }
    pub(crate) fn load(&self) -> Result<Option<Database>> {
        let Some(mut db) = self.file.load::<Database>()? else {
            return Ok(None);
        };
        db.validate()?;
        let legacy = db
            .accounts
            .iter()
            .any(|a| a.tokens.is_some() || a.refresh_pending);
        match self.secrets()? {
            Some(secrets) => secrets.merge(&mut db)?,
            None if db.secrets_in_vault => return Err(AuthError::Storage),
            None if !legacy => return Ok(Some(db)),
            None => {}
        }
        // Vault state wins after an interrupted cleanup, especially after a
        // rotating refresh token was replaced. Never replay the old JSON token.
        if legacy || !db.secrets_in_vault {
            self.save(&db)?;
            db.secrets_in_vault = true;
        }
        Ok(Some(db))
    }
    pub(crate) fn save(&self, db: &Database) -> Result<()> {
        db.validate()?;
        let bytes = serde_json::to_vec(&Secrets::capture(db)).map_err(|_| AuthError::Storage)?;
        if bytes.len() > MAX_SECRET_BYTES {
            return Err(AuthError::Storage);
        }
        let previous = self.vault.load()?;
        if let Some(bytes) = &previous {
            if bytes.len() > MAX_SECRET_BYTES {
                return Err(AuthError::Storage);
            }
            let saved: Secrets = serde_json::from_slice(bytes).map_err(|_| AuthError::Storage)?;
            if saved.version != 1 || saved.host_id != db.host_id {
                return Err(AuthError::Storage);
            }
        }
        let secured = db.secrets_in_vault
            || previous.is_some()
            || db
                .accounts
                .iter()
                .any(|a| a.tokens.is_some() || a.refresh_pending);
        if secured && previous.as_deref() != Some(bytes.as_slice()) {
            self.vault.save(&bytes)?;
            if self.vault.load()?.as_deref() != Some(bytes.as_slice()) {
                return Err(AuthError::Storage);
            }
        }
        let mut public = db.clone();
        public.secrets_in_vault = secured;
        for account in &mut public.accounts {
            account.tokens = None;
            account.refresh_pending = false;
        }
        // Commit the sanitized file only after the secure record is verified.
        // A failure leaves the old file intact and the vault authoritative.
        self.file.save(&public)
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryVault {
    pub(crate) bytes: std::sync::Mutex<Option<Vec<u8>>>,
    pub(crate) fail_read: std::sync::atomic::AtomicBool,
    pub(crate) fail_write: std::sync::atomic::AtomicBool,
}
#[cfg(test)]
impl Vault for MemoryVault {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        if self.fail_read.load(std::sync::atomic::Ordering::SeqCst) {
            Err(AuthError::Storage)
        } else {
            Ok(self.bytes.lock().unwrap().clone())
        }
    }
    fn save(&self, bytes: &[u8]) -> Result<()> {
        if self.fail_write.load(std::sync::atomic::Ordering::SeqCst) {
            Err(AuthError::Storage)
        } else {
            *self.bytes.lock().unwrap() = Some(bytes.to_vec());
            Ok(())
        }
    }
}
#[cfg(test)]
pub(crate) fn test_vault(path: &std::path::Path) -> Arc<MemoryVault> {
    static VAULTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, Arc<MemoryVault>>>,
    > = std::sync::OnceLock::new();
    VAULTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(path.to_path_buf())
        .or_default()
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Registration;
    use std::sync::atomic::Ordering::SeqCst;
    fn legacy() -> Database {
        let mut db = Database::new();
        db.active = Some("oaiapp_synthetic_registration".into());
        db.accounts.push(Registration {
            client_id: db.active.clone().unwrap(),
            subject: Some("synthetic-subject".into()),
            email: Some("synthetic@example.invalid".into()),
            selected_model: Some("synthetic-model".into()),
            refresh_pending: false,
            tokens: Some(Tokens {
                access_token: "synthetic-access".into(),
                refresh_token: Some("synthetic-refresh".into()),
                id_token: "synthetic-id".into(),
                scopes: vec![crate::oauth::DIRECT_SCOPE.into()],
                expires_at: 4000000000,
            }),
        });
        db
    }
    #[test]
    fn migration_and_restart_keep_preferences_and_only_vault_has_secrets() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = temp.path().join("auth");
        let file = storage::Store::open(path.clone()).unwrap();
        let db = legacy();
        file.save(&db).unwrap();
        let vault = Arc::new(MemoryVault::default());
        let store = Store::with_vault(path.clone(), vault.clone()).unwrap();
        let _lock = store.lock().unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert!(loaded.secrets_in_vault);
        let bytes = std::fs::read(path.join("auth.json")).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        for secret in ["synthetic-access", "synthetic-refresh", "synthetic-id"] {
            assert!(!text.contains(secret));
        }
        assert!(text.contains("synthetic-model"));
        drop(_lock);
        drop(store);
        let reopened = Store::with_vault(path, vault).unwrap();
        let _lock = reopened.lock().unwrap();
        let loaded = reopened.load().unwrap().unwrap();
        assert_eq!(
            loaded.accounts[0].tokens.as_ref().unwrap().access_token,
            "synthetic-access"
        );
        assert_eq!(loaded.active, db.active);
        assert_eq!(
            loaded.accounts[0].selected_model,
            db.accounts[0].selected_model
        );
    }
    #[test]
    fn denied_vault_read_or_write_preserves_legacy_bytes_and_can_retry() {
        for read in [false, true] {
            let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
            let path = temp.path().join("auth");
            let file = storage::Store::open(path.clone()).unwrap();
            file.save(&legacy()).unwrap();
            let before = std::fs::read(path.join("auth.json")).unwrap();
            let vault = Arc::new(MemoryVault::default());
            if read {
                vault.fail_read.store(true, SeqCst);
            } else {
                vault.fail_write.store(true, SeqCst);
            }
            let store = Store::with_vault(path.clone(), vault.clone()).unwrap();
            let _lock = store.lock().unwrap();
            assert!(matches!(store.load(), Err(AuthError::Storage)));
            assert_eq!(std::fs::read(path.join("auth.json")).unwrap(), before);
            vault.fail_read.store(false, SeqCst);
            vault.fail_write.store(false, SeqCst);
            assert!(store.load().unwrap().unwrap().secrets_in_vault);
        }
    }
    #[test]
    fn interrupted_cleanup_uses_rotated_vault_never_old_file_token() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = temp.path().join("auth");
        let file = storage::Store::open(path.clone()).unwrap();
        let old = legacy();
        file.save(&old).unwrap();
        let mut rotated = old.clone();
        rotated.accounts[0].tokens.as_mut().unwrap().refresh_token =
            Some("synthetic-rotated".into());
        let vault = Arc::new(MemoryVault::default());
        vault
            .save(&serde_json::to_vec(&Secrets::capture(&rotated)).unwrap())
            .unwrap();
        let store = Store::with_vault(path.clone(), vault).unwrap();
        let _lock = store.lock().unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(
            loaded.accounts[0]
                .tokens
                .as_ref()
                .unwrap()
                .refresh_token
                .as_deref(),
            Some("synthetic-rotated")
        );
        assert!(
            !String::from_utf8(std::fs::read(path.join("auth.json")).unwrap())
                .unwrap()
                .contains("synthetic-refresh")
        );
    }
    #[test]
    fn missing_or_corrupt_vault_never_falls_back_to_legacy_or_overwrites_it() {
        for variant in 0..4 {
            let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
            let path = temp.path().join("auth");
            let file = storage::Store::open(path.clone()).unwrap();
            let mut db = legacy();
            db.secrets_in_vault = true;
            file.save(&db).unwrap();
            let before = std::fs::read(path.join("auth.json")).unwrap();
            let vault = Arc::new(MemoryVault::default());
            if variant > 0 {
                let mut secrets = Secrets::capture(&db);
                if variant == 2 {
                    secrets.host_id = uuid::Uuid::new_v4().urn().to_string();
                }
                if variant == 3 {
                    secrets.accounts[0].subject = Some("wrong-subject".into());
                }
                vault
                    .save(&if variant == 1 {
                        b"invalid".to_vec()
                    } else {
                        serde_json::to_vec(&secrets).unwrap()
                    })
                    .unwrap();
            }
            let saved = vault.load().unwrap();
            let store = Store::with_vault(path.clone(), vault.clone()).unwrap();
            let _lock = store.lock().unwrap();
            assert!(matches!(store.load(), Err(AuthError::Storage)));
            assert_eq!(before, std::fs::read(path.join("auth.json")).unwrap());
            assert_eq!(saved, vault.load().unwrap());
        }
    }
}
