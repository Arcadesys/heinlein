//! Explicit macOS-only disposable scene IPC fixture; production startup is disabled.
use super::*;
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    time::Duration,
};
use tauri::{utils::config::AppDirectoriesOverride, Listener, WebviewUrl, WebviewWindowBuilder};

const SOURCE: &str = "Exact — e\u{301} 🦊 writing.\r\n";
const NOTES: &str = "Unlisted notes — preserve.\r\n";
fn private(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let m = path.symlink_metadata()?;
    if !m.is_dir()
        || m.uid() != rustix::process::getuid().as_raw()
        || m.mode() & 0o077 != 0
        || path.canonicalize()? != path
    {
        return Err("Fixture root must be canonical, private and owned".into());
    }
    Ok(())
}
fn put(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let mut f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
fn verify(root: &Path, phase: &str) -> Result<(), Box<dyn std::error::Error>> {
    let repo = Repository::open(root.join("source"))?;
    let state = repo.load_drafting()?;
    let expected = [
        "Above 1", "Above 2", "anchor", "Below 2", "Below 1", "missing",
    ];
    if state
        .scenes
        .iter()
        .map(|s| s.title.as_str())
        .collect::<Vec<_>>()
        != expected
        || state.untracked_paths != vec!["ms/notes.md"]
        || state.missing_paths != vec!["ms/missing.md"]
        || fs::read(root.join("source/ms/anchor.md"))? != SOURCE.as_bytes()
        || fs::read(root.join("source/ms/notes.md"))? != NOTES.as_bytes()
        || root.join("source/ms/missing.md").exists()
    {
        return Err("Native byte/order/drift verification failed".into());
    }
    for scene in state
        .scenes
        .iter()
        .filter(|s| s.title.starts_with("Above") || s.title.starts_with("Below"))
    {
        if !fs::read(root.join("source").join(&scene.path))?.is_empty() {
            return Err("New scene was not empty".into());
        }
    }
    let receipt = serde_json::json!({"phase":phase,"realIPC":true,"exactBytes":true,"order":expected,"unlistedPreserved":true,"missingPreserved":true,"repeated":true,"canceled":true});
    put(
        &root.join(format!("{phase}-receipt.json")),
        receipt.to_string().as_bytes(),
    )?;
    Ok(())
}
pub(super) fn run() {
    if let Err(error) = checked() {
        eprintln!("Scene fixture failed: {error}");
        std::process::exit(73);
    }
}
fn checked() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4
        || args[1] != "--scene-native-acceptance"
        || !["first", "reopen"].contains(&args[3].as_str())
    {
        return Err("Explicit root and phase required".into());
    }
    let root = PathBuf::from(&args[2]);
    private(&root)?;
    let key = root
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_prefix("heinlein-native-scene-"))
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .ok_or("UUID root required")?;
    if std::env::temp_dir().canonicalize()? != root {
        return Err("TMPDIR must be fixture root".into());
    }
    let phase = args[3].clone();
    if phase == "first" {
        if fs::read_dir(&root)?.next().is_some() {
            return Err("First root must be empty".into());
        }
        for p in [
            "source",
            "source/ms",
            "app-data",
            "app-data/caches",
            "app-data/logs",
        ] {
            fs::DirBuilder::new().mode(0o700).create(root.join(p))?;
        }
        put(&root.join("source/ms/anchor.md"), SOURCE.as_bytes())?;
        put(
            &root.join("source/ms/missing.md"),
            b"Missing synthetic scene",
        )?;
        let repo = Repository::open(root.join("source"))?;
        let recovery = RecoveryStore::open(root.join("app-data/recovery"))?;
        let plan = repo.preview_drafting(
            None,
            repository_core::DraftingChange::Initialize {
                project: "Synthetic scene insertion".into(),
            },
            &[],
            &recovery,
        )?;
        repo.apply_drafting(&plan, &recovery)?;
        fs::remove_file(root.join("source/ms/missing.md"))?;
        put(&root.join("source/ms/notes.md"), NOTES.as_bytes())?;
    } else {
        // The first-phase native verifier owns this receipt; no real project can qualify.
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("first-receipt.json"))?)?;
        if receipt["realIPC"] != true || receipt["exactBytes"] != true {
            return Err("Missing first receipt".into());
        }
    }
    let mut context = tauri::generate_context!("../macos/tests/native-scene-probe/tauri.conf.json");
    context.config_mut().identifier =
        format!("me.thearcades.heinlein.synthetic-scene-{}", key.simple());
    context.config_mut().app.app_directories_override =
        Some(AppDirectoriesOverride::Root(root.join("app-data")));
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone();
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        drafting::load_drafting,
        drafting::preview_drafting_change,
        drafting::apply_drafting_change,
        read_document
    ];
    let app = tauri::Builder::default()
        .manage(BrowserState::default())
        .invoke_handler(move |invoke| {
            if ![
                "load_drafting",
                "preview_drafting_change",
                "apply_drafting_change",
                "read_document",
            ]
            .contains(&invoke.message.command())
            {
                invoke.resolver.reject("Unrelated fixture command refused");
                return true;
            }
            handler(invoke)
        })
        .setup(move |app| {
            for path in [
                app.path().app_config_dir()?,
                app.path().app_data_dir()?,
                app.path().app_local_data_dir()?,
                app.path().app_cache_dir()?,
                app.path().app_log_dir()?,
                app.path().temp_dir()?,
            ] {
                if !path.starts_with(&root) {
                    return Err("App path escaped root".into());
                }
                private(&path)?;
            }
            let state = app.state::<BrowserState>();
            let repo = Arc::new(Repository::open(root.join("source"))?);
            let repository_id = id();
            *state.selected.lock().unwrap() = Some(Selected {
                id: repository_id.clone(),
                repo,
            });
            *state.recovery.lock().unwrap() = Some(Arc::new(RecoveryStore::open(
                root.join("app-data/recovery"),
            )?));
            let h = app.handle().clone();
            app.listen("scene-fixture-failed", move |event| {
                eprintln!("Renderer failed: {}", event.payload());
                h.exit(73);
            });
            let h = app.handle().clone();
            let r = root.clone();
            let p = phase.clone();
            let d = finished.clone();
            app.listen("scene-fixture-finish", move |_| match verify(&r, &p) {
                Ok(()) => {
                    d.store(true, Ordering::SeqCst);
                    h.exit(0);
                }
                Err(e) => {
                    eprintln!("{e}");
                    h.exit(73);
                }
            });
            let script = format!(
                "globalThis.__SCENE_FIXTURE__={};",
                serde_json::json!({"repositoryId":repository_id,"phase":phase})
            );
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("DISPOSABLE scene insertion — synthetic writing only")
                .incognito(true)
                .initialization_script(&script)
                .on_navigation(|u| u.scheme() == "tauri" && u.host_str() == Some("localhost"))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .build(context)?;
    let h = app.handle().clone();
    let watchdog = done.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        if !watchdog.load(Ordering::SeqCst) {
            eprintln!("Scene fixture watchdog failed");
            h.exit(73);
        }
    });
    let code = app.run_return(|_, _| {});
    if code != 0 || !done.load(Ordering::SeqCst) {
        return Err("Native acceptance incomplete".into());
    }
    Ok(())
}
