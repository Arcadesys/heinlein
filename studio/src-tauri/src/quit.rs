//! Shared normal application-exit route. AppKit native terminate is Cancel/deferred.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[derive(Default)]
pub struct Gate {
    permission: AtomicBool,
    generation: AtomicU64,
}
pub fn authorize(
    gate: &Gate,
    generation: u64,
    ready: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    ready()?;
    gate.generation.store(generation, Ordering::SeqCst);
    gate.permission.store(true, Ordering::SeqCst);
    Ok(())
}
pub fn cancel(gate: &Gate) {
    gate.permission.store(false, Ordering::SeqCst)
}
pub fn consume(
    gate: &Gate,
    generation: u64,
    ready: impl FnOnce() -> Result<(), String>,
) -> (bool, bool) {
    let granted = gate.permission.swap(false, Ordering::SeqCst);
    (
        granted && gate.generation.load(Ordering::SeqCst) == generation && ready().is_ok(),
        granted,
    )
}
pub fn handle(
    event: &tauri::RunEvent,
    gate: &Gate,
    generation: u64,
    ready: impl FnOnce() -> Result<(), String>,
    request: impl FnOnce(bool),
) -> Option<bool> {
    if let tauri::RunEvent::ExitRequested { api, .. } = event {
        let (allowed, granted) = consume(gate, generation, ready);
        if !allowed {
            api.prevent_exit();
            request(granted);
        }
        Some(allowed)
    } else {
        None
    }
}
pub fn handle_window_close(event: &tauri::WindowEvent, request: impl FnOnce()) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        request();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_menu_needs_fresh_grant_and_rechecks_consumed_permission() {
        let p = Gate::default();
        assert_eq!(consume(&p, 1, || Ok(())), (false, false));
        assert!(authorize(&p, 1, || Err("pending credential write".into())).is_err());
        authorize(&p, 1, || Ok(())).unwrap();
        assert_eq!(consume(&p, 2, || Ok(())), (false, true));
        assert_eq!(consume(&p, 2, || Ok(())), (false, false));
        authorize(&p, 2, || Ok(())).unwrap();
        assert_eq!(consume(&p, 2, || Err("new save".into())), (false, true));
        authorize(&p, 3, || Ok(())).unwrap();
        assert_eq!(consume(&p, 3, || Ok(())), (true, true));
        assert_eq!(consume(&p, 3, || Ok(())), (false, false));
    }
}
