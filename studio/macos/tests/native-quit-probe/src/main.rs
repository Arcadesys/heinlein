//! Explicitly executed disposable Wry/AppKit app, never part of Studio startup.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../../../../src-tauri/src/mutation_gate.rs"]
mod mutation_gate;
#[cfg(target_os = "macos")]
#[path = "../../../../src-tauri/src/quit.rs"]
mod quit;
#[cfg(target_os = "macos")]
mod native {
    use super::{mutation_gate::MutationGate, quit};
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
    // Dispatch only this process's standard native Quit action. No AX access,
    // remote app messages, input injection or termination signal is involved.
    fn native_quit() {
        use std::ffi::{c_char, c_void};
        #[link(name = "objc")]
        extern "C" {
            fn objc_getClass(n: *const c_char) -> *mut c_void;
            fn sel_registerName(n: *const c_char) -> *mut c_void;
            fn objc_msgSend();
        }
        unsafe {
            let app: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
                std::mem::transmute(objc_msgSend as *const ());
            let app = app(
                objc_getClass(c"NSApplication".as_ptr()),
                sel_registerName(c"sharedApplication".as_ptr()),
            );
            let send: unsafe extern "C" fn(
                *mut c_void,
                *mut c_void,
                *mut c_void,
                *mut c_void,
                *mut c_void,
            ) -> bool = std::mem::transmute(objc_msgSend as *const ());
            assert!(send(
                app,
                sel_registerName(c"sendAction:to:from:".as_ptr()),
                sel_registerName(c"terminate:".as_ptr()),
                app,
                std::ptr::null_mut()
            ));
        }
    }
    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        assert_eq!(
            args.len(),
            2,
            "Pass the fresh canonical synthetic fixture root only"
        );
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
        assert_eq!(meta.uid(), rustix_uid());
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
            Err(Error::RotationNotSaved)
        ));
        let gate = Arc::new(MutationGate::default());
        let permission = AtomicBool::new(false);
        let mut save_work = None;
        let mut phase = 0;
        let mut pending = true;
        let mut seen = Vec::new();
        let mut allowed = false;
        let app = tauri::Builder::default()
            .menu(tauri::menu::Menu::default)
            .on_window_event(|_, event| quit::handle_window_close(event, || {}))
            .setup(|app| {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "synthetic-quit-only",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Heinlein synthetic Quit test — no writing or real accounts")
                .incognito(true)
                .build()?;
                Ok(())
            })
            .build(tauri::generate_context!())
            .unwrap();
        let code=app.run_return(move|_app,event|{
            if let tauri::RunEvent::ExitRequested{code,..}=&event {assert!(code.is_none(),"Expected own native menu action, not AppHandle.exit");}
            let decision=quit::handle(&event,&permission,||ready(&auth,&gate),||{});
            if let Some(exit)=decision {
                if exit{assert_eq!(phase,5);allowed=true;seen.push("normal_native_exit_permitted_after_fresh_grant");}
                else {
                    match phase {
                        0=>{assert!(quit::authorize(&permission,||ready(&auth,&gate)).is_err());seen.push("pending_rotation_refused");store.deny.store(false,Ordering::SeqCst);auth.retry_saved().unwrap();seen.push("explicit_retry_saved");save_work=Some(save(&gate));},
                        1=>{assert!(quit::authorize(&permission,||ready(&auth,&gate)).is_err());seen.push("inflight_save_refused");finish(&mut save_work);quit::authorize(&permission,||ready(&auth,&gate)).unwrap();save_work=Some(save(&gate));},
                        2=>{assert!(!permission.load(Ordering::SeqCst));seen.push("new_save_recheck_consumed_grant");finish(&mut save_work);},
                        3=>{assert!(!permission.load(Ordering::SeqCst));seen.push("consumed_grant_not_reused");quit::authorize(&permission,||ready(&auth,&gate)).unwrap();},
                        _=>panic!("unexpected refusal"),
                    }
                    phase+=1;if phase==4{phase=5;}pending=true;
                }
            }
            if matches!(event,tauri::RunEvent::Ready|tauri::RunEvent::MainEventsCleared)&&pending {pending=false;native_quit();}
            if matches!(event,tauri::RunEvent::Exit){assert!(allowed);assert_eq!(seen.len(),6);println!("{}",serde_json::json!({"nativeQuitPassed":true,"nativeUserExitCodeNone":true,"checks":seen,"physicalKeyboard":false,"osStoreUsed":false,"networkUsed":false,"appId":"me.thearcades.heinlein.synthetic-quit"}));}
        });
        assert_eq!(code, 0);
    }
    fn rustix_uid() -> u32 {
        unsafe {
            extern "C" {
                fn getuid() -> u32;
            }
            getuid()
        }
    }
}
fn main() {
    #[cfg(target_os = "macos")]
    native::run();
    #[cfg(not(target_os = "macos"))]
    println!("native-quit-probe is macOS-only; no execution");
}
