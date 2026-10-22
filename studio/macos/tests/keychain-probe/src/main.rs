//! NEVER run against a real service. The caller owns an anonymous seed pipe.
//! A/B builds have distinct native code bytes but the same explicit signer IDs.
use github_workspace::{
    api::Provider,
    auth::{Auth, Credential, DeviceCode, OsStore, Poll, SecretStore, TokenSet, User},
    registry::{PullRequest, StateDir},
    Error, RepoInfo, Result,
};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::Arc,
};
struct SyntheticApi {
    seed: String,
}
impl Provider for SyntheticApi {
    fn device_start(&self, _: &str) -> Result<DeviceCode> {
        Ok(DeviceCode {
            device_code: "synthetic-only".into(),
            user_code: "SYNTHETIC".into(),
            verification_uri: "https://github.com/login/device".into(),
            expires_in: 900,
            interval: 5,
        })
    }
    fn device_poll(&self, _: &str, _: &str) -> Result<Poll> {
        Ok(Poll::Authorized(TokenSet {
            access_token: self.seed.clone(),
            refresh_token: None,
            expires_in: 3600,
            refresh_expires_in: 0,
        }))
    }
    fn user(&self, _: &Credential) -> Result<User> {
        Ok(User {
            id: 9,
            login: "synthetic-author".into(),
        })
    }
    fn refresh(&self, _: &str, _: &str) -> Result<TokenSet> {
        Err(Error::Network)
    }
    fn repository(&self, _: &Credential, _: &str, _: &str) -> Result<RepoInfo> {
        Err(Error::Network)
    }
    fn repository_by_id(&self, _: &Credential, _: u64) -> Result<RepoInfo> {
        Err(Error::Network)
    }
    fn head(&self, _: &Credential, _: &RepoInfo, _: &str) -> Result<Option<String>> {
        Err(Error::Network)
    }
    fn pulls(
        &self,
        _: &Credential,
        _: &RepoInfo,
        _: &str,
        _: &str,
    ) -> Result<Vec<(PullRequest, String)>> {
        Err(Error::Network)
    }
    fn create_draft(
        &self,
        _: &Credential,
        _: &RepoInfo,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<PullRequest> {
        Err(Error::Network)
    }
}
fn prepare_initial(
    auth: &Auth,
    store: &dyn SecretStore,
    expected: &str,
    confirmed: bool,
    stage: &mut &'static str,
) -> Result<()> {
    *stage = "store-read-before-write";
    if let Some(raw) = store.load()? {
        let record: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| Error::StoreInvalid)?;
        // A retry may finish its own partial write, never replace an unknown item.
        if record["version"] != 1
            || record["client_id"] != "synthetic-public-client"
            || record["user"]["id"] != 9
            || record["access_token"].as_str() != Some(expected)
        {
            return Err(Error::Conflict);
        }
        let view = auth.view()?;
        if !confirmed && view.confirmed {
            return Err(Error::Conflict);
        }
    } else {
        *stage = "synthetic-authorize";
        auth.begin(
            &SyntheticApi {
                seed: expected.into(),
            },
            1000,
        )?;
        auth.poll(
            &SyntheticApi {
                seed: expected.into(),
            },
            1005,
        )?;
    }
    if confirmed && !auth.view()?.confirmed {
        *stage = "store-confirm";
        auth.confirm(9)?;
    }
    Ok(())
}
fn run(stage: &mut &'static str) -> Result<serde_json::Value> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err(Error::Unsupported);
    }
    *stage = "service-preflight";
    let service = &args[2];
    let suffix = service
        .strip_prefix("me.thearcades.heinlein.synthetic-update-")
        .ok_or(Error::Unsupported)?;
    uuid::Uuid::parse_str(suffix).map_err(|_| Error::Unsupported)?;
    *stage = "profile-preflight";
    let root = PathBuf::from(&args[3]);
    if !root.is_absolute()
        || !root.starts_with(
            std::env::temp_dir()
                .canonicalize()
                .unwrap_or_else(|_| std::env::temp_dir()),
        )
    {
        return Err(Error::Unsupported);
    }
    if args[1] == "preflight" {
        return Ok(serde_json::json!({"preflight":true,"allEqual":false}));
    }
    *stage = "seed-pipe";
    let mut seed = [0; 32];
    if args[1] != "cleanup" {
        std::io::stdin()
            .read_exact(&mut seed)
            .map_err(|_| Error::Storage)?;
    }
    let expected = seed.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut outcomes = Vec::new();
    for confirmed in [false, true] {
        let store = Arc::new(OsStore::new(&format!(
            "{service}-{}",
            if confirmed {
                "confirmed"
            } else {
                "unconfirmed"
            }
        ))?);
        *stage = "profile-open";
        let auth = Auth::new(
            "synthetic-public-client".into(),
            store.clone(),
            StateDir::open(&root.join(if confirmed {
                "confirmed"
            } else {
                "unconfirmed"
            }))?,
        )?;
        match args[1].as_str() {
            "write" => prepare_initial(&auth, store.as_ref(), &expected, confirmed, stage)?,
            "read" => {}
            "cleanup" => {
                *stage = "synthetic-cleanup";
                store.clear()?;
                continue;
            }
            _ => return Err(Error::Unsupported),
        }
        *stage = "store-read-result";
        let view = auth.view()?;
        let raw = store.load()?.ok_or(Error::StoreInvalid)?;
        let record: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| Error::StoreInvalid)?;
        *stage = "record-equality";
        outcomes.push(
            view.account.is_some_and(|u| u.id == 9)
                && view.confirmed == confirmed
                && record["version"] == 1
                && record["access_token"].as_str() == Some(&expected),
        );
    }
    if args[1] != "cleanup" && !outcomes.iter().all(|v| *v) {
        return Err(Error::Conflict);
    }
    *stage = "ready-receipt";
    // Build marker changes code hashes. No seed/record/token/digest ever leaves this process.
    if args[1] == "read" && outcomes.iter().all(|v| *v) {
        if let (Ok(directory), Ok(nonce)) = (
            std::env::var("HEINLEIN_PROBE_ACK_DIR"),
            std::env::var("HEINLEIN_READY_NONCE"),
        ) {
            let directory = PathBuf::from(directory);
            if !directory.starts_with(
                std::env::temp_dir()
                    .canonicalize()
                    .unwrap_or_else(|_| std::env::temp_dir()),
            ) || nonce.len() != 32
                || !nonce.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err(Error::Unsupported);
            }
            let exe = std::env::current_exe().map_err(|_| Error::Storage)?;
            let bundle = exe
                .parent()
                .and_then(std::path::Path::parent)
                .and_then(std::path::Path::parent)
                .ok_or(Error::Storage)?;
            let manifest: serde_json::Value = serde_json::from_slice(
                &std::fs::read(bundle.join("Contents/Resources/source-update.json"))
                    .map_err(|_| Error::Storage)?,
            )
            .map_err(|_| Error::Storage)?;
            let target = directory.join(format!("ready-{nonce}.json"));
            let temporary = directory.join(format!(".probe-ready-{nonce}"));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| Error::Storage)?;
            file.write_all(serde_json::to_vec(&serde_json::json!({"nonce":nonce,"pid":std::process::id(),"commit":manifest["commit"],"tree":manifest["tree"]})).map_err(|_|Error::Storage)?.as_slice()).and_then(|_|file.sync_all()).map_err(|_|Error::Storage)?;
            std::fs::rename(temporary, target).map_err(|_| Error::Storage)?;
        }
    }
    let marker = option_env!("HEINLEIN_PROBE_BUILD").unwrap_or("compile-only");
    std::hint::black_box(marker);
    Ok(
        serde_json::json!({"allEqual":outcomes.iter().all(|v|*v),"confirmedAndUnconfirmed":outcomes.len()==2,"cleanup":args[1]=="cleanup"}),
    )
}
fn diagnostic(error: Error, stage: &str) -> serde_json::Value {
    let (code, os_status) = match error {
        Error::StoreLocked => ("locked", Some(-25308)),
        Error::StoreDenied => ("denied", Some(-25293)),
        Error::StoreCancelled => ("cancelled", Some(-128)),
        Error::StoreUnavailable => ("unavailable", None),
        Error::StoreInvalid => ("invalid-record", None),
        Error::Unsupported => ("preflight-rejected", None),
        Error::Storage => ("profile-storage", None),
        Error::Conflict => ("existing-item-mismatch", None),
        _ => ("probe-failed", None),
    };
    serde_json::json!({"allEqual":false,"error":code,"stage":stage,"osStatus":os_status})
}
fn main() {
    let mut stage = "argument-preflight";
    match run(&mut stage) {
        Ok(value) => {
            let _ = writeln!(std::io::stdout(), "{value}");
        }
        Err(error) => {
            let _ = writeln!(std::io::stdout(), "{}", diagnostic(error, stage));
            std::process::exit(1);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Memory {
        bytes: Mutex<Option<Vec<u8>>>,
        writes: Mutex<usize>,
        fail_at: Mutex<Option<usize>>,
        read_error: Mutex<Option<Error>>,
    }
    impl SecretStore for Memory {
        fn load(&self) -> Result<Option<Vec<u8>>> {
            if let Some(e) = *self.read_error.lock().unwrap() {
                return Err(e);
            }
            Ok(self.bytes.lock().unwrap().clone())
        }
        fn save(&self, value: &[u8]) -> Result<()> {
            let mut n = self.writes.lock().unwrap();
            *n += 1;
            if *self.fail_at.lock().unwrap() == Some(*n) {
                return Err(Error::StoreDenied);
            }
            *self.bytes.lock().unwrap() = Some(value.to_vec());
            Ok(())
        }
        fn clear(&self) -> Result<()> {
            panic!("retry must never delete")
        }
    }
    fn fixture() -> (Auth, Arc<Memory>, PathBuf) {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("heinlein-probe-unit-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Memory::default());
        let auth = Auth::new(
            "synthetic-public-client".into(),
            store.clone(),
            StateDir::open(&path).unwrap(),
        )
        .unwrap();
        (auth, store, path)
    }
    #[test]
    fn partial_initial_confirmation_retries_same_item_without_overwriting_or_oauth() {
        let (auth, store, path) = fixture();
        let mut stage = "initial";
        *store.fail_at.lock().unwrap() = Some(2);
        assert!(matches!(
            prepare_initial(&auth, store.as_ref(), "unit-only", true, &mut stage),
            Err(Error::StoreDenied)
        ));
        assert_eq!(stage, "store-confirm");
        assert!(!auth.view().unwrap().confirmed);
        *store.fail_at.lock().unwrap() = None;
        prepare_initial(&auth, store.as_ref(), "unit-only", true, &mut stage).unwrap();
        assert!(auth.view().unwrap().confirmed);
        let n = *store.writes.lock().unwrap();
        prepare_initial(&auth, store.as_ref(), "unit-only", true, &mut stage).unwrap();
        assert_eq!(*store.writes.lock().unwrap(), n);
        drop(auth);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn unknown_item_is_never_overwritten_even_with_valid_synthetic_shape() {
        let (auth, store, path) = fixture();
        let mut stage = "initial";
        prepare_initial(&auth, store.as_ref(), "first-unit-value", false, &mut stage).unwrap();
        let original = store.load().unwrap();
        let writes = *store.writes.lock().unwrap();
        assert!(matches!(
            prepare_initial(
                &auth,
                store.as_ref(),
                "different-unit-value",
                false,
                &mut stage
            ),
            Err(Error::Conflict)
        ));
        assert_eq!(store.load().unwrap(), original);
        assert_eq!(*store.writes.lock().unwrap(), writes);
        drop(auth);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn locked_initial_read_exposes_stage_then_retry_writes_only_after_access_returns() {
        let (auth, store, path) = fixture();
        let mut stage = "initial";
        *store.read_error.lock().unwrap() = Some(Error::StoreLocked);
        assert!(matches!(
            prepare_initial(&auth, store.as_ref(), "unit-only", false, &mut stage),
            Err(Error::StoreLocked)
        ));
        assert_eq!(stage, "store-read-before-write");
        assert_eq!(*store.writes.lock().unwrap(), 0);
        let receipt = diagnostic(Error::StoreLocked, stage);
        assert_eq!(receipt["osStatus"], -25308);
        assert_eq!(receipt["error"], "locked");
        assert!(!receipt.to_string().contains("unit-only"));
        *store.read_error.lock().unwrap() = None;
        prepare_initial(&auth, store.as_ref(), "unit-only", false, &mut stage).unwrap();
        assert_eq!(*store.writes.lock().unwrap(), 1);
        drop(auth);
        std::fs::remove_dir_all(path).unwrap();
    }
}
