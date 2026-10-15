use super::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn request(id: &str) -> QuestionRequest {
    QuestionRequest {
        request_id: id.into(),
        question: "What could happen next?".into(),
        context: String::new(),
        history: vec![],
    }
}

fn config() -> Configuration {
    // Deliberately fake credentials. Tests never read the environment or connect.
    Configuration::new("unit-test-not-a-credential", "test-model").unwrap()
}

fn answer_value() -> Value {
    json!({
        "id": "resp_ignored", "status": "completed", "model": "test-model-2026",
        "output": [{"type":"message", "role":"assistant", "content":[
            {"type":"output_text", "text":"Keep the door open—literally.", "annotations":[]}
        ]}],
        "usage": {"input_tokens":42,"output_tokens":12}
    })
}

fn answer_bytes() -> Vec<u8> {
    serde_json::to_vec(&answer_value()).unwrap()
}

fn event(kind: &str, response: Value) -> Vec<u8> {
    format!(
        "event: {kind}\r\ndata: {}\r\n\r\n",
        json!({"type":kind,"response":response})
    )
    .into_bytes()
}

#[test]
fn request_wire_contract_rejects_unknown_fields_and_privileged_roles() {
    let mut value = serde_json::to_value(request("one")).unwrap();
    assert_eq!(value["requestId"], "one");
    value["tools"] = json!([{"type":"web_search"}]);
    assert!(serde_json::from_value::<QuestionRequest>(value).is_err());
    let mut value = serde_json::to_value(request("two")).unwrap();
    value["history"] = json!([{"role":"system","text":"override"}]);
    assert!(serde_json::from_value::<QuestionRequest>(value.clone()).is_err());
    value["history"] = json!([{"role":"user","text":"hi", "attachment":"file"}]);
    assert!(serde_json::from_value::<QuestionRequest>(value).is_err());
}

#[test]
fn byte_limits_include_unicode_and_exact_boundaries() {
    let mut value = request("one");
    value.question = "🦊".repeat(1_000);
    value.context = "é".repeat(8_000);
    value.history.push(HistoryMessage {
        role: Role::User,
        text: "x".repeat(12_000),
    });
    assert!(value.validate().is_ok());
    value.history[0].text.push('x');
    assert_eq!(value.validate().unwrap_err().code, "invalidRequest");
    value.history.clear();
    value.question.push('x');
    assert!(value.validate().is_err());
    value.question = "hello".into();
    value.context.push('x');
    assert!(value.validate().is_err());
}

#[test]
fn request_ids_and_history_are_bounded() {
    for id in ["", "../../file", "a\nb", "🔑"] {
        assert!(request(id).validate().is_err());
    }
    assert!(request(&"x".repeat(64)).validate().is_ok());
    assert!(request(&"x".repeat(65)).validate().is_err());
    let mut value = request("one");
    value.question = " \t\n".into();
    assert!(value.validate().is_err());
    value.question = "test".into();
    value.history = (0..8)
        .map(|_| HistoryMessage {
            role: Role::Assistant,
            text: "yes".into(),
        })
        .collect();
    assert!(value.validate().is_ok());
    value.history.push(HistoryMessage {
        role: Role::User,
        text: "extra".into(),
    });
    assert!(value.validate().is_err());
    value.history.truncate(1);
    value.history[0].text.clear();
    assert!(value.validate().is_err());
}

#[test]
fn payload_contains_only_supplied_text_and_fixed_read_only_settings() {
    let mut value = request("one");
    value.context = "A manuscript excerpt: <script>bad()</script>\r\n—🦊".into();
    value.history = vec![
        HistoryMessage {
            role: Role::User,
            text: "Earlier question".into(),
        },
        HistoryMessage {
            role: Role::Assistant,
            text: "Earlier answer".into(),
        },
    ];
    let bytes = request_body(&value, config().model()).unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        body["input"],
        json!([
            {"role":"user","content":"Earlier question"},
            {"role":"assistant","content":"Earlier answer"},
            {"role":"user","content":value.context},
            {"role":"user","content":value.question}
        ])
    );
    assert_eq!(body["store"], false);
    assert_eq!(body["stream"], true);
    assert_eq!(body["tools"], json!([]));
    assert_eq!(body["max_output_tokens"], 2_000);
    assert!(body.get("previous_response_id").is_none());
    assert!(body.get("conversation").is_none());
    assert!(body.get("requestId").is_none());
    assert!(!String::from_utf8(bytes)
        .unwrap()
        .contains("unit-test-not-a-credential"));
}

