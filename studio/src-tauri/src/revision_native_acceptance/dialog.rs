//! Only compiled into the explicit disposable revision fixture.
//! Objective-C objects are created, inspected, clicked and released on main only.
use super::*;
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CStr};
use std::rc::Rc;
use std::sync::atomic::AtomicUsize;

type Object = *mut c_void;
type CFRef = *const c_void;
#[repr(C)]
struct TimerContext {
    version: isize,
    info: *mut c_void,
    retain: Option<extern "C" fn(*const c_void) -> *const c_void>,
    release: Option<extern "C" fn(*const c_void)>,
    description: Option<extern "C" fn(*const c_void) -> CFRef>,
}
#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Object;
    fn sel_registerName(name: *const c_char) -> Object;
    fn objc_msgSend();
}
#[link(name = "System")]
extern "C" {
    fn pthread_main_np() -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFAbsoluteTimeGetCurrent() -> f64;
    fn CFRunLoopGetMain() -> CFRef;
    fn CFRunLoopTimerCreate(
        allocator: CFRef,
        fire: f64,
        interval: f64,
        flags: usize,
        order: isize,
        callback: extern "C" fn(CFRef, *mut c_void),
        context: *mut TimerContext,
    ) -> CFRef;
    fn CFRunLoopAddTimer(loop_: CFRef, timer: CFRef, mode: CFRef);
    fn CFRunLoopTimerInvalidate(timer: CFRef);
    fn CFStringCreateWithCString(allocator: CFRef, value: *const c_char, encoding: u32) -> CFRef;
    fn CFRelease(value: CFRef);
    static kCFRunLoopDefaultMode: CFRef;
}
unsafe fn selector(name: &CStr) -> Object {
    sel_registerName(name.as_ptr())
}
unsafe fn object(receiver: Object, name: &CStr) -> Object {
    let f: unsafe extern "C" fn(Object, Object) -> Object =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector(name))
}
unsafe fn flag(receiver: Object, name: &CStr) -> bool {
    let f: unsafe extern "C" fn(Object, Object) -> bool =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector(name))
}
unsafe fn argument_flag(receiver: Object, name: &CStr, arg: Object) -> bool {
    let f: unsafe extern "C" fn(Object, Object, Object) -> bool =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector(name), arg)
}
unsafe fn number(receiver: Object, name: &CStr) -> usize {
    let f: unsafe extern "C" fn(Object, Object) -> usize =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector(name))
}
unsafe fn indexed(receiver: Object, index: usize) -> Object {
    let f: unsafe extern "C" fn(Object, Object, usize) -> Object =
        std::mem::transmute(objc_msgSend as *const ());
    f(receiver, selector(c"objectAtIndex:"), index)
}
unsafe fn text(string: Object) -> Option<String> {
    if string.is_null() {
        return None;
    }
    let f: unsafe extern "C" fn(Object, Object, usize) -> usize =
        std::mem::transmute(objc_msgSend as *const ());
    let size = f(string, selector(c"lengthOfBytesUsingEncoding:"), 4);
    if size > 32768 {
        return None;
    }
    let f: unsafe extern "C" fn(Object, Object) -> *const u8 =
        std::mem::transmute(objc_msgSend as *const ());
    let bytes = f(string, selector(c"UTF8String"));
    if bytes.is_null() {
        return None;
    }
    std::str::from_utf8(std::slice::from_raw_parts(bytes, size))
        .ok()
        .map(str::to_owned)
}
unsafe fn release_object(value: Object) {
    let f: unsafe extern "C" fn(Object, Object) = std::mem::transmute(objc_msgSend as *const ());
    f(value, selector(c"release"));
}
unsafe fn click(value: Object) {
    let f: unsafe extern "C" fn(Object, Object, Object) =
        std::mem::transmute(objc_msgSend as *const ());
    f(value, selector(c"performClick:"), std::ptr::null_mut());
}

