//! Feature-only public AppKit actions on this fixture's positively owned sheets.
//! Raw Objective-C objects remain on main. Workers exchange only immutable phase IDs.
use std::{
    cell::{Cell, RefCell},
    ffi::{c_char, c_void, CStr, CString},
    io::Write,
    os::unix::fs::MetadataExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        OnceLock,
    },
    time::Instant,
};
use tauri::Manager;
mod completion;
static ACTIONS: completion::ActionCompletion = completion::ActionCompletion::new();
static DECLARED: OnceLock<Declaration> = OnceLock::new();
static NEXT: AtomicUsize = AtomicUsize::new(0);
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static DEADLINE: AtomicU64 = AtomicU64::new(0);
static NAME_INPUTS: AtomicUsize = AtomicUsize::new(0);
static ALERT_CALLS: AtomicUsize = AtomicUsize::new(0);
static PREVIEW_REQUESTS: AtomicUsize = AtomicUsize::new(0);
static CREATE_REQUESTS: AtomicUsize = AtomicUsize::new(0);
static FAILURE: AtomicUsize = AtomicUsize::new(0);
struct Declaration {
    root: PathBuf,
    dir: PathBuf,
    root_id: (u64, u64),
    dir_id: (u64, u64),
    started: Instant,
}
struct Object(*mut c_void);
impl Drop for Object {
    fn drop(&mut self) {
        unsafe {
            objc_release(self.0);
        }
    }
}
struct Main {
    parent: Object,
    number: isize,
}
thread_local! {static MAIN:RefCell<Option<Main>>=const{RefCell::new(None)};static BUSY:Cell<bool>=const{Cell::new(false)};}
#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
    fn objc_retain(obj: *mut c_void) -> *mut c_void;
    fn objc_release(obj: *mut c_void);
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
}
#[link(name = "System")]
extern "C" {
    fn pthread_main_np() -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFAbsoluteTimeGetCurrent() -> f64;
    fn CFRunLoopGetMain() -> *mut c_void;
    fn CFRunLoopTimerCreate(
        allocator: *const c_void,
        fire: f64,
        interval: f64,
        flags: usize,
        order: isize,
        callback: extern "C" fn(*mut c_void, *mut c_void),
        context: *mut c_void,
    ) -> *mut c_void;
    fn CFRunLoopAddTimer(run: *mut c_void, timer: *mut c_void, mode: *const c_void);
    fn CFRunLoopTimerInvalidate(timer: *mut c_void);
    fn CFRelease(value: *const c_void);
    static kCFRunLoopDefaultMode: *const c_void;
}
#[link(name = "AppKit", kind = "framework")]
extern "C" {
    static NSModalPanelRunLoopMode: *const c_void;
}
fn selector(name: &str) -> *mut c_void {
    let n = CString::new(name).unwrap();
    unsafe { sel_registerName(n.as_ptr()) }
}
unsafe fn object(receiver: *mut c_void, name: &str) -> *mut c_void {
    let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector(name))
}
unsafe fn integer(receiver: *mut c_void, name: &str) -> isize {
    let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> isize =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector(name))
}
unsafe fn boolean(receiver: *mut c_void, name: &str) -> bool {
    let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector(name))
}
unsafe fn indexed(receiver: *mut c_void, index: usize) -> *mut c_void {
    let f: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector("objectAtIndex:"), index)
}
unsafe fn kind(receiver: *mut c_void, class: &str) -> bool {
    if receiver.is_null() {
        return false;
    }
    let n = CString::new(class).unwrap();
    let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> bool =
        std::mem::transmute(objc_msgSend as *const ());
    f(
        receiver,
        selector("isKindOfClass:"),
        objc_getClass(n.as_ptr()),
    )
}
unsafe fn action(receiver: *mut c_void, name: &str) {
    let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector(name), std::ptr::null_mut());
}
unsafe fn string(value: *mut c_void) -> Option<String> {
    if value.is_null() || integer(value, "length") > 4096 {
        return None;
    }
    let p = object(value, "UTF8String").cast::<c_char>();
    if p.is_null() {
        None
    } else {
        CStr::from_ptr(p).to_str().ok().map(str::to_owned)
    }
}
fn stage(name: &str, phase: usize) {
    use std::io::Write;
    println!(
        "{}",
        serde_json::json!({"kind":"native-picker","stage":name,"phase":phase,"physicalKeyboard":false,"allUIInProcess":false})
    );
    let _ = std::io::stdout().flush();
}
fn identity(path: &std::path::Path) -> Result<(u64, u64), String> {
    let m = path
        .symlink_metadata()
        .map_err(|_| "Synthetic directory missing")?;
    if !m.is_dir()
        || m.file_type().is_symlink()
        || m.uid() != rustix::process::getuid().as_raw()
        || m.mode() & 0o077 != 0
    {
        return Err("Synthetic directory must remain private and owned".into());
    }
    Ok((m.dev(), m.ino()))
}
fn paths_valid(d: &Declaration) -> bool {
    identity(&d.root).ok() == Some(d.root_id)
        && identity(&d.dir).ok() == Some(d.dir_id)
        && d.dir.parent() == Some(d.root.as_path())
}
fn expected_picker(step: usize) -> bool {
    [1, 2, 4].contains(&step)
}
fn arm(picker: bool) -> Result<PathBuf, String> {
    if unsafe { pthread_main_np() } != 0 {
        return Err("Native picker arm must be off main".into());
    }
    let d = DECLARED
        .get()
        .ok_or("Verified native picker declaration required")?;
    if FAILURE.load(Ordering::SeqCst) != 0 || !paths_valid(d) || ACTIVE.load(Ordering::SeqCst) != 0
    {
        return Err("Native dialog state unavailable".into());
    }
    let before = NEXT.load(Ordering::SeqCst);
    let next = before + 1;
    if next
        > if super::standalone_native_acceptance::picker_preview_only() {
            2
        } else {
            5
        }
        || expected_picker(next) != picker
    {
        return Err("Unexpected native dialog phase".into());
    }
    NEXT.compare_exchange(before, next, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Concurrent native dialog request")?;
    DEADLINE.store(
        d.started.elapsed().as_millis() as u64 + 10000,
        Ordering::SeqCst,
    );
    ACTIVE.store(next, Ordering::SeqCst);
    stage("immutable-one-shot-armed-before-builder", next);
    Ok(d.dir.clone())
}
// Pure lexical gate: never canonicalize/stat a candidate returned outside our declaration.
fn validate_exact_return(
    chosen: &std::path::Path,
    expected: &std::path::Path,
    phase: usize,
) -> Result<(), String> {
    if !chosen.is_absolute()
        || chosen.as_os_str() != expected.as_os_str()
        || ![2, 4].contains(&phase)
    {
        return Err("Native picker returned an undeclared synthetic destination".into());
    }
    Ok(())
}
pub(super) fn validate_returned_picker_path(chosen: &std::path::Path) -> Result<(), String> {
    let d = DECLARED
        .get()
        .ok_or("Verified native picker declaration required")?;
    let phase = NEXT.load(Ordering::SeqCst);
    validate_exact_return(chosen, &d.dir.join("draft.md"), phase)?;
    // Only declared root metadata may be touched after the candidate passes lexical validation.
    if FAILURE.load(Ordering::SeqCst) != 0
        || ACTIVE.load(Ordering::SeqCst) != 0
        || ACTIONS.count() != phase
        || !paths_valid(d)
    {
        return Err("Native picker return phase/declaration no longer valid".into());
    }
    Ok(())
}
fn preview_request_shape(request: &serde_json::Value, id: Option<&str>) -> bool {
    match request["kind"].as_str() {
        Some("list" | "release") => true,
        Some("create") => request["text"] == CONTENT,
        Some("open") => id.is_some_and(|id| request["id"] == id),
        Some("save") => {
            request["text"] == CONTENT && request["hash"] == HASH && request["revision"] == 1
        }
        Some("preview") => {
            request["destination"] == "file" && request["hash"] == HASH && request["revision"] == 1
        }
        _ => false,
    }
}
pub(super) fn preview_only_request_allowed(request: &serde_json::Value) -> bool {
    let Some(d) = DECLARED.get() else {
        return false;
    };
    if !super::standalone_native_acceptance::picker_preview_only()
        || failure().is_some()
        || !paths_valid(d)
    {
        return false;
    }
    let identity =
        super::standalone_native_acceptance::file_read(&d.root.join("draft-identity.json")).ok();
    let id = identity.as_ref().and_then(|v| v["id"].as_str());
    if !preview_request_shape(request, id) {
        return false;
    }
    match request["kind"].as_str() {
        Some("create") => CREATE_REQUESTS.fetch_add(1, Ordering::SeqCst) == 0 && id.is_none(),
        Some("preview") => PREVIEW_REQUESTS.fetch_add(1, Ordering::SeqCst) < 2 && id.is_some(),
        _ => true,
    }
}
fn filename_option(preview_only: bool) -> Option<&'static str> {
    if preview_only {
        None
    } else {
        Some("draft.md")
    }
}
pub(super) fn suggested_filename() -> Option<&'static str> {
    filename_option(super::standalone_native_acceptance::picker_preview_only())
}
fn filename_input_allowed(
    phase: usize,
    owned: bool,
    is_save: bool,
    message: bool,
    directory: bool,
) -> bool {
    [1, 2].contains(&phase) && owned && is_save && message && directory
}
fn record_failure(code: usize) {
    FAILURE.store(code, Ordering::SeqCst);
    ACTIONS.terminate();
}
pub(super) fn abort_action_waiters() {
    record_failure(6);
}
pub(super) fn expected_action_phase() -> Result<usize, String> {
    let phase = NEXT.load(Ordering::SeqCst);
    if failure().is_some() || phase == 0 || ACTIVE.load(Ordering::SeqCst) != phase {
        return Err("Native dialog phase unavailable before presentation".into());
    }
    Ok(phase)
}
// Call ONLY after the genuine blocking plugin response, from its command worker.
// No main callback can wait here, and no lock is retained across the public action.
pub(super) fn wait_action_returned(phase: usize) -> Result<(), String> {
    if unsafe { pthread_main_np() } != 0 {
        record_failure(6);
        return Err("Action completion cannot wait on main".into());
    }
    if let Err(error) = ACTIONS.wait_returned(phase, std::time::Duration::from_secs(5)) {
        record_failure(6);
        return Err(error.into());
    }
    if failure().is_some() {
        return Err("Native action failed before response validation".into());
    }
    Ok(())
}
pub(super) fn arm_picker() -> Result<PathBuf, String> {
    arm(true)
}
pub(super) fn arm_confirmation(message: &str) -> Result<(), String> {
    ALERT_CALLS.fetch_add(1, Ordering::SeqCst);
    if super::standalone_native_acceptance::picker_preview_only() {
        record_failure(6);
        return Err("Preview-only fixture forbids placement confirmation".into());
    }
    let d = DECLARED
        .get()
        .ok_or("Verified picker declaration required")?;
    if message != confirmation(d) {
        return Err("Unexpected synthetic placement confirmation".into());
    }
    arm(false).map(|_| ())
}
fn confirmation(d: &Declaration) -> String {
    format!("Place an independent copy at {}? This destination may be shared by its sync tools. Your standalone draft stays here; later edits are not synchronized.",d.dir.join("draft.md").display())
}
pub(super) fn failure() -> Option<&'static str> {
    match FAILURE.load(Ordering::SeqCst) {
        0 => None,
        1 => Some("owned-native-dialog-timeout"),
        2 => Some("owned-native-parent-or-path-changed"),
        3 => Some("unexpected-owned-native-sheet"),
        4 => Some("owned-picker-directory-name-title-mismatch"),
        _ => Some("owned-native-dialog-driver-failed"),
    }
}
pub(super) fn summary() -> serde_json::Value {
    serde_json::json!({"armed":NEXT.load(Ordering::SeqCst),"completedPublicActions":ACTIONS.count(),"failure":FAILURE.load(Ordering::SeqCst),"readbackMask":READBACKS.load(Ordering::SeqCst),"pickerOnly":super::standalone_native_acceptance::picker_preview_only(),"placementConfirmation":!super::standalone_native_acceptance::picker_preview_only(),"alertCalls":ALERT_CALLS.load(Ordering::SeqCst),"syntheticNameInputMask":NAME_INPUTS.load(Ordering::SeqCst),"defaultSuggestedFilenameInitialization":!super::standalone_native_acceptance::picker_preview_only(),"physicalKeyboard":false,"VoiceOver":false,"allUIInProcess":false})
}
pub(super) fn install(window: &tauri::WebviewWindow, root: PathBuf) -> Result<(), String> {
    if unsafe { pthread_main_np() } != 1 {
        return Err("Native panel objects must stay on main".into());
    }
    super::check_window(window)?;
    if window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| "Fixture app data missing")?
        != root.join("app-data")
    {
        return Err("Picker app data escaped root".into());
    }
    let dir = root.join("copy-targets");
    let d = Declaration {
        root_id: identity(&root)?,
        dir_id: identity(&dir)?,
        root,
        dir,
        started: Instant::now(),
    };
    let parent = window
        .ns_window()
        .map_err(|_| "Owned native parent missing")?;
    if parent.is_null() {
        return Err("Owned native parent missing".into());
    }
    unsafe {
        if !boolean(parent, "isVisible") {
            return Err("Owned native parent invisible".into());
        }
    }
    DECLARED
        .set(d)
        .map_err(|_| "Picker declaration already installed")?;
    MAIN.with(|state| -> Result<(), String> {
        let mut s = state.borrow_mut();
        if s.is_some() {
            return Err("Owned parent already captured".into());
        }
        *s = Some(Main {
            parent: Object(unsafe { objc_retain(parent) }),
            number: unsafe { integer(parent, "windowNumber") },
        });
        Ok(())
    })?;
    unsafe {
        let timer = CFRunLoopTimerCreate(
            std::ptr::null(),
            CFAbsoluteTimeGetCurrent() + 0.05,
            0.05,
            0,
            0,
            timer_callback,
            std::ptr::null_mut(),
        );
        if timer.is_null() {
            return Err("Native modal timer unavailable".into());
        }
        CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopDefaultMode);
        CFRunLoopAddTimer(CFRunLoopGetMain(), timer, NSModalPanelRunLoopMode);
        CFRelease(timer);
    }
    stage(
        "main-only-parent-captured-default-and-modal-timer-installed",
        0,
    );
    Ok(())
}
struct Pool(*mut c_void);
impl Drop for Pool {
    fn drop(&mut self) {
        unsafe {
            objc_autoreleasePoolPop(self.0);
        }
    }
}
struct Busy;
impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.with(|b| b.set(false));
    }
}
extern "C" fn timer_callback(timer: *mut c_void, _: *mut c_void) {
    if unsafe { pthread_main_np() } != 1 {
        record_failure(5);
        return;
    }
    if BUSY.with(|b| b.replace(true)) {
        return;
    }
    let _busy = Busy;
    let _pool = Pool(unsafe { objc_autoreleasePoolPush() });
    if FAILURE.load(Ordering::SeqCst) != 0 {
        unsafe { CFRunLoopTimerInvalidate(timer) };
        return;
    }
    let phase = ACTIVE.load(Ordering::SeqCst);
    if phase == 0 {
        if ACTIONS.count()
            == if super::standalone_native_acceptance::picker_preview_only() {
                2
            } else {
                5
            }
        {
            unsafe { CFRunLoopTimerInvalidate(timer) };
        }
        return;
    }
    let Some(d) = DECLARED.get() else {
        record_failure(5);
        return;
    };
    MAIN.with(|state| {
        let s = state.borrow();
        let Some(m) = s.as_ref() else {
            record_failure(5);
            return;
        };
        unsafe {
            if !paths_valid(d)
                || !boolean(m.parent.0, "isVisible")
                || integer(m.parent.0, "windowNumber") != m.number
            {
                record_failure(2);
                return;
            }
            let sheet = object(m.parent.0, "attachedSheet");
            if sheet.is_null() {
                if d.started.elapsed().as_millis() as u64 > DEADLINE.load(Ordering::SeqCst) {
                    record_failure(1);
                }
                return;
            }
            let sheet = Object(objc_retain(sheet));
            if object(sheet.0, "sheetParent") != m.parent.0 || !boolean(sheet.0, "isVisible") {
                record_failure(3);
                return;
            }
            let result = if expected_picker(phase) {
                drive_picker(d, m, sheet.0, phase)
            } else if super::standalone_native_acceptance::picker_preview_only() {
                Err(6)
            } else {
                drive_alert(d, m, sheet.0, phase)
            };
            match result {
                Ok(true) => (),
                Ok(false) => {
                    if d.started.elapsed().as_millis() as u64 > DEADLINE.load(Ordering::SeqCst) {
                        record_failure(1);
                    }
                }
                Err(code) => {
                    record_failure(code);
                }
            }
        }
    });
}
unsafe fn same_sheet(m: &Main, sheet: *mut c_void) -> bool {
    object(m.parent.0, "attachedSheet") == sheet
        && object(sheet, "sheetParent") == m.parent.0
        && boolean(m.parent.0, "isVisible")
        && boolean(sheet, "isVisible")
}
// Pinned rfd 0.16 panel_ffi.rs set_title delegates to NSSavePanel.setMessage.
// The fixture reads that exact public property; window title is independent.
const PICKER_MESSAGE_SELECTOR: &str = "message";
fn picker_field_diagnostics(
    message: Option<&str>,
    name: Option<&str>,
    directory: Option<&str>,
    expected_directory: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "messageMatches":message==Some("Choose a NEW file for this copy"),
        "nameMatches":name==Some("draft.md"),
        "directoryMatches":directory.is_some() && directory==expected_directory,
        "messageMissing":message.is_none(),"nameMissing":name.is_none(),
        "directoryMissing":directory.is_none(),
    })
}
unsafe fn drive_picker(
    d: &Declaration,
    m: &Main,
    sheet: *mut c_void,
    phase: usize,
) -> Result<bool, usize> {
    let is_save = kind(sheet, "NSSavePanel");
    let is_open = kind(sheet, "NSOpenPanel");
    if !is_save || is_open {
        println!(
            "{}",
            serde_json::json!({"kind":"native-picker-diagnostic","phase":phase,"savePanelTypeMatches":is_save&&!is_open,"visible":boolean(sheet,"isVisible"),"fields":picker_field_diagnostics(None,None,None,d.dir.to_str())})
        );
        let _ = std::io::stdout().flush();
        return Err(3);
    }
    let message = string(object(sheet, PICKER_MESSAGE_SELECTOR));
    let name = string(object(sheet, "nameFieldStringValue"));
    let url = object(sheet, "directoryURL");
    let path = if url.is_null() {
        None
    } else {
        string(object(url, "path"))
    };
    println!(
        "{}",
        serde_json::json!({"kind":"native-picker-diagnostic","phase":phase,"savePanelTypeMatches":true,"visible":boolean(sheet,"isVisible"),"fields":picker_field_diagnostics(message.as_deref(),name.as_deref(),path.as_deref(),d.dir.to_str())})
    );
    let _ = std::io::stdout().flush();
    let mut name = name;
    let mut path = path;
    if super::standalone_native_acceptance::picker_preview_only() {
        if !filename_input_allowed(
            phase,
            same_sheet(m, sheet) && paths_valid(d) && ACTIVE.load(Ordering::SeqCst) == phase,
            is_save && !is_open,
            message.as_deref() == Some("Choose a NEW file for this copy"),
            path.is_some() && path.as_deref() == d.dir.to_str(),
        ) {
            return Err(4);
        }
        let bit = 1usize << phase;
        if NAME_INPUTS.fetch_or(bit, Ordering::SeqCst) & bit != 0 {
            return Err(6);
        }
        stage("owned-panel-before-synthetic-name-input", phase);
        let make: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let name_object = make(
            objc_getClass(c"NSString".as_ptr()),
            selector("stringWithUTF8String:"),
            c"draft.md".as_ptr(),
        );
        if name_object.is_null() {
            return Err(6);
        }
        let set: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        set(sheet, selector("setNameFieldStringValue:"), name_object);
        // Real public user-input property only. Reread actual properties; never rewrite the directory.
        name = string(object(sheet, "nameFieldStringValue"));
        let url = object(sheet, "directoryURL");
        path = if url.is_null() {
            None
        } else {
            string(object(url, "path"))
        };
        println!(
            "{}",
            serde_json::json!({"kind":"native-picker-diagnostic","phase":phase,"afterSyntheticNameInput":true,"savePanelTypeMatches":true,"visible":boolean(sheet,"isVisible"),"fields":picker_field_diagnostics(string(object(sheet,PICKER_MESSAGE_SELECTOR)).as_deref(),name.as_deref(),path.as_deref(),d.dir.to_str())})
        );
        let _ = std::io::stdout().flush();
        if !same_sheet(m, sheet)
            || !paths_valid(d)
            || string(object(sheet, PICKER_MESSAGE_SELECTOR)).as_deref()
                != Some("Choose a NEW file for this copy")
            || name.as_deref() != Some("draft.md")
            || path.as_deref() != d.dir.to_str()
        {
            return Err(4);
        }
        stage("synthetic-filename-reread-verified", phase);
    }
    if message.as_deref() != Some("Choose a NEW file for this copy")
        || name.as_deref() != Some("draft.md")
        || path.as_deref() != d.dir.to_str()
    {
        return Err(4);
    }
    match d.dir.join("draft.md").symlink_metadata() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        _ => return Err(4),
    }
    stage("actual-NSSavePanel-owned-parent-dir-name-verified", phase);
    if !same_sheet(m, sheet)
        || !paths_valid(d)
        || ACTIVE
            .compare_exchange(phase, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return Err(2);
    }
    ACTIONS.issued(phase).map_err(|_| 6usize)?;
    // Public panel actions preserve native validation and the real plugin completion callback.
    action(sheet, if phase == 1 { "cancel:" } else { "ok:" });
    ACTIONS.returned(phase).map_err(|_| 6usize)?;
    stage(
        "public-panel-action-dispatched-real-completion-required",
        phase,
    );
    Ok(true)
}
fn valid_alert(texts: &[String], buttons: &[(String, bool, bool)], expected: &str) -> bool {
    texts
        .iter()
        .filter(|s| s.as_str() == "Standalone draft")
        .count()
        == 1
        && texts.iter().filter(|s| s.as_str() == expected).count() == 1
        && texts
            .iter()
            .all(|s| s.is_empty() || s == "Standalone draft" || s == expected)
        && buttons.len() == 2
        && buttons
            .iter()
            .filter(|(s, e, h)| s == "OK" && *e && !*h)
            .count()
            == 1
        && buttons
            .iter()
            .filter(|(s, e, h)| s == "Cancel" && *e && !*h)
            .count()
            == 1
}
unsafe fn drive_alert(
    d: &Declaration,
    m: &Main,
    sheet: *mut c_void,
    phase: usize,
) -> Result<bool, usize> {
    if kind(sheet, "NSSavePanel") || !kind(sheet, "NSPanel") {
        return Err(3);
    }
    let content = object(sheet, "contentView");
    if content.is_null() {
        return Ok(false);
    }
    let mut todo = vec![(content, 0usize)];
    let mut seen = 0;
    let mut texts = Vec::new();
    let mut buttons = Vec::new();
    let mut target: *mut c_void = std::ptr::null_mut();
    while let Some((view, depth)) = todo.pop() {
        seen += 1;
        if seen > 180 || depth > 12 {
            return Err(3);
        }
        if kind(view, "NSTextField") {
            let Some(value) = string(object(view, "stringValue")) else {
                return Err(3);
            };
            texts.push(value);
        }
        if kind(view, "NSButton") {
            let Some(label) = string(object(view, "title")) else {
                return Err(3);
            };
            let enabled = boolean(view, "isEnabled");
            let hidden = boolean(view, "isHidden");
            if label == if phase == 3 { "Cancel" } else { "OK" } {
                if !target.is_null() {
                    return Err(3);
                }
                target = view;
            }
            buttons.push((label, enabled, hidden));
        }
        let children = object(view, "subviews");
        if children.is_null() {
            continue;
        }
        let count = integer(children, "count");
        if !(0..=180).contains(&count) {
            return Err(3);
        }
        for index in 0..count {
            todo.push((indexed(children, index as usize), depth + 1));
        }
    }
    if !valid_alert(&texts, &buttons, &confirmation(d)) || target.is_null() {
        return Ok(false);
    }
    stage(
        "actual-parented-alert-exact-synthetic-content-controls-verified",
        phase,
    );
    if !same_sheet(m, sheet)
        || !paths_valid(d)
        || !boolean(target, "isEnabled")
        || boolean(target, "isHidden")
        || ACTIVE
            .compare_exchange(phase, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return Err(2);
    }
    ACTIONS.issued(phase).map_err(|_| 6usize)?;
    action(target, "performClick:");
    ACTIONS.returned(phase).map_err(|_| 6usize)?;
    stage(
        "public-alert-button-action-dispatched-real-completion-required",
        phase,
    );
    Ok(true)
}

