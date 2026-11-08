//! Managed main-source updates. No credentials or source roots enter this bridge.
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

#[derive(Default)]
pub(crate) struct Runtime {
    // Dropping this file closes only this process's inherited lease description.
    _lease: Option<File>,
    bundle: Option<PathBuf>,
    cache: Option<PathBuf>,
    operation: Mutex<()>,
    release_enabled: bool,
    release_status: Mutex<Option<Status>>,
    #[cfg(all(feature = "update-native-acceptance", target_os = "macos"))]
    synthetic: Option<std::sync::Arc<super::update_native_script::Script>>,
    exiting: std::sync::atomic::AtomicBool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    Status,
    Check,
    Schedule,
    OpenRelease,
    BuildRelease,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Status {
    state: String,
    #[serde(default)]
    commit: Option<String>,
    #[serde(default)]
    tree: Option<String>,
    #[serde(default)]
    available_commit: Option<String>,
    #[serde(default)]
    available_tree: Option<String>,
    #[serde(default)]
    generation: Option<u64>,
    #[serde(default)]
    step: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    current_version: Option<String>,
    #[serde(default)]
    available_version: Option<String>,
}
fn unavailable() -> Status {
    Status {
        state: "unavailable".into(),
        commit: None,
        tree: None,
        available_commit: None,
        available_tree: None,
        generation: None,
        step: None,
        channel: None,
        current_version: None,
        available_version: None,
    }
}
fn parse_status(bytes: &[u8]) -> Result<Status, String> {
    if bytes.len() > 65536 {
        return Err("Update status is unavailable".into());
    }
    let result: Status =
        serde_json::from_slice(bytes).map_err(|_| "Update status is unavailable")?;
    if result.state.len() > 80
        || !result
            .state
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '-')
    {
        return Err("Update status is unavailable".into());
    }
    if result.step.as_ref().is_some_and(|step| {
        step.len() > 80 || !step.chars().all(|c| c.is_ascii_lowercase() || c == '-')
    }) {
        return Err("Update status is unavailable".into());
    }
    for value in [
        &result.commit,
        &result.tree,
        &result.available_commit,
        &result.available_tree,
    ]
    .into_iter()
    .flatten()
    {
        if value.len() != 40 || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Update source metadata is invalid".into());
        }
    }
    Ok(result)
}
impl Runtime {
    /// Called before constructing any writing window. A direct second native launch
    /// activates the lease owner; a launcher transfers its exact open description.
    pub fn acquire() -> Result<Option<Self>, String> {
        #[cfg(target_os = "macos")]
        {
            use rustix::fs::{flock, FlockOperation};
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::fs::{MetadataExt, OpenOptionsExt},
            };
            let exe = std::env::current_exe().map_err(|_| "App location unavailable")?;
            let Some(bundle) = exe.parent().and_then(Path::parent).and_then(Path::parent) else {
                return Ok(Some(Self::default()));
            };
            let manifest = bundle.join("Contents/Resources/source-update.json");
            if !manifest.is_file() {
                return Ok(Some(Self {
                    release_enabled: bundle.extension().is_some_and(|ext| ext == "app"),
                    ..Self::default()
                }));
            }
            let metadata: serde_json::Value = serde_json::from_slice(
                &std::fs::read(&manifest).map_err(|_| "Update metadata unavailable")?,
            )
            .map_err(|_| "Update metadata unavailable")?;
            if metadata["updaterVersion"] != 1 {
                return Ok(Some(Self::default()));
            }
            let home = PathBuf::from(std::env::var_os("HOME").ok_or("Home unavailable")?);
            if bundle != home.join("Applications/Heinlein Studio.app")
                || bundle.canonicalize().ok().as_deref() != Some(bundle)
            {
                return Err("Unsupported managed install location".into());
            }
            let cache = home.join("Library/Application Support/Heinlein Studio/updater");
            std::fs::create_dir_all(&cache).map_err(|_| "Updater storage unavailable")?;
            if cache.canonicalize().ok().as_deref() != Some(cache.as_path()) {
                return Err("Unsafe updater storage".into());
            }
            let info = cache
                .metadata()
                .map_err(|_| "Updater storage unavailable")?;
            if info.uid() != rustix::process::getuid().as_raw() || info.mode() & 0o077 != 0 {
                return Err("Updater storage must be private".into());
            }
            let path = cache.join("lifetime.lock");
            let named = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
                .open(path)
                .map_err(|_| "Update lease unavailable")?;
            let lock_info = named.metadata().map_err(|_| "Update lease unavailable")?;
            if !lock_info.is_file()
                || lock_info.uid() != rustix::process::getuid().as_raw()
                || lock_info.mode() & 0o077 != 0
                || lock_info.nlink() != 1
            {
                return Err("Unsafe update lease".into());
            }
            let lease = if let Ok(fd) = std::env::var("HEINLEIN_LIFETIME_FD") {
                let fd: i32 = fd.parse().map_err(|_| "Invalid update handoff")?;
                if fd < 3 {
                    return Err("Invalid update handoff".into());
                }
                let inherited = unsafe { File::from_raw_fd(fd) };
                let a = named.metadata().map_err(|_| "Update lease unavailable")?;
                let b = inherited
                    .metadata()
                    .map_err(|_| "Update lease unavailable")?;
                if a.dev() != b.dev() || a.ino() != b.ino() {
                    return Err("Invalid update handoff".into());
                }
                inherited
            } else {
                named
            };
            if flock(&lease, FlockOperation::NonBlockingLockExclusive).is_err() {
                let _ = atomic(
                    &cache.join("activate-v1.json"),
                    &serde_json::json!({"nonce":uuid::Uuid::new_v4().simple().to_string()}),
                );
                return Ok(None);
            }
            rustix::io::fcntl_setfd(&lease, rustix::io::FdFlags::CLOEXEC)
                .map_err(|_| "Update lease unavailable")?;
            let _ = lease.as_raw_fd();
            Ok(Some(Self {
                _lease: Some(lease),
                bundle: Some(bundle.to_owned()),
                cache: Some(cache),
                #[cfg(all(feature = "update-native-acceptance", target_os = "macos"))]
                synthetic: None,
                operation: Mutex::new(()),
                release_enabled: false,
                release_status: Mutex::new(None),
                exiting: std::sync::atomic::AtomicBool::new(false),
            }))
        }
        #[cfg(not(target_os = "macos"))]
        Ok(Some(Self::default()))
    }
    pub fn ready(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let (Some(bundle), Some(cache)) = (&self.bundle, &self.cache) else {
            return Ok(());
        };
        let nonce = std::env::var("HEINLEIN_READY_NONCE").unwrap_or_default();
        if nonce.len() == 32 && nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
            let source: serde_json::Value = serde_json::from_slice(
                &std::fs::read(bundle.join("Contents/Resources/source-update.json"))
                    .map_err(|_| "Update metadata unavailable")?,
            )
            .map_err(|_| "Update metadata unavailable")?;
            atomic(
                &cache.join(format!("ready-{nonce}.json")),
                &serde_json::json!({"nonce":nonce,"pid":std::process::id(),"commit":source["commit"],"tree":source["tree"]}),
            )?;
        }
        let app = app.clone();
        let activation = cache.join("activate-v1.json");
        std::thread::spawn(move || {
            let mut last = None;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let current = std::fs::metadata(&activation)
                    .and_then(|m| m.modified())
                    .ok();
                if current.is_some() && current != last {
                    last = current;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
        Ok(())
    }
    pub(crate) fn idle(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.operation
            .try_lock()
            .map_err(|_| "Wait for the update check before quitting".into())
    }
    pub(crate) fn seal_for_exit(&self) {
        self.exiting
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    #[cfg(all(feature = "update-native-acceptance", target_os = "macos"))]
    pub(crate) fn synthetic(script: std::sync::Arc<super::update_native_script::Script>) -> Self {
        Self {
            synthetic: Some(script),
            ..Self::default()
        }
    }
    fn execute(&self, action: Action) -> Result<Status, String> {
        if self.bundle.is_none() && !self.release_enabled {
            #[cfg(all(feature = "update-native-acceptance", target_os = "macos"))]
            let synthetic = self.synthetic.is_some();
            #[cfg(not(all(feature = "update-native-acceptance", target_os = "macos")))]
            let synthetic = false;
            if !synthetic {
                return Ok(unavailable());
            }
        }
        let _gate = self
            .operation
            .try_lock()
            .map_err(|_| "An update check is already running")?;
        if self.exiting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Heinlein is quitting".into());
        }
        #[cfg(all(feature = "update-native-acceptance", target_os = "macos"))]
        if let Some(script) = &self.synthetic {
            // Synthetic bytes travel through the real operation/exiting gates and parser.
            // Never fall through to codesign, Python or a real updater path.
            return parse_status(&script.respond(action)?);
        }
        if self.release_enabled {
            return match action {
                Action::Status => Ok(self
                    .release_status
                    .lock()
                    .map_err(|_| "Update status unavailable")?
                    .clone()
                    .unwrap_or_else(release_not_checked)),
                Action::Check => {
                    let status = check_release().unwrap_or_else(|_| Status {
                        state: "release-check-failed".into(),
                        ..release_not_checked()
                    });
                    *self
                        .release_status
                        .lock()
                        .map_err(|_| "Update status unavailable")? = Some(status.clone());
                    Ok(status)
                }
                _ => Err("Use the release download page for this app".into()),
            };
        }
        let bundle = self.bundle.as_ref().ok_or("Managed bundle unavailable")?;
        // Use OS verification before executing bundled updater code. No deep re-sign.
        if !std::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| "Bundle verification unavailable")?
            .success()
        {
            return Err("The app bundle failed integrity verification".into());
        }
        let python = [
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3",
        ]
        .into_iter()
        .find(|p| Path::new(p).is_file())
        .ok_or("Python 3 is required for source updates")?;
        let action = match action {
            Action::Status => "status",
            Action::Check => "check",
            Action::Schedule => "schedule",
            Action::OpenRelease | Action::BuildRelease => {
                return Err("Release downloads do not replace managed source apps".into())
            }
        };
        let output = std::process::Command::new(python)
            .env_clear()
            .env("HOME", std::env::var_os("HOME").ok_or("Home unavailable")?)
            .env(
                "PATH",
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            )
            .env("LANG", "en_US.UTF-8")
            .args(["-I", "-S"])
            .arg(bundle.join("Contents/Resources/update.py"))
            .arg("--app")
            .arg(bundle)
            .arg(action)
            .stderr(std::process::Stdio::null())
            .output()
            .map_err(|_| "Update check unavailable")?;
        parse_status(&output.stdout)
    }
}
const RELEASE_PAGE: &str = "https://github.com/Arcadesys/heinlein/releases/latest";
fn release_not_checked() -> Status {
    Status {
        state: "release-not-checked".into(),
        channel: Some("release".into()),
        current_version: Some(env!("CARGO_PKG_VERSION").into()),
        ..unavailable()
    }
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<ReleaseAsset>,
}
#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
}
fn release_status(release: Release, installed: &str) -> Result<Status, String> {
    let version = release
        .tag_name
        .strip_prefix('v')
        .ok_or("Invalid release version")?;
    let latest = semver::Version::parse(version).map_err(|_| "Invalid release version")?;
    let current = semver::Version::parse(installed).map_err(|_| "Invalid installed version")?;
    // Publisher-only tags and incomplete/prerelease downloads are not app updates.
    if release.draft
        || release.prerelease
        || !latest.pre.is_empty()
        || !release
            .assets
            .iter()
            .any(|a| a.name == format!("Heinlein-Studio-{version}-macos-arm64.dmg"))
    {
        return Err("No stable app release available".into());
    }
    Ok(Status {
        state: if latest > current {
            "release-available"
        } else {
            "release-current"
        }
        .into(),
        current_version: Some(installed.into()),
        available_version: Some(latest.to_string()),
        ..release_not_checked()
    })
}
fn check_release() -> Result<Status, String> {
    use std::io::Read;
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Release check unavailable")?
        .get("https://api.github.com/repos/Arcadesys/heinlein/releases/latest")
        .header(reqwest::header::USER_AGENT, "Heinlein-Studio-update-check")
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| "Release check unavailable")?;
    let mut bytes = Vec::new();
    response
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|_| "Release check unavailable")?;
    if bytes.len() > 1_048_576 {
        return Err("Release response too large".into());
    }
    let release = serde_json::from_slice(&bytes).map_err(|_| "Release metadata unavailable")?;
    release_status(release, env!("CARGO_PKG_VERSION"))
}
fn build_release(version: &str) -> Result<PathBuf, String> {
    let parsed = semver::Version::parse(version).map_err(|_| "Invalid release version")?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        return Err("Only stable releases can be built".into());
    }
    let python = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    .into_iter()
    .find(|p| Path::new(p).is_file())
    .ok_or("Python 3 is required")?;
    let home = std::env::var_os("HOME").ok_or("Home unavailable")?;
    let cargo = PathBuf::from(&home).join(".cargo/bin");
    let output = std::process::Command::new(python)
        .env_clear()
        .env("HOME", home)
        .env(
            "PATH",
            format!(
                "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                cargo.display()
            ),
        )
        .env("LANG", "en_US.UTF-8")
        .env("OPENSSL_STATIC", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "-I",
            "-S",
            "-c",
            include_str!("../../macos/build_release.py"),
            version,
        ])
        .output()
        .map_err(|_| "Release build unavailable")?;
    if !output.status.success() {
        return Err("Release build failed".into());
    }
    let path = PathBuf::from(
        String::from_utf8(output.stdout)
            .map_err(|_| "Build output unavailable")?
            .trim(),
    );
    if !path.is_absolute()
        || !path.is_dir()
        || path.file_name().and_then(|s| s.to_str()) != Some("Heinlein Studio.app")
    {
        return Err("Build output unavailable".into());
    }
    Ok(path)
}
fn atomic(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Updater storage unavailable")?;
    let temp = parent.join(format!(".ready-{}", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|_| "Updater storage unavailable")?;
    file.write_all(&serde_json::to_vec(value).map_err(|_| "Update status unavailable")?)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Update status unavailable")?;
    std::fs::rename(&temp, path)
        .and_then(|_| File::open(parent)?.sync_all())
        .map_err(|_| "Update status unavailable".into())
}
#[cfg(any(target_os = "macos", test))]
pub(crate) fn guard_repository(root: &Path, home: &Path) -> Result<(), String> {
    let root = super::resolved_future_path(root)?;
    for relative in [
        "Library/Application Support/Heinlein Studio/updater",
        "Applications/.heinlein-updates",
        "Applications/Heinlein Studio.app",
    ] {
        super::guard_auth_repository_separation(&root, &home.join(relative)).map_err(|_| {
            "Choose a writing folder outside the app installation and private updater cache"
        })?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn update_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: Action,
) -> Result<Status, String> {
    super::check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<super::BrowserState>();
        if state.quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Heinlein is quitting".into());
        }
        state.mutation_gate.note_activity();
        if matches!(action, Action::BuildRelease) {
            let runtime = app.state::<Runtime>();
            let _gate = runtime.idle()?;
            if !runtime.release_enabled || runtime.exiting.load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err("Release builds unavailable".into());
            }
            let previous = runtime
                .release_status
                .lock()
                .map_err(|_| "Update status unavailable")?
                .clone()
                .ok_or("Check for a newer release first")?;
            if !matches!(
                previous.state.as_str(),
                "release-available" | "release-build-failed"
            ) {
                return Err("Check for a newer release first".into());
            }
            let version = previous
                .available_version
                .as_deref()
                .ok_or("Release version unavailable")?;
            let result = build_release(version);
            let next = match result {
                Ok(path) => {
                    use tauri_plugin_opener::OpenerExt;
                    app.opener().reveal_item_in_dir(path).map_err(|_| {
                        "App built, but Finder could not show the temporary build folder"
                    })?;
                    Status {
                        state: "release-build-ready".into(),
                        ..previous
                    }
                }
                Err(_) => Status {
                    state: "release-build-failed".into(),
                    ..previous
                },
            };
            *runtime
                .release_status
                .lock()
                .map_err(|_| "Update status unavailable")? = Some(next.clone());
            return Ok(next);
        }
        if matches!(action, Action::OpenRelease) {
            let runtime = app.state::<Runtime>();
            let _gate = runtime.idle()?;
            if !runtime.release_enabled || runtime.exiting.load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err("Release downloads unavailable".into());
            }
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(RELEASE_PAGE, None::<&str>)
                .map_err(|_| "Release page unavailable")?;
            return Ok(runtime
                .release_status
                .lock()
                .map_err(|_| "Update status unavailable")?
                .clone()
                .unwrap_or_else(release_not_checked));
        }
        app.state::<Runtime>().execute(action)
    })
    .await
    .map_err(|_| String::from("Update check interrupted"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn release(version: &str) -> Release {
        Release {
            tag_name: format!("v{version}"),
            draft: false,
            prerelease: false,
            assets: vec![ReleaseAsset {
                name: format!("Heinlein-Studio-{version}-macos-arm64.dmg"),
            }],
        }
    }
    #[test]
    fn published_app_versions_never_downgrade_local_builds() {
        assert_eq!(
            release_status(release("1.8.0"), "1.7.0").unwrap().state,
            "release-available"
        );
        assert_eq!(
            release_status(release("1.7.0"), "1.7.0").unwrap().state,
            "release-current"
        );
        assert_eq!(
            release_status(release("1.6.0"), "1.7.0").unwrap().state,
            "release-current"
        );
        assert_eq!(
            release_status(release("1.10.0"), "1.9.0").unwrap().state,
            "release-available"
        );
    }
    #[test]
    fn incomplete_publisher_and_prerelease_downloads_are_not_app_updates() {
        let mut value = release("1.8.0");
        value.draft = true;
        assert!(release_status(value, "1.7.0").is_err());
        let mut value = release("1.8.0");
        value.prerelease = true;
        assert!(release_status(value, "1.7.0").is_err());
        assert!(release_status(release("1.8.0-beta.1"), "1.7.0").is_err());
        let mut value = release("1.8.0");
        value.assets.clear();
        assert!(release_status(value, "1.7.0").is_err());
        let mut value = release("1.8.0");
        value.tag_name = "invalid".into();
        assert!(release_status(value, "1.7.0").is_err());
    }
    #[cfg(all(feature = "update-native-acceptance", target_os = "macos"))]
    #[test]
    fn synthetic_backend_obeys_real_operation_and_exiting_guards_and_parser() {
        let script = std::sync::Arc::new(super::super::update_native_script::Script::default());
        let runtime = Runtime::synthetic(script.clone());
        assert_eq!(
            runtime.execute(Action::Status).unwrap().state,
            "not-checked"
        );
        let lock = runtime.operation.lock().unwrap();
        assert!(runtime.execute(Action::Status).is_err());
        assert_eq!(script.summary()["calls"], serde_json::json!(["status"]));
        drop(lock);
        runtime.seal_for_exit();
        assert!(runtime.execute(Action::Status).is_err());
        assert_eq!(script.summary()["calls"], serde_json::json!(["status"]));
    }
    #[test]
    fn native_quit_waits_for_update_save_and_author_gates() {
        let runtime = Runtime::default();
        let running = runtime.operation.lock().unwrap();
        assert!(runtime.idle().is_err());
        drop(running);
        assert!(runtime.idle().is_ok());
        let gate = super::super::proposals::authority::MutationGate::default();
        let save = gate.edit().unwrap();
        assert!(gate.close_guard().is_err());
        drop(save);
        let author = gate.author_operation().unwrap();
        assert!(gate.close_guard().is_err());
        drop(author);
        assert!(gate.close_guard().is_ok());
    }
    #[test]
    fn updater_paths_cannot_be_selected_as_writing_roots() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        for path in [
            "Library/Application Support/Heinlein Studio/updater/source",
            "Applications/.heinlein-updates/backup",
            "Applications/Heinlein Studio.app",
        ] {
            assert!(guard_repository(&home.join(path), home).is_err())
        }
        assert!(guard_repository(&home.join("Writing/My story"), home).is_ok());
        assert!(guard_repository(home, home).is_err());
    }
    #[test]
    fn status_is_bounded_and_cannot_smuggle_paths_or_credentials() {
        assert!(parse_status(
            br#"{"state":"available","commit":"0123456789012345678901234567890123456789"}"#
        )
        .is_ok());
        for value in [
            br#"{"state":"available","token":"private"}"#.as_slice(),
            br#"{"state":"current","commit":"/private/writing"}"#,
            br#"{"state":"raw provider error"}"#,
            br#"{"state":"current","step":"/private/writing"}"#,
        ] {
            assert!(parse_status(value).is_err())
        }
    }
    #[test]
    fn native_ready_receipt_is_atomic_and_contains_only_public_binding() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("ready.json");
        atomic(
            &path,
            &serde_json::json!({"nonce":"synthetic","commit":"public","pid":42}),
        )
        .unwrap();
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }
}
