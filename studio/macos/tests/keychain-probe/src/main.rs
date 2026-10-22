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
fn run() -> Result<serde_json::Value> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err(Error::Unsupported);
    }
    let service = &args[2];
    let suffix = service
        .strip_prefix("me.thearcades.heinlein.synthetic-update-")
        .ok_or(Error::Unsupported)?;
    uuid::Uuid::parse_str(suffix).map_err(|_| Error::Unsupported)?;
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
            "write" => {
                auth.begin(
                    &SyntheticApi {
                        seed: expected.clone(),
                    },
                    1000,
                )?;
                auth.poll(
                    &SyntheticApi {
                        seed: expected.clone(),
                    },
                    1005,
                )?;
                if confirmed {
                    auth.confirm(9)?;
                }
            }
            "read" => {}
            "cleanup" => {
                store.clear()?;
                continue;
            }
            _ => return Err(Error::Unsupported),
        }
        let view = auth.view()?;
        let raw = store.load()?.ok_or(Error::StoreInvalid)?;
        let record: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| Error::StoreInvalid)?;
        outcomes.push(
            view.account.is_some_and(|u| u.id == 9)
                && view.confirmed == confirmed
                && record["version"] == 1
                && record["access_token"].as_str() == Some(&expected),
        );
    }
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
fn main() {
    match run() {
        Ok(value) => {
            let _ = writeln!(std::io::stdout(), "{value}");
        }
        Err(error) => {
            let code = match error {
                Error::StoreLocked => "locked",
                Error::StoreDenied => "denied",
                Error::StoreCancelled => "cancelled",
                Error::StoreUnavailable => "unavailable",
                _ => "probe-failed",
            };
            let _ = writeln!(
                std::io::stdout(),
                "{}",
                serde_json::json!({"allEqual":false,"error":code})
            );
            std::process::exit(1)
        }
    }
}
