//! Bounded Review definitions, chunk coordinates and serial batches. No file/tool authority.
use crate::{review::*, *};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewerDefinition {
    pub id: String,
    pub version: u32,
    pub display_name: String,
    pub instructions: String,
}
pub fn definitions() -> Vec<ReviewerDefinition> {
    vec![ReviewerDefinition{id:"mechanical".into(),version:1,display_name:"Mechanical review".into(),instructions:"Suggest only clear mechanical corrections. Preserve intentional style and expressive choices. No findings is valid.".into()},ReviewerDefinition{id:"contextual".into(),version:1,display_name:"Story and clarity review".into(),instructions:"Suggest small contextual clarity improvements. Consider continuity and story intent; do not invent canon or rewrite intentional voice. No findings is valid.".into()}]
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditableRange {
    pub path: String,
    pub from_utf8: usize,
    pub to_utf8: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub reviewers: Vec<String>,
    #[serde(default)]
    pub context: Vec<ReviewSnapshot>,
    #[serde(default)]
    pub context_note: String,
    #[serde(default)]
    pub ranges: Vec<EditableRange>,
    #[serde(default)]
    pub review_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextRange {
    pub source_index: usize,
    pub from_utf8: usize,
    pub to_utf8: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Coverage {
    #[serde(default)]
    pub context_ranges: Vec<ContextRange>,
    pub id: String,
    pub source_index: usize,
    pub from_utf8: usize,
    pub to_utf8: usize,
    pub window_from: usize,
    pub window_to: usize,
    pub reviewer: usize,
    pub status: String,
    pub request_id: Option<String>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallResult {
    #[serde(default)]
    pub provider_response_id: Option<String>,
    pub coverage: Coverage,
    pub edits: Vec<ReviewEdit>,
    pub model: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    pub calls: Vec<CallResult>,
    pub cancelled: bool,
    #[serde(default)]
    pub limit_reached: bool,
}
fn invalid() -> QuestionError {
    QuestionError::new("invalidReviewScope","Choose 1–3 reviewers and at most 1 MiB of selected source, 128 chunks, and 4,000 UTF-8 bytes of additional author notes. Nothing is truncated.")
}
pub fn validate(r: &ReviewRequest) -> Result<(), QuestionError> {
    let o = r.workflow.as_ref().ok_or_else(invalid)?;
    if !valid_id(&r.request_id)
        || r.repository_id.is_empty()
        || r.repository_id.len() > 1024
        || r.snapshots.is_empty()
        || r.snapshots.len() + o.context.len() > 128
        || o.reviewers.is_empty()
        || o.reviewers.len() > 3
        || o.reviewers.iter().any(|id| {
            id.is_empty()
                || id.len() > 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
    {
        return Err(invalid());
    }
    let mut paths = std::collections::HashSet::new();
    let mut bytes = o.context_note.len();
    for (s, readonly) in r
        .snapshots
        .iter()
        .map(|s| (s, false))
        .chain(o.context.iter().map(|s| (s, true)))
    {
        if s.path.is_empty()
            || s.path.len() > 1024
            || s.path.starts_with('/')
            || s.path.contains('\\')
            || s.path.chars().any(char::is_control)
            || s.path
                .split('/')
                .any(|p| p.is_empty() || matches!(p, "." | "..") || p.contains(':'))
            || !paths.insert(&s.path)
            || s.source_hash.is_empty()
            || s.source_hash.len() != 64
            || !s.source_hash.bytes().all(|b| b.is_ascii_hexdigit())
            || s.scene_id.as_ref().is_some_and(|id| {
                id.is_empty() || id.len() > 128 || id.chars().any(char::is_control)
            })
            || s.source.is_empty()
        {
            return Err(invalid());
        }
        bytes = bytes.checked_add(s.source.len()).ok_or_else(invalid)?;
        let _ = readonly;
    }
    if bytes > 1024 * 1024 || o.context_note.len() > 4000 {
        return Err(invalid());
    }
    if o.ranges.len() > 128 {
        return Err(invalid());
    }
    for (index, range) in o.ranges.iter().enumerate() {
        let s = r
            .snapshots
            .iter()
            .find(|s| s.path == range.path)
            .ok_or_else(invalid)?;
        if range.from_utf8 > range.to_utf8
            || range.to_utf8 > s.source.len()
            || !s.source.is_char_boundary(range.from_utf8)
            || !s.source.is_char_boundary(range.to_utf8)
            || boundary(&s.source, range.from_utf8, false) != range.from_utf8
            || boundary(&s.source, range.to_utf8, false) != range.to_utf8
            || o.ranges[..index].iter().any(|other| {
                other.path == range.path
                    && overlaps(
                        other.from_utf8,
                        other.to_utf8,
                        range.from_utf8,
                        range.to_utf8,
                    )
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn boundary(s: &str, mut at: usize, forward: bool) -> usize {
    while !s.is_char_boundary(at)
        || (at > 0
            && s.as_bytes().get(at - 1) == Some(&b'\r')
            && s.as_bytes().get(at) == Some(&b'\n'))
    {
        if forward {
            at += 1
        } else {
            at -= 1
        }
    }
    at
}
pub fn plan(r: &ReviewRequest) -> Result<Vec<Coverage>, QuestionError> {
    validate(r)?;
    let o = r.workflow.as_ref().unwrap();
    let context_bytes = o.context.iter().map(|s| s.source.len()).sum::<usize>();
    let context_budget = if context_bytes == 0 {
        0
    } else {
        context_bytes.div_ceil(127) + 8
    };
    let core_budget = 16000usize
        .checked_sub(o.context_note.len() + context_budget + 1000)
        .filter(|v| *v >= 4)
        .ok_or_else(invalid)?;
    let mut contexts: Vec<Vec<ContextRange>> = Vec::new();
    let mut current = Vec::new();
    let mut available = context_budget;
    for (index, s) in o.context.iter().enumerate() {
        let mut at = 0;
        while at < s.source.len() {
            let end = boundary(&s.source, (at + available).min(s.source.len()), false);
            if end == at {
                contexts.push(std::mem::take(&mut current));
                available = context_budget;
                continue;
            }
            current.push(ContextRange {
                source_index: index,
                from_utf8: at,
                to_utf8: end,
            });
            available -= end - at;
            at = end;
            if available == 0 {
                contexts.push(std::mem::take(&mut current));
                available = context_budget;
            }
        }
    }
    if !current.is_empty() {
        contexts.push(current)
    }
    let mut cores = Vec::new();
    for (index, s) in r.snapshots.iter().enumerate() {
        let ranges = if o.ranges.is_empty() {
            vec![EditableRange {
                path: s.path.clone(),
                from_utf8: 0,
                to_utf8: s.source.len(),
            }]
        } else {
            o.ranges
                .iter()
                .filter(|p| p.path == s.path)
                .cloned()
                .collect()
        };
        for range in ranges {
            let mut at = range.from_utf8;
            loop {
                let mut end = boundary(&s.source, (at + core_budget).min(range.to_utf8), false);
                if end < range.to_utf8 {
                    if let Some(cut) = s.source[at..end].rfind("\n\n") {
                        if cut >= core_budget * 9 / 10 {
                            end = at + cut + 2;
                        }
                    }
                }
                cores.push((
                    index,
                    at,
                    end,
                    boundary(&s.source, at.saturating_sub(500), true),
                    boundary(&s.source, (end + 500).min(s.source.len()), false),
                ));
                if end == range.to_utf8 {
                    break;
                }
                if end <= at {
                    return Err(invalid());
                }
                at = end;
            }
        }
    }
    if cores.is_empty() {
        return Err(invalid());
    }
    let jobs = cores.len().max(contexts.len());
    if jobs > 128 {
        return Err(invalid());
    }
    let mut calls = Vec::new();
    for index in 0..jobs {
        let (source_index, from_utf8, to_utf8, window_from, window_to) = cores[index % cores.len()];
        let context_ranges = if contexts.is_empty() {
            vec![]
        } else {
            contexts[index % contexts.len()].clone()
        };
        for reviewer in 0..o.reviewers.len() {
            calls.push(Coverage {
                context_ranges: context_ranges.clone(),
                id: format!("chunk-{index}-reviewer-{reviewer}"),
                source_index,
                from_utf8,
                to_utf8,
                window_from,
                window_to,
                reviewer,
                status: "queued".into(),
                request_id: None,
                error: None,
            });
        }
    }
    Ok(calls)
}
pub fn overlaps(a: usize, b: usize, c: usize, d: usize) -> bool {
    if a == b || c == d {
        a <= d && c <= b
    } else {
        a < d && c < b
    }
}
impl QuestionService {
    // Keep the captured authority, persisted coverage and explicit dispatch budget visible.
    #[allow(clippy::too_many_arguments)]
    pub async fn review_batch_reserved<P>(
        &self,
        request: ReviewRequest,
        config: Configuration,
        permit: QuestionPermit,
        coverage: Vec<Coverage>,
        defs: Vec<ReviewerDefinition>,
        remaining: usize,
        progress: P,
    ) -> Result<Batch, QuestionError>
    where
        P: FnMut(&CallResult) -> Result<(), QuestionError>,
    {
        self.review_batch_with(
            request,
            config,
            permit,
            coverage,
            defs,
            remaining,
            progress,
            send_request,
            REQUEST_TIMEOUT,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn review_batch_with<F, Fut, P>(
        &self,
        request: ReviewRequest,
        config: Configuration,
        permit: QuestionPermit,
        coverage: Vec<Coverage>,
        defs: Vec<ReviewerDefinition>,
        mut remaining: usize,
        mut progress: P,
        mut transport: F,
        timeout: Duration,
    ) -> Result<Batch, QuestionError>
    where
        F: FnMut(Configuration, Vec<u8>) -> Fut,
        Fut: Future<Output = Result<Vec<u8>, QuestionError>>,
        P: FnMut(&CallResult) -> Result<(), QuestionError>,
    {
        validate(&request)?;
        let mut flight = permit.0;
        if !Arc::ptr_eq(&flight.state, &self.state)
            || flight.id != request.request_id
            || flight.account_id != config.account_id
        {
            return Err(QuestionError::invalid_request());
        }
        let mut changed = config.cancelled.clone();
        let mut calls = Vec::new();
        let mut cancelled = false;
        let mut limit_reached = remaining == 0;
        for mut coverage in coverage
            .into_iter()
            .filter(|c| matches!(c.status.as_str(), "queued" | "notRun"))
            .take(8)
        {
            if remaining == 0 {
                limit_reached = true;
                break;
            }
            if *flight.cancelled.borrow() {
                cancelled = true;
                break;
            }
            let source = &request.snapshots[coverage.source_index];
            let opts = request.workflow.as_ref().unwrap();
            let def = defs.get(coverage.reviewer).ok_or_else(invalid)?;
            if def.id != opts.reviewers[coverage.reviewer]
                || def.instructions.len() > 4000
                || def.version == 0
            {
                return Err(invalid());
            }
            let id = format!("call-{}-{}", request.request_id, calls.len());
            coverage.request_id = Some(id.clone());
            let mut sub = request.clone();
            sub.request_id = id;
            sub.scope = ReviewScope::Scene;
            sub.snapshots = vec![ReviewSnapshot {
                path: source.path.clone(),
                source: source.source[coverage.window_from..coverage.window_to].into(),
                source_hash: source.source_hash.clone(),
                scene_id: source.scene_id.clone(),
            }];
            sub.workflow.as_mut().unwrap().context = coverage
                .context_ranges
                .iter()
                .map(|range| {
                    let original = &opts.context[range.source_index];
                    ReviewSnapshot {
                        path: original.path.clone(),
                        source: original.source[range.from_utf8..range.to_utf8].into(),
                        source_hash: original.source_hash.clone(),
                        scene_id: original.scene_id.clone(),
                    }
                })
                .collect();
            sub.workflow.as_mut().unwrap().ranges = vec![EditableRange {
                path: source.path.clone(),
                from_utf8: coverage.from_utf8 - coverage.window_from,
                to_utf8: coverage.to_utf8 - coverage.window_from,
            }];
            let body = crate::review::workflow_body(&sub, &config.model, &def.instructions)?;
            coverage.status = "running".into();
            progress(&CallResult {
                provider_response_id: None,
                coverage: coverage.clone(),
                edits: vec![],
                model: config.model.clone(),
            })?;
            let answer = tokio::select! {biased;_=connection_changed(&mut changed)=>Err(QuestionError::stale_connection()),_=flight.cancelled.wait_for(|c|*c)=>{cancelled=true;Err(QuestionError::cancelled())},r=tokio::time::timeout(timeout,transport(config.clone(),body))=>match r{Ok(Ok(bytes))=>crate::review::parse_review(&sub,&bytes).map(|(answer,json)| { let value:serde_json::Value=serde_json::from_slice(&bytes).unwrap_or_default(); let provider_response_id=safe_request_id(value.get("id").and_then(|v|v.as_str())); (answer,json,provider_response_id) }),Ok(Err(e))=>Err(e),Err(_)=>Err(QuestionError::timeout())}};
            match answer {
                Ok((answer, json, provider_response_id)) => {
                    let mut output: ReviewOutput =
                        serde_json::from_str(&json).map_err(|_| invalid())?;
                    for edit in &mut output.edits {
                        edit.from_utf8 += coverage.window_from;
                        edit.to_utf8 += coverage.window_from;
                    }
                    if answer.model != config.model || output.validate(&request).is_err() {
                        coverage.status = "failed".into();
                        coverage.error = Some("invalidReviewOrModel".into());
                        calls.push(CallResult {
                            provider_response_id: provider_response_id.clone(),
                            coverage,
                            edits: vec![],
                            model: config.model.clone(),
                        });
                        progress(calls.last().unwrap())?;
                        continue;
                    }
                    if output.edits.len() > remaining {
                        limit_reached = true;
                        coverage.status = "failed".into();
                        coverage.error = Some("findingLimit".into());
                        calls.push(CallResult {
                            provider_response_id: provider_response_id.clone(),
                            coverage,
                            edits: vec![],
                            model: config.model.clone(),
                        });
                        progress(calls.last().unwrap())?;
                        break;
                    }
                    remaining -= output.edits.len();
                    coverage.status = "completed".into();
                    calls.push(CallResult {
                        provider_response_id,
                        coverage,
                        edits: output.edits,
                        model: answer.model,
                    });
                }
                Err(e) => {
                    coverage.status = if cancelled { "cancelled" } else { "failed" }.into();
                    coverage.error = Some(e.code.to_string());
                    calls.push(CallResult {
                        provider_response_id: e.provider_request_id.clone(),
                        coverage,
                        edits: vec![],
                        model: config.model.clone(),
                    });
                    if e.is_usage_limit() {
                        progress(calls.last().unwrap())?;
                        let _ = flight.finish::<()>(Err(e));
                        break;
                    }
                }
            }
            progress(calls.last().unwrap())?;
            if cancelled {
                break;
            }
        }
        if changed
            .as_ref()
            .is_some_and(|c| *c.borrow() || c.has_changed().is_err())
        {
            return flight.finish(Err(QuestionError::stale_connection()));
        }
        let batch = Batch {
            calls,
            cancelled,
            limit_reached: limit_reached || remaining == 0,
        };
        if cancelled {
            let _ = flight.finish::<()>(Err(QuestionError::cancelled()));
            Ok(batch)
        } else {
            flight.finish(Ok(batch))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(text: &str) -> ReviewRequest {
        ReviewRequest {
            request_id: "batch-test".into(),
            repository_id: "private-repo".into(),
            scope: ReviewScope::Scene,
            snapshots: vec![ReviewSnapshot {
                path: "scene.md".into(),
                source: text.into(),
                source_hash: "a".repeat(64),
                scene_id: None,
            }],
            workflow: Some(Options {
                reviewers: vec!["contextual".into()],
                context: vec![],
                context_note: String::new(),
                ranges: vec![],
                review_id: None,
            }),
        }
    }
    fn response(edits: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"status":"completed","model":"test-model","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":serde_json::to_string(&serde_json::json!({"schemaVersion":1,"edits":edits})).unwrap()}]}]})).unwrap()
    }
    #[test]
    fn chunks_cover_selected_unicode_crlf_source_once_and_never_silently_truncate() {
        let text = "🐺 paragraph.\r\n\r\n".repeat(10000);
        let r = request(&text);
        let coverage = plan(&r).unwrap();
        assert!(coverage.len() > 8);
        let mut at = 0;
        for c in &coverage {
            assert_eq!(c.from_utf8, at);
            assert!(text.is_char_boundary(c.from_utf8) && text.is_char_boundary(c.to_utf8));
            assert!(!text[..c.to_utf8].ends_with('\r'));
            assert!(c.window_to - c.window_from <= 16000);
            at = c.to_utf8;
        }
        assert_eq!(at, text.len());
        let mut too_large = request(&"x".repeat(1024 * 1024 + 1));
        assert!(plan(&too_large).is_err());
        too_large = request("story");
        too_large.workflow.as_mut().unwrap().context_note = "x".repeat(4001);
        assert!(plan(&too_large).is_err());
    }
    #[tokio::test]
    async fn serial_batch_stops_at_eight_and_retains_good_siblings_after_schema_failure() {
        let r = request(&"paragraph\n\n".repeat(12000));
        let coverage = plan(&r).unwrap();
        let service = QuestionService::default();
        let permit = service
            .reserve(&r.question_request().unwrap(), "account")
            .unwrap();
        let config = Configuration::new("synthetic-token", "test-model")
            .unwrap()
            .with_account("account")
            .unwrap();
        let mut calls = 0;
        let defs = vec![definitions().remove(1)];
        let batch = service
            .review_batch_with(
                r,
                config,
                permit,
                coverage,
                defs,
                1024,
                |_| Ok(()),
                |_, body| {
                    calls += 1;
                    let data: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(data["tools"], serde_json::json!([]));
                    assert!(!data.to_string().contains("private-repo"));
                    let bytes = if calls == 2 {
                        b"broken-json".to_vec()
                    } else {
                        response(serde_json::json!([]))
                    };
                    async move { Ok(bytes) }
                },
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert_eq!(calls, 8);
        assert_eq!(
            batch
                .calls
                .iter()
                .filter(|c| c.coverage.status == "completed")
                .count(),
            7
        );
        assert_eq!(batch.calls[1].coverage.status, "failed");
    }
    #[tokio::test]
    async fn cancellation_retains_only_completed_calls_and_drops_the_inflight_answer() {
        let r = request(&"paragraph\n\n".repeat(2000));
        let coverage = plan(&r).unwrap();
        let service = QuestionService::default();
        let permit = service
            .reserve(&r.question_request().unwrap(), "account")
            .unwrap();
        let config = Configuration::new("synthetic-token", "test-model")
            .unwrap()
            .with_account("account")
            .unwrap();
        let mut calls = 0;
        let cancel = service.clone();
        let batch = service
            .review_batch_with(
                r,
                config,
                permit,
                coverage,
                vec![definitions().remove(1)],
                1024,
                |_| Ok(()),
                move |_, _| {
                    calls += 1;
                    let cancel = cancel.clone();
                    async move {
                        if calls == 2 {
                            let _ = cancel.cancel("batch-test");
                            std::future::pending::<()>().await;
                        }
                        Ok(response(serde_json::json!([])))
                    }
                },
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert!(batch.cancelled);
        assert_eq!(batch.calls[0].coverage.status, "completed");
        assert_eq!(batch.calls[1].coverage.status, "cancelled");
    }
    #[test]
    fn insertion_and_boundary_dependencies_are_not_ranked() {
        assert!(overlaps(4, 4, 4, 4));
        assert!(overlaps(4, 4, 0, 4));
        assert!(overlaps(4, 4, 4, 8));
        assert!(!overlaps(0, 4, 4, 8));
    }
    #[test]
    fn long_readonly_context_is_fully_windowed_bounded_and_never_sent_with_private_paths() {
        let mut r = request("Story.");
        r.workflow.as_mut().unwrap().context = vec![ReviewSnapshot {
            path: "private/notes.md".into(),
            source: "🐺 note.\r\n".repeat(40000),
            source_hash: "b".repeat(64),
            scene_id: None,
        }];
        let calls = plan(&r).unwrap();
        assert!(calls.len() > 8 && calls.len() <= 128);
        let original = &r.workflow.as_ref().unwrap().context[0].source;
        let mut covered = vec![false; original.len()];
        for call in calls {
            let count = call
                .context_ranges
                .iter()
                .map(|range| {
                    assert!(
                        original.is_char_boundary(range.from_utf8)
                            && original.is_char_boundary(range.to_utf8)
                    );
                    covered[range.from_utf8..range.to_utf8].fill(true);
                    range.to_utf8 - range.from_utf8
                })
                .sum::<usize>();
            assert!(count + call.window_to - call.window_from <= 16000);
        }
        assert!(covered.iter().all(|v| *v));
        r.workflow.as_mut().unwrap().context[0].source = "Read-only context".into();
        let body =
            crate::review::workflow_body(&r, "test-model", &definitions()[0].instructions).unwrap();
        let body = String::from_utf8(body).unwrap();
        assert!(!body.contains("private/notes.md"));
        assert!(!body.contains("private-repo"));
        assert!(body.contains("Read-only context"));
    }
    #[tokio::test]
    async fn failed_progress_stops_dispatch_and_finding_limit_never_truncates_a_call() {
        let r = request(&"Bad dog. ".repeat(3000));
        let coverage = plan(&r).unwrap();
        let service = QuestionService::default();
        let permit = service
            .reserve(&r.question_request().unwrap(), "account")
            .unwrap();
        let config = Configuration::new("synthetic-token", "test-model")
            .unwrap()
            .with_account("account")
            .unwrap();
        let mut completed = 0;
        let mut dispatched = 0;
        let result = service
            .review_batch_with(
                r,
                config,
                permit,
                coverage,
                vec![definitions().remove(1)],
                1024,
                |call| {
                    if call.coverage.status == "completed" {
                        completed += 1;
                        return Err(QuestionError::review_persistence());
                    }
                    Ok(())
                },
                |_, _| {
                    dispatched += 1;
                    async { Ok(response(serde_json::json!([]))) }
                },
                Duration::from_secs(1),
            )
            .await;
        assert!(result.is_err());
        assert_eq!((dispatched, completed), (1, 1));
        let r = request("Bad dog.");
        let coverage = plan(&r).unwrap();
        let permit = service.reserve(&r.question_request().unwrap(), "account");
        assert!(permit.is_err());
        let mut r = r;
        r.request_id = "next-batch".into();
        let permit = service
            .reserve(&r.question_request().unwrap(), "account")
            .unwrap();
        let config = Configuration::new("synthetic-token", "test-model")
            .unwrap()
            .with_account("account")
            .unwrap();
        let mut statuses = vec![];
        let result=service.review_batch_with(r,config,permit,coverage,vec![definitions().remove(1)],1,|call|{statuses.push(call.coverage.status.clone());Ok(())},|_,_|async{Ok(response(serde_json::json!([{ "id":"a","sceneIndex":0,"fromUtf8":0,"toUtf8":3,"original":"Bad","replacement":"Good","reason":"One"},{"id":"b","sceneIndex":0,"fromUtf8":4,"toUtf8":7,"original":"dog","replacement":"cat","reason":"Two"}])))},Duration::from_secs(1)).await.unwrap();
        assert!(result.limit_reached);
        assert_eq!(
            result.calls[0].coverage.error.as_deref(),
            Some("findingLimit")
        );
        assert!(result.calls[0].edits.is_empty());
        assert_eq!(statuses, vec!["running", "failed"]);
    }
}