// Retain the CURRENT matched sheet and selected control through synchronous
// dismissal/completion. Native's parent/prior-sheet owners are not substitutes.
struct ActionOwners {
    sheet: Object,
    button: Object,
}
impl ActionOwners {
    unsafe fn retain(sheet: Object, button: Object) -> Self {
        Self {
            sheet: object(sheet, c"retain"),
            button: object(button, c"retain"),
        }
    }
    unsafe fn perform(&self) {
        click(self.button);
    }
}
impl Drop for ActionOwners {
    fn drop(&mut self) {
        unsafe {
            release_object(self.button);
            release_object(self.sheet);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Cancel,
    Confirm,
    ConfirmAfterExternalChange,
}
pub(crate) struct Observation {
    action: Action,
    proposal_id: String,
    observed: AtomicBool,
    clicked: AtomicBool,
    failed: AtomicBool,
    source_hashes: [String; 2],
    receipt_ids: Vec<String>,
}
static ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
struct Expected {
    retained: proposals::authority::Review,
    repository_id: String,
    review_id: String,
    phase: String,
    title: String,
    body: String,
    action: Action,
    root: PathBuf,
}
// Allocated/owned by a main-runloop timer; never sent between threads.
struct Native {
    parent: Object,
    prior_sheet: Object,
    timer: CFRef,
    deadline: f64,
    expected: Expected,
    observation: Arc<Observation>,
    app: tauri::AppHandle,
    external: Option<Arc<Mutex<Option<bool>>>>,
}
// The timer owns one Rc. Each callback takes another before touching its context:
// invalidation releases the timer's Rc immediately, not the callback's borrow.
unsafe fn callback_owner<T>(info: *const c_void) -> Rc<RefCell<T>> {
    let pointer = info.cast::<RefCell<T>>();
    Rc::increment_strong_count(pointer);
    Rc::from_raw(pointer)
}
unsafe fn release_context<T>(info: *const c_void) {
    drop(Rc::from_raw(info.cast::<RefCell<T>>()));
}
extern "C" fn dispose(info: *const c_void) {
    if !info.is_null() {
        unsafe { release_context::<Native>(info) };
    }
}
impl Drop for Native {
    fn drop(&mut self) {
        if unsafe { pthread_main_np() } != 0 {
            unsafe {
                if !self.prior_sheet.is_null() {
                    release_object(self.prior_sheet);
                }
                release_object(self.parent);
            }
        } else {
            self.observation.failed.store(true, Ordering::SeqCst);
        }
    }
}

unsafe fn controls(sheet: Object, expected: &Expected) -> Option<(Object, Object)> {
    let root = object(sheet, c"contentView");
    if root.is_null() {
        return None;
    }
    let button_class = objc_getClass(c"NSButton".as_ptr());
    let mut todo = vec![(root, 0)];
    let mut count = 0;
    let (mut title, mut body) = (0, 0);
    let (mut ok, mut cancel) = (vec![], vec![]);
    while let Some((view, depth)) = todo.pop() {
        count += 1;
        if count > 256 || depth > 12 {
            return None;
        }
        if argument_flag(view, c"isKindOfClass:", button_class) {
            if object(view, c"window") != sheet {
                return None;
            }
            match text(object(view, c"title"))?.as_str() {
                "OK" => ok.push(view),
                "Cancel" => cancel.push(view),
                _ => return None,
            }
        } else if argument_flag(view, c"respondsToSelector:", selector(c"stringValue")) {
            let value = text(object(view, c"stringValue"))?;
            if value == expected.title {
                title += 1;
            }
            if value == expected.body {
                body += 1;
            }
        }
        let children = object(view, c"subviews");
        let n = number(children, c"count");
        if n > 256 {
            return None;
        }
        for index in 0..n {
            todo.push((indexed(children, index), depth + 1));
        }
    }
    if title != 1
        || body != 1
        || ok.len() != 1
        || cancel.len() != 1
        || !flag(ok[0], c"isEnabled")
        || !flag(cancel[0], c"isEnabled")
    {
        return None;
    }
    Some((ok[0], cancel[0]))
}
unsafe fn matched(state: &Native) -> Option<(Object, Object, Object)> {
    let fixture = FIXTURE.get()?;
    if fixture.repository_id != state.expected.repository_id
        || fixture.review_id != state.expected.review_id
        || fixture.phase != state.expected.phase
        || fixture.root != state.expected.root
        || state.expected.retained.confirmation_message() != state.expected.body
        || state.expected.retained.origin.review.as_ref()?.review_id != fixture.review_id
    {
        return None;
    }
    if !flag(state.parent, c"isVisible")
        || state
            .app
            .state::<BrowserState>()
            .quitting
            .load(Ordering::SeqCst)
    {
        return None;
    }
    let sheet = object(state.parent, c"attachedSheet");
    if sheet.is_null()
        || sheet == state.prior_sheet
        || object(sheet, c"sheetParent") != state.parent
    {
        return None;
    }
    let (ok, cancel) = controls(sheet, &state.expected)?;
    Some((sheet, ok, cancel))
}
struct TimerRelease(CFRef);
impl Drop for TimerRelease {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}
unsafe fn invalidate_timer(handle: &mut CFRef) -> Option<TimerRelease> {
    let timer = std::mem::replace(handle, std::ptr::null());
    if timer.is_null() {
        return None;
    }
    // The callback's independent Rc retains context and native owners. Taking
    // the handle first also makes panic/error cleanup idempotent.
    let release = TimerRelease(timer);
    CFRunLoopTimerInvalidate(timer);
    Some(release)
}
unsafe fn terminate_timer(state: &mut Native) {
    drop(invalidate_timer(&mut state.timer));
}
extern "C" fn tick(_: CFRef, info: *mut c_void) {
    // Main-only Rc; no native objects or pointers cross threads. Keep this owner
    // outside catch_unwind, including its error cleanup and final state access.
    let owner = unsafe { callback_owner::<Native>(info) };
    let Ok(mut state) = owner.try_borrow_mut() else {
        // A modal action may reenter the runloop. The active callback owns it.
        return;
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        tick_inner(&mut state)
    }));
    if result.is_err() {
        unsafe {
            state.observation.failed.store(true, Ordering::SeqCst);
            state.app.exit(73);
            terminate_timer(&mut state);
        }
    }
}
unsafe fn tick_inner(state: &mut Native) {
    if pthread_main_np() == 0 {
        state.observation.failed.store(true, Ordering::SeqCst);
        return;
    }
    if CFAbsoluteTimeGetCurrent() > state.deadline {
        state.observation.failed.store(true, Ordering::SeqCst);
        // Cleanup may only click a positively identified own Cancel. Never pass.
        if let Some((sheet, _, cancel)) = matched(state) {
            let owners = ActionOwners::retain(sheet, cancel);
            owners.perform();
        }
        progress("actual-dialog-timeout-FAIL");
        state.app.exit(73);
        terminate_timer(state);
        return;
    }
    let Some((sheet, _, _)) = matched(state) else {
        return;
    };
    if !state.observation.observed.swap(true, Ordering::SeqCst) {
        progress("own-attached-sheet-exact-content-observed");
    }
    if state.expected.action == Action::ConfirmAfterExternalChange {
        if state.external.is_none() {
            let status = Arc::new(Mutex::new(None));
            state.external = Some(status.clone());
            let root = state.expected.root.clone();
            std::thread::spawn(move || {
                let result = (|| {
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .truncate(true)
                        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
                        .open(root.join("source/scene.md"))?;
                    file.write_all(format!("{SOURCE}External synthetic change\n").as_bytes())?;
                    file.sync_all()
                })();
                *status.lock().unwrap() = Some(result.is_ok());
            });
            return;
        }
        let external_result = *state.external.as_ref().unwrap().lock().unwrap();
        match external_result {
            None => return,
            Some(false) => {
                state.observation.failed.store(true, Ordering::SeqCst);
                state.app.exit(73);
                terminate_timer(state);
                return;
            }
            Some(true) => {}
        }
    }
    // Recheck reciprocal identity and full immutable content immediately before action.
    let Some((same, ok, cancel)) = matched(state) else {
        return;
    };
    if same != sheet {
        return;
    }
    if state.observation.clicked.swap(true, Ordering::SeqCst) {
        return;
    }
    let owners = ActionOwners::retain(
        same,
        if state.expected.action == Action::Cancel {
            cancel
        } else {
            ok
        },
    );
    let _timer = invalidate_timer(&mut state.timer);
    progress(if state.expected.action == Action::Cancel {
        "own-sheet-Cancel-performClick"
    } else {
        "own-sheet-OK-performClick"
    });
    owners.perform();
}
fn source_hashes(root: &Path) -> Result<[String; 2], String> {
    let hash = |name: &str| {
        fs::read_to_string(root.join("source").join(name))
            .map(|s| text_hash(&s))
            .map_err(|_| "Fixture source unavailable".to_string())
    };
    Ok([hash("scene.md")?, hash("other.md")?])
}
fn receipt_ids(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let f = FIXTURE.get().ok_or("Fixture missing")?;
    let repo = Repository::open(f.root.join("source")).map_err(|e| e.to_string())?;
    let (_, store) = proposals::stores(app)?;
    let mut ids = store
        .with_lock(&repo, || store.read_all(&repo))?
        .into_iter()
        .map(|r| r.id)
        .collect::<Vec<_>>();
    ids.sort();
    Ok(ids)
}
pub(super) fn arm(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    review: &proposals::authority::Review,
) -> Result<Arc<Observation>, String> {
    super::validate_review(app, review)?;
    let f = FIXTURE.get().ok_or("Fixture missing")?;
    let index = ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    let action = if f.phase == "stale" {
        Action::ConfirmAfterExternalChange
    } else if f.phase == "first" && index == 0 {
        Action::Cancel
    } else {
        Action::Confirm
    };
    let observation = Arc::new(Observation {
        action,
        proposal_id: review.proposal_id.clone(),
        observed: AtomicBool::new(false),
        clicked: AtomicBool::new(false),
        failed: AtomicBool::new(false),
        source_hashes: source_hashes(&f.root)?,
        receipt_ids: receipt_ids(app)?,
    });
    let expected = Expected {
        retained: review.clone(),
        repository_id: f.repository_id.clone(),
        review_id: f.review_id.clone(),
        phase: f.phase.clone(),
        title: if review.kind == "revert" {
            "Heinlein: confirm guarded revert"
        } else {
            "Heinlein: confirm reviewed proposal"
        }
        .into(),
        body: review.confirmation_message(),
        action,
        root: f.root.clone(),
    };
    let result = observation.clone();
    let window = window.clone();
    let h = app.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let armed = (|| unsafe {
            check_window(&window)?;
            if pthread_main_np() == 0 {
                return Err("Dialog observer requires main".to_string());
            }
            let parent = window.ns_window().map_err(|_| "Own parent unavailable")?;
            if parent.is_null() || !flag(parent, c"isVisible") {
                return Err("Own parent is not visible".into());
            }
            let parent = object(parent, c"retain");
            let prior = object(parent, c"attachedSheet");
            let prior_sheet = if prior.is_null() {
                prior
            } else {
                object(prior, c"retain")
            };
            let state = Rc::new(RefCell::new(Native {
                parent,
                prior_sheet,
                timer: std::ptr::null(),
                deadline: CFAbsoluteTimeGetCurrent() + 12.0,
                expected,
                observation,
                app: h,
                external: None,
            }));
            let raw = Rc::into_raw(state.clone());
            let mut context = TimerContext {
                version: 0,
                info: raw.cast_mut().cast(),
                retain: None,
                release: Some(dispose),
                description: None,
            };
            let timer = CFRunLoopTimerCreate(
                std::ptr::null(),
                CFAbsoluteTimeGetCurrent() + 0.05,
                0.05,
                0,
                0,
                tick,
                &mut context,
            );
            if timer.is_null() {
                dispose(raw.cast());
                return Err("Own timer unavailable".into());
            }
            state.borrow_mut().timer = timer;
            let loop_ = CFRunLoopGetMain();
            CFRunLoopAddTimer(loop_, timer, kCFRunLoopDefaultMode);
            let modal = CFStringCreateWithCString(
                std::ptr::null(),
                c"NSModalPanelRunLoopMode".as_ptr(),
                0x08000100,
            );
            if modal.is_null() {
                terminate_timer(&mut state.borrow_mut());
                return Err("Modal runloop mode unavailable".into());
            }
            CFRunLoopAddTimer(loop_, timer, modal);
            CFRelease(modal);
            progress("actual-dialog-observer-armed-before-builder");
            Ok(())
        })();
        let _ = tx.send(armed);
    })
    .map_err(|_| "Own dialog observer could not be queued")?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Own observer did not arm")??;
    Ok(result)
}
pub(super) fn completed(
    app: &tauri::AppHandle,
    observation: Arc<Observation>,
    answer: bool,
) -> Result<(), String> {
    if observation.failed.load(Ordering::SeqCst)
        || !observation.observed.load(Ordering::SeqCst)
        || !observation.clicked.load(Ordering::SeqCst)
        || answer != (observation.action != Action::Cancel)
    {
        return Err("Actual dialog response was not the verified native action".into());
    }
    if !answer {
        let f = FIXTURE.get().ok_or("Fixture missing")?;
        if source_hashes(&f.root)? != observation.source_hashes
            || receipt_ids(app)? != observation.receipt_ids
        {
            return Err("Cancel changed source or receipt".into());
        }
        progress("actual-plugin-Cancel-false-zero-source-receipt-change");
    } else {
        progress("actual-plugin-OK-true-returned");
    }
    let f = FIXTURE.get().ok_or("Fixture missing")?;
    f.actual_answers
        .lock()
        .map_err(|_| "Answers unavailable")?
        .push(answer);
    if answer {
        f.confirmations
            .lock()
            .map_err(|_| "Confirmations unavailable")?
            .push(observation.proposal_id.clone());
    }
    Ok(())
}

