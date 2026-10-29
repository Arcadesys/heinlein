//! Compile-gated, in-memory updater bytes. No OS commands, paths, network or account store.
use super::update::Action;
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::Emitter;

#[derive(Default)]
struct State {
    calls: Vec<String>,
    checks: u64,
    scheduled: bool,
    held: Option<u64>,
    released: bool,
}
#[derive(Default)]
pub(super) struct Script {
    state: Mutex<State>,
    wake: Condvar,
    app: Mutex<Option<tauri::AppHandle>>,
}
impl Script {
    pub(super) fn attach(&self, app: tauri::AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }
    fn observe(&self, value: serde_json::Value) {
        println!("{}", serde_json::json!({"kind":"backend", "value":value}));
        if let Some(app) = self.app.lock().unwrap().as_ref() {
            let _ = app.emit("native42-backend", value);
        }
    }
    pub(super) fn release(&self, index: u64) -> Result<(), String> {
        let mut s = self.state.lock().map_err(|_| "Script state unavailable")?;
        if s.held != Some(index) || s.released {
            return Err("Unknown or duplicate synthetic release".into());
        }
        s.released = true;
        self.wake.notify_all();
        Ok(())
    }
    pub(super) fn summary(&self) -> serde_json::Value {
        let s = self.state.lock().unwrap();
        serde_json::json!({"calls":s.calls,"checks":s.checks,"scheduledInMemory":s.scheduled,"held":s.held,"realUpdaterExecutions":0})
    }
    pub(super) fn respond(&self, action: Action) -> Result<Vec<u8>, String> {
        let mut s = self.state.lock().map_err(|_| "Script state unavailable")?;
        let label = match action {
            Action::Status => "status",
            Action::Check => "check",
            Action::Schedule => "schedule",
        };
        s.calls.push(label.into());
        let mut index = 0;
        if label == "check" {
            s.checks += 1;
            index = s.checks;
        }
        if label == "schedule" {
            if s.checks != 3 || s.scheduled {
                return Err("Unexpected synthetic schedule".into());
            }
            s.scheduled = true;
        }
        let held = label == "check" && [1, 3].contains(&index);
        if held {
            s.held = Some(index);
            s.released = false;
        }
        self.observe(
            serde_json::json!({"stage":"entered","action":label,"index":index,"held":held}),
        );
        if held {
            let (next, timeout) = self
                .wake
                .wait_timeout_while(s, Duration::from_secs(12), |s| !s.released)
                .map_err(|_| "Synthetic wait failed")?;
            s = next;
            if timeout.timed_out() || !s.released {
                return Err("Synthetic backend release timed out".into());
            }
            s.held = None;
        }
        let state = if label == "check" && held {
            "fetch-failed"
        } else if s.scheduled {
            "scheduled"
        } else if s.checks == 0 {
            "not-checked"
        } else {
            "available"
        };
        let bytes = serde_json::to_vec(&serde_json::json!({"state":state,"commit":"1111111111111111111111111111111111111111","tree":"2222222222222222222222222222222222222222","availableCommit":if s.checks>0{Some("3333333333333333333333333333333333333333")}else{None},"availableTree":if s.checks>0{Some("4444444444444444444444444444444444444444")}else{None},"generation":7})).map_err(|_| "Synthetic serialization failed")?;
        self.observe(
            serde_json::json!({"stage":"returned","action":label,"index":index,"state":state}),
        );
        Ok(bytes)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_requires_the_exact_held_action_once() {
        let s = Script::default();
        assert!(s.release(1).is_err());
        {
            s.state.lock().unwrap().held = Some(3);
        }
        assert!(s.release(1).is_err());
        assert!(s.release(3).is_ok());
        assert!(s.release(3).is_err());
    }
    #[test]
    fn inert_script_has_no_real_updater_and_refuses_early_schedule() {
        let script = std::sync::Arc::new(Script::default());
        let runtime = super::super::update::Runtime::synthetic(script.clone());
        // Native memory checks are placed below private execute guards in update.rs tests.
        assert_eq!(script.summary()["realUpdaterExecutions"], 0);
        assert!(runtime.idle().is_ok());
        assert!(script.respond(Action::Status).is_ok());
        assert!(script.respond(Action::Schedule).is_err());
    }
    #[test]
    fn held_failure_then_explicit_retry_and_schedule_are_counted() {
        let script = std::sync::Arc::new(Script::default());
        for index in [1, 3] {
            let child = script.clone();
            let thread = std::thread::spawn(move || child.respond(Action::Check));
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while script.state.lock().unwrap().held != Some(index) {
                assert!(std::time::Instant::now() < deadline);
                std::thread::yield_now();
            }
            script.release(index).unwrap();
            let value: serde_json::Value =
                serde_json::from_slice(&thread.join().unwrap().unwrap()).unwrap();
            assert_eq!(value["state"], "fetch-failed");
            if index == 1 {
                let value: serde_json::Value =
                    serde_json::from_slice(&script.respond(Action::Check).unwrap()).unwrap();
                assert_eq!(value["state"], "available");
            }
        }
        let value: serde_json::Value =
            serde_json::from_slice(&script.respond(Action::Schedule).unwrap()).unwrap();
        assert_eq!(value["state"], "scheduled");
        assert!(script.respond(Action::Schedule).is_err());
        assert_eq!(script.summary()["realUpdaterExecutions"], 0);
    }
}
