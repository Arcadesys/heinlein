//! Action bookkeeping only: a genuine plugin response is still required by the caller.
//! No lock is held across the public action; Condvar waiting releases the lock.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Condvar, Mutex,
};
use std::time::{Duration, Instant};

struct State {
    issued: [bool; 6],
    returned: [bool; 6],
    terminal: bool,
}
pub(super) struct ActionCompletion {
    state: Mutex<State>,
    changed: Condvar,
    returned_phase: AtomicUsize,
}
impl ActionCompletion {
    pub(super) const fn new() -> Self {
        Self {
            state: Mutex::new(State {
                issued: [false; 6],
                returned: [false; 6],
                terminal: false,
            }),
            changed: Condvar::new(),
            returned_phase: AtomicUsize::new(0),
        }
    }
    pub(super) fn issued(&self, phase: usize) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Action bookkeeping poisoned")?;
        if state.terminal
            || !(1..=5).contains(&phase)
            || state.issued[phase]
            || (phase > 1 && !state.returned[phase - 1])
        {
            state.terminal = true;
            self.changed.notify_all();
            return Err("Duplicate, terminal or out-of-order public action");
        }
        state.issued[phase] = true;
        Ok(())
    }
    pub(super) fn returned(&self, phase: usize) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Action bookkeeping poisoned")?;
        if state.terminal
            || !(1..=5).contains(&phase)
            || !state.issued[phase]
            || state.returned[phase]
        {
            state.terminal = true;
            self.changed.notify_all();
            return Err("Unexpected public action return");
        }
        // Publish the count before waking the command worker/validating its real response.
        self.returned_phase.store(phase, Ordering::SeqCst);
        state.returned[phase] = true;
        self.changed.notify_all();
        Ok(())
    }
    pub(super) fn count(&self) -> usize {
        self.returned_phase.load(Ordering::SeqCst)
    }
    pub(super) fn terminate(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.terminal = true;
        }
        self.changed.notify_all();
    }
    // Only the native command's off-main worker may call this method.
    pub(super) fn wait_returned(
        &self,
        phase: usize,
        timeout: Duration,
    ) -> Result<(), &'static str> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Action bookkeeping poisoned")?;
        if !(1..=5).contains(&phase) || !state.issued[phase] {
            state.terminal = true;
            self.changed.notify_all();
            return Err("Plugin response without a matching issued action");
        }
        loop {
            if state.terminal {
                return Err("Action completion terminated");
            }
            if state.returned[phase] {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.terminal = true;
                self.changed.notify_all();
                return Err("Public action return timed out");
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| "Action bookkeeping poisoned")?;
            state = next;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    #[test]
    fn real_result_before_action_return_waits_without_marking_completion() {
        let action = Arc::new(ActionCompletion::new());
        action.issued(1).unwrap();
        let (entered, ready) = mpsc::channel();
        let (finished, result) = mpsc::channel();
        let worker = action.clone();
        let join = std::thread::spawn(move || {
            entered.send(()).unwrap();
            let value = worker.wait_returned(1, Duration::from_secs(2));
            finished.send(value).unwrap();
        });
        ready.recv().unwrap();
        assert_eq!(action.count(), 0);
        assert!(result.try_recv().is_err());
        action.returned(1).unwrap();
        assert_eq!(result.recv_timeout(Duration::from_secs(2)).unwrap(), Ok(()));
        join.join().unwrap();
        assert_eq!(action.count(), 1);
    }
    #[test]
    fn action_return_before_real_result_is_retained_for_later_waiter() {
        let action = ActionCompletion::new();
        action.issued(1).unwrap();
        action.returned(1).unwrap();
        assert_eq!(action.wait_returned(1, Duration::ZERO), Ok(()));
        assert_eq!(action.count(), 1);
    }
    #[test]
    fn timeout_is_terminal_and_late_return_cannot_complete() {
        let action = ActionCompletion::new();
        action.issued(1).unwrap();
        assert!(action.wait_returned(1, Duration::ZERO).is_err());
        assert!(action.returned(1).is_err());
        assert_eq!(action.count(), 0);
    }
    #[test]
    fn failure_or_abort_wakes_waiter_without_a_success_ack() {
        let action = Arc::new(ActionCompletion::new());
        action.issued(1).unwrap();
        let worker = action.clone();
        let join = std::thread::spawn(move || worker.wait_returned(1, Duration::from_secs(2)));
        action.terminate();
        assert!(join.join().unwrap().is_err());
        assert_eq!(action.count(), 0);
    }
    #[test]
    fn duplicate_reentrant_and_out_of_order_actions_fail_closed() {
        for phase in [1, 2] {
            let action = ActionCompletion::new();
            action.issued(1).unwrap();
            assert!(action.issued(phase).is_err());
            assert!(action.returned(1).is_err());
            assert_eq!(action.count(), 0);
        }
        let action = ActionCompletion::new();
        assert!(action.returned(1).is_err());
        let action = ActionCompletion::new();
        assert!(action.wait_returned(1, Duration::ZERO).is_err());
    }
    #[test]
    fn alert_uses_same_ordered_phase_protocol_without_double_action() {
        let action = ActionCompletion::new();
        for phase in 1..=3 {
            action.issued(phase).unwrap();
            action.returned(phase).unwrap();
        }
        assert_eq!(action.wait_returned(3, Duration::ZERO), Ok(()));
        assert!(action.returned(3).is_err());
        assert_eq!(action.count(), 3);
    }
}