#[test]
fn omitted_context_does_not_create_hidden_input_and_escaping_is_bounded() {
    let mut value = request("one");
    assert_eq!(
        serde_json::from_slice::<Value>(&request_body(&value, "model").unwrap()).unwrap()["input"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    value.question = "\0".repeat(MAX_QUESTION_BYTES);
    value.context = "\0".repeat(MAX_CONTEXT_BYTES);
    value.history.push(HistoryMessage {
        role: Role::User,
        text: "\0".repeat(12_000),
    });
    let bytes = request_body(&value, "model").unwrap();
    assert!(bytes.len() <= MAX_REQUEST_BODY_BYTES);
}

#[test]
fn config_is_strict_native_only_and_header_is_sensitive() {
    assert!(config().authorization.is_sensitive());
    for (token, model) in [
        ("", "model"),
        ("a\r\nInjected: yes", "model"),
        ("token", ""),
        ("token", "invalid model"),
        ("token", "invalid?model"),
    ] {
        assert_eq!(
            Configuration::new(token, model).err().unwrap(),
            QuestionError::not_configured()
        );
    }
    assert!(Configuration::new(&"a".repeat(65_537), "model").is_err());
    assert!(Configuration::new("token", &"m".repeat(201)).is_err());
}

#[test]
fn response_wire_contract_preserves_plain_text_and_optional_usage() {
    let answer = parse_response("one", &answer_bytes()).unwrap();
    let value = serde_json::to_value(answer).unwrap();
    assert_eq!(
        value,
        json!({
            "requestId":"one", "text":"Keep the door open—literally.",
            "model":"test-model-2026", "inputTokens":42, "outputTokens":12, "incomplete":false
        })
    );
    let mut response = answer_value();
    response.as_object_mut().unwrap().remove("usage");
    response["output"][0]["content"][0]["text"] = json!("<img src=x onerror=bad()>\r\n\n");
    let value = serde_json::to_value(
        parse_response("two", &serde_json::to_vec(&response).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(value["text"], "<img src=x onerror=bad()>\r\n\n");
    assert!(value.get("inputTokens").is_none());
}

#[test]
fn response_supports_reasoning_refusal_and_explicit_incomplete() {
    let mut response = answer_value();
    response["status"] = json!("incomplete");
    response["output"] = json!([
        {"type":"reasoning","summary":[]},
        {"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"I cannot help with that."}]}
    ]);
    let answer = parse_response("one", &serde_json::to_vec(&response).unwrap()).unwrap();
    assert!(answer.incomplete);
    assert_eq!(answer.text, "I cannot help with that.");
}

#[test]
fn response_rejects_tool_calls_invalid_roles_and_nonterminal_states() {
    for status in ["queued", "in_progress", "failed", "cancelled"] {
        let mut response = answer_value();
        response["status"] = json!(status);
        assert_eq!(
            parse_response("one", &serde_json::to_vec(&response).unwrap())
                .unwrap_err()
                .code,
            "invalidResponse"
        );
    }
    for output in [
        json!([{"type":"function_call","name":"write_file","arguments":"{}"}]),
        json!([{"type":"message","role":"user","content":[]}]),
        json!([{"type":"message","role":"assistant","content":[{"type":"input_text","text":"bad"}]}]),
    ] {
        let mut response = answer_value();
        response["output"] = output;
        assert!(parse_response("one", &serde_json::to_vec(&response).unwrap()).is_err());
    }
}

#[test]
fn response_rejects_empty_malformed_and_oversize_text() {
    assert!(parse_response("one", b"not json: unit-test-secret").is_err());
    assert_eq!(
        parse_response("one", &vec![b'x'; MAX_RESPONSE_BYTES + 1])
            .unwrap_err()
            .code,
        "responseTooLarge"
    );
    let mut response = answer_value();
    response["output"][0]["content"][0]["text"] = json!(" ");
    assert_eq!(
        parse_response("one", &serde_json::to_vec(&response).unwrap())
            .unwrap_err()
            .code,
        "emptyResponse"
    );
    response["output"][0]["content"][0]["text"] = json!("🦊".repeat(8_000));
    assert!(parse_response("one", &serde_json::to_vec(&response).unwrap()).is_ok());
    response["output"][0]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"output_text","text":"x"}));
    assert_eq!(
        parse_response("one", &serde_json::to_vec(&response).unwrap())
            .unwrap_err()
            .code,
        "responseTooLarge"
    );
}

#[test]
fn sse_handles_every_chunk_boundary_including_utf8_and_crlf() {
    let bytes = event("response.completed", answer_value());
    for split in 0..=bytes.len() {
        let mut stream = ResponseStream::default();
        stream.push(&bytes[..split]).unwrap();
        stream.push(&bytes[split..]).unwrap();
        assert_eq!(
            parse_response("one", &stream.finish().unwrap())
                .unwrap()
                .text,
            "Keep the door open—literally."
        );
    }
    let mut stream = ResponseStream::default();
    for byte in bytes {
        stream.push(&[byte]).unwrap();
    }
    assert!(stream.finish().is_ok());
}

#[test]
fn sse_ignores_deltas_comments_and_requires_a_terminal_response() {
    let mut stream = ResponseStream::default();
    stream.push(b": heartbeat\n\ndata: {").unwrap();
    stream
        .push(b"\"type\":\"response.output_text.delta\",\"delta\":\"not final\"}\n\n")
        .unwrap();
    assert_eq!(stream.finish().unwrap_err().code, "interrupted");
    let mut stream = ResponseStream::default();
    let mut bytes = event("response.completed", answer_value());
    bytes.truncate(bytes.len() - 2); // An unterminated event is not a completed answer.
    stream.push(&bytes).unwrap();
    assert_eq!(stream.finish().unwrap_err().code, "interrupted");
}

#[test]
fn sse_failed_and_incomplete_are_not_completed_success() {
    let mut stream = ResponseStream::default();
    let mut value = answer_value();
    value["status"] = json!("incomplete");
    stream
        .push(&event("response.incomplete", value.clone()))
        .unwrap();
    assert!(
        parse_response("one", &stream.finish().unwrap())
            .unwrap()
            .incomplete
    );
    let mut stream = ResponseStream::default();
    assert!(stream.push(&event("response.completed", value)).is_err());
    for kind in ["error", "response.failed"] {
        let mut stream = ResponseStream::default();
        let error = stream
            .push(&event(
                kind,
                json!({"error":"private body and unit-test-secret"}),
            ))
            .unwrap_err();
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("unit-test-secret"));
        assert_eq!(error.code, "providerUnavailable");
    }
}

#[test]
fn sse_caps_event_line_stream_and_multiline_data() {
    let mut stream = ResponseStream::default();
    assert_eq!(
        stream
            .push(&vec![b'a'; MAX_RESPONSE_BYTES + 1])
            .unwrap_err()
            .code,
        "responseTooLarge"
    );
    let mut stream = ResponseStream::default();
    let comment = b": ignored\n";
    for _ in 0..MAX_STREAM_BYTES / comment.len() {
        stream.push(comment).unwrap();
    }
    assert_eq!(stream.push(comment).unwrap_err().code, "responseTooLarge");
    let mut stream = ResponseStream::default();
    stream.push(b"data: {\n").unwrap();
    stream
        .push(b"data: \"type\":\"response.created\"}\n\n")
        .unwrap();
    assert!(stream.finish().is_err());
    let mut stream = ResponseStream::default();
    assert!(stream.push(b"data: [DONE]\n\n").is_err());
}

#[test]
fn safe_errors_never_reflect_http_error_details() {
    for (status, code) in [
        (301, "providerUnavailable"),
        (401, "authentication"),
        (403, "authentication"),
        (404, "providerRequest"),
        (429, "rateLimited"),
        (500, "providerUnavailable"),
        (504, "timeout"),
    ] {
        let error = status_error(status);
        assert_eq!(error.code, code);
        assert!(!error.message.contains("unit-test-secret"));
    }
}

#[tokio::test]
async fn mocked_send_happens_once_with_no_credential_in_body() {
    let service = QuestionService::default();
    let calls = AtomicUsize::new(0);
    let counter = &calls;
    let answer = service
        .ask_with(
            request("one"),
            config(),
            |configuration, body| async move {
                counter.fetch_add(1, Ordering::SeqCst);
                assert_eq!(configuration.model(), "test-model");
                assert!(!String::from_utf8(body)
                    .unwrap()
                    .contains("unit-test-not-a-credential"));
                Ok(answer_bytes())
            },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(answer.request_id, "one");
    let error = service
        .ask_with(
            request("two"),
            config(),
            |_, _| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(status_error(429))
            },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "rateLimited");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn invalid_requests_and_prestart_cancellation_never_call_transport() {
    let service = QuestionService::default();
    assert!(!service.cancel("cancelled-first").unwrap());
    let calls = AtomicUsize::new(0);
    for (value, code) in [
        (request("cancelled-first"), "cancelled"),
        (request("bad/id"), "invalidRequest"),
    ] {
        let error = service
            .ask_with(
                value,
                config(),
                |_, _| async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(answer_bytes())
                },
                REQUEST_TIMEOUT,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, code);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

struct DropSignal(Arc<AtomicBool>);
impl Drop for DropSignal {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn cancellation_aborts_transport_releases_slot_and_rejects_late_success() {
    let service = QuestionService::default();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let dropped = Arc::new(AtomicBool::new(false));
    let worker_service = service.clone();
    let signal = dropped.clone();
    let worker = tokio::spawn(async move {
        worker_service
            .ask_with(
                request("one"),
                config(),
                |_, _| async move {
                    let _guard = DropSignal(signal);
                    started_tx.send(()).unwrap();
                    std::future::pending().await
                },
                REQUEST_TIMEOUT,
            )
            .await
    });
    started_rx.await.unwrap();
    assert!(service.cancel("one").unwrap());
    assert_eq!(worker.await.unwrap().unwrap_err().code, "cancelled");
    assert!(dropped.load(Ordering::SeqCst));
    assert!(service
        .ask_with(
            request("two"),
            config(),
            |_, _| async { Ok(answer_bytes()) },
            REQUEST_TIMEOUT
        )
        .await
        .is_ok());
    assert_eq!(
        service
            .ask_with(
                request("one"),
                config(),
                |_, _| async { panic!("cancelled ID cannot send") },
                REQUEST_TIMEOUT
            )
            .await
            .unwrap_err()
            .code,
        "cancelled"
    );
}

#[tokio::test]
async fn a_second_inflight_is_rejected_and_wrong_id_cancellation_does_not_abort() {
    let service = QuestionService::default();
    let flight = service.begin("one").unwrap();
    assert!(!service.cancel("unrelated").unwrap());
    assert!(!*flight.cancelled.borrow());
    let error = service
        .ask_with(
            request("two"),
            config(),
            |_, _| async { panic!("busy request cannot send") },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "busy");
    drop(flight);
    assert!(service
        .ask_with(
            request("two"),
            config(),
            |_, _| async { Ok(answer_bytes()) },
            REQUEST_TIMEOUT
        )
        .await
        .is_ok());
}

#[tokio::test(start_paused = true)]
async fn timeout_drops_transport_and_does_not_retry() {
    let service = QuestionService::default();
    let dropped = Arc::new(AtomicBool::new(false));
    let calls = AtomicUsize::new(0);
    let signal = dropped.clone();
    let error = service
        .ask_with(
            request("one"),
            config(),
            |_, _| async {
                let _guard = DropSignal(signal);
                calls.fetch_add(1, Ordering::SeqCst);
                std::future::pending().await
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert!(dropped.load(Ordering::SeqCst));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(service.state.lock().unwrap().active.is_none());
}

#[tokio::test]
async fn dropping_ask_future_releases_the_slot() {
    let service = QuestionService::default();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let worker_service = service.clone();
    let worker = tokio::spawn(async move {
        worker_service
            .ask_with(
                request("one"),
                config(),
                |_, _| async {
                    started_tx.send(()).unwrap();
                    std::future::pending().await
                },
                REQUEST_TIMEOUT,
            )
            .await
    });
    started_rx.await.unwrap();
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    assert!(service.state.lock().unwrap().active.is_none());
}

#[test]
fn cancellation_wins_if_it_arrives_before_result_is_published() {
    let service = QuestionService::default();
    let flight = service.begin("one").unwrap();
    let result = parse_response("one", &answer_bytes());
    assert!(service.cancel("one").unwrap());
    assert_eq!(flight.finish(result).unwrap_err().code, "cancelled");
    assert!(!service.cancel("one").unwrap());
}

#[test]
fn duplicate_ids_and_old_guard_cannot_clear_new_request() {
    let service = QuestionService::default();
    let old = service.begin("one").unwrap();
    old.finish(parse_response("one", &answer_bytes())).unwrap();
    assert_eq!(service.begin("one").err().unwrap().code, "duplicateRequest");
    for i in 0..RECENT_REQUESTS {
        drop(service.begin(&format!("cycle-{i}")).unwrap());
    }
    let new = service.begin("one").unwrap();
    drop(old);
    assert!(service.state.lock().unwrap().active.is_some());
    drop(new);
    assert!(service.state.lock().unwrap().active.is_none());
}

#[test]
fn cancellation_memory_is_bounded() {
    let service = QuestionService::default();
    for i in 0..RECENT_REQUESTS * 3 {
        service.cancel(&format!("cancel-{i}")).unwrap();
    }
    assert_eq!(
        service.state.lock().unwrap().cancelled_ids.len(),
        RECENT_REQUESTS
    );
}

#[test]
fn structured_plan_errors_keep_only_safe_machine_metadata() {
    let value = json!({"error": {
        "code":"subscription_sharing_unsupported_capability", "param":"tools[0].type",
        "message":"private prompt and unit-test-secret"
    }});
    let error = provider_error(400, Some(&value), Some("req_abc-123"));
    assert_eq!(error.code, "unsupportedCapability");
    assert_eq!(
        error.provider_code,
        Some("subscription_sharing_unsupported_capability")
    );
    assert_eq!(error.provider_param.as_deref(), Some("tools[0].type"));
    assert_eq!(error.provider_request_id.as_deref(), Some("req_abc-123"));
    assert_eq!(error.http_status, Some(400));
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains("unit-test-secret"));
    let error = provider_error(
        401,
        Some(&json!({"detail":"unit-test-secret"})),
        Some("sk-private"),
    );
    assert_eq!(error.code, "authentication");
    assert!(error.provider_request_id.is_none());
    assert!(error.provider_code.is_none());
    let error = provider_error(
        400,
        Some(&json!({"error":{"code":"unit-test-secret","param":"unit-test-secret"}})),
        None,
    );
    assert!(error.provider_code.is_none());
    assert!(error.provider_param.is_none());
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains("unit-test-secret"));
}

#[test]
fn plan_usage_errors_are_recognized_before_and_during_streams() {
    for (code, expected) in [
        ("subscription_sharing_user_not_eligible", "planUnavailable"),
        ("subscription_sharing_usage_limit_exceeded", "usageLimit"),
        ("subscription_sharing_usage_unavailable", "usageUnavailable"),
        (
            "subscription_sharing_unsupported_capability",
            "unsupportedCapability",
        ),
        (
            "subscription_sharing_route_not_supported",
            "routeUnsupported",
        ),
        ("subscription_sharing_invalid_user", "invalidAccount"),
        ("chatpass_v2_scope_not_authorized", "planPermission"),
        (
            "chatpass_v2_invalid_authorization_context",
            "planPermission",
        ),
        (
            "subscription_sharing_user_unavailable",
            "accountUnavailable",
        ),
    ] {
        let value = json!({"error":{"code":code,"message":"ignored raw error"}});
        let error = provider_error(429, Some(&value), None);
        assert_eq!(error.code, expected);
        assert_eq!(error.provider_code, Some(code));
        let mut stream = ResponseStream::default();
        let error = stream.push(&event("response.failed", value)).unwrap_err();
        assert_eq!(error.code, expected);
        assert_eq!(error.provider_code, Some(code));
    }
    let mut stream = ResponseStream::default();
    let bytes = format!(
        "data: {}\n\n",
        json!({"type":"error","code":"subscription_sharing_usage_limit_exceeded","message":"ignored"})
    );
    assert!(stream.push(bytes.as_bytes()).unwrap_err().is_usage_limit());
}

#[tokio::test]
async fn quota_blocks_same_account_until_explicit_recheck_without_billing_fallback() {
    let service = QuestionService::default();
    let calls = AtomicUsize::new(0);
    let error = service
        .ask_with(
            request("one"),
            config().with_account("account-a").unwrap(),
            |_, _| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(QuestionError::usage_limited())
            },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
    assert!(error.is_usage_limit());
    assert_eq!(error.usage_url, Some("https://chatgpt.com/settings/usage"));
    assert!(service.is_usage_limited("account-a").unwrap());
    let error = service
        .ask_with(
            request("two"),
            config().with_account("account-a").unwrap(),
            |_, _| async { panic!("blocked account cannot send") },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
    assert!(error.is_usage_limit());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // A different account is only used when the native author-selected binding
    // explicitly supplies it. The service never retries or changes that binding.
    assert!(service
        .ask_with(
            request("three"),
            config().with_account("account-b").unwrap(),
            |_, _| async { Ok(answer_bytes()) },
            REQUEST_TIMEOUT
        )
        .await
        .is_ok());
    assert!(service.is_usage_limited("account-a").unwrap());
    service.clear_usage_limit("account-a").unwrap();
    assert!(service
        .ask_with(
            request("four"),
            config().with_account("account-a").unwrap(),
            |_, _| async { Ok(answer_bytes()) },
            REQUEST_TIMEOUT
        )
        .await
        .is_ok());
}

#[tokio::test]
async fn stale_or_closed_auth_lease_cannot_start_transport() {
    let service = QuestionService::default();
    let (sender, receiver) = watch::channel(false);
    sender.send(true).unwrap();
    let error = service
        .ask_with(
            request("one"),
            config().with_cancellation(receiver),
            |_, _| async { panic!("stale connection cannot send") },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "staleConnection");
    let (sender, receiver) = watch::channel(false);
    drop(sender);
    let error = service
        .ask_with(
            request("two"),
            config().with_cancellation(receiver),
            |_, _| async { panic!("closed connection cannot send") },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "staleConnection");
}

#[tokio::test]
async fn account_switch_aborts_inflight_transport_and_cannot_publish_result() {
    let service = QuestionService::default();
    let (sender, receiver) = watch::channel(false);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let dropped = Arc::new(AtomicBool::new(false));
    let signal = dropped.clone();
    let worker = tokio::spawn(async move {
        service
            .ask_with(
                request("one"),
                config().with_cancellation(receiver),
                |_, _| async move {
                    let _guard = DropSignal(signal);
                    started_tx.send(()).unwrap();
                    std::future::pending().await
                },
                REQUEST_TIMEOUT,
            )
            .await
    });
    started_rx.await.unwrap();
    sender.send(true).unwrap();
    assert_eq!(worker.await.unwrap().unwrap_err().code, "staleConnection");
    assert!(dropped.load(Ordering::SeqCst));
}

#[test]
fn identifiers_match_native_auth_limits_without_becoming_paths() {
    assert!(Configuration::new("token", &"m".repeat(200)).is_ok());
    assert!(Configuration::new("token", "vendor/model:variant").is_ok());
    assert!(config().with_account(&"a".repeat(192)).is_ok());
    assert!(config().with_account("oaiapp.account-one").is_ok());
    assert!(config().with_account(&"a".repeat(193)).is_err());
    assert!(config().with_account("account/other").is_err());
    assert!(config().with_account("account other").is_err());
}

#[tokio::test]
async fn reserved_preflight_cancellation_survives_tombstone_eviction() {
    let service = QuestionService::default();
    let value = request("waiting-for-auth");
    let permit = service.reserve(&value, "account-a").unwrap();
    assert!(service.cancel(&value.request_id).unwrap());
    for i in 0..RECENT_REQUESTS * 2 {
        service.cancel(&format!("unrelated-{i}")).unwrap();
    }
    let error = service
        .run_with(
            value,
            config().with_account("account-a").unwrap(),
            permit,
            |_, _| async { panic!("cancelled preflight cannot send") },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert!(service.state.lock().unwrap().active.is_none());
}

#[tokio::test]
async fn reserved_preflight_enforces_one_flight_and_exact_binding() {
    let service = QuestionService::default();
    let value = request("one");
    let permit = service.reserve(&value, "account-a").unwrap();
    assert_eq!(
        service
            .reserve(&request("two"), "account-a")
            .err()
            .unwrap()
            .code,
        "busy"
    );
    let error = service
        .run_with(
            value,
            config().with_account("account-b").unwrap(),
            permit,
            |_, _| async { panic!("wrong account cannot send") },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalidRequest");
    assert!(service.state.lock().unwrap().active.is_none());
    let value = request("three");
    let permit = service.reserve(&value, "account-a").unwrap();
    let error = QuestionService::default()
        .run_with(
            value,
            config().with_account("account-a").unwrap(),
            permit,
            |_, _| async { panic!("wrong host cannot send") },
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalidRequest");
    assert!(service.state.lock().unwrap().active.is_none());
}

fn revision_bytes(text: &str) -> Vec<u8> {
    let mut value = answer_value();
    value["output"][0]["content"][0]["text"] = json!(text);
    serde_json::to_vec(&value).unwrap()
}

async fn prepared_revision(
    service: &QuestionService,
    id: &str,
    config: Configuration,
) -> PreparedRevision {
    let request = request(id);
    let permit = service.reserve(&request, &config.account_id).unwrap();
    service
        .revise_with(
            request,
            "Exact—🦊\r\n".into(),
            config,
            permit,
            |_, _| async {
                Ok(revision_bytes(
                    r#"{"explanation":"Keep the voice.","replacement":"  Revised—🦊\r\n"}"#,
                ))
            },
            REQUEST_TIMEOUT,
        )
        .await
        .ok()
        .unwrap()
}

#[test]
fn revision_wire_is_strict_bounded_and_only_explicitly_supplied_text() {
    let mut request = request("revision-wire");
    request.context = "Opt-in context\r\n".into();
    let target = "Exact—🦊\r\n";
    let bytes = request_body_for(&request, "test-model", Some(target)).unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        value["input"],
        json!([
            {"role":"user","content":request.context},
            {"role":"user","content":target},
            {"role":"user","content":request.question}
        ])
    );
    assert_eq!(value["text"]["format"]["type"], "json_schema");
    assert_eq!(value["text"]["format"]["strict"], true);
    assert_eq!(
        value["text"]["format"]["schema"]["additionalProperties"],
        false
    );
    assert_eq!(
        value["text"]["format"]["schema"]["required"],
        json!(["explanation", "replacement"])
    );
    assert_eq!(value["store"], false);
    assert_eq!(value["stream"], true);
    assert_eq!(value["tools"], json!([]));
    assert_eq!(value["max_output_tokens"], MAX_OUTPUT_TOKENS);
    request.history.push(HistoryMessage {
        role: Role::Assistant,
        text: "Previous advice".into(),
    });
    assert!(validate_revision_request(&request, target).is_err());
    request.history.clear();
    request.question = "q".repeat(4000);
    request.context = "c".repeat(16000);
    assert!(validate_revision_request(&request, &"🦊".repeat(3000)).is_ok());
    assert!(validate_revision_request(&request, &"🦊".repeat(3001)).is_err());
    assert!(validate_revision_request(&request, "").is_err());
}

#[test]
fn revision_parser_preserves_whitespace_and_accepts_explicit_deletion() {
    let (answer, replacement) = parse_revision(
        "r",
        &revision_bytes(r#"{"explanation":"  Reason.\n","replacement":"  Élan—🦊\r\n"}"#),
    )
    .unwrap();
    assert_eq!(answer.text, "  Reason.\n");
    assert_eq!(replacement, "  Élan—🦊\r\n");
    assert!(!answer.incomplete);
    assert_eq!(
        parse_revision(
            "r",
            &revision_bytes(
                r#"{"explanation":"Remove the selected repetition.","replacement":""}"#
            )
        )
        .unwrap()
        .1,
        ""
    );
}

#[test]
fn revision_parser_never_repairs_or_promotes_advice_or_malformed_json() {
    for text in [
        "Here is my advice",
        "```json\n{\"explanation\":\"x\",\"replacement\":\"y\"}\n```",
        r#"{"explanation":"x"}"#,
        r#"{"replacement":"x"}"#,
        r#"{"explanation":"x","replacement":"y","approve":true}"#,
        r#"{"explanation":"x","replacement":"a","replacement":"b"}"#,
        r#"{"explanation":"x","explanation":"y","replacement":"b"}"#,
        r#"{"explanation":" ","replacement":"y"}"#,
        r#"{"explanation":"x","replacement":null}"#,
        r#"{"explanation":"x","replacement":"y"} trailing"#,
    ] {
        assert!(
            parse_revision("r", &revision_bytes(text)).is_err(),
            "{text}"
        );
    }
}

#[test]
fn revision_parser_rejects_incomplete_refusal_and_ambiguous_outputs() {
    let valid = revision_bytes(r#"{"explanation":"x","replacement":"y"}"#);
    let value: Value = serde_json::from_slice(&valid).unwrap();
    for key in ["incomplete_details", "error"] {
        let mut response = value.clone();
        response[key] = json!({"reason":"not complete"});
        assert!(parse_revision("r", &serde_json::to_vec(&response).unwrap()).is_err());
    }
    let mut response = value.clone();
    response["output"][0]["status"] = json!("incomplete");
    assert!(parse_revision("r", &serde_json::to_vec(&response).unwrap()).is_err());
    for status in ["incomplete", "failed", "cancelled", "in_progress"] {
        let mut response = value.clone();
        response["status"] = json!(status);
        assert!(parse_revision("r", &serde_json::to_vec(&response).unwrap()).is_err());
    }
    let mut response = value.clone();
    response["output"][0]["content"][0] = json!({"type":"refusal","refusal":"No"});
    assert!(parse_revision("r", &serde_json::to_vec(&response).unwrap()).is_err());
    let mut response = value.clone();
    response["output"][0]["content"][0]["refusal"] = json!("No");
    assert!(parse_revision("r", &serde_json::to_vec(&response).unwrap()).is_err());
    let mut response = value.clone();
    response["output"]
        .as_array_mut()
        .unwrap()
        .push(value["output"][0].clone());
    assert!(parse_revision("r", &serde_json::to_vec(&response).unwrap()).is_err());
    let mut response = value.clone();
    response["output"][0]["content"]
        .as_array_mut()
        .unwrap()
        .push(value["output"][0]["content"][0].clone());
    assert!(parse_revision("r", &serde_json::to_vec(&response).unwrap()).is_err());
}

#[tokio::test]
async fn prepared_revision_keeps_slot_and_cancellation_until_persistence() {
    let service = QuestionService::default();
    let prepared = prepared_revision(&service, "revision-cancel", config()).await;
    assert_eq!(
        service
            .reserve(&request("busy-revision"), "")
            .err()
            .unwrap()
            .code,
        "busy"
    );
    assert!(service.cancel("revision-cancel").unwrap());
    let called = AtomicBool::new(false);
    let result: Result<_, QuestionError> = prepared.persist(|_, _| {
        called.store(true, Ordering::SeqCst);
        Ok(())
    });
    assert_eq!(result.err().unwrap().code, "cancelled");
    assert!(!called.load(Ordering::SeqCst));
    assert!(service.reserve(&request("next-revision"), "").is_ok());
}

#[tokio::test]
async fn prepared_revision_drop_releases_slot_without_persisting() {
    let service = QuestionService::default();
    let prepared = prepared_revision(&service, "revision-drop", config()).await;
    drop(prepared);
    assert!(!service.cancel("revision-drop").unwrap());
    assert!(service.reserve(&request("after-drop"), "").is_ok());
}

#[tokio::test]
async fn prepared_revision_rejects_changed_or_closed_auth_lease() {
    for close in [false, true] {
        let service = QuestionService::default();
        let (sender, receiver) = watch::channel(false);
        let prepared = prepared_revision(
            &service,
            "revision-auth",
            config().with_cancellation(receiver),
        )
        .await;
        if close {
            drop(sender);
        } else {
            sender.send(true).unwrap();
        }
        let result: Result<(QuestionAnswer, String, ()), QuestionError> =
            prepared.persist(|_, _| panic!("stale auth cannot store a proposal"));
        assert_eq!(result.err().unwrap().code, "staleConnection");
    }
}

#[tokio::test]
async fn prepared_revision_success_is_explicit_and_releases_slot() {
    let service = QuestionService::default();
    let prepared = prepared_revision(&service, "revision-store", config()).await;
    let (answer, replacement, id) = prepared
        .persist::<_, QuestionError>(|answer, replacement| {
            assert_eq!(answer.request_id, "revision-store");
            assert_eq!(replacement, "  Revised—🦊\r\n");
            Ok("native-proposal-id")
        })
        .unwrap();
    assert_eq!(id, "native-proposal-id");
    assert!(!answer.incomplete);
    assert_eq!(replacement, "  Revised—🦊\r\n");
    assert!(!service.cancel("revision-store").unwrap());
}

#[tokio::test]
async fn revision_transport_error_and_quota_never_persist() {
    let service = QuestionService::default();
    let config = config().with_account("oaiapp_test").unwrap();
    let request = request("revision-quota");
    let permit = service.reserve(&request, "oaiapp_test").unwrap();
    let result = service
        .revise_with(
            request,
            "Target".into(),
            config,
            permit,
            |_, _| async { Err(QuestionError::usage_limited()) },
            REQUEST_TIMEOUT,
        )
        .await;
    assert_eq!(result.err().unwrap().code, "usageLimit");
    assert!(service.is_usage_limited("oaiapp_test").unwrap());
}

#[tokio::test]
async fn committing_revision_does_not_block_status_or_accept_cancellation() {
    let service = QuestionService::default();
    let prepared = prepared_revision(&service, "revision-commit", config()).await;
    let (entered_send, entered) = std::sync::mpsc::channel();
    let (resume, resume_recv) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        prepared.persist::<_, QuestionError>(|_, _| {
            entered_send.send(()).unwrap();
            resume_recv.recv().unwrap();
            Ok("proposal-id")
        })
    });
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    // These calls must return while the persistence closure remains suspended.
    assert!(!service.is_usage_limited("test-account").unwrap());
    assert!(!service.cancel("revision-commit").unwrap());
    assert_eq!(service.cancel_active().unwrap_err().code, "busy");
    assert_eq!(
        service
            .reserve(&request("commit-busy"), "")
            .err()
            .unwrap()
            .code,
        "busy"
    );
    resume.send(()).unwrap();
    assert_eq!(worker.join().unwrap().unwrap().2, "proposal-id");
}
