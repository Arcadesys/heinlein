//! Validated writing-window parent shared by native confirmation builders.
use crate::check_window;
use tauri::Manager;

fn ensure_off_main() -> Result<(), String> {
    #[link(name = "System")]
    extern "C" {
        fn pthread_main_np() -> i32;
    }
    if unsafe { pthread_main_np() } != 0 {
        return Err("Blocking native confirmation cannot run on the main thread".into());
    }
    Ok(())
}

/// Cache both fallible public handles before passing them to the dialog plugin.
/// The plugin's parent() otherwise silently falls back to an unparented alert.
/// Caller MUST hold the existing selection/close-exclusion guard from capture
/// through dialog completion. No direct destroy/hide/replacement is permitted.
/// This borrow retains the exact owning window; dirty notifications remain live.
pub(crate) struct ValidatedConfirmationParent<'a> {
    _window: &'a tauri::WebviewWindow,
    window: raw_window_handle::WindowHandle<'a>,
    display: raw_window_handle::DisplayHandle<'a>,
}
impl<'a> ValidatedConfirmationParent<'a> {
    pub(crate) fn check_on_main(&self, app: &tauri::AppHandle) -> Result<(), String> {
        ensure_off_main()?;
        let window = self._window.clone();
        let app_handle = app.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = (|| {
                check_window(&window)?;
                let current = app_handle
                    .get_webview_window("main")
                    .ok_or("Writing window closed")?;
                if !window
                    .is_visible()
                    .map_err(|_| "Writing window unavailable")?
                    || window
                        .ns_window()
                        .map_err(|_| "Writing window unavailable")?
                        .is_null()
                    || current.ns_window().map_err(|_| "Writing window changed")?
                        != window
                            .ns_window()
                            .map_err(|_| "Writing window unavailable")?
                {
                    return Err("Keep the original writing window open for confirmation".into());
                }
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|_| "Writing window cannot present confirmation")?;
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "Writing window did not acknowledge confirmation")?
    }
    pub(crate) fn capture(
        app: &tauri::AppHandle,
        window: &'a tauri::WebviewWindow,
    ) -> Result<Self, String> {
        ensure_off_main()?;
        use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
        check_window(window)?;
        let current = app
            .get_webview_window("main")
            .ok_or("Writing window is unavailable")?;
        if &current != window
            || !current
                .is_visible()
                .map_err(|_| "Writing window is unavailable")?
        {
            return Err("Keep the writing window open for confirmation".into());
        }
        let window_handle = window
            .window_handle()
            .map_err(|_| "Writing window handle is unavailable")?;
        if current
            .window_handle()
            .map_err(|_| "Current writing window is unavailable")?
            .as_raw()
            != window_handle.as_raw()
        {
            return Err("Writing window changed before confirmation".into());
        }
        let display = window
            .display_handle()
            .map_err(|_| "Writing display handle is unavailable")?;
        check_window(&current)?;
        Ok(Self {
            _window: window,
            window: window_handle,
            display,
        })
    }
}
impl raw_window_handle::HasWindowHandle for ValidatedConfirmationParent<'_> {
    fn window_handle(
        &self,
    ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        Ok(self.window)
    }
}
impl raw_window_handle::HasDisplayHandle for ValidatedConfirmationParent<'_> {
    fn display_handle(
        &self,
    ) -> Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError> {
        Ok(self.display)
    }
}
