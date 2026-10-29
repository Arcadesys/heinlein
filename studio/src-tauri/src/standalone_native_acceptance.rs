//! Explicit feature-only native IPC acceptance. No managed startup or services.
use super::*;
use std::{
    io::{BufRead, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    sync::{atomic::AtomicU64, OnceLock},
    time::Duration,
};
use tauri::utils::config::AppDirectoriesOverride;
use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};

static FIXTURE: OnceLock<Arc<Fixture>> = OnceLock::new();
struct Fixture {
    root: PathBuf,
    phase: String,
    steps: Mutex<Vec<String>>,
    forbidden: AtomicU64,
    calls: AtomicU64,
    close_calls: AtomicU64,
    abort: AtomicBool,
    ended: AtomicBool,
}
fn stage(name: &str) {
    println!("{}", serde_json::json!({"kind":"progress","stage":name}));
    let _ = std::io::stdout().flush();
}
fn private(path: &Path) -> Result<(), String> {
    let m = path
        .symlink_metadata()
        .map_err(|_| "Fixture path missing")?;
    let uid = unsafe {
        extern "C" {
            fn getuid() -> u32;
        }
        getuid()
    };
    if !m.is_dir()
        || m.uid() != uid
        || m.mode() & 0o077 != 0
        || path.canonicalize().ok().as_deref() != Some(path)
    {
        return Err("Fixture path must be canonical, owned and private".into());
    }
    Ok(())
}
pub(super) fn file_read(path: &Path) -> Result<serde_json::Value, String> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)
        .map_err(|_| "Fixture sentinel missing")?;
    let meta = file.metadata().map_err(|_| "Fixture sentinel metadata")?;
    let uid = unsafe {
        extern "C" {
            fn getuid() -> u32;
        }
        getuid()
    };
    if meta.uid() != uid
        || !meta.is_file()
        || meta.nlink() != 1
        || meta.mode() & 0o077 != 0
        || meta.len() > 4096
    {
        return Err("Unsafe fixture sentinel".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| "Fixture sentinel unreadable")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid fixture sentinel".into())
}
pub(super) fn file_create(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)
        .map_err(|_| "Fixture sentinel already exists")?;
    file.write_all(value.to_string().as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| String::from("Fixture sentinel write failed"))?;
    std::fs::File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|_| "Fixture directory sync failed".into())
}
fn fail(app: &tauri::AppHandle, reason: &str) {
    stage(reason);
    FIXTURE.get().unwrap().abort.store(true, Ordering::SeqCst);
    app.exit(73);
}
// Own AppKit action, always queued outside any Tauri callback. No AX/IPC/input injection.
fn native_quit() {
    use std::ffi::{c_char, c_void};
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(n: *const c_char) -> *mut c_void;
        fn sel_registerName(n: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    #[link(name = "System")]
    extern "C" {
        static _dispatch_main_q: c_void;
        fn dispatch_async_f(q: *mut c_void, c: *mut c_void, f: extern "C" fn(*mut c_void));
    }
    extern "C" fn perform(_: *mut c_void) {
        unsafe {
            let get: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
                std::mem::transmute(objc_msgSend as *const ());
            let app = get(
                objc_getClass(c"NSApplication".as_ptr()),
                sel_registerName(c"sharedApplication".as_ptr()),
            );
            let send: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
                std::mem::transmute(objc_msgSend as *const ());
            stage("own-native-terminate-dispatched");
            send(
                app,
                sel_registerName(c"terminate:".as_ptr()),
                std::ptr::null_mut(),
            );
            stage("own-native-terminate-returned-cancel");
        }
    }
    unsafe {
        dispatch_async_f(
            std::ptr::addr_of!(_dispatch_main_q).cast_mut(),
            std::ptr::null_mut(),
            perform,
        )
    }
}
fn nonpersistent(webview: *mut std::ffi::c_void) -> bool {
    use std::ffi::{c_char, c_void};
    #[link(name = "objc")]
    extern "C" {
        fn sel_registerName(n: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    unsafe {
        let get: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let configuration = get(webview, sel_registerName(c"configuration".as_ptr()));
        let store = get(
            configuration,
            sel_registerName(c"websiteDataStore".as_ptr()),
        );
        let persistent: unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool =
            std::mem::transmute(objc_msgSend as *const ());
        !store.is_null() && !persistent(store, sel_registerName(c"isPersistent".as_ptr()))
    }
}
fn await_navigation_gate(
    gate: std::sync::mpsc::Receiver<bool>,
    returned: std::sync::mpsc::Receiver<bool>,
    timeout: Duration,
) -> Result<(), &'static str> {
    match gate.recv_timeout(timeout) {
        Ok(true) => (),
        Ok(false) => return Err("WebKit-data-store-is-persistent-ABORT"),
        Err(_) => return Err("WebKit-gate-missing-or-timeout"),
    }
    match returned.recv_timeout(timeout) {
        Ok(true) => Ok(()),
        Ok(false) => Err("with-webview-dispatch-failed"),
        Err(_) => Err("with-webview-return-missing-or-timeout"),
    }
}
fn enqueue_if_active(
    terminal: impl Fn() -> bool,
    enqueue: impl FnOnce() -> Result<(), ()>,
) -> Result<bool, &'static str> {
    if terminal() {
        return Ok(false);
    }
    enqueue()
        .map(|()| true)
        .map_err(|()| "worker-navigation-enqueue-failed")
}
pub(super) fn picker_guard_home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let fixture = FIXTURE.get().ok_or("Verified picker startup required")?;
    if !fixture.phase.starts_with("picker") {
        return Err("Picker startup required for destination guards".into());
    }
    private(&fixture.root)?;
    if std::env::temp_dir().canonicalize().ok() != Some(fixture.root.clone())
        || app
            .path()
            .app_data_dir()
            .map_err(|_| "Fixture app data unavailable")?
            != fixture.root.join("app-data")
    {
        return Err("Picker root/path confinement lost".into());
    }
    Ok(fixture.root.clone())
}
pub(super) fn picker_preview_only() -> bool {
    FIXTURE
        .get()
        .is_some_and(|fixture| fixture.phase == "picker-preview-only")
}
pub(super) fn picker_root() -> Result<PathBuf, String> {
    let fixture = FIXTURE.get().ok_or("Verified picker startup required")?;
    if !fixture.phase.starts_with("picker") {
        return Err("Explicit picker fixture required".into());
    }
    private(&fixture.root)?;
    Ok(fixture.root.clone())
}
pub(super) fn run() {
    let result = run_fixture();
    if let Err(error) = result {
        eprintln!("Fixture preflight failed: {error}");
        std::process::exit(73)
    }
}
fn run_fixture() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4
        || args[1] != "--standalone-native-acceptance"
        || ![
            "first",
            "reopen",
            "picker",
            "picker-reopen",
            "picker-preview-only",
        ]
        .contains(&args[3].as_str())
    {
        return Err("Explicit fixture invocation/root/phase required".into());
    }
    let root = PathBuf::from(&args[2]);
    private(&root)?;
    if !root.starts_with("/private/tmp") || root.parent() != Some(Path::new("/private/tmp")) {
        return Err("Fresh private tmp fixture root required".into());
    }
    let uuid = root
        .file_name()
        .unwrap()
        .to_str()
        .and_then(|n| n.strip_prefix("heinlein-native-standalone-"))
        .and_then(|n| uuid::Uuid::parse_str(n).ok())
        .ok_or("UUID root required")?;
    if std::env::temp_dir().canonicalize().ok() != Some(root.clone()) {
        return Err("TMPDIR must equal fixture root before startup".into());
    }
    let sentinel = root.join("fixture-sentinel.json");
    if ["first", "picker", "picker-preview-only"].contains(&args[3].as_str()) {
        if std::fs::read_dir(&root)
            .map_err(|_| "Fixture root unavailable")?
            .next()
            .is_some()
        {
            return Err("First fixture root must be empty".into());
        }
        file_create(
            &sentinel,
            &serde_json::json!({"schema":1,"uuid":uuid.to_string()}),
        )?;
    }
    let value = file_read(&sentinel)?;
    if value["schema"] != 1 || value["uuid"] != uuid.to_string() {
        return Err("Fixture sentinel mismatch".into());
    }
    let app_root = root.join("app-data");
    for p in [&app_root, &app_root.join("caches"), &app_root.join("logs")] {
        if !p.exists() {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(p)
                .map_err(|_| "Fixture directory creation")?;
        }
        private(p)?;
    }
    if ["picker", "picker-preview-only"].contains(&args[3].as_str()) {
        let target = root.join("copy-targets");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&target)
            .map_err(|_| "Fresh picker target creation failed")?;
        private(&target)?;
    }
    let identity = if ["reopen", "picker-reopen"].contains(&args[3].as_str()) {
        file_read(&root.join("draft-identity.json"))?["id"]
            .as_str()
            .map(str::to_string)
            .ok_or("Draft identity missing")?
    } else {
        String::new()
    };
    let fixture = Arc::new(Fixture {
        root: root.clone(),
        phase: args[3].clone(),
        steps: Mutex::new(Vec::new()),
        forbidden: AtomicU64::new(0),
        calls: AtomicU64::new(0),
        close_calls: AtomicU64::new(0),
        abort: AtomicBool::new(false),
        ended: AtomicBool::new(false),
    });
    FIXTURE
        .set(fixture.clone())
        .map_err(|_| "Fixture already initialized")?;
    stage("feature-explicit-invocation-private-root-sentinel-validated");
    let mut context = if fixture.phase.starts_with("picker") {
        tauri::generate_context!("../macos/tests/native-standalone-probe/picker/tauri.conf.json")
    } else {
        tauri::generate_context!("../macos/tests/native-standalone-probe/tauri.conf.json")
    };
    context.config_mut().identifier = format!(
        "me.thearcades.heinlein.synthetic-standalone-{}",
        uuid.simple()
    );
    context.config_mut().app.app_directories_override =
        Some(AppDirectoriesOverride::Root(app_root.clone()));
    let expected_revision = if args[3] == "reopen" {
        Some(
            file_read(&root.join("durable-revision.json"))?["revision"]
                .as_u64()
                .filter(|r| *r > 0)
                .ok_or("Durable revision missing")?,
        )
    } else {
        None
    };
    let phase = args[3].clone();
    let script = format!(
        "globalThis.__HEINLEIN_NATIVE47__={};",
        serde_json::json!({"phase":phase,"id":identity,"expectedRevision":expected_revision})
    );
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        standalone::standalone_request,
        set_unsaved_changes,
        request_close,
        quit_request_finished
    ];
    let guarded = fixture.clone();
    let app = tauri::Builder::default()
        .manage(BrowserState::default())
        .manage(update::Runtime::default()) // inert idle/close semantics; never acquire/discover managed app
        .invoke_handler(move |invoke| {
            let cmd = invoke.message.command();
            if ![
                "standalone_request",
                "set_unsaved_changes",
                "request_close",
                "quit_request_finished",
            ]
            .contains(&cmd)
            {
                guarded.forbidden.fetch_add(1, Ordering::SeqCst);
                invoke
                    .resolver
                    .reject("Fixture prohibits this native service");
                return true;
            }
            if cmd == "standalone_request" {
                let allowed = match invoke.message.payload() {
                    tauri::ipc::InvokeBody::Json(v) => {
                        if guarded.phase == "picker-preview-only" {
                            super::standalone_picker_acceptance::preview_only_request_allowed(&v["request"])
                        } else { v["request"]["kind"].as_str().is_some_and(|kind| {
                            ["list", "create", "open", "save", "release"].contains(&kind) || (guarded.phase.starts_with("picker") && ["preview", "cancelPreview", "place"].contains(&kind) && (kind != "preview" || v["request"]["destination"] == "file"))
                        }) }
                    }
                    _ => false,
                };
                if !allowed {
                    guarded.forbidden.fetch_add(1, Ordering::SeqCst);
                    invoke
                        .resolver
                        .reject("Fixture prohibits destination/provider operations");
                    return true;
                }
            }
            if guarded.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                stage("first-renderer-IPC");
            }
            if cmd == "request_close" {
                guarded.close_calls.fetch_add(1, Ordering::SeqCst);
                stage("production-request-close-command-received");
            }
            handler(invoke)
        })
        .setup(move |app| {
            for path in [
                app.path().app_config_dir(),
                app.path().app_data_dir(),
                app.path().app_local_data_dir(),
                app.path().app_cache_dir(),
                app.path().app_log_dir(),
                app.path().temp_dir(),
            ] {
                let path = path?;
                if !path.starts_with(&root) {
                    return Err(std::io::Error::other("App path escaped fixture root").into());
                }
                private(&path).map_err(std::io::Error::other)?;
            }
            stage("all-tauri-app-paths-confined-before-webview-or-store");
            if FIXTURE.get().unwrap().phase.starts_with("picker") {
                picker_guard_home(app.handle()).map_err(std::io::Error::other)?;
                stage("immutable-fixture-private-home-resolver-validated-no-env-override");
                app.handle().plugin(tauri_plugin_dialog::init())?;
                stage("native-dialog-plugin-after-confinement-no-JS-dialog-ACL");
            }
            let h = app.handle().clone();
            app.listen("native47-diagnostic", move |event| {
                let parsed = serde_json::from_str::<serde_json::Value>(event.payload());
                let Ok(v) = parsed else {
                    fail(&h, "invalid-renderer-diagnostic");
                    return;
                };
                let Some(name) = v["stage"].as_str() else {
                    fail(&h, "missing-renderer-stage");
                    return;
                };
                let allowed = [
                    "close-handler-entered",
                    "callback-dispatched",
                    "native-save-promise-resolved",
                    "both-gates-ready",
                    "ack-release",
                    "validation-failed",
                    "seed-identity",
                    "production-editor-ready",
                    "production-editor-focused",
                    "editor-revision-queued",
                    "save-IPC-queued",
                    "durable-save-IPC-returned",
                    "native-close-received-before-save-ack",
                    "durable-save-ack-released",
                    "request-close-from-production",
                    "reopened-exact-bytes-same-id",
                    "inert-startup-dependency",
                    "renderer-failed",
                    "picker-cancel-real-null",
                    "picker-preview-real-token",
                    "picker-place-cancel-real-null",
                    "picker-copy-real-receipt",
                    "picker-replay-denied",
                    "picker-reopened-both",
                    "picker-all-evidence-ready",
                ];
                if !allowed.contains(&name) {
                    fail(&h, "unexpected-renderer-stage");
                    return;
                }
                let f = FIXTURE.get().unwrap();
                f.steps.lock().unwrap().push(name.to_string());
                stage(name);
                if name == "production-editor-focused" {
                    let Some(window) = h.get_webview_window("main") else {
                        fail(&h, "owned-window-missing");
                        return;
                    };
                    let visible = window.is_visible().unwrap_or(false);
                    let focused = window.is_focused().unwrap_or(false);
                    println!("{}", serde_json::json!({"kind":"owned-window-observation","label":"main","visible":visible,"focused":focused,"rendererActiveElement":v["activeElement"],"editorHasFocus":v["editorHasFocus"],"documentHasFocus":v["documentHasFocus"]}));
                    let _ = std::io::stdout().flush();
                    if !visible || !focused || v["activeElement"] != true || v["editorHasFocus"] != true || v["documentHasFocus"] != true {
                        fail(&h, "owned-window-or-editor-not-focused");
                        return;
                    }
                    stage("owned-native-window-visible-focused");
                }
                if let Some(hash) = v["textHash"].as_str() {
                    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                        fail(&h, "invalid-text-hash");
                        return;
                    }
                    println!(
                        "{}",
                        serde_json::json!({"kind":"synthetic-text-hash","stage":name,"sha256":hash})
                    );
                    let _ = std::io::stdout().flush();
                }
                if name.starts_with("picker-") && f.phase.starts_with("picker") {
                    if name == "picker-all-evidence-ready" {
                        native_quit();
                    } else {
                        let app = h.clone(); let phase = name.to_string();
                        std::thread::spawn(move || {
                            match super::standalone_picker_acceptance::verify_readback(&app, &phase) {
                                Ok(value) => {
                                    println!("{}", serde_json::json!({"kind":"native-picker-readback","value":value}));
                                    let _ = std::io::stdout().flush();
                                    let _ = app.emit("native47-picker-readback", value);
                                },
                                Err(reason) => fail(&app, &reason),
                            }
                        });
                    }
                }
                if name == "renderer-failed" || name == "validation-failed" {
                    eprintln!(
                        "Synthetic renderer diagnostic: {}",
                        v["detail"].as_str().unwrap_or("unspecified")
                    );
                    fail(&h, "renderer-assertion-failed");
                    return;
                }
                if name=="reopened-exact-bytes-same-id" {
                    println!("{}",serde_json::json!({"kind":"reopen-binding","draftId":v["draftId"],"revision":v["revision"],"textHash":v["textHash"]}));let _=std::io::stdout().flush();
                }
                if name == "durable-save-ack-released" {
                    let Some(revision) = v["revision"].as_u64().filter(|r| *r > 0) else {
                        fail(&h, "missing-durable-revision");
                        return;
                    };
                    if f.phase != "first"
                        || file_create(
                            &f.root.join("durable-revision.json"),
                            &serde_json::json!({"revision":revision}),
                        )
                        .is_err()
                    {
                        fail(&h, "durable-revision-write-failed");
                        return;
                    }
                    println!(
                        "{}",
                        serde_json::json!({"kind":"durable-revision","revision":revision})
                    );
                    let _ = std::io::stdout().flush();
                }
                if name == "seed-identity" {
                    let Some(id) = v["id"].as_str() else {
                        fail(&h, "missing-synthetic-draft-id");
                        return;
                    };
                    if uuid::Uuid::parse_str(id).is_err()
                        || file_create(
                            &f.root.join("draft-identity.json"),
                            &serde_json::json!({"id":id}),
                        )
                        .is_err()
                    {
                        fail(&h, "synthetic-draft-id-write-failed")
                    }
                }
                if name == "save-IPC-queued" || name == "reopened-exact-bytes-same-id" {
                    native_quit();
                }
            });
            let h = app.handle().clone();
            quit_macos::install(move || {
                stage("native-terminate-cancel-deferred-to-production-renderer");
                let window = h
                    .get_webview_window("main")
                    .ok_or("Fixture main unavailable")?;
                window
                    .emit("close-requested", ())
                    .map_err(|_| "Fixture close event failed".into())
            })
            .map_err(std::io::Error::other)?;
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External("about:blank".parse()?),
            )
            .title("DISPOSABLE Heinlein standalone IPC test — synthetic writing only")
            .visible(true)
            .focused(true)
            .incognito(true)
            .initialization_script(&script)
            .on_navigation(|url| {
                let ok = url.as_str() == "about:blank"
                    || (url.scheme() == "tauri" && url.host_str() == Some("localhost"));
                if !ok {
                    FIXTURE
                        .get()
                        .unwrap()
                        .forbidden
                        .fetch_add(1, Ordering::SeqCst);
                }
                ok
            })
            .on_new_window(|_, _| {
                FIXTURE
                    .get()
                    .unwrap()
                    .forbidden
                    .fetch_add(1, Ordering::SeqCst);
                tauri::webview::NewWindowResponse::Deny
            })
            .build()?;
            window.show()?;
            window.set_focus()?;
            if FIXTURE.get().unwrap().phase.starts_with("picker") {
                super::standalone_picker_acceptance::install(&window, picker_root().map_err(std::io::Error::other)?).map_err(std::io::Error::other)?;
            }
            // Dispatcher calls here would reacquire with_webview's window-id mutex.
            let (gate_tx, gate_rx) = std::sync::mpsc::channel();
            let (returned_tx, returned_rx) = std::sync::mpsc::channel();
            let handle = window.clone();
            let main_thread = std::thread::current().id();
            std::thread::spawn(move || {
                if std::thread::current().id() == main_thread {
                    return;
                }
                let result = await_navigation_gate(gate_rx, returned_rx, Duration::from_secs(10));
                let f = FIXTURE.get().unwrap();
                if f.abort.load(Ordering::SeqCst) || f.ended.load(Ordering::SeqCst) {
                    return;
                }
                if let Err(reason) = result {
                    fail(handle.app_handle(), reason);
                    return;
                }
                stage("worker-not-main-navigation-gates-complete");
                if f.abort.load(Ordering::SeqCst) || f.ended.load(Ordering::SeqCst) {
                    return;
                }
                match enqueue_if_active(
                    || f.abort.load(Ordering::SeqCst) || f.ended.load(Ordering::SeqCst),
                    || {
                        handle
                            .navigate("tauri://localhost/index.html".parse().unwrap())
                            .map_err(|_| ())
                    },
                ) {
                    Ok(true) => stage("worker-navigation-enqueued"),
                    Ok(false) => (),
                    Err(reason) => fail(handle.app_handle(), reason),
                }
            });
            let dispatched = window.with_webview(move |webview| {
                let success = nonpersistent(webview.inner());
                if success {
                    stage("own-webkit-isPersistent-false-before-fixture-navigation");
                    stage("callback-gate-passed");
                } else {
                    stage("callback-persistent-store-rejected");
                }
                let _ = gate_tx.send(success);
            });
            stage("with-webview-call-returned");
            let _ = returned_tx.send(dispatched.is_ok());
            Ok(())
        })
        .on_window_event(|window, event| {
            quit::handle_window_close(event, || {
                let _ = window.emit("close-requested", ());
            })
        })
        .build(context)
        .map_err(|_| "Fixture native construction failed")?;
    let h = app.handle().clone();
    let f = fixture.clone();
    std::thread::spawn(move || {
        for _ in 0..600 {
            std::thread::sleep(Duration::from_millis(100));
            if f.ended.load(Ordering::SeqCst) {
                return;
            }
            if f.phase.starts_with("picker") {
                if let Some(reason) = super::standalone_picker_acceptance::failure() {
                    fail(&h, reason);
                    return;
                }
            }
        }
        fail(&h, "stage-timeout-cooperative-abort");
    });
    let h = app.handle().clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if line.trim() == "abort" {
                fail(&h, "operator-cooperative-abort");
                break;
            }
        }
    });
    let mut approved = 0;
    let code=app.run_return(move|app,event|{
        if fixture.abort.load(Ordering::SeqCst){if matches!(event,tauri::RunEvent::Exit){fixture.ended.store(true,Ordering::SeqCst);}return;}
        let exit_code=if let tauri::RunEvent::ExitRequested{code,..}=&event {Some(*code)}else{None};
        let exiting=matches!(event,tauri::RunEvent::Exit);
        handle_run_event(app,event);
        if let Some(code)=exit_code {
            if app.state::<BrowserState>().quitting.load(Ordering::SeqCst){assert_eq!(code,Some(0));approved+=1;stage("production-exit-guards-approved-Some0");}
        }
        if exiting{
            fixture.ended.store(true,Ordering::SeqCst);
            let steps=fixture.steps.lock().unwrap();
            let complete=approved==1&&fixture.close_calls.load(Ordering::SeqCst)==1&&fixture.forbidden.load(Ordering::SeqCst)==0&&steps.iter().any(|s|s=="request-close-from-production")&&if fixture.phase.starts_with("picker"){super::standalone_picker_acceptance::passed(&fixture.phase)}else if fixture.phase=="first"{steps.iter().any(|s|s=="native-close-received-before-save-ack")&&steps.iter().any(|s|s=="durable-save-ack-released")}else{steps.iter().any(|s|s=="reopened-exact-bytes-same-id")};
            println!("{}",serde_json::json!({"kind":"result","passed":complete,"phase":fixture.phase,"approvedProgrammaticExits":approved,"nativeTerminateCounters":quit_macos::counters(),"realIPCCommandCount":fixture.calls.load(Ordering::SeqCst),"forbiddenServiceAttempts":fixture.forbidden.load(Ordering::SeqCst),"osStoreProviderConstructorsReachable":false,"managedRuntimeAcquire":false,"physicalKeyboard":false,"picker":super::standalone_picker_acceptance::summary(),"steps":*steps}));
            let _=std::io::stdout().flush();
        }
    });
    if code != 0 {
        std::process::exit(code)
    }
    Ok(())
}

