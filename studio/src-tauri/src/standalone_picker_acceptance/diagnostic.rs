//! D1 diagnostic ONLY: explicit feature + immutable verified picker-d1 startup.
//! A terminal marker is failure; instrumented normal flow is non-reproduction only.
use std::ffi::{c_int, c_void};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
static ENABLED: AtomicBool = AtomicBool::new(false);
static PANICS: AtomicUsize = AtomicUsize::new(0);
static PHASE: AtomicUsize = AtomicUsize::new(0);
static CHECKPOINT: AtomicUsize = AtomicUsize::new(0);
static REENTRIES: AtomicUsize = AtomicUsize::new(0);
static SEEN: [AtomicUsize; 3] = [
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
];
const RUST_PANIC: c_int = 71;
const HOOK_REENTRY: c_int = 72;
const MARKER_FAILURE: c_int = 79;
#[link(name = "System")]
extern "C" {
    fn write(fd: c_int, bytes: *const c_void, len: usize) -> isize;
    fn _exit(status: c_int) -> !;
    fn pthread_main_np() -> c_int;
}
extern "C" {
    fn native47_d1_action(panel: *mut c_void, action: u32, phase: u32) -> i32;
}
#[derive(Clone, Copy)]
#[repr(usize)]
pub(super) enum Point {
    Installed = 0,
    TimerEntered = 1,
    BeforeIssue = 2,
    BeforeShim = 3,
    AfterShim = 4,
    BeforeReturned = 5,
    AfterReturned = 6,
    BeforeSheetDrop = 7,
    AfterSheetDrop = 8,
    BeforePoolPop = 9,
    AfterPoolPop = 10,
}
struct Buffer {
    bytes: [u8; 384],
    len: usize,
    valid: bool,
}
impl Buffer {
    fn new() -> Self {
        Self {
            bytes: [0; 384],
            len: 0,
            valid: true,
        }
    }
    fn text(&mut self, value: &str) {
        if value.len() > self.bytes.len().saturating_sub(self.len) {
            self.valid = false;
            return;
        }
        let end = self.len + value.len();
        self.bytes[self.len..end].copy_from_slice(value.as_bytes());
        self.len = end;
    }
    fn number(&mut self, mut value: usize) {
        let mut digits = [0u8; 20];
        let mut index = 20;
        loop {
            if index == 0 {
                self.valid = false;
                return;
            }
            index -= 1;
            digits[index] = b'0' + (value % 10) as u8;
            value /= 10;
            if value == 0 {
                break;
            }
        }
        for digit in &digits[index..] {
            if self.len == self.bytes.len() {
                self.valid = false;
                return;
            }
            self.bytes[self.len] = *digit;
            self.len += 1;
        }
    }
}
fn source_suffix(file: &str) -> &'static str {
    for (suffix, label) in [
        (
            "/standalone_picker_acceptance/diagnostic.rs",
            "diagnostic.rs",
        ),
        (
            "/standalone_picker_acceptance.rs",
            "standalone_picker_acceptance.rs",
        ),
        (
            "/standalone_picker_acceptance/completion.rs",
            "completion.rs",
        ),
        (
            "/standalone_native_acceptance.rs",
            "standalone_native_acceptance.rs",
        ),
        ("/modal_future.rs", "modal_future.rs"),
        ("/panel_ffi.rs", "panel_ffi.rs"),
        ("/panicking.rs", "rust_core_panicking"),
    ] {
        if file.ends_with(suffix) {
            return label;
        }
    }
    "unknown"
}
fn marker(category: &str, seq: usize, source: &str, line: usize, column: usize) -> Buffer {
    let mut b = Buffer::new();
    b.text("{\"kind\":\"native47-d1\",\"category\":\"");
    b.text(category);
    b.text("\",\"sequence\":");
    b.number(seq);
    b.text(",\"phase\":");
    b.number(PHASE.load(Ordering::SeqCst));
    b.text(",\"checkpoint\":");
    b.number(CHECKPOINT.load(Ordering::SeqCst));
    b.text(",\"main\":");
    b.text(if unsafe { pthread_main_np() } != 0 {
        "true"
    } else {
        "false"
    });
    b.text(",\"source\":\"");
    b.text(source);
    b.text("\",\"line\":");
    b.number(line);
    b.text(",\"column\":");
    b.number(column);
    b.text("}\n");
    b
}
fn emit(b: Buffer) {
    // One <=384-byte checked write, no allocator/framework/logger/locks/retry loop.
    if !b.valid || unsafe { write(2, b.bytes.as_ptr().cast(), b.len) } != b.len as isize {
        unsafe { _exit(MARKER_FAILURE) }
    }
}
fn first_panic(info: &std::panic::PanicHookInfo<'_>) {
    if PANICS.fetch_add(1, Ordering::SeqCst) != 0 {
        emit(marker("hook_reentry", 2, "unknown", 0, 0));
        unsafe { _exit(HOOK_REENTRY) }
    }
    let (source, line, column) = match info.location() {
        Some(location) => (
            source_suffix(location.file()),
            location.line() as usize,
            location.column() as usize,
        ),
        None => ("unknown", 0, 0),
    };
    emit(marker("rust_panic", 1, source, line, column));
    unsafe { _exit(RUST_PANIC) }
}
fn install_hook() {
    ENABLED.store(true, Ordering::SeqCst);
    std::panic::set_hook(Box::new(first_panic));
    checkpoint(Point::Installed);
}
pub(super) fn install_verified(app: &tauri::AppHandle) -> Result<(), String> {
    if !crate::standalone_native_acceptance::picker_d1() {
        return Err("Explicit diagnostic picker mode required".into());
    }
    crate::standalone_native_acceptance::picker_guard_home(app)?;
    install_hook();
    Ok(())
}
pub(super) fn set_phase(phase: usize) {
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    if phase > 2 {
        emit(marker("invalid_phase", 0, "unknown", 0, 0));
        unsafe { _exit(83) }
    }
    PHASE.store(phase, Ordering::SeqCst);
}
pub(super) fn checkpoint(point: Point) {
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    let value = point as usize;
    CHECKPOINT.store(value, Ordering::SeqCst);
    let phase = PHASE.load(Ordering::SeqCst);
    if phase > 2 {
        unsafe { _exit(83) }
    }
    if SEEN[phase].fetch_or(1usize << value, Ordering::SeqCst) & (1usize << value) == 0 {
        emit(marker("checkpoint", 0, "unknown", 0, 0));
    }
}
pub(super) fn reentry() {
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    let count = REENTRIES.load(Ordering::SeqCst);
    if count >= 4
        || REENTRIES
            .compare_exchange(count, count + 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return;
    }
    emit(marker("reentry", count + 1, "unknown", 0, 0));
}
pub(super) unsafe fn invoke(panel: *mut c_void, phase: usize) {
    checkpoint(Point::BeforeShim);
    if pthread_main_np() == 0 || !(1..=2).contains(&phase) {
        emit(marker("invalid_dispatch", 0, "unknown", 0, 0));
        _exit(83);
    }
    // Only called when this explicit verified diagnostic mode installed its hook.
    if !ENABLED.load(Ordering::SeqCst) {
        _exit(83);
    }
    let returned = native47_d1_action(panel, phase as u32, phase as u32);
    if returned != 0 {
        emit(marker("invalid_shim_return", 0, "unknown", 0, 0));
        _exit(83);
    }
    checkpoint(Point::AfterShim);
}