#[cfg(test)]
mod timer_lifetime_tests {
    use super::*;
    use std::cell::Cell;

    struct Probe {
        drops: Rc<Cell<usize>>,
        action_reads: usize,
        timer: CFRef,
    }
    impl Drop for Probe {
        fn drop(&mut self) {
            self.drops.set(self.drops.get() + 1);
        }
    }
    extern "C" fn dispose_probe(info: *const c_void) {
        unsafe { release_context::<Probe>(info) };
    }
    extern "C" fn unused_tick(_: CFRef, _: *mut c_void) {}

    // Actual CF context release, without a window, runloop, dialog or app store.
    unsafe fn exercise_cleanup(error: bool) {
        let drops = Rc::new(Cell::new(0));
        let initial = Rc::new(RefCell::new(Probe {
            drops: drops.clone(),
            action_reads: 0,
            timer: std::ptr::null(),
        }));
        let raw = Rc::into_raw(initial.clone());
        let mut context = TimerContext {
            version: 0,
            info: raw.cast_mut().cast(),
            retain: None,
            release: Some(dispose_probe),
            description: None,
        };
        let timer =
            CFRunLoopTimerCreate(std::ptr::null(), 0.0, 1.0, 0, 0, unused_tick, &mut context);
        assert!(!timer.is_null());
        initial.borrow_mut().timer = timer;
        drop(initial); // Now only CF owns the raw context, as at callback entry.
        {
            let callback = callback_owner::<Probe>(raw.cast());
            let mut state = callback.borrow_mut();
            let nested = callback_owner::<Probe>(raw.cast());
            assert!(nested.try_borrow_mut().is_err()); // No reentrant action.
            drop(nested);
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _release = invalidate_timer(&mut state.timer);
                assert_eq!(drops.get(), 0);
                assert_eq!(Rc::strong_count(&callback), 1); // CF released its owner.
                state.action_reads += 1; // Native owners still live during action.
                if error {
                    panic!("synthetic action failure");
                }
            }));
            assert_eq!(outcome.is_err(), error);
            assert_eq!(state.action_reads, 1);
            assert!(invalidate_timer(&mut state.timer).is_none()); // Error/timeout cleanup repeats safely.
            assert_eq!(drops.get(), 0);
        }
        assert_eq!(drops.get(), 1); // Only after the callback's final access.
    }
    #[test]
    fn matched_action_keeps_context_until_callback_returns() {
        unsafe { exercise_cleanup(false) };
    }
    #[test]
    fn panic_and_repeated_cleanup_keep_context_and_release_exactly_once() {
        unsafe { exercise_cleanup(true) };
    }
}
