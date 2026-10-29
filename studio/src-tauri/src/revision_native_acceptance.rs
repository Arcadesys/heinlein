//! Feature-only synthetic review acceptance. This module never acquires a provider.
//! Stored records are informational; the renderer must use production native commands.
use crate::review_state::ReviewSession;
use drafting_questions::{
    review::{ReviewEdit, ReviewRequest, ReviewRole, ReviewScope, ReviewSnapshot},
    review_workflow::{Batch, CallResult, Options},
};
use proposal_store::{text_hash, ReviewStore};
use repository_core::Repository;

const SOURCE: &str = "🐺 Bad. Same. Same. Keep — voice.\r\n";
const OTHER: &str = "Second — unchanged.\n";
const MODEL: &str = "synthetic-captured-review";

// Called only for the first phase in a newly created, validated fixture root.
// The caller owns filesystem isolation; no existing source is overwritten here.
fn seed(repo: &Repository, records: &ReviewStore, repository_id: &str) -> Result<String, String> {
    let request = ReviewRequest {
        request_id: "native-review-captured".into(),
        repository_id: repository_id.into(),
        scope: ReviewScope::Chapter,
        snapshots: [("scene.md", SOURCE), ("other.md", OTHER)]
            .into_iter()
            .map(|(path, source)| ReviewSnapshot {
                path: path.into(),
                source: source.into(),
                source_hash: text_hash(source),
                scene_id: None,
            })
            .collect(),
        workflow: Some(Options {
            reviewers: vec!["contextual".into(), "mechanical".into()],
            context: vec![],
            context_note: String::new(),
            ranges: vec![],
            review_id: None,
        }),
    };
    let mut session = ReviewSession::workflow(
        request,
        repo.project_key(),
        MODEL.into(),
        "synthetic-account-no-service".into(),
        1,
    )?;
    let calls = session
        .coverage()
        .into_iter()
        .map(|mut coverage| {
            coverage.status = "completed".into();
            coverage.request_id = Some(format!("captured-{}", coverage.id));
            let (path, source) = if coverage.source_index == 0 {
                ("scene.md", SOURCE)
            } else {
                ("other.md", OTHER)
            };
            let specs: Vec<(usize, &str, &str)> = match (coverage.source_index, coverage.reviewer) {
                (0, 0) => vec![
                    (SOURCE.find("Bad").unwrap(), "Bad", "Good 🦊"),
                    (SOURCE.find("Same").unwrap(), "Same", "Clear"),
                    (SOURCE.rfind("Same").unwrap(), "Same", "Never"),
                    (SOURCE.find("Keep").unwrap(), "Keep", "Hold"),
                ],
                (0, 1) => vec![(SOURCE.find("Keep").unwrap(), "Keep", "Retain")],
                (1, 0) => vec![(0, "Second", "Other")],
                _ => vec![],
            };
            let edits = specs
                .into_iter()
                .enumerate()
                .map(|(i, (from, original, replacement))| {
                    assert_eq!(&source[from..from + original.len()], original);
                    ReviewEdit {
                        id: format!("captured-{i}"),
                        path: path.into(),
                        from_utf8: from,
                        to_utf8: from + original.len(),
                        original: original.into(),
                        replacement: replacement.into(),
                        reason:
                            "Explicit synthetic acceptance finding; not a live reviewer response"
                                .into(),
                        role: ReviewRole::Editor,
                    }
                })
                .collect();
            CallResult {
                provider_response_id: None,
                coverage,
                edits,
                model: MODEL.into(),
            }
        })
        .collect();
    session.ingest(
        Batch {
            calls,
            cancelled: false,
            limit_reached: false,
        },
        &Default::default(),
    )?;
    session.persist(records, repo)?;
    Ok(session.id().to_owned())
}

use super::*;
use std::fs;
use std::{
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    sync::OnceLock,
    time::Duration,
};
use tauri::utils::config::AppDirectoriesOverride;
use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};
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

