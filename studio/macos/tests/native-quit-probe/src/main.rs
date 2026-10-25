//! Explicitly executed disposable Wry/AppKit app, never part of Studio startup.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../../../../src-tauri/src/mutation_gate.rs"]
mod mutation_gate;
#[cfg(target_os = "macos")]
#[path = "../../../../src-tauri/src/quit.rs"]
mod quit;
#[cfg(target_os = "macos")]
#[path = "../../../../src-tauri/src/quit_macos.rs"]
mod quit_macos;
#[cfg(target_os = "macos")]
mod native {
    use super::{mutation_gate::MutationGate, quit, quit_macos};
    use github_workspace::{
        api::Provider,
        auth::{Auth, Credential, DeviceCode, Poll, SecretStore, TokenSet, User},
        registry::{PullRequest, StateDir},
        Error, RepoInfo, Result,
    };
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc, Mutex,
        },
    };
    #[derive(Default)]
    struct Memory {
        value: Mutex<Option<Vec<u8>>>,
        deny: AtomicBool,
    }
    impl SecretStore for Memory {
        fn load(&self) -> Result<Option<Vec<u8>>> {
            Ok(self.value.lock().unwrap().clone())
        }
        fn save(&self, v: &[u8]) -> Result<()> {
            if self.deny.load(Ordering::SeqCst) {
                return Err(Error::StoreDenied);
            }
            *self.value.lock().unwrap() = Some(v.to_vec());
            Ok(())
        }
        fn clear(&self) -> Result<()> {
            panic!("synthetic quit never deletes credentials")
        }
    }
    struct Api;
    impl Provider for Api {
        fn device_start(&self, _: &str) -> Result<DeviceCode> {
            Ok(DeviceCode {
                device_code: "synthetic".into(),
                user_code: "SYNTHETIC".into(),
                verification_uri: "https://github.com/login/device".into(),
                expires_in: 900,
                interval: 5,
            })
        }
        fn device_poll(&self, _: &str, _: &str) -> Result<Poll> {
            Ok(Poll::Authorized(TokenSet {
                access_token: "memory-only-before".into(),
                refresh_token: Some("memory-only-refresh".into()),
                expires_in: 3600,
                refresh_expires_in: 10000,
            }))
        }
        fn user(&self, _: &Credential) -> Result<User> {
            Ok(User {
                id: 9,
                login: "synthetic-only".into(),
            })
        }
        fn refresh(&self, _: &str, _: &str) -> Result<TokenSet> {
            Ok(TokenSet {
                access_token: "memory-only-after".into(),
                refresh_token: Some("memory-only-next".into()),
                expires_in: 3600,
                refresh_expires_in: 10000,
            })
        }
        fn repository(&self, _: &Credential, _: &str, _: &str) -> Result<RepoInfo> {
            Err(Error::Unsupported)
        }
        fn repository_by_id(&self, _: &Credential, _: u64) -> Result<RepoInfo> {
            Err(Error::Unsupported)
        }
        fn head(&self, _: &Credential, _: &RepoInfo, _: &str) -> Result<Option<String>> {
            Err(Error::Unsupported)
        }
        fn pulls(
            &self,
            _: &Credential,
            _: &RepoInfo,
            _: &str,
            _: &str,
        ) -> Result<Vec<(PullRequest, String)>> {
            Err(Error::Unsupported)
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
            Err(Error::Unsupported)
        }
    }
    struct Save {
        release: mpsc::Sender<()>,
        thread: std::thread::JoinHandle<()>,
    }
    fn save(gate: &Arc<MutationGate>) -> Save {
        let gate = gate.clone();
        let (ready, wait) = mpsc::channel();
        let (release, finish) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let _save = gate.edit().unwrap();
            ready.send(()).unwrap();
            finish.recv().unwrap();
        });
        wait.recv().unwrap();
        Save { release, thread }
    }
    fn finish(save: &mut Option<Save>) {
        if let Some(s) = save.take() {
            s.release.send(()).unwrap();
            s.thread.join().unwrap();
        }
    }
    fn ready(auth: &Auth, gate: &MutationGate) -> std::result::Result<(), String> {
        let _save = gate.close_guard()?;
        auth.ready_to_quit().map_err(|e| e.to_string())
    }

    fn progress(stage: &str) {
        use std::io::Write;
        println!("{}", serde_json::json!({"kind":"progress","stage":stage}));
        let _ = std::io::stdout().flush();
    }
    static ACTION_FAILED: AtomicBool = AtomicBool::new(false);
    fn schedule_native(action: usize) {
        use std::ffi::c_void;
        #[link(name = "System")]
        extern "C" {
            static _dispatch_main_q: c_void;
            fn dispatch_async_f(
                queue: *mut c_void,
                context: *mut c_void,
                work: extern "C" fn(*mut c_void),
            );
        }
        extern "C" fn perform(context: *mut c_void) {
            let result = std::panic::catch_unwind(|| {
                progress("native-action-dispatched-after-callback");
                let action = context as usize;
                let ok = match action {
                    0 => menu_quit() && menu_quit() && direct_quit(),
                    1 => direct_quit(),
                    _ => menu_quit(),
                };
                if !ok {
                    ACTION_FAILED.store(true, Ordering::SeqCst);
                }
                progress("native-action-returned");
            });
            if result.is_err() {
                ACTION_FAILED.store(true, Ordering::SeqCst);
                progress("native-action-failed");
            }
        }
        unsafe {
            dispatch_async_f(
                std::ptr::addr_of!(_dispatch_main_q).cast_mut(),
                action as *mut c_void,
                perform,
            )
        }
    }
    mod objc {
        use std::ffi::{c_char, c_void};
        pub type Object = *mut c_void;
        #[link(name = "objc")]
        extern "C" {
            pub fn objc_getClass(n: *const c_char) -> Object;
            pub fn sel_registerName(n: *const c_char) -> Object;
            pub fn objc_msgSend();
        }
        pub unsafe fn id(object: Object, selector: &std::ffi::CStr) -> Object {
            let f: unsafe extern "C" fn(Object, Object) -> Object =
                std::mem::transmute(objc_msgSend as *const ());
            f(object, sel_registerName(selector.as_ptr()))
        }
        pub unsafe fn app() -> Object {
            id(
                objc_getClass(c"NSApplication".as_ptr()),
                c"sharedApplication",
            )
        }
    }
    fn direct_quit() -> bool {
        unsafe {
            use objc::*;
            let app = app();
            if app.is_null() {
                return false;
            }
            let f: unsafe extern "C" fn(Object, Object, Object) =
                std::mem::transmute(objc_msgSend as *const ());
            f(
                app,
                sel_registerName(c"terminate:".as_ptr()),
                std::ptr::null_mut(),
            );
            true
        }
    }
    fn menu_quit() -> bool {
        unsafe fn activate(menu: objc::Object, depth: u8) -> bool {
            use objc::*;
            if menu.is_null() || depth > 4 {
                return false;
            }
            let count: unsafe extern "C" fn(Object, Object) -> isize =
                std::mem::transmute(objc_msgSend as *const ());
            let n = count(menu, sel_registerName(c"numberOfItems".as_ptr()));
            if !(0..100).contains(&n) {
                return false;
            }
            let item: unsafe extern "C" fn(Object, Object, isize) -> Object =
                std::mem::transmute(objc_msgSend as *const ());
            for index in 0..n {
                let entry = item(menu, sel_registerName(c"itemAtIndex:".as_ptr()), index);
                if id(entry, c"action") == sel_registerName(c"terminate:".as_ptr()) {
                    let perform: unsafe extern "C" fn(Object, Object, isize) =
                        std::mem::transmute(objc_msgSend as *const ());
                    perform(
                        menu,
                        sel_registerName(c"performActionForItemAtIndex:".as_ptr()),
                        index,
                    );
                    return true;
                }
                if activate(id(entry, c"submenu"), depth + 1) {
                    return true;
                }
            }
            false
        }
        unsafe { activate(objc::id(objc::app(), c"mainMenu"), 0) }
    }
    pub fn run() {
        progress("preflight");
        let args: Vec<String> = std::env::args().collect();
        assert_eq!(args.len(), 2, "Pass fresh canonical synthetic root");
        let root = PathBuf::from(&args[1]);
        assert!(
            root.is_absolute()
                && root.canonicalize().ok() == Some(root.clone())
                && root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("heinlein-native-quit-")
        );
        use std::os::unix::fs::MetadataExt;
        let meta = root.metadata().unwrap();
        unsafe {
            extern "C" {
                fn getuid() -> u32;
            }
            assert_eq!(meta.uid(), getuid())
        }
        assert_eq!(meta.mode() & 0o077, 0);
        let store = Arc::new(Memory::default());
        let auth = Auth::new(
            "synthetic-only-client".into(),
            store.clone(),
            StateDir::open(&root.join("memory-auth")).unwrap(),
        )
        .unwrap();
        auth.begin(&Api, 1000).unwrap();
        auth.poll(&Api, 1005).unwrap();
        auth.confirm(9).unwrap();
        store.deny.store(true, Ordering::SeqCst);
        assert!(matches!(
            auth.credential(&Api, 4590),
            Err(Error::RotationNotSaved(_))
        ));
        let original = store.value.lock().unwrap().clone();
        let gate = Arc::new(MutationGate::default());
        let permission = quit::Gate::default();
        let requested = Arc::new(AtomicBool::new(false));
        let receiver = requested.clone();
        let mut phase = 0;
        let mut scheduled = true;
        let mut seen = Vec::new();
        let mut allowed = false;
        let mut approved_exits = 0;
        progress("building-disposable-app");
        let app = tauri::Builder::default()
            .menu(tauri::menu::Menu::default)
            .on_window_event(|_, event| quit::handle_window_close(event, || {}))
            .setup(move |app| {
                let request = receiver.clone();
                let handle = app.handle().clone();
                quit_macos::install(move || {
                    let (entries, returns, _, errors) = quit_macos::counters();
                    assert_eq!(entries, returns);
                    assert_eq!(errors, 0);
                    progress("should-terminate-entered-and-returned-cancel");
                    request.store(true, Ordering::SeqCst);
                    progress("deferred-author-request-received");
                    let handle = handle.clone();
                    std::thread::spawn(move || {
                        let _ = handle.run_on_main_thread(|| {});
                    });
                    Ok(())
                })
                .map_err(std::io::Error::other)?;
                // Registration is idempotent; must not replace the retained callback.
                quit_macos::install(|| Err("unexpected callback replacement".into()))
                    .map_err(std::io::Error::other)?;
                tauri::WebviewWindowBuilder::new(
                    app,
                    "synthetic-quit-only",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Heinlein synthetic Quit test — no writing or real accounts")
                .incognito(true)
                .build()?;
                progress("native-adapter-and-window-ready");
                Ok(())
            })
            .build(tauri::generate_context!())
            .unwrap();
        let abort = Arc::new(AtomicBool::new(false));
        let ended = Arc::new(AtomicBool::new(false));
        let flag = abort.clone();
        let done = ended.clone();
        let h = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(30));
            if !done.load(Ordering::SeqCst) {
                progress("timeout-orderly-test-abort-requested");
                flag.store(true, Ordering::SeqCst);
                h.exit(73);
            }
        });
        let flag = abort.clone();
        let h = app.handle().clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::stdin()
                .lock()
                .lines()
                .map_while(std::result::Result::ok)
            {
                if line.trim() == "abort" {
                    progress("operator-orderly-test-abort-requested");
                    flag.store(true, Ordering::SeqCst);
                    h.exit(73);
                    break;
                }
            }
        });
        let code = app.run_return(move |app, event| {
            if abort.load(Ordering::SeqCst) {
                if matches!(event, tauri::RunEvent::Exit) {
                    ended.store(true, Ordering::SeqCst);
                    println!("{}", serde_json::json!({"nativeQuitPassed":false,"aborted":true,"stage":"orderly-test-abort"}));
                }
                return;
            }
            if matches!(event, tauri::RunEvent::Ready) {
                progress("event-loop-ready");
            }
            let activity = gate.activity();
            let decision = quit::handle(&event, &permission, activity, || {
                let _exclusive = gate.close_guard()?;
                auth.ready_to_quit().map_err(|e| e.to_string())?;
                if gate.activity() != activity {
                    return Err("new work".into());
                }
                gate.seal_for_exit();
                Ok(())
            }, |_| {});
            if let Some(exit) = decision {
                if let tauri::RunEvent::ExitRequested { code, .. } = &event {
                    assert_eq!(*code, Some(0));
                }
                if exit {
                    assert_eq!(phase, 5);
                    approved_exits += 1;
                    allowed = true;
                    assert!(gate.edit().is_err());
                    seen.push("fresh-grant-revalidated-quiesced-normal-exit");
                    progress("final-one-shot-consumed-and-exit-approved");
                } else {
                    match phase {
                        2 => {
                            assert!(!quit::consume(&permission, gate.activity(), || Ok(())).0);
                            seen.push("settled-new-save-invalidated-and-consumed-grant");
                            quit_macos::finished();
                            phase = 3;
                            app.exit(0);
                        }
                        3 => {
                            seen.push("consumed-grant-not-reused");
                            quit_macos::finished();
                            phase = 4;
                            scheduled = true;
                        }
                        _ => panic!("unexpected programmatic refusal"),
                    }
                }
            }
            if requested.swap(false, Ordering::SeqCst) {
                assert!(!ACTION_FAILED.load(Ordering::SeqCst));
                match phase {
                    0 => {
                        assert_eq!(quit_macos::counters(), (3, 3, 1, 0));
                        assert!(quit::authorize(&permission, gate.activity(), || ready(&auth, &gate)).is_err());
                        assert_eq!(*store.value.lock().unwrap(), original);
                        seen.push("native-menu-and-direct-terminate-cancel-coalesced");
                        seen.push("pending-rotation-preserved-and-author-cancel-reset");
                        quit::cancel(&permission);
                        quit_macos::finished();
                        progress("pending-rotation-refused-author-cancelled");
                        phase = 1;
                        scheduled = true;
                    }
                    1 => {
                        store.deny.store(false, Ordering::SeqCst);
                        auth.retry_saved().unwrap();
                        seen.push("explicit-memory-credential-retry-succeeded");
                        let mut save_work = Some(save(&gate));
                        assert!(quit::authorize(&permission, gate.activity(), || ready(&auth, &gate)).is_err());
                        seen.push("native-quit-refused-active-save");
                        finish(&mut save_work);
                        quit_macos::finished();
                        progress("explicit-retry-succeeded-active-save-refused");
                        phase = 2;
                        scheduled = true;
                    }
                    2 => {
                        quit::authorize(&permission, gate.activity(), || ready(&auth, &gate)).unwrap();
                        let mut save_work = Some(save(&gate));
                        finish(&mut save_work);
                        progress("new-work-after-author-grant");
                        app.exit(0);
                    }
                    4 => {
                        quit::authorize(&permission, gate.activity(), || ready(&auth, &gate)).unwrap();
                        phase = 5;
                        app.exit(0);
                    }
                    _ => panic!("duplicate or unexpected author request"),
                }
            }
            if matches!(event, tauri::RunEvent::Ready | tauri::RunEvent::MainEventsCleared) && scheduled {
                scheduled = false;
                schedule_native(if phase == 0 { 0 } else if phase == 1 || phase == 4 { 1 } else { 2 });
            }
            if matches!(event, tauri::RunEvent::Exit) {
                ended.store(true, Ordering::SeqCst);
                assert!(allowed);
                assert_eq!(approved_exits, 1);
                assert_eq!(seen.len(), 7);
                let counts = quit_macos::counters();
                assert_eq!(counts.0, counts.1);
                assert_eq!(counts.3, 0);
                println!("{}", serde_json::json!({"nativeQuitPassed":true,"nativeMenuAndDirectTerminate":true,"shouldTerminateAlwaysCancelled":true,"deferredAuthorRequests":counts.2,"nativeAttempts":counts.0,"approvedProgrammaticExits":approved_exits,"checks":seen,"physicalKeyboard":false,"osStoreUsed":false,"networkUsed":false,"appId":"me.thearcades.heinlein.synthetic-quit"}));
            }
        });
        if code != 0 {
            std::process::exit(code)
        }
    }
}
fn main() {
    #[cfg(target_os = "macos")]
    native::run();
    #[cfg(not(target_os = "macos"))]
    println!("native-quit-probe is macOS-only; no execution");
}
