//! Pure manual callback contract. No UI, path resolution, filesystem access or timers.
use std::path::Path;
pub const MODE: &str = "picker-manual-preview";
pub fn supported(mode: &str) -> bool {
    matches!(mode, "first" | "reopen") || mode == MODE
}
pub fn diagnostic_allowed(stage: &str) -> bool {
    matches!(
        stage,
        "seed-identity"
            | "picker-cancel-real-null"
            | "picker-preview-real-token"
            | "request-close-from-production"
            | "renderer-failed"
            | "validation-failed"
    )
}
#[derive(Default)]
pub struct Manual {
    pub observation_nonce: Option<String>,
    pub completed: usize,
    pub active: Option<usize>,
    pub failed: bool,
    pub token: bool,
    pub finished: bool,
}
impl Manual {
    fn reject<T>(&mut self) -> Result<T, String> {
        self.failed = true;
        Err("Manual callback order/path/token invalid; stop as incomplete".into())
    }
    pub fn observe(&mut self, line: &str) -> Result<String, String> {
        let Some(nonce) = line.strip_prefix("observation-ready ") else { return self.reject(); };
        // Exact one bounded UUID line. This channel is owned by the proof-validating collector.
        let valid = nonce.len() == 36 && nonce.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_digit() || (b'a'..=b'f').contains(&b) }
        });
        if !valid || self.failed || self.observation_nonce.is_some() || self.completed != 0 || self.active.is_some() || self.finished {
            return self.reject();
        }
        self.observation_nonce = Some(nonce.to_owned());
        Ok(nonce.to_owned())
    }
    pub fn begin(&mut self) -> Result<usize, String> {
        if self.failed || self.observation_nonce.is_none() || self.active.is_some() || self.completed >= 2 {
            return self.reject();
        }
        let phase = self.completed + 1;
        self.active = Some(phase);
        Ok(phase)
    }
    pub fn returned(
        &mut self,
        phase: usize,
        candidate: Option<&Path>,
        expected: &Path,
    ) -> Result<(), String> {
        // OsStr equality is lexical; do not normalize aliases, resolve URLs, or touch candidate metadata.
        let valid = match (phase, candidate) {
            (1, None) => true,
            (2, Some(path)) => path.is_absolute() && path.as_os_str() == expected.as_os_str(),
            _ => false,
        };
        if self.failed || self.active != Some(phase) || phase != self.completed + 1 || !valid {
            return self.reject();
        }
        self.active = None;
        self.completed += 1;
        Ok(())
    }
    pub fn retain_token(&mut self, token: &str) -> Result<(), String> {
        if self.failed
            || self.completed != 2
            || self.active.is_some()
            || self.token
            || token.is_empty()
        {
            return self.reject();
        }
        self.token = true;
        Ok(())
    }
    pub fn finish(&mut self, exact_no_copy: bool) -> Result<(), String> {
        if self.failed
            || self.completed != 2
            || !self.token
            || self.active.is_some()
            || self.finished
            || !exact_no_copy
        {
            return self.reject();
        }
        self.finished = true;
        Ok(())
    }
}
// The same gate surrounds native readback; no mutex is held across filesystem work.
pub fn finish_guarded<T>(
    manual: &std::sync::Mutex<Manual>,
    readback_mask: impl Fn() -> usize,
    session_failed: impl Fn() -> bool,
    final_readback: impl FnOnce() -> Result<(T, bool), String>,
) -> Result<T, String> {
    {
        let mut m = manual.lock().unwrap();
        if session_failed()
            || readback_mask() != 6
            || m.failed
            || m.completed != 2
            || m.active.is_some()
            || !m.token
            || m.finished
        {
            return m.reject();
        }
    }
    let (value, exact_no_copy) = final_readback()?;
    let mut m = manual.lock().unwrap();
    if session_failed() || readback_mask() != 14 {
        return m.reject();
    }
    m.finish(exact_no_copy)?;
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    const TARGET: &str = "/private/tmp/owned/copy-targets/draft.md";
    const NONCE: &str = "11111111-2222-4333-8444-555555555555";
    fn observed() -> Manual {
        let mut m = Manual::default();
        m.observe(&format!("observation-ready {NONCE}")).unwrap();
        m
    }
    fn ready() -> Manual {
        let mut m = observed();
        let p = m.begin().unwrap();
        m.returned(p, None, Path::new(TARGET)).unwrap();
        m
    }
    #[test]
    fn observation_required_once_before_any_picker_action() {
        let mut m = Manual::default();
        assert!(m.begin().is_err()); // Premature IPC latches failure, cannot recover later.
        assert!(m.observe(&format!("observation-ready {NONCE}")).is_err());
        let mut m = observed();
        assert!(m.observe(&format!("observation-ready {NONCE}")).is_err());
        let mut m = ready();
        assert!(m.observe(&format!("observation-ready {NONCE}")).is_err());
        for line in ["", "observation-ready bad", "abort", "observation-ready 11111111-2222-4333-8444-555555555555\nextra"] {
            let mut m = Manual::default();
            assert!(m.observe(line).is_err());
            assert!(m.begin().is_err());
        }
        let mut m = observed();
        assert_eq!(m.observation_nonce.as_deref(), Some(NONCE));
        assert_eq!(m.begin().unwrap(), 1);
    }
    #[test]
    fn legacy_auto_quit_diagnostics_are_not_manual_authority() {
        for stage in [
            "save-IPC-queued",
            "reopened-exact-bytes-same-id",
            "picker-all-evidence-ready",
            "picker-copy-real-receipt",
        ] {
            assert!(!diagnostic_allowed(stage));
        }
        assert!(diagnostic_allowed("picker-preview-real-token"));
    }
    #[test]
    fn exact_mode_only_and_automated_modes_rejected() {
        for m in [
            "picker",
            "picker-reopen",
            "picker-preview-only",
            "picker-d1",
            "picker-manual-preview-extra",
            "",
        ] {
            assert!(!supported(m));
        }
        assert!(supported(MODE));
        assert!(supported("first"));
        assert!(supported("reopen"));
    }
    #[test]
    fn genuine_order_token_then_finish() {
        let mut m = ready();
        let p = m.begin().unwrap();
        assert_eq!(m.completed, 1);
        m.returned(p, Some(Path::new(TARGET)), Path::new(TARGET))
            .unwrap();
        m.retain_token("real-token").unwrap();
        m.finish(true).unwrap();
        assert!(m.finished);
        assert!(m.finish(true).is_err());
    }
    #[test]
    fn unexpected_null_duplicate_concurrent_and_order_fail_closed() {
        let mut m = ready();
        let p = m.begin().unwrap();
        assert!(m.returned(p, None, Path::new(TARGET)).is_err());
        let mut m = observed();
        m.begin().unwrap();
        assert!(m.begin().is_err());
        let mut m = observed();
        m.begin().unwrap();
        assert!(m
            .returned(1, Some(Path::new(TARGET)), Path::new(TARGET))
            .is_err());
        let mut m = ready();
        assert!(m.returned(1, None, Path::new(TARGET)).is_err());
        assert!(ready().finish(true).is_err());
    }
    fn token_ready() -> Manual {
        let mut m = ready();
        let phase = m.begin().unwrap();
        m.returned(phase, Some(Path::new(TARGET)), Path::new(TARGET))
            .unwrap();
        m.retain_token("actual-token").unwrap();
        m
    }
    #[test]
    fn finish_missing_delayed_or_failed_evidence_never_reaches_readback_or_quit() {
        use std::{cell::Cell, sync::Mutex};
        for mask in [0, 2, 4] {
            // skipped Cancel, skipped Save, and delayed prior readback.
            let m = Mutex::new(token_ready());
            let readbacks = Cell::new(0);
            let quits = Cell::new(0);
            let result = finish_guarded(
                &m,
                || mask,
                || false,
                || {
                    readbacks.set(readbacks.get() + 1);
                    Ok(((), true))
                },
            );
            if result.is_ok() {
                quits.set(quits.get() + 1);
            }
            assert!(result.is_err());
            assert_eq!(readbacks.get(), 0);
            assert_eq!(quits.get(), 0);
            assert!(!m.lock().unwrap().finished);
        }
        for source in 0..3 {
            // actual call site combines FIXTURE.abort, picker failure, Manual.failed.
            let mut state = token_ready();
            if source == 2 {
                state.failed = true;
            }
            let m = Mutex::new(state);
            let readbacks = Cell::new(0);
            let result = finish_guarded(
                &m,
                || 6,
                || source < 2,
                || {
                    readbacks.set(1);
                    Ok(((), true))
                },
            );
            assert!(result.is_err());
            assert_eq!(readbacks.get(), 0);
            assert!(!m.lock().unwrap().finished);
        }
    }
    #[test]
    fn finish_valid_evidence_unchanged_and_failure_during_readback_cannot_finish() {
        use std::{cell::Cell, sync::Mutex};
        for fail_after in [false, true] {
            let mask = Cell::new(6);
            let failed = Cell::new(false);
            let readbacks = Cell::new(0);
            let m = Mutex::new(token_ready());
            let result = finish_guarded(
                &m,
                || mask.get(),
                || failed.get(),
                || {
                    readbacks.set(1);
                    mask.set(14);
                    failed.set(fail_after);
                    Ok(("actual-readback", true))
                },
            );
            assert_eq!(readbacks.get(), 1);
            assert_eq!(result.is_ok(), !fail_after);
            assert_eq!(m.lock().unwrap().finished, !fail_after);
        }
    }
    #[test]
    fn lexical_aliases_and_external_candidates_fail_before_any_io() {
        for candidate in [
            "/outside/draft.md",
            "/private/tmp/owned/copy-targets/./draft.md",
            "/private/tmp/owned/copy-targets/../copy-targets/draft.md",
            "file:///private/tmp/owned/copy-targets/draft.md",
            "draft.md",
        ] {
            let mut m = ready();
            let p = m.begin().unwrap();
            assert!(m
                .returned(p, Some(Path::new(candidate)), Path::new(TARGET))
                .is_err());
        }
    }
}