#[cfg(test)]
mod isolation_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn navigation_queue_failure_and_terminal_stop_are_not_success() {
        let called = std::cell::Cell::new(false);
        assert_eq!(
            enqueue_if_active(
                || true,
                || {
                    called.set(true);
                    Ok(())
                }
            ),
            Ok(false)
        );
        assert!(!called.get());
        assert_eq!(
            enqueue_if_active(|| false, || Err(())),
            Err("worker-navigation-enqueue-failed")
        );
        assert_eq!(enqueue_if_active(|| false, || Ok(())), Ok(true));
    }
    #[test]
    fn navigation_requires_both_successes_and_fails_closed() {
        for (gate, returned, pass) in [
            (Some(true), Some(true), true),
            (Some(false), Some(true), false),
            (Some(true), Some(false), false),
            (None, Some(true), false),
            (Some(true), None, false),
        ] {
            let (g_tx, g_rx) = std::sync::mpsc::channel();
            let (r_tx, r_rx) = std::sync::mpsc::channel();
            if let Some(value) = gate {
                g_tx.send(value).unwrap();
            }
            drop(g_tx);
            if let Some(value) = returned {
                r_tx.send(value).unwrap();
            }
            drop(r_tx);
            assert_eq!(
                await_navigation_gate(g_rx, r_rx, Duration::from_millis(5)).is_ok(),
                pass
            );
        }
        let (_g_tx, g_rx) = std::sync::mpsc::channel();
        let (_r_tx, r_rx) = std::sync::mpsc::channel();
        assert!(await_navigation_gate(g_rx, r_rx, Duration::from_millis(5)).is_err());
    }
    #[test]
    fn root_and_sentinel_refuse_aliases_and_shared_permissions() {
        let root = tempfile::tempdir_in("/private/tmp").unwrap();
        let path = root.path();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(private(path).is_ok());
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(private(path).is_err());
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let alias = path.join("alias");
        symlink(path, &alias).unwrap();
        assert!(private(&alias).is_err());
        let sentinel = path.join("sentinel");
        let value = serde_json::json!({"schema":1,"uuid":uuid::Uuid::new_v4()});
        file_create(&sentinel, &value).unwrap();
        assert_eq!(file_read(&sentinel).unwrap(), value);
        assert!(file_create(&sentinel, &value).is_err());
        let linked = path.join("linked");
        symlink(&sentinel, &linked).unwrap();
        assert!(file_read(&linked).is_err());
        let hardlink = path.join("hardlink");
        std::fs::hard_link(&sentinel, &hardlink).unwrap();
        assert!(file_read(&sentinel).is_err());
    }
    #[test]
    fn sentinel_refuses_shared_or_oversized_file() {
        let root = tempfile::tempdir_in("/private/tmp").unwrap();
        let path = root.path().join("sentinel");
        file_create(&path, &serde_json::json!({"schema":1})).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(file_read(&path).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&path, vec![b' '; 4097]).unwrap();
        assert!(file_read(&path).is_err());
    }
}