struct Fixture {
    root: PathBuf,
    repository_id: String,
    review_id: String,
    phase: String,
    confirmations: Mutex<Vec<String>>,
    done: AtomicBool,
    failed: AtomicBool,
}
static FIXTURE: OnceLock<Fixture> = OnceLock::new();
fn progress(stage: &str) {
    println!("{}", serde_json::json!({"kind":"progress","stage":stage}));
    let _ = std::io::stdout().flush();
}
// Compile-feature-only trusted author choice, fixed by the native invocation.
// No renderer argument or persisted decision can enable confirmation.
pub(crate) fn confirm_review(
    app: &tauri::AppHandle,
    review: &proposals::authority::Review,
) -> Result<bool, String> {
    let f = FIXTURE.get().ok_or("Native44 not initialized")?;
    if f.done.load(Ordering::SeqCst) || f.failed.load(Ordering::SeqCst) || review.kind != "apply" {
        return Err("Native44 confirmation outside active apply".into());
    }
    let state = app.state::<BrowserState>();
    let selected = state
        .selected
        .lock()
        .map_err(|_| "Selected source unavailable")?;
    let selected = selected.as_ref().ok_or("Selected source missing")?;
    if selected.id != f.repository_id || selected.repo.root() != f.root.join("source") {
        return Err("Native44 session/root mismatch".into());
    }
    let attribution = review
        .origin
        .review
        .as_ref()
        .ok_or("Review provenance missing")?;
    let origin = serde_json::to_value(attribution).map_err(|_| "Review provenance invalid")?;
    if origin["reviewId"] != f.review_id {
        return Err("Native44 review identity mismatch".into());
    }
    let records = ReviewStore::open(
        app.path()
            .app_data_dir()
            .map_err(|_| "Fixture data path unavailable")?
            .join("review-records-v2"),
    )
    .map_err(|_| "Fixture records unavailable")?;
    let record: ReviewSession = records
        .load(&selected.repo, &f.review_id)
        .map_err(|_| "Fixture review unavailable")?;
    let view = serde_json::to_value(record.view()).map_err(|_| "Fixture review invalid")?;
    let finding = view["edits"]
        .as_array()
        .and_then(|items| items.iter().find(|e| e["id"] == attribution.finding_id))
        .ok_or("Fixture finding identity missing")?;
    if finding["path"] != review.path
        || finding["proposalId"] != review.proposal_id
        || finding["status"] != "prepared"
    {
        return Err("Fixture retained proposal/finding binding changed".into());
    }
    // Only exact declared synthetic transformations can receive this native choice.
    let expected = if review.path == "scene.md" && f.phase == "first" {
        [
            (SOURCE, SOURCE.replacen("Bad", "Good 🦊", 1)),
            (
                "🐺 Good 🦊. Same. Same. Keep — voice.\r\n",
                "🐺 Good 🦊. Clear. Same. Keep — voice.\r\n".into(),
            ),
            (
                "🐺 Good 🦊. Clear. Same. Keep — voice.\r\n",
                "🐺 Good 🦊. Clear. Same. Hold — voice.\r\n".into(),
            ),
        ]
        .into_iter()
        .any(|(before, after)| review.base_text == before && review.replacement_text == after)
    } else {
        f.phase == "reopen"
            && review.path == "other.md"
            && review.base_text == OTHER
            && review.replacement_text == "Other — unchanged.\n"
    };
    if !expected
        || review.base_hash != text_hash(&review.base_text)
        || review.replacement_hash != text_hash(&review.replacement_text)
        || review.diff_hash
            != proposal_store::diff_hash(&review.path, &review.base_text, &review.replacement_text)
    {
        return Err("Undeclared synthetic patch refused".into());
    }
    let mut seen = f
        .confirmations
        .lock()
        .map_err(|_| "Confirmation unavailable")?;
    if seen.contains(&review.proposal_id) {
        return Err("Synthetic confirmation reuse refused".into());
    }
    seen.push(review.proposal_id.clone());
    progress("native-synthetic-author-choice-retained-exact-patch");
    Ok(true)
}
fn native44_progress(stage: String) -> Result<(), String> {
    if ![
        "production-review-panel-reopened",
        "rejected-durably",
        "unicode-edit-approved",
        "unrelated-shifted-edit-approved",
        "unchosen-conflict-refused",
        "chosen-conflict-approved",
        "restart-unrelated-file-approved",
    ]
    .contains(&stage.as_str())
    {
        return Err("Invalid native44 diagnostic".into());
    }
    progress(&stage);
    Ok(())
}
fn native44_abort(app: tauri::AppHandle) {
    FIXTURE.get().unwrap().failed.store(true, Ordering::SeqCst);
    progress("renderer-aborted-FAIL");
    app.exit(73);
}
fn native44_finish(app: tauri::AppHandle) -> Result<(), String> {
    let f = FIXTURE.get().ok_or("Fixture missing")?;
    let expected = "🐺 Good 🦊. Clear. Same. Hold — voice.\r\n";
    if fs::read(f.root.join("source/scene.md")).map_err(|_| "Source missing")?
        != expected.as_bytes()
        || fs::read(f.root.join("source/other.md")).map_err(|_| "Other missing")?
            != if f.phase == "first" {
                OTHER
            } else {
                "Other — unchanged.\n"
            }
            .as_bytes()
    {
        return Err("Native exact bytes differ".into());
    }
    let repo = Repository::open(f.root.join("source")).map_err(|e| e.to_string())?;
    let records = ReviewStore::open(
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("review-records-v2"),
    )
    .map_err(|e| e.to_string())?;
    let session: ReviewSession = records
        .load(&repo, &f.review_id)
        .map_err(|e| e.to_string())?;
    let view = serde_json::to_value(session.view()).map_err(|e| e.to_string())?;
    let edits = view["edits"].as_array().ok_or("Findings missing")?;
    let count = |status: &str| edits.iter().filter(|e| e["status"] == status).count();
    if count("accepted") != if f.phase == "first" { 3 } else { 4 }
        || count("rejected") != 1
        || count("supersededByAuthorChoice") != 1
    {
        return Err("Native durable decision counts differ".into());
    }
    let confirmations = f
        .confirmations
        .lock()
        .map_err(|_| "Confirmation unavailable")?
        .len();
    if confirmations != if f.phase == "first" { 3 } else { 1 } {
        return Err("Unexpected confirmation count".into());
    }
    let (_, receipts) = proposals::stores(&app)?;
    let receipt_count = receipts
        .with_lock(&repo, || receipts.read_all(&repo))?
        .len();
    if receipt_count < if f.phase == "first" { 4 } else { 5 } {
        return Err("Native receipt chain incomplete".into());
    }
    file_create(
        &f.root.join(format!("{}-receipt.json", f.phase)),
        &serde_json::json!({"schema":1,"phase":f.phase,"realIPC":true,"accepted":count("accepted"),"rejected":1,"superseded":1,"confirmations":confirmations,"receiptCount":receipt_count,"exactBytes":true,"confirmation":"compile-feature-native-synthetic-author-choice","osDialogUsability":false}),
    )?;
    f.done.store(true, Ordering::SeqCst);
    progress("native-record-receipt-byte-verification-PASS");
    app.exit(0);
    Ok(())
}
pub(super) fn run() {
    if let Err(error) = run_checked() {
        eprintln!("Native44 startup refused: {error}");
        std::process::exit(64);
    }
}
fn run_checked() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5
        || args[1] != "--revision-native-acceptance"
        || !["first", "reopen"].contains(&args[3].as_str())
        || args[4] != "--synthetic-author-choice"
    {
        return Err("Explicit fixture root/phase/native synthetic choice required".into());
    }
    let root = PathBuf::from(&args[2]);
    private(&root)?;
    let uuid = root
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("heinlein-native-review-"))
        .and_then(|n| uuid::Uuid::parse_str(n).ok())
        .ok_or("UUID root required")?;
    if std::env::temp_dir().canonicalize().ok() != Some(root.clone()) {
        return Err("TMPDIR must equal fixture root".into());
    }
    let sentinel = root.join("fixture-sentinel.json");
    if args[3] == "first" {
        if fs::read_dir(&root)
            .map_err(|_| "Root unavailable")?
            .next()
            .is_some()
        {
            return Err("First root must be empty".into());
        }
        file_create(
            &sentinel,
            &serde_json::json!({"schema":1,"uuid":uuid.to_string(),"purpose":"native-review"}),
        )?;
    }
    let mark = file_read(&sentinel)?;
    if mark["schema"] != 1 || mark["uuid"] != uuid.to_string() || mark["purpose"] != "native-review"
    {
        return Err("Fixture marker mismatch".into());
    }
    let app_root = root.join("app-data");
    for p in [
        &app_root,
        &app_root.join("caches"),
        &app_root.join("logs"),
        &root.join("source"),
    ] {
        if !p.exists() {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(p)
                .map_err(|_| "Fixture mkdir failed")?;
        }
        private(p)?;
    }
    if args[3] == "first" {
        for (path, text) in [("scene.md", SOURCE), ("other.md", OTHER)] {
            let mut out = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(root.join("source").join(path))
                .map_err(|_| "Synthetic source already exists")?;
            out.write_all(text.as_bytes())
                .and_then(|_| out.sync_all())
                .map_err(|_| "Source write failed")?;
        }
    }
    let mut context =
        tauri::generate_context!("../macos/tests/native-review-probe/tauri.conf.json");
    context.config_mut().identifier =
        format!("me.thearcades.heinlein.synthetic-review-{}", uuid.simple());
    context.config_mut().app.app_directories_override =
        Some(AppDirectoriesOverride::Root(app_root));
    let phase = args[3].clone();
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        questions::review_definitions,
        questions::list_reviews,
        questions::get_review,
        questions::choose_review_edit,
        questions::reject_review_edit,
        questions::approve_review_edit,
    ];
    let app=tauri::Builder::default().manage(BrowserState::default()).manage(questions::QuestionHost::default()).manage(update::Runtime::default())
        .invoke_handler(move|invoke|{if !["review_definitions","list_reviews","get_review","choose_review_edit","reject_review_edit","approve_review_edit"].contains(&invoke.message.command()){if let Some(f)=FIXTURE.get(){f.failed.store(true,Ordering::SeqCst);}invoke.resolver.reject("Native44 forbids unrelated services");return true;}handler(invoke)})
        .setup(move|app|{
            for p in [app.path().app_config_dir(),app.path().app_data_dir(),app.path().app_local_data_dir(),app.path().app_cache_dir(),app.path().app_log_dir(),app.path().temp_dir()]{let p=p?;if !p.starts_with(&root){return Err(std::io::Error::other("App path escaped root").into());}private(&p).map_err(std::io::Error::other)?;}
            let h=app.handle().clone();
            app.listen("native44-progress",move|event|{let result=serde_json::from_str::<String>(event.payload()).map_err(|_|"Invalid fixture progress".into()).and_then(native44_progress);if result.is_err(){native44_abort(h.clone());}});
            let h=app.handle().clone();app.listen("native44-abort",move|_|native44_abort(h.clone()));
            let h=app.handle().clone();app.listen("native44-finish",move|_|{if let Err(reason)=native44_finish(h.clone()){eprintln!("Native44 verification refused: {reason}");native44_abort(h.clone());}});
            let data=app.path().app_data_dir()?;
            let state=app.state::<BrowserState>();
            let repo=Arc::new(Repository::open(root.join("source"))?);
            let repository_id=uuid::Uuid::new_v4().to_string();
            *state.selected.lock().unwrap()=Some(Selected{id:repository_id.clone(),repo:repo.clone()});
            *state.recovery.lock().unwrap()=Some(Arc::new(RecoveryStore::open(data.join("draft-recovery-v1"))?));
            let records=ReviewStore::open(data.join("review-records-v2"))?;
            let review_id=if phase=="first"{let id=seed(&repo,&records,&repository_id).map_err(std::io::Error::other)?;file_create(&root.join("review-identity.json"),&serde_json::json!({"id":id})).map_err(std::io::Error::other)?;id}else{file_read(&root.join("review-identity.json")).map_err(std::io::Error::other)?["id"].as_str().ok_or("Review ID missing")?.to_owned()};
            let snapshots=["scene.md","other.md"].into_iter().map(|path|{let source=fs::read_to_string(root.join("source").join(path)).unwrap();serde_json::json!({"path":path,"sourceHash":text_hash(&source),"source":source})}).collect::<Vec<_>>();
            let script=format!("globalThis.__HEINLEIN_NATIVE44__={};",serde_json::json!({"phase":phase,"repositoryId":repository_id,"reviewId":review_id,"snapshots":snapshots}));
            FIXTURE.set(Fixture{root:root.clone(),repository_id,review_id,phase,confirmations:Mutex::new(vec![]),done:AtomicBool::new(false),failed:AtomicBool::new(false)}).map_err(|_|"Fixture already active")?;
            let window=WebviewWindowBuilder::new(app,"main",WebviewUrl::External("about:blank".parse()?)).title("DISPOSABLE native review IPC — synthetic writing only").incognito(true).initialization_script(&script)
              .on_navigation(|url|url.as_str()=="about:blank"||(url.scheme()=="tauri"&&url.host_str()==Some("localhost")))
              .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny).build()?;
            let (tx,rx)=std::sync::mpsc::channel();let (returned,returned_rx)=std::sync::mpsc::channel();let w=window.clone();
            std::thread::spawn(move||{if await_navigation_gate(rx,returned_rx,Duration::from_secs(10)).is_err(){progress("nonpersistent-gate-FAIL");w.app_handle().exit(73);return;}progress("nonpersistent-WK-and-outer-return-confirmed");let _=w.navigate("tauri://localhost/index.html".parse().unwrap());});
            let result=window.with_webview(move|view|{let _=tx.send(nonpersistent(view.inner()));});let _=returned.send(result.is_ok());
            progress("confined-native-state-ready-before-nonpersistent-navigation");Ok(())
        }).build(context).map_err(|e|e.to_string())?;
    let h = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(90));
        if !FIXTURE.get().is_some_and(|f| f.done.load(Ordering::SeqCst)) {
            progress("watchdog-FAIL");
            h.exit(73);
        }
    });
    let code = app.run_return(|_, _| {});
    if code != 0
        || !FIXTURE
            .get()
            .is_some_and(|f| f.done.load(Ordering::SeqCst) && !f.failed.load(Ordering::SeqCst))
    {
        return Err("Native44 acceptance incomplete".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captured_outputs_use_native_ids_conflicts_and_durable_record() {
        let tmp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let source = tmp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("scene.md"), SOURCE).unwrap();
        fs::write(source.join("other.md"), OTHER).unwrap();
        let repo = Repository::open(&source).unwrap();
        let records = ReviewStore::open(tmp.path().join("records")).unwrap();
        let id = seed(&repo, &records, "native-synthetic-session").unwrap();
        let restored: ReviewSession = records.load(&repo, &id).unwrap();
        let view = serde_json::to_value(restored.view()).unwrap();
        let edits = view["edits"].as_array().unwrap();
        assert_eq!(edits.len(), 6);
        assert!(edits.iter().all(|e| e["status"] == "pending"));
        let alternatives: Vec<_> = edits.iter().filter(|e| e["original"] == "Keep").collect();
        assert_eq!(alternatives.len(), 2);
        assert_eq!(
            alternatives[0]["conflictGroup"],
            alternatives[1]["conflictGroup"]
        );
        assert!(alternatives[0]["conflictGroup"].is_string());
        assert!(alternatives.iter().all(|e| e["selected"] == false));
        assert_eq!(
            fs::read(source.join("scene.md")).unwrap(),
            SOURCE.as_bytes()
        );
        assert_eq!(fs::read(source.join("other.md")).unwrap(), OTHER.as_bytes());
    }
}