const CONTENT: &str =
    "Synthetic café — 🦊\r\nSecond line\n第三行\rFinal original\r\nLatest revision: naïve 🌈\r\n";
const HASH: &str = "115d534fa5575cf7820a1c44c84824eb41871d514293561082f487cfcbe5a276";
static READBACKS: AtomicUsize = AtomicUsize::new(0);
pub(super) fn passed(phase: &str) -> bool {
    FAILURE.load(Ordering::SeqCst) == 0
        && ACTIVE.load(Ordering::SeqCst) == 0
        && if phase == "picker-preview-only" {
            NEXT.load(Ordering::SeqCst) == 2
                && ACTIONS.count() == 2
                && READBACKS.load(Ordering::SeqCst) == 6
                && ALERT_CALLS.load(Ordering::SeqCst) == 0
                && NAME_INPUTS.load(Ordering::SeqCst) == 6
        } else if phase == "picker" {
            NEXT.load(Ordering::SeqCst) == 5
                && ACTIONS.count() == 5
                && READBACKS.load(Ordering::SeqCst) == 126
        } else {
            NEXT.load(Ordering::SeqCst) == 0
                && ACTIONS.count() == 0
                && READBACKS.load(Ordering::SeqCst) == 128
        }
}
pub(super) fn verify_readback(
    app: &tauri::AppHandle,
    phase: &str,
) -> Result<serde_json::Value, String> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    let d = DECLARED.get().ok_or("Picker declaration missing")?;
    if super::standalone_native_acceptance::picker_guard_home(app)? != d.root
        || !paths_valid(d)
        || failure().is_some()
    {
        return Err("Picker readback isolation failed".into());
    }
    let actions = ACTIONS.count();
    let (bit, placed) = match (phase, actions) {
        ("picker-cancel-real-null", 1) => (1, false),
        ("picker-preview-real-token", 2) => (2, false),
        ("picker-place-cancel-real-null", 3) => (3, false),
        ("picker-preview-real-token", 4) => (4, false),
        ("picker-copy-real-receipt", 5) => (5, true),
        ("picker-replay-denied", 5) => (6, true),
        ("picker-reopened-both", 0) => (7, true),
        _ => return Err("Readback outside declared native phase".into()),
    };
    let value =
        super::standalone_native_acceptance::file_read(&d.root.join("draft-identity.json"))?;
    let id = value["id"]
        .as_str()
        .ok_or("Synthetic source identity missing")?;
    let store = repository_core::standalone::DraftStore::open(
        app.path()
            .app_data_dir()
            .map_err(|_| "Synthetic source path unavailable")?
            .join("standalone-drafts-v1"),
    )
    .map_err(|_| "Synthetic source store unavailable")?;
    let loaded = store
        .read(id)
        .map_err(|_| "Synthetic source readback failed")?;
    let draft = loaded.draft;
    if loaded.recovery_required
        || draft.id != id
        || draft.text != CONTENT
        || draft.text_hash != HASH
        || draft.state != "active"
        || !store
            .pending(id)
            .map_err(|_| "Synthetic intents unavailable")?
            .is_empty()
    {
        return Err("Original source bytes/state were not retained".into());
    }
    let path = d.dir.join("draft.md");
    if placed {
        if draft.placements.len() != 1 {
            return Err("Exactly one placement receipt required".into());
        }
        let receipt = &draft.placements[0];
        if receipt.kind != "file"
            || receipt.destination != path.to_string_lossy()
            || receipt.source_hash != HASH
            || receipt.source_revision != 1
        {
            return Err("Native receipt binding mismatch".into());
        }
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(&path)
            .map_err(|_| "Synthetic copy readback failed")?;
        let m = file.metadata().map_err(|_| "Copy metadata unavailable")?;
        if !m.is_file()
            || m.uid() != rustix::process::getuid().as_raw()
            || m.nlink() != 1
            || m.len() != CONTENT.len() as u64
        {
            return Err("Synthetic copy type/size changed".into());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|_| "Copy bytes unavailable")?;
        if bytes != CONTENT.as_bytes() {
            return Err("Copied UTF8 bytes differ".into());
        }
        let binding = serde_json::json!({"id":id,"revision":draft.revision,"hash":HASH});
        let revision = d.root.join("picker-revision.json");
        if phase == "picker-copy-real-receipt" {
            super::standalone_native_acceptance::file_create(&revision, &binding)?;
        } else if super::standalone_native_acceptance::file_read(&revision)? != binding {
            return Err("Restart/replay source revision binding changed".into());
        }
    } else {
        if !draft.placements.is_empty() {
            return Err("Cancelled/preview action published a receipt".into());
        }
        match path.symlink_metadata() {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err("Cancel/preview published a file".into()),
        }
    }
    let flag = 1usize << bit;
    if READBACKS.fetch_or(flag, Ordering::SeqCst) & flag != 0 {
        return Err("Duplicate native evidence phase".into());
    }
    Ok(
        serde_json::json!({"stage":phase,"nativeActions":actions,"originalExact":true,"copyExact":placed,"publicationAbsent":!placed,"bytes":CONTENT.len(),"hash":draft.text_hash,"draftId":draft.id,"revision":draft.revision,"placements":draft.placements.len(),"pendingIntents":0,"immutableFixturePrivateHome":true,"environmentHomeUnchanged":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_filename_option_avoids_pinned_directory_append_without_changing_default() {
        let directory = std::path::Path::new("/synthetic/copy-targets");
        let pinned_requested_directory = |filename: Option<&str>| {
            filename.map_or_else(|| directory.to_owned(), |name| directory.join(name))
        };
        assert_eq!(filename_option(false), Some("draft.md"));
        assert_eq!(pinned_requested_directory(filename_option(true)), directory);
        assert_eq!(
            pinned_requested_directory(filename_option(false)),
            directory.join("draft.md")
        );
    }
    #[test]
    fn synthetic_filename_input_requires_all_identity_and_directory_gates() {
        assert!(filename_input_allowed(1, true, true, true, true));
        assert!(filename_input_allowed(2, true, true, true, true));
        for phase in [0, 3, 4, 5] {
            assert!(!filename_input_allowed(phase, true, true, true, true));
        }
        for (owned, save, message, directory) in [
            (false, true, true, true),
            (true, false, true, true),
            (true, true, false, true),
            (true, true, true, false),
        ] {
            assert!(!filename_input_allowed(1, owned, save, message, directory));
        }
        let after = picker_field_diagnostics(
            Some("Choose a NEW file for this copy"),
            Some("draft.md"),
            Some("/unexpected"),
            Some("/synthetic"),
        );
        assert_eq!(after["nameMatches"], true);
        assert_eq!(after["directoryMatches"], false);
    }
    #[test]
    fn pinned_rfd_builder_caption_maps_to_message_not_window_title() {
        // Independent property model of pinned set_title -> setMessage assignment.
        let public_properties = std::collections::HashMap::from([
            ("title", "Independent native window title"),
            ("message", "Choose a NEW file for this copy"),
        ]);
        let selected = public_properties[PICKER_MESSAGE_SELECTOR];
        let observed = picker_field_diagnostics(
            Some(selected),
            Some("draft.md"),
            Some("/synthetic"),
            Some("/synthetic"),
        );
        assert_eq!(observed["messageMatches"], true);
        assert_eq!(
            picker_field_diagnostics(
                Some(public_properties["title"]),
                Some("draft.md"),
                Some("/synthetic"),
                Some("/synthetic")
            )["messageMatches"],
            false
        );
    }
    #[test]
    fn picker_diagnostics_split_fields_without_observed_text_or_paths() {
        let d = picker_field_diagnostics(
            Some("Unexpected observed text"),
            Some("draft.md"),
            Some("/outside/private"),
            Some("/synthetic"),
        );
        assert_eq!(d["messageMatches"], false);
        assert_eq!(d["nameMatches"], true);
        assert_eq!(d["directoryMatches"], false);
        assert_eq!(d["directoryMissing"], false);
        assert!(!d.to_string().contains("Unexpected"));
        assert!(!d.to_string().contains("/outside"));
        let missing = picker_field_diagnostics(None, None, None, Some("/synthetic"));
        for key in ["messageMissing", "nameMissing", "directoryMissing"] {
            assert_eq!(missing[key], true);
        }
        for key in ["messageMatches", "nameMatches", "directoryMatches"] {
            assert_eq!(missing[key], false);
        }
    }
    #[test]
    fn preview_only_denies_placement_and_unrelated_requests_before_dispatch() {
        use serde_json::json;
        for kind in [
            "place",
            "openPlaced",
            "discard",
            "restore",
            "repair",
            "cancelPreview",
            "unknown",
        ] {
            let dispatched = Cell::new(false);
            if preview_request_shape(&json!({"kind":kind}), Some("own-id")) {
                dispatched.set(true);
            }
            assert!(!dispatched.get(), "{kind}");
        }
        assert!(preview_request_shape(
            &json!({"kind":"create","text":CONTENT}),
            None
        ));
        assert!(!preview_request_shape(
            &json!({"kind":"create","text":"other"}),
            None
        ));
        assert!(preview_request_shape(
            &json!({"kind":"open","id":"own-id"}),
            Some("own-id")
        ));
        assert!(!preview_request_shape(
            &json!({"kind":"open","id":"other"}),
            Some("own-id")
        ));
        let mut preview = json!({"kind":"preview","destination":"file","revision":1,"hash":HASH});
        assert!(preview_request_shape(&preview, Some("own-id")));
        preview["destination"] = json!("existingProject");
        assert!(!preview_request_shape(&preview, Some("own-id")));
        for revision in [0, 2] {
            assert!(!preview_request_shape(
                &json!({"kind":"save","text":CONTENT,"hash":HASH,"revision":revision}),
                Some("own-id")
            ));
        }
    }
    #[test]
    fn undeclared_return_is_rejected_before_resolver_can_run() {
        let expected = std::path::Path::new("/synthetic/copy-targets/draft.md");
        for candidate in [
            "/outside/draft.md",
            "draft.md",
            "/synthetic/copy-targets/../draft.md",
            "/synthetic/copy-targets/./draft.md",
            "/synthetic/copy-targets/other.md",
        ] {
            let resolver_called = Cell::new(false);
            let result = validate_exact_return(std::path::Path::new(candidate), expected, 2)
                .map(|()| resolver_called.set(true));
            assert!(result.is_err());
            assert!(!resolver_called.get());
        }
        for phase in [0, 1, 3, 5, 6] {
            assert!(validate_exact_return(expected, expected, phase).is_err());
        }
        for phase in [2, 4] {
            assert!(validate_exact_return(expected, expected, phase).is_ok());
        }
    }
    #[test]
    fn alert_requires_exact_content_and_unique_enabled_controls() {
        let text = vec!["Standalone draft".into(), "Synthetic confirmation".into()];
        let buttons = vec![("OK".into(), true, false), ("Cancel".into(), true, false)];
        assert!(valid_alert(&text, &buttons, "Synthetic confirmation"));
        assert!(!valid_alert(&text, &buttons, "Different destination"));
        let mut extra = text.clone();
        extra.push("Unexpected content".into());
        assert!(!valid_alert(&extra, &buttons, "Synthetic confirmation"));
        for index in 0..2 {
            let mut disabled = buttons.clone();
            disabled[index].1 = false;
            assert!(!valid_alert(&text, &disabled, "Synthetic confirmation"));
            let mut hidden = buttons.clone();
            hidden[index].2 = true;
            assert!(!valid_alert(&text, &hidden, "Synthetic confirmation"));
        }
        let mut duplicate = buttons.clone();
        duplicate.push(buttons[0].clone());
        assert!(!valid_alert(&text, &duplicate, "Synthetic confirmation"));
    }
    #[test]
    fn independent_utf8_oracle_preserves_mixed_endings() {
        assert_eq!(CONTENT.len(), 94);
        assert!(CONTENT.contains("🦊\r\nSecond line\n第三行\rFinal original\r\n"));
    }
    #[test]
    fn immutable_action_sequence_has_no_extra_or_open_panel_action() {
        assert!(expected_picker(1));
        assert!(expected_picker(2));
        assert!(!expected_picker(3));
        assert!(expected_picker(4));
        assert!(!expected_picker(5));
        assert!(!expected_picker(6));
    }
}
