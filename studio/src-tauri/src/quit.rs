//! Shared normal application-exit route, including native menu/shortcut Quit.
use std::sync::atomic::{AtomicBool, Ordering};
pub fn authorize(
    permission: &AtomicBool,
    ready: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    ready()?;
    permission.store(true, Ordering::SeqCst);
    Ok(())
}
pub fn consume(permission: &AtomicBool, ready: impl FnOnce() -> Result<(), String>) -> bool {
    permission.swap(false, Ordering::SeqCst) && ready().is_ok()
}
pub fn handle(
    event: &tauri::RunEvent,
    permission: &AtomicBool,
    ready: impl FnOnce() -> Result<(), String>,
    request: impl FnOnce(),
) -> Option<bool> {
    if let tauri::RunEvent::ExitRequested { api, .. } = event {
        let allowed = consume(permission, ready);
        if !allowed {
            api.prevent_exit();
            request();
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
    fn normal_menu_needs_author_grant_and_rechecks_consumed_permission() {
        let p = AtomicBool::new(false);
        assert!(!consume(&p, || Ok(())));
        assert!(authorize(&p, || Err("pending credential write".into())).is_err());
        assert!(!p.load(Ordering::SeqCst));
        authorize(&p, || Ok(())).unwrap();
        assert!(!consume(&p, || Err("new save".into())));
        assert!(!consume(&p, || Ok(())));
        authorize(&p, || Ok(())).unwrap();
        assert!(consume(&p, || Ok(())));
        assert!(!consume(&p, || Ok(())));
    }
}
