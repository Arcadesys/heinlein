//! Display-only review activity. Partial provider text never crosses this channel.
use drafting_questions::review_workflow::Coverage;
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewProgress {
    request_id: String,
    completed_calls: usize,
    total_calls: usize,
    reviewer: usize,
    source_index: usize,
    chunk_index: usize,
    status: String,
    received_bytes: usize,
    suggestions: usize,
}

pub(super) struct Reporter {
    event: ReviewProgress,
    channel: Option<tauri::ipc::Channel<ReviewProgress>>,
    last_sent: Option<Instant>,
}

impl Reporter {
    pub(super) fn new(
        request_id: String,
        channel: Option<tauri::ipc::Channel<ReviewProgress>>,
    ) -> Self {
        Self {
            event: ReviewProgress {
                request_id,
                completed_calls: 0,
                total_calls: 0,
                reviewer: 0,
                source_index: 0,
                chunk_index: 0,
                status: "running".into(),
                received_bytes: 0,
                suggestions: 0,
            },
            channel,
            last_sent: None,
        }
    }
    pub(super) fn transition(
        &mut self,
        call: &Coverage,
        coverage: &[Coverage],
        suggestions: usize,
    ) {
        self.event.completed_calls = coverage.iter().filter(|c| c.status == "completed").count();
        self.event.total_calls = coverage.len();
        self.event.reviewer = call.reviewer;
        self.event.source_index = call.source_index;
        self.event.chunk_index = coverage.iter().position(|c| c.id == call.id).unwrap_or(0) + 1;
        self.event.status = call.status.clone();
        self.event.suggestions = suggestions;
        self.event.received_bytes = 0;
        self.last_sent = None;
        self.send();
    }
    pub(super) fn receiving(&mut self, bytes: usize) {
        if !matches!(self.event.status.as_str(), "running" | "receiving")
            || bytes <= self.event.received_bytes
        {
            return;
        }
        self.event.received_bytes = bytes;
        self.event.status = "receiving".into();
        if self
            .last_sent
            .is_none_or(|time| time.elapsed() >= Duration::from_millis(250))
        {
            self.send();
            self.last_sent = Some(Instant::now());
        }
    }
    fn send(&self) {
        if let Some(channel) = &self.channel {
            // A hidden/disposed renderer must not turn a safely persisted call into a failure.
            let _ = channel.send(self.event.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_persisted_coverage_and_counts_without_partial_text() {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let received = events.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                received
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str::<serde_json::Value>(&body).unwrap());
            }
            Ok(())
        });
        let mut reporter = Reporter::new("batch".into(), Some(channel));
        let mut coverage = Coverage {
            context_ranges: vec![],
            id: "chunk".into(),
            source_index: 0,
            from_utf8: 0,
            to_utf8: 8,
            window_from: 0,
            window_to: 8,
            reviewer: 1,
            status: "running".into(),
            request_id: Some("call".into()),
            error: None,
        };
        reporter.transition(&coverage, &[coverage.clone()], 0);
        reporter.receiving("private 🐺 response".len());
        let event = serde_json::to_value(&reporter.event).unwrap();
        assert_eq!(event["status"], "receiving");
        assert_eq!(event["receivedBytes"], "private 🐺 response".len());
        assert!(!event.to_string().contains("private"));
        coverage.status = "completed".into();
        reporter.transition(&coverage, &[coverage.clone()], 2);
        reporter.receiving(1000);
        assert_eq!(reporter.event.completed_calls, 1);
        assert_eq!(reporter.event.suggestions, 2);
        assert_eq!(reporter.event.status, "completed");
        assert_eq!(reporter.event.received_bytes, 0);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["status"], "running");
        assert_eq!(events[1]["status"], "receiving");
        assert_eq!(events[2]["completedCalls"], 1);
        assert_eq!(events[2]["suggestions"], 2);
    }
}
