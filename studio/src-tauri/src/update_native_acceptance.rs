//! Compile-only Updates native acceptance, isolated synthetic state and inert services.
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
fn file_read(path: &Path) -> Result<serde_json::Value, String> {
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
fn file_create(path: &Path, value: &serde_json::Value) -> Result<(), String> {
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
pub(super) fn run() {
    if let Err(error) = run_fixture() {
        eprintln!("Synthetic Updates fixture: {error}");
        std::process::exit(73);
    }
}
fn run_fixture() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--update-native-acceptance" {
        return Err("Explicit fixture/root required".into());
    }
    let root = PathBuf::from(&args[2]);
    private(&root)?;
    if root.parent() != Some(Path::new("/private/tmp"))
        || std::env::temp_dir().canonicalize().ok() != Some(root.clone())
    {
        return Err("Canonical private TMPDIR required".into());
    }
    let uuid = root
        .file_name()
        .and_then(|p| p.to_str())
        .and_then(|p| p.strip_prefix("heinlein-native-updates-"))
        .and_then(|p| uuid::Uuid::parse_str(p).ok())
        .ok_or("Fresh UUID root required")?;
    if std::fs::read_dir(&root)
        .map_err(|_| "Fixture root unavailable")?
        .next()
        .is_some()
    {
        return Err("Fresh empty root required".into());
    }
    file_create(
        &root.join("fixture-sentinel.json"),
        &serde_json::json!({"schema":1,"uuid":uuid.to_string()}),
    )?;
    let sentinel = file_read(&root.join("fixture-sentinel.json"))?;
    if sentinel["uuid"] != uuid.to_string() {
        return Err("Sentinel mismatch".into());
    }
    let app_root = root.join("app-data");
    for p in [&app_root, &app_root.join("caches"), &app_root.join("logs")] {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(p)
            .map_err(|_| "Private fixture directory creation")?;
        private(p)?;
    }
    let fixture = Arc::new(Fixture {
        root: root.clone(),
        phase: "updates".into(),
        steps: Mutex::new(Vec::new()),
        forbidden: AtomicU64::new(0),
        calls: AtomicU64::new(0),
        close_calls: AtomicU64::new(0),
        abort: AtomicBool::new(false),
        ended: AtomicBool::new(false),
    });
    FIXTURE
        .set(fixture.clone())
        .map_err(|_| "Fixture initialized twice")?;
    stage("feature-explicit-invocation-private-root-sentinel-validated");
    let mut context =
        tauri::generate_context!("../macos/tests/native-update-probe/tauri.conf.json");
    context.config_mut().identifier =
        format!("me.thearcades.heinlein.synthetic-updates-{}", uuid.simple());
    context.config_mut().app.app_directories_override =
        Some(AppDirectoriesOverride::Root(app_root.clone()));
    let backend = Arc::new(super::update_native_script::Script::default());
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        standalone::standalone_request,
        set_unsaved_changes,
        request_close,
        quit_request_finished,
        update::update_request
    ];
    let guard = fixture.clone();
    let setup_backend = backend.clone();
    let app=tauri::Builder::default().manage(BrowserState::default()).manage(update::Runtime::synthetic(backend.clone()))
    .invoke_handler(move|invoke|{
        let cmd=invoke.message.command();
        if !["standalone_request","set_unsaved_changes","request_close","quit_request_finished","update_request"].contains(&cmd){guard.forbidden.fetch_add(1,Ordering::SeqCst);invoke.resolver.reject("Forbidden fixture command");return true;}
        if cmd=="standalone_request" { let value=match invoke.message.payload(){tauri::ipc::InvokeBody::Json(value)=>value,_=>{invoke.resolver.reject("JSON only");return true;}};
            let kind=value["request"]["kind"].as_str().unwrap_or("");
            if !["list","create","open","save","release"].contains(&kind){guard.forbidden.fetch_add(1,Ordering::SeqCst);invoke.resolver.reject("Forbidden standalone operation");return true;}
        }
        if guard.calls.fetch_add(1,Ordering::SeqCst)==0 {stage("first-renderer-IPC");}
        if cmd=="request_close" {guard.close_calls.fetch_add(1,Ordering::SeqCst);stage("production-request-close-command-received");}
        handler(invoke)
    })
    .setup(move|app|{
        for path in [app.path().app_config_dir()?,app.path().app_data_dir()?,app.path().app_local_data_dir()?,app.path().app_cache_dir()?,app.path().app_log_dir()?,app.path().temp_dir()?] {
            if !path.starts_with(&root){return Err(std::io::Error::other("App path escaped fixture root").into());}
            if path.exists(){private(&path).map_err(std::io::Error::other)?;}
        }
        stage("all-tauri-app-paths-confined-before-webview-or-store");
        setup_backend.attach(app.handle().clone());
        let h=app.handle().clone();let control=setup_backend.clone();let native_requests=Arc::new(AtomicU64::new(0));
        app.listen("native42-control",move|event|{
            let Ok(v)=serde_json::from_str::<serde_json::Value>(event.payload()) else{fail(&h,"invalid-control");return;};
            match v["action"].as_str(){
                Some("release-check")=>{if control.release(v["index"].as_u64().unwrap_or(0)).is_err(){fail(&h,"invalid-release");}},
                Some("native-quit")=>{if native_requests.fetch_add(1,Ordering::SeqCst)!=0 {fail(&h,"duplicate-native-quit");}else{native_quit();}},
                _=>fail(&h,"unknown-control"),
            }
        });
        let h=app.handle().clone();
        app.listen("native42-diagnostic",move|event|{
            let Ok(v)=serde_json::from_str::<serde_json::Value>(event.payload()) else{fail(&h,"invalid-diagnostic");return;};
            let Some(name)=v["stage"].as_str() else{fail(&h,"missing-stage");return;};
            let allowed=["fixture-editor-focused","updates-initial-status","check-busy-duplicate-suppressed","quit-refused-during-check","check-failed-visible","explicit-retry-available","deferred-writing-retained","late-response-ignored","in-memory-scheduled","stale-save-failure-preserved","save-quit-held-for-genuine-ack","genuine-save-ack-released","production-request-close","renderer-failed"];
            if !allowed.contains(&name){fail(&h,"unexpected-renderer-stage");return;}
            FIXTURE.get().unwrap().steps.lock().unwrap().push(name.to_string());stage(name);
            if name=="renderer-failed"{eprintln!("Fixture failure: {}",v["detail"].as_str().unwrap_or("unknown"));fail(&h,"renderer-failed-cooperative-abort");return;}
            if name=="fixture-editor-focused" {
                let Some(w)=h.get_webview_window("main") else{fail(&h,"own-window-missing");return;};
                let visible=w.is_visible().unwrap_or(false);let focused=w.is_focused().unwrap_or(false);
                println!("{}",serde_json::json!({"kind":"owned-window-observation","visible":visible,"focused":focused,"editorHasFocus":v["editorHasFocus"],"activeElement":v["activeElement"]}));
                if !visible||!focused||v["editorHasFocus"]!=true||v["activeElement"]!=true{fail(&h,"own-window-editor-focus-failed");}
            }
        });
        let h=app.handle().clone();quit_macos::install(move||h.get_webview_window("main").ok_or("Fixture window absent")?.emit("close-requested",()).map_err(|_|"Fixture close delivery failed".into())).map_err(std::io::Error::other)?;
        let window=WebviewWindowBuilder::new(app,"main",WebviewUrl::External("about:blank".parse()?)).title("DISPOSABLE Heinlein Updates test — synthetic writing only").incognito(true).visible(true).focused(true)
          .on_navigation(|url|{let ok=url.as_str()=="about:blank"||(url.scheme()=="tauri"&&url.host_str()==Some("localhost"));if !ok{FIXTURE.get().unwrap().forbidden.fetch_add(1,Ordering::SeqCst);}ok})
          .on_new_window(|_,_|{FIXTURE.get().unwrap().forbidden.fetch_add(1,Ordering::SeqCst);tauri::webview::NewWindowResponse::Deny}).build()?;
        window.show()?;window.set_focus()?;
        let (gate_tx,gate_rx)=std::sync::mpsc::channel();let (returned_tx,returned_rx)=std::sync::mpsc::channel();let handle=window.clone();let main=std::thread::current().id();
        std::thread::spawn(move||{
            if std::thread::current().id()==main{return;}
            let result=await_navigation_gate(gate_rx,returned_rx,Duration::from_secs(10));let f=FIXTURE.get().unwrap();
            if f.abort.load(Ordering::SeqCst)||f.ended.load(Ordering::SeqCst){return;}
            if let Err(reason)=result{fail(handle.app_handle(),reason);return;}
            stage("worker-not-main-navigation-gates-complete");
            match enqueue_if_active(||f.abort.load(Ordering::SeqCst)||f.ended.load(Ordering::SeqCst),||handle.navigate("tauri://localhost/index.html".parse().unwrap()).map_err(|_|())){Ok(true)=>stage("worker-navigation-enqueued"),Ok(false)=>(),Err(reason)=>fail(handle.app_handle(),reason)}
        });
        let dispatched=window.with_webview(move|webview|{let success=nonpersistent(webview.inner());if success{stage("own-webkit-isPersistent-false-before-fixture-navigation");stage("callback-gate-passed");}let _=gate_tx.send(success);});
        stage("with-webview-call-returned");let _=returned_tx.send(dispatched.is_ok());Ok(())
    })
    .on_window_event(|window,event|quit::handle_window_close(event,||{let _=window.emit("close-requested",());}))
    .build(context).map_err(|_|"Fixture native construction failed")?;
    let h = app.handle().clone();
    let f = fixture.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(55));
        if !f.ended.load(Ordering::SeqCst) {
            fail(&h, "stage-timeout-cooperative-abort");
        }
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
        let exit=if let tauri::RunEvent::ExitRequested{code,..}=&event{Some(*code)}else{None};let exiting=matches!(event,tauri::RunEvent::Exit);handle_run_event(app,event);
        if let Some(code)=exit{if app.state::<BrowserState>().quitting.load(Ordering::SeqCst){assert_eq!(code,Some(0));approved+=1;stage("production-exit-guards-approved-Some0");}}
        if exiting{
            fixture.ended.store(true,Ordering::SeqCst);let steps=fixture.steps.lock().unwrap();
            let required=["fixture-editor-focused","updates-initial-status","check-busy-duplicate-suppressed","quit-refused-during-check","check-failed-visible","explicit-retry-available","deferred-writing-retained","late-response-ignored","in-memory-scheduled","stale-save-failure-preserved","save-quit-held-for-genuine-ack","genuine-save-ack-released","production-request-close"];
            let summary=backend.summary();let expected=serde_json::json!(["status","check","check","status","check","status","schedule"]);
            let complete=approved==1&&fixture.close_calls.load(Ordering::SeqCst)==2&&fixture.forbidden.load(Ordering::SeqCst)==0&&required.iter().all(|s|steps.iter().any(|v|v==s))&&summary["calls"]==expected;
            println!("{}",serde_json::json!({"kind":"result","passed":complete,"approvedProgrammaticExits":approved,"closeCommands":fixture.close_calls.load(Ordering::SeqCst),"realIPCCommandCount":fixture.calls.load(Ordering::SeqCst),"forbiddenServiceAttempts":fixture.forbidden.load(Ordering::SeqCst),"managedRuntimeAcquire":false,"osStoreProviderConstructorsReachable":false,"nativeTerminateCounters":quit_macos::counters(),"backend":summary,"steps":*steps}));let _=std::io::stdout().flush();
        }
    });
    if code != 0 {
        std::process::exit(code);
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
