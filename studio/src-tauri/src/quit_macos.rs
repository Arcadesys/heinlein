//! Pinned missing-selector-only AppKit delegate extension. Never replace methods,
//! delegate/isa/lifecycle, or return NSTerminateNow. Revalidate on dependency upgrade.
use std::{
    ffi::{c_char, c_void, CStr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        OnceLock,
    },
};
type Object = *mut c_void;
struct Request {
    callback: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
    pending: AtomicBool,
    entries: AtomicU64,
    returns: AtomicU64,
    deferred: AtomicU64,
    errors: AtomicU64,
}
static REQUEST: OnceLock<Request> = OnceLock::new();
static CLASS: OnceLock<usize> = OnceLock::new();
#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Object;
    fn object_getClass(object: Object) -> Object;
    fn class_getName(class: Object) -> *const c_char;
    fn class_getSuperclass(class: Object) -> Object;
    fn sel_registerName(name: *const c_char) -> Object;
    fn objc_msgSend();
    fn class_getInstanceMethod(class: Object, selector: Object) -> Object;
    fn class_addMethod(
        class: Object,
        selector: Object,
        implementation: *const c_void,
        types: *const c_char,
    ) -> bool;
    fn method_getImplementation(method: Object) -> *const c_void;
    fn method_getTypeEncoding(method: Object) -> *const c_char;
}
#[link(name = "System")]
extern "C" {
    fn pthread_main_np() -> i32;
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(queue: Object, context: Object, work: extern "C" fn(Object));
}
extern "C" fn deferred(_: Object) {
    if let Some(state) = REQUEST.get() {
        state.deferred.fetch_add(1, Ordering::SeqCst);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (state.callback)()));
        if !matches!(result, Ok(Ok(()))) {
            state.errors.fetch_add(1, Ordering::SeqCst);
            state.pending.store(false, Ordering::SeqCst);
            eprintln!("Native Quit request could not be delivered; Heinlein stayed open.");
        }
    }
}
extern "C" fn should_terminate(_: Object, _: Object, _: Object) -> usize {
    // No locks, waits, emit, callback, allocation, modal UI or unwind across ObjC.
    if let Some(state) = REQUEST.get() {
        state.entries.fetch_add(1, Ordering::SeqCst);
        if !state.pending.swap(true, Ordering::SeqCst) {
            unsafe {
                dispatch_async_f(
                    std::ptr::addr_of!(_dispatch_main_q).cast_mut(),
                    std::ptr::null_mut(),
                    deferred,
                )
            }
        }
        state.returns.fetch_add(1, Ordering::SeqCst);
    }
    0 // NSUInteger NSApplicationTerminateReply::NSTerminateCancel, SDK Q@:@ ABI.
}
fn pins(lock: &str) -> bool {
    [
        ("tauri", "2.12.4"),
        ("tauri-runtime-wry", "2.12.2"),
        ("tao", "0.37.1"),
        ("muda", "0.20.0"),
    ]
    .into_iter()
    .all(|(name, version)| {
        let blocks: Vec<_> = lock
            .split("[[package]]")
            .filter(|block| {
                block
                    .lines()
                    .any(|line| line == format!("name = \"{name}\""))
            })
            .collect();
        blocks.len() == 1
            && blocks[0]
                .lines()
                .any(|line| line == format!("version = \"{version}\""))
    })
}
pub fn install(
    callback: impl Fn() -> Result<(), String> + Send + Sync + 'static,
) -> Result<(), String> {
    let incompatible = || {
        String::from("Native Quit safety adapter is incompatible; startup stopped before writing. Revalidate the pinned macOS lifecycle adapter.")
    };
    if !pins(include_str!("../../Cargo.lock")) || std::mem::size_of::<usize>() != 8 {
        return Err(incompatible());
    }
    unsafe {
        if pthread_main_np() != 1 {
            return Err(incompatible());
        }
        let send: unsafe extern "C" fn(Object, Object) -> Object =
            std::mem::transmute(objc_msgSend as *const ());
        let app = send(
            objc_getClass(c"NSApplication".as_ptr()),
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        if app.is_null() {
            return Err(incompatible());
        }
        let delegate = send(app, sel_registerName(c"delegate".as_ptr()));
        if delegate.is_null() {
            return Err(incompatible());
        }
        let class = object_getClass(delegate);
        let expected = objc_getClass(c"TaoAppDelegateParent".as_ptr());
        if class.is_null()
            || class != expected
            || CStr::from_ptr(class_getName(class)).to_bytes() != b"TaoAppDelegateParent"
        {
            return Err(incompatible());
        }
        let parent = class_getSuperclass(class);
        if parent.is_null() || CStr::from_ptr(class_getName(parent)).to_bytes() != b"NSResponder" {
            return Err(incompatible());
        }
        let selector = sel_registerName(c"applicationShouldTerminate:".as_ptr());
        let method = class_getInstanceMethod(class, selector);
        if let Some(installed) = CLASS.get() {
            return if *installed == class as usize
                && !method.is_null()
                && method_getImplementation(method) == should_terminate as *const c_void
                && CStr::from_ptr(method_getTypeEncoding(method)).to_bytes() == b"Q@:@"
            {
                Ok(())
            } else {
                Err(incompatible())
            };
        }
        // Includes inherited implementations: never replace/swizzle one.
        if !method.is_null() {
            return Err(incompatible());
        }
        REQUEST
            .set(Request {
                callback: Box::new(callback),
                pending: AtomicBool::new(false),
                entries: AtomicU64::new(0),
                returns: AtomicU64::new(0),
                deferred: AtomicU64::new(0),
                errors: AtomicU64::new(0),
            })
            .map_err(|_| incompatible())?;
        if !class_addMethod(
            class,
            selector,
            should_terminate as *const c_void,
            c"Q@:@".as_ptr(),
        ) {
            return Err(incompatible());
        }
        let method = class_getInstanceMethod(class, selector);
        if method.is_null()
            || method_getImplementation(method) != should_terminate as *const c_void
            || CStr::from_ptr(method_getTypeEncoding(method)).to_bytes() != b"Q@:@"
            || send(app, sel_registerName(c"delegate".as_ptr())) != delegate
            || object_getClass(delegate) != class
        {
            return Err(incompatible());
        }
        CLASS.set(class as usize).map_err(|_| incompatible())?;
    }
    Ok(())
}
pub fn finished() {
    if let Some(state) = REQUEST.get() {
        state.pending.store(false, Ordering::SeqCst)
    }
}
#[allow(dead_code)]
pub fn counters() -> (u64, u64, u64, u64) {
    REQUEST
        .get()
        .map(|s| {
            (
                s.entries.load(Ordering::SeqCst),
                s.returns.load(Ordering::SeqCst),
                s.deferred.load(Ordering::SeqCst),
                s.errors.load(Ordering::SeqCst),
            )
        })
        .unwrap_or_default()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dependency_seam_requires_exact_pins() {
        let lock = include_str!("../../Cargo.lock");
        assert!(pins(lock));
        assert!(!pins(&format!(
            "{lock}\n[[package]]\nname = \"tao\"\nversion = \"99.0.0\"\n"
        )));
        assert!(!pins(
            &lock.replace("version = \"0.37.1\"", "version = \"99.0.0\"")
        ));
    }
}