#[cfg(all(test, feature = "standalone-ok-diagnostic-probes"))]
mod tests {
    use super::*;
    use std::process::{Command, Output};
    extern "C" {
        fn native47_d1_probe(branch: u32, action: u32) -> i32;
        fn close(fd: c_int) -> c_int;
    }
    #[test]
    fn probe_entry() {
        let Ok(mode) = std::env::var("HEINLEIN_D1_NO_GUI_PROBE") else {
            return;
        };
        match mode.as_str() {
            "panic" | "reentry" | "write-failure" | "checkpoints" => {
                install_hook();
                set_phase(2);
                if mode == "reentry" {
                    PANICS.store(1, Ordering::SeqCst);
                }
                if mode == "write-failure" {
                    unsafe {
                        close(2);
                    }
                }
                if mode == "checkpoints" {
                    for _ in 0..100 {
                        checkpoint(Point::TimerEntered);
                        reentry();
                    }
                    return;
                }
                panic!("PRIVATE_PROBE_PAYLOAD /private/SECRET_PATH");
            }
            "objc-normal-cancel" => assert_eq!(unsafe { native47_d1_probe(0, 1) }, 0),
            "objc-normal-ok" => assert_eq!(unsafe { native47_d1_probe(0, 2) }, 0),
            "objc-exception" => {
                unsafe { native47_d1_probe(1, 2) };
                panic!("caught exception returned");
            }
            "objc-other" => {
                unsafe { native47_d1_probe(2, 2) };
                panic!("caught object returned");
            }
            _ => panic!("Unknown NO-GUI probe"),
        }
    }
    fn probe(mode: &str) -> Output {
        Command::new(std::env::current_exe().expect("test exe"))
            .args([
                "--exact",
                "standalone_picker_acceptance::diagnostic::tests::probe_entry",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("HEINLEIN_D1_NO_GUI_PROBE", mode)
            .output()
            .expect("own NO-GUI test subprocess")
    }
    #[test]
    fn first_panic_exits_nonzero_with_allowlisted_location_and_no_payload() {
        let out = probe("panic");
        assert_eq!(out.status.code(), Some(71));
        let text = String::from_utf8_lossy(&out.stderr);
        assert!(text.contains("\"category\":\"rust_panic\""));
        assert!(text.contains("diagnostic.rs"));
        assert!(!text.contains("PRIVATE_PROBE"));
        assert!(!text.contains("SECRET_PATH"));
    }
    #[test]
    fn hook_reentry_and_marker_write_failure_are_terminal_nonpass() {
        let out = probe("reentry");
        assert_eq!(out.status.code(), Some(72));
        assert!(String::from_utf8_lossy(&out.stderr).contains("hook_reentry"));
        let out = probe("write-failure");
        assert_eq!(out.status.code(), Some(79));
        let text = String::from_utf8_lossy(&out.stderr);
        // Hook installation precedes closing the synthetic child stderr.
        assert!(text
            .lines()
            .all(|line| line.contains("\"category\":\"checkpoint\"")));
        assert!(!text.contains("rust_panic"));
    }
    #[test]
    fn marker_and_reentry_counts_are_bounded() {
        let out = probe("checkpoints");
        assert!(out.status.success());
        let text = String::from_utf8_lossy(&out.stderr);
        assert_eq!(
            text.lines().filter(|line| line.contains("reentry")).count(),
            4
        );
        assert!(text.len() < 384 * 8);
        let b = marker(
            "rust_panic",
            usize::MAX,
            "standalone_picker_acceptance.rs",
            usize::MAX,
            usize::MAX,
        );
        assert!(b.valid && b.len <= 384);
    }
    #[test]
    fn objc_no_gui_normal_calls_and_both_terminal_catches() {
        for mode in ["objc-normal-cancel", "objc-normal-ok"] {
            assert!(probe(mode).status.success());
        }
        for (mode, code, category) in [
            ("objc-exception", 81, "objc_exception"),
            ("objc-other", 82, "objc_other"),
        ] {
            let out = probe(mode);
            assert_eq!(out.status.code(), Some(code));
            let text = String::from_utf8_lossy(&out.stderr);
            assert!(text.contains(category));
            assert!(!text.contains("PRIVATE_PROBE"));
        }
    }
}
