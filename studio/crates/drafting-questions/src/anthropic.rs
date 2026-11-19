//! Claude (Anthropic Messages API) support at the transport edge.
//!
//! Every request in this crate is built in one internal shape and every answer
//! is validated from one internal terminal shape. Rather than duplicate those
//! builders and validators, this module converts at the wire: the outgoing body
//! becomes a Messages API request, and the Messages SSE stream is reduced to the
//! same bounded terminal object the existing validators already check. Nothing
//! here widens what is sent: the same bounded text, no tools, no files.

use crate::{append_bounded, safe_request_id, ProtocolDiagnostic, QuestionError};
use crate::{MAX_ANSWER_BYTES, MAX_OUTPUT_TOKENS, MAX_RESPONSE_BYTES, MAX_STREAM_BYTES};

pub(crate) const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
pub(crate) const API_VERSION: &str = "2026-10-21";
/// Server-side refusal fallback: if a safety classifier declines a passage, the
/// API continues on a fallback model inside the same call instead of failing.
pub(crate) const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// Which provider a [`crate::Configuration`] sends to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    #[default]
    OpenAi,
    Anthropic,
}

/// JSON-schema keywords the Messages API structured-output compiler does not
/// accept. The same bounds are enforced again by this crate's validators after
/// the answer arrives, so removing them here never loosens what is accepted.
const UNSUPPORTED_SCHEMA_KEYWORDS: [&str; 8] = [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
];

fn strip_schema(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for key in UNSUPPORTED_SCHEMA_KEYWORDS {
                map.remove(key);
            }
            map.values_mut().for_each(strip_schema);
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(strip_schema),
        _ => {}
    }
}

/// Convert an internal request body into a Messages API request body.
pub(crate) fn to_messages_body(body: &[u8]) -> Result<Vec<u8>, QuestionError> {
    let invalid = QuestionError::invalid_request;
    let source: serde_json::Value = serde_json::from_slice(body).map_err(|_| invalid())?;
    let model = source["model"].as_str().ok_or_else(invalid)?;
    let system = source["instructions"].as_str().ok_or_else(invalid)?;
    let input = source["input"].as_array().ok_or_else(invalid)?;
    let mut messages = Vec::with_capacity(input.len());
    for message in input {
        let role = match message["role"].as_str() {
            Some(role @ ("user" | "assistant")) => role,
            _ => return Err(invalid()),
        };
        let content = message["content"].as_str().ok_or_else(invalid)?;
        messages.push(serde_json::json!({"role": role, "content": content}));
    }
    if messages.first().is_none_or(|m| m["role"] != "user") {
        return Err(invalid());
    }
    // Short Ask and Revise answers are latency-sensitive and tightly bounded;
    // reviews read more text and get more room. Claude always reasons before
    // answering and that reasoning counts toward max_tokens, so the budget is
    // larger than the visible answer limit. The visible answer stays bounded by
    // MAX_ANSWER_BYTES and MAX_RESPONSE_BYTES when it arrives.
    let short = source["max_output_tokens"].as_u64() == Some(u64::from(MAX_OUTPUT_TOKENS));
    let (effort, max_tokens) = if short {
        ("low", 8_000)
    } else {
        ("medium", 32_000)
    };
    let mut output_config = serde_json::json!({"effort": effort});
    if let Some(format) = source.get("text").and_then(|text| text.get("format")) {
        if format["type"] != "json_schema" {
            return Err(invalid());
        }
        let mut schema = format.get("schema").cloned().ok_or_else(invalid)?;
        strip_schema(&mut schema);
        output_config["format"] = serde_json::json!({"type": "json_schema", "schema": schema});
    }
    serde_json::to_vec(&serde_json::json!({
        "model": model,
        "system": system,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": true,
        "output_config": output_config,
        "fallbacks": "default",
    }))
    .map_err(|_| invalid())
}

/// Map a Messages API error (HTTP status plus the `error.type` field) to a
/// fixed, provider-worded error. Provider message text never crosses IPC.
pub(crate) fn error(
    status: u16,
    value: Option<&serde_json::Value>,
    request_id: Option<&str>,
) -> QuestionError {
    let kind = value
        .and_then(|value| value.get("error"))
        .and_then(|error| error.get("type"))
        .and_then(serde_json::Value::as_str);
    let mut error = match (kind, status) {
        (Some("authentication_error" | "permission_error"), _) | (None, 401 | 403) => {
            QuestionError::new(
                "authentication",
                "Anthropic did not accept this API key. Check the key in Heinlein's Claude settings.",
            )
        }
        (Some("billing_error"), _) | (None, 402) => QuestionError::new(
            "billing",
            "Your Anthropic account needs billing attention before Claude can answer. Check console.anthropic.com.",
        ),
        (Some("rate_limit_error"), _) | (None, 429) => QuestionError::new(
            "rateLimited",
            "Anthropic's rate or usage limit was reached; the request was not retried",
        ),
        (Some("overloaded_error"), _) | (None, 529) => QuestionError::new(
            "providerBusy",
            "Claude is busy right now. Try again in a minute; the request was not retried",
        ),
        (Some("not_found_error"), _) | (None, 404) => QuestionError::new(
            "providerRequest",
            "Anthropic did not accept the selected Claude model. Choose another model and try again.",
        ),
        (Some("invalid_request_error"), _) | (None, 400 | 413 | 422) => QuestionError::new(
            "providerRequest",
            "Anthropic did not accept the request; the request was not retried",
        ),
        (_, 408 | 504) => QuestionError::new(
            "timeout",
            "Claude did not answer in time; the request was not retried and may have incurred usage",
        ),
        _ => QuestionError::new(
            "providerUnavailable",
            "Claude could not answer this request; the request was not retried",
        ),
    };
    error.provider_request_id = safe_request_id(request_id);
    error.http_status = Some(status);
    error
}

pub(crate) fn refused() -> QuestionError {
    QuestionError::new(
        "refused",
        "Claude declined to answer this request. Nothing was changed; you can rephrase or switch to ChatGPT.",
    )
    .at(ProtocolDiagnostic::AnswerContent)
}

/// Reduce a Messages API SSE stream to the internal terminal response object.
///
/// Only `text` content blocks contribute to the answer. Reasoning, signature
/// and fallback blocks are ignored. When a fallback block starts, any text from
/// the declined attempt is discarded so a partial answer is never kept.
#[derive(Clone, Default)]
pub(crate) struct Stream {
    line: Vec<u8>,
    previous_cr: bool,
    data: Vec<u8>,
    total: usize,
    message_id: Option<String>,
    model: Option<String>,
    text_blocks: Vec<usize>,
    text: String,
    stop_reason: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    terminal: Option<Vec<u8>>,
    pub(crate) preview: String,
    pub(crate) preview_changed: bool,
}

impl Stream {
    pub(crate) fn terminal(&self) -> bool {
        self.terminal.is_some()
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<(), QuestionError> {
        self.total = self
            .total
            .checked_add(bytes.len())
            .ok_or_else(QuestionError::response_too_large)?;
        if self.total > MAX_STREAM_BYTES {
            return Err(QuestionError::response_too_large());
        }
        for byte in bytes {
            if self.terminal.is_some() {
                break;
            }
            if self.previous_cr && *byte == b'\n' {
                self.previous_cr = false;
                continue;
            }
            self.previous_cr = *byte == b'\r';
            if matches!(*byte, b'\n' | b'\r') {
                if self.line.is_empty() {
                    self.event()?;
                } else if let Some(mut data) = self.line.strip_prefix(b"data:") {
                    if data.first() == Some(&b' ') {
                        data = &data[1..];
                    }
                    if !self.data.is_empty() {
                        append_bounded(&mut self.data, b"\n")?;
                    }
                    append_bounded(&mut self.data, data)?;
                }
                self.line.clear();
            } else {
                append_bounded(&mut self.line, &[*byte])?;
            }
        }
        Ok(())
    }

    fn schema() -> QuestionError {
        QuestionError::invalid_response().at(ProtocolDiagnostic::ResponseSchema)
    }

    fn event(&mut self) -> Result<(), QuestionError> {
        if self.data.is_empty() {
            return Ok(());
        }
        let data = std::mem::take(&mut self.data);
        let event: serde_json::Value = serde_json::from_slice(&data)
            .map_err(|_| QuestionError::invalid_response().at(ProtocolDiagnostic::EventJson))?;
        match event.get("type").and_then(serde_json::Value::as_str) {
            Some("message_start") => {
                if self.message_id.is_some() {
                    return Err(Self::schema());
                }
                let message = &event["message"];
                let id = message["id"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 256)
                    .ok_or_else(Self::schema)?;
                let model = message["model"].as_str().ok_or_else(Self::schema)?;
                self.message_id = Some(id.to_owned());
                self.model = Some(model.to_owned());
                self.input_tokens = message["usage"]["input_tokens"].as_u64();
            }
            Some("content_block_start") => {
                self.started()?;
                let index = event["index"].as_u64().ok_or_else(Self::schema)? as usize;
                match event["content_block"]["type"].as_str() {
                    Some("text") => {
                        if self.text_blocks.len() >= 64 {
                            return Err(Self::schema());
                        }
                        self.text_blocks.push(index);
                    }
                    Some("fallback") => {
                        // The previous attempt declined; drop its partial text.
                        self.text_blocks.clear();
                        self.text.clear();
                        self.preview.clear();
                        self.preview_changed = true;
                    }
                    Some("tool_use" | "server_tool_use") => {
                        return Err(
                            QuestionError::invalid_response().at(ProtocolDiagnostic::AnswerContent)
                        )
                    }
                    Some(_) => {} // Reasoning and other non-answer blocks.
                    None => return Err(Self::schema()),
                }
            }
            Some("content_block_delta") => {
                self.started()?;
                let index = event["index"].as_u64().ok_or_else(Self::schema)? as usize;
                if event["delta"]["type"] == "text_delta" && self.text_blocks.contains(&index) {
                    let delta = event["delta"]["text"].as_str().ok_or_else(Self::schema)?;
                    if delta.len() > MAX_ANSWER_BYTES.saturating_sub(self.text.len()) {
                        return Err(QuestionError::response_too_large());
                    }
                    self.text.push_str(delta);
                    self.preview.push_str(delta);
                    self.preview_changed = true;
                }
            }
            Some("message_delta") => {
                self.started()?;
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(reason.to_owned());
                }
                if let Some(tokens) = event["usage"]["output_tokens"].as_u64() {
                    self.output_tokens = Some(tokens);
                }
            }
            Some("message_stop") => {
                self.started()?;
                self.finish_message()?;
            }
            Some("error") => return Err(error(200, Some(&event), None)),
            Some(_) => {} // ping, content_block_stop and other lifecycle events.
            None => return Err(QuestionError::invalid_response().at(ProtocolDiagnostic::EventJson)),
        }
        Ok(())
    }

    fn started(&self) -> Result<(), QuestionError> {
        if self.message_id.is_none() {
            return Err(QuestionError::invalid_response().at(ProtocolDiagnostic::StreamFraming));
        }
        Ok(())
    }

    fn finish_message(&mut self) -> Result<(), QuestionError> {
        let (status, incomplete) = match self.stop_reason.as_deref() {
            Some("end_turn" | "stop_sequence") => ("completed", serde_json::Value::Null),
            Some("max_tokens" | "model_context_window_exceeded") => (
                "incomplete",
                serde_json::json!({"reason": "max_output_tokens"}),
            ),
            Some("refusal") => return Err(refused()),
            _ => {
                return Err(QuestionError::invalid_response().at(ProtocolDiagnostic::TerminalStatus))
            }
        };
        let response = serde_json::json!({
            "id": self.message_id,
            "object": "response",
            "status": status,
            "model": self.model,
            "output": [{
                "type": "message",
                "id": "claude_answer",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": self.text}],
            }],
            "usage": {"input_tokens": self.input_tokens, "output_tokens": self.output_tokens},
            "incomplete_details": incomplete,
            "error": null,
        });
        let bytes = serde_json::to_vec(&response)
            .map_err(|_| QuestionError::invalid_response().at(ProtocolDiagnostic::EventJson))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(QuestionError::response_too_large());
        }
        self.terminal = Some(bytes);
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<Vec<u8>, QuestionError> {
        self.terminal.ok_or_else(|| {
            QuestionError::new(
                "interrupted",
                "The Claude answer was interrupted; the request was not retried and may have incurred usage",
            )
            .at(ProtocolDiagnostic::StreamFraming)
        })
    }
}

impl QuestionError {
    /// Reword the provider-neutral failures that this crate phrases for OpenAI
    /// so a Claude author is never told OpenAI failed. Codes are unchanged.
    pub fn for_provider(mut self, provider: Provider) -> Self {
        if provider != Provider::Anthropic {
            return self;
        }
        self.message = match self.code {
            "notConfigured" => "Claude is not configured. Add your Anthropic API key in the Claude settings.",
            "staleConnection" => "The Claude key or model changed. Check the connection and send again.",
            "timeout" => "Claude did not answer in time; the request was not retried and may have incurred usage",
            "network" => "Could not receive a Claude answer; the request was not retried and may have incurred usage",
            "invalidResponse" => "Claude returned an unsupported answer; the request was not retried",
            "outputLimit" => "Claude reached the response length limit before producing an answer; the request was not retried",
            "incompleteNoText" => "Claude returned an incomplete response without answer text; the request was not retried",
            "emptyResponse" => "Claude completed the request without answer text; the request was not retried",
            "incompleteStructuredResponse" => "Claude returned incomplete structured advice; no suggestions were accepted or retried",
            _ => self.message,
        };
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::request;
    use serde_json::{json, Value};

    const MODEL: &str = "claude-opus-5-5";

    fn sse(events: &[Value]) -> Vec<u8> {
        events
            .iter()
            .map(|event| {
                format!(
                    "event: {}\ndata: {event}\n\n",
                    event["type"].as_str().unwrap()
                )
            })
            .collect::<String>()
            .into_bytes()
    }

    fn message(text_chunks: &[&str], stop_reason: &str) -> Vec<Value> {
        let mut events = vec![
            json!({"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":MODEL,"content":[],"usage":{"input_tokens":40,"output_tokens":1}}}),
            json!({"type":"ping"}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"not the answer"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
        ];
        for chunk in text_chunks {
            events.push(json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":chunk}}));
        }
        events.extend([
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":stop_reason},"usage":{"output_tokens":12}}),
            json!({"type":"message_stop"}),
        ]);
        events
    }

    fn decode(bytes: &[u8]) -> Result<Vec<u8>, QuestionError> {
        let mut stream = Stream::default();
        stream.push(bytes)?;
        stream.finish()
    }

    fn advice() -> String {
        json!({"schemaVersion":2,"answer":"Keep the door open—literally.","strengths":[],"findings":[],"edits":[]}).to_string()
    }

    #[test]
    fn ask_body_becomes_a_messages_request_with_only_the_supplied_text() {
        let mut ask = request("one");
        ask.context = "Rain tapped.".into();
        let body = to_messages_body(&crate::request_body(&ask, MODEL).unwrap()).unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["model"], MODEL);
        assert!(value["system"]
            .as_str()
            .unwrap()
            .contains("queer, trans, kink, and furry"));
        assert_eq!(
            value["messages"],
            json!([{"role":"user","content":"Rain tapped."},{"role":"user","content":"What could happen next?"}])
        );
        assert_eq!(value["stream"], true);
        assert_eq!(value["fallbacks"], "default");
        assert_eq!(value["output_config"]["effort"], "low");
        assert_eq!(value["output_config"]["format"]["type"], "json_schema");
        assert!(value["max_tokens"].as_u64().unwrap() >= 8_000);
        // Nothing from the internal wire shape leaks through, and no tools or
        // thinking override are ever sent.
        for absent in [
            "instructions",
            "input",
            "store",
            "tools",
            "text",
            "thinking",
            "max_output_tokens",
        ] {
            assert!(value.get(absent).is_none(), "{absent} must not be sent");
        }
        let schema = value["output_config"]["format"]["schema"].to_string();
        for keyword in UNSUPPORTED_SCHEMA_KEYWORDS {
            assert!(!schema.contains(keyword), "{keyword} must be stripped");
        }
        assert!(schema.contains("additionalProperties"));
    }

    #[test]
    fn revision_and_review_bodies_keep_their_schemas_and_reviews_get_more_room() {
        let mut revise = request("two");
        revise.question = "Tighten this.".into();
        let body = crate::request_body_for(&revise, MODEL, Some("Rain tapped the glass.")).unwrap();
        let value: Value = serde_json::from_slice(&to_messages_body(&body).unwrap()).unwrap();
        assert_eq!(value["messages"].as_array().unwrap().len(), 2);
        assert!(value["output_config"]["format"]["schema"]["properties"]["edits"].is_object());
        let mut internal: Value = serde_json::from_slice(&body).unwrap();
        internal["max_output_tokens"] = json!(crate::review::MAX_REVIEW_OUTPUT_TOKENS);
        let value: Value = serde_json::from_slice(
            &to_messages_body(&serde_json::to_vec(&internal).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(value["output_config"]["effort"], "medium");
        assert!(value["max_tokens"].as_u64().unwrap() > 8_000);
    }

    #[test]
    fn bodies_with_privileged_roles_or_no_user_turn_are_refused() {
        let mut internal: Value =
            serde_json::from_slice(&crate::request_body(&request("one"), MODEL).unwrap()).unwrap();
        internal["input"][0]["role"] = json!("system");
        assert!(to_messages_body(&serde_json::to_vec(&internal).unwrap()).is_err());
        internal["input"] = json!([]);
        assert!(to_messages_body(&serde_json::to_vec(&internal).unwrap()).is_err());
        assert!(to_messages_body(b"not json").is_err());
    }

    #[test]
    fn a_streamed_answer_passes_the_existing_structured_validation() {
        let text = advice();
        let (a, b) = text.split_at(text.len() / 2);
        let bytes = decode(&sse(&message(&[a, b], "end_turn"))).unwrap();
        let answer = crate::parse_question_response(&request("one"), &bytes).unwrap();
        assert_eq!(answer.model, MODEL);
        assert_eq!(answer.input_tokens, Some(40));
        assert_eq!(answer.output_tokens, Some(12));
        assert!(!answer.text.contains("not the answer"));
        assert!(answer.text.contains("Keep the door open—literally."));
    }

    #[test]
    fn a_streamed_revision_passes_the_existing_revision_parser() {
        let text = json!({"explanation":"Sharper verb.","edits":[{"original":"tapped","replacement":"drummed"}]}).to_string();
        let bytes = decode(&sse(&message(&[&text], "end_turn"))).unwrap();
        let (_, edits) = crate::parse_revision("two", &bytes).unwrap();
        assert_eq!(
            crate::apply_revision_diffs("Rain tapped.", &edits).unwrap(),
            "Rain drummed."
        );
    }

    #[test]
    fn every_chunk_boundary_including_utf8_and_crlf_decodes_the_same() {
        let bytes = String::from_utf8(sse(&message(&["Door—🦊 ", "open."], "end_turn")))
            .unwrap()
            .replace('\n', "\r\n")
            .into_bytes();
        let whole = decode(&bytes).unwrap();
        for split in 0..=bytes.len() {
            let mut stream = Stream::default();
            stream.push(&bytes[..split]).unwrap();
            stream.push(&bytes[split..]).unwrap();
            assert_eq!(stream.finish().unwrap(), whole, "split at {split}");
        }
    }

    #[test]
    fn previews_carry_answer_text_only() {
        let mut stream = Stream::default();
        stream
            .push(&sse(&message(&["Hello"], "end_turn")[..8]))
            .unwrap();
        assert_eq!(stream.preview, "Hello");
        assert!(!stream.preview.contains("not the answer"));
    }

    #[test]
    fn a_fallback_discards_the_declined_attempts_partial_text() {
        let mut events = message(&["partial from declined model"], "end_turn");
        let stop = events.len() - 3;
        events.splice(
            stop..stop,
            [
                json!({"type":"content_block_start","index":2,"content_block":{"type":"fallback","from":{"model":MODEL},"to":{"model":"claude-opus-4-8"}}}),
                json!({"type":"content_block_stop","index":2}),
                json!({"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"kept"}}),
                json!({"type":"content_block_stop","index":3}),
            ],
        );
        let bytes = decode(&sse(&events)).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["output"][0]["content"][0]["text"], "kept");
    }

    #[test]
    fn refusal_max_tokens_and_tool_use_never_become_accepted_answers() {
        assert_eq!(
            decode(&sse(&message(&["half"], "refusal")))
                .unwrap_err()
                .code,
            "refused"
        );
        let bytes = decode(&sse(&message(&["half"], "max_tokens"))).unwrap();
        let answer = crate::parse_response("one", &bytes).unwrap();
        assert!(answer.incomplete);
        assert_eq!(
            crate::parse_question_response(&request("one"), &bytes)
                .unwrap_err()
                .code,
            "incompleteStructuredResponse"
        );
        assert!(crate::parse_revision("one", &bytes).is_err());
        assert!(decode(&sse(&message(&["x"], "tool_use"))).is_err());
        let mut events = message(&["x"], "end_turn");
        events.insert(1, json!({"type":"content_block_start","index":5,"content_block":{"type":"tool_use","id":"t","name":"x","input":{}}}));
        assert!(decode(&sse(&events)).is_err());
    }

    #[test]
    fn interrupted_streams_and_events_before_message_start_fail_closed() {
        let events = message(&["Hello"], "end_turn");
        let error = decode(&sse(&events[..events.len() - 1])).unwrap_err();
        assert_eq!(error.code, "interrupted");
        assert!(error.message.contains("Claude"));
        assert!(decode(&sse(&events[2..])).is_err());
        let mut twice = events.clone();
        twice.insert(1, events[0].clone());
        assert!(decode(&sse(&twice)).is_err());
        assert!(decode(b"data: {not json}\n\n").is_err());
    }

    #[test]
    fn errors_are_fixed_claude_wording_without_provider_text() {
        let overloaded =
            json!({"type":"error","error":{"type":"overloaded_error","message":"secret detail"}});
        let mut events = message(&["x"], "end_turn");
        events.insert(3, overloaded.clone());
        let streamed = decode(&sse(&events)).unwrap_err();
        assert_eq!(streamed.code, "providerBusy");
        assert_eq!(streamed.http_status, Some(200));
        for (status, kind, code) in [
            (529, "overloaded_error", "providerBusy"),
            (401, "authentication_error", "authentication"),
            (402, "billing_error", "billing"),
            (429, "rate_limit_error", "rateLimited"),
            (404, "not_found_error", "providerRequest"),
            (400, "invalid_request_error", "providerRequest"),
            (500, "api_error", "providerUnavailable"),
        ] {
            let body = json!({"type":"error","error":{"type":kind,"message":"secret detail"}});
            let mapped = super::error(status, Some(&body), Some("req_011CAbc"));
            assert_eq!(mapped.code, code, "{kind}");
            assert_eq!(mapped.http_status, Some(status));
            assert_eq!(mapped.provider_request_id.as_deref(), Some("req_011CAbc"));
            let wire = serde_json::to_string(&mapped).unwrap();
            assert!(!wire.contains("secret detail"));
            assert!(!wire.contains("OpenAI"));
        }
        assert_eq!(error(529, None, None).code, "providerBusy");
        assert_eq!(
            error(401, None, Some("not-a-request-id")).provider_request_id,
            None
        );
    }

    #[test]
    fn neutral_failures_are_reworded_for_claude_and_untouched_for_openai() {
        for error in [
            QuestionError::timeout(),
            QuestionError::invalid_response(),
            QuestionError::not_configured(),
        ] {
            let openai = error.clone().for_provider(Provider::OpenAi);
            assert_eq!(openai, error);
            let claude = error.clone().for_provider(Provider::Anthropic);
            assert_eq!(claude.code, error.code);
            assert!(claude.message.contains("Claude"), "{}", claude.code);
            assert!(!claude.message.contains("OpenAI"));
        }
    }

    #[test]
    fn claude_configuration_keeps_the_key_sensitive_and_validated() {
        let config = crate::Configuration::anthropic("sk-ant-unit-test-not-a-key", MODEL).unwrap();
        assert_eq!(config.provider(), Provider::Anthropic);
        assert_eq!(config.model(), MODEL);
        assert!(config.authorization.is_sensitive());
        assert!(crate::Configuration::anthropic("", MODEL).is_err());
        assert!(crate::Configuration::anthropic("has space", MODEL).is_err());
        assert!(crate::Configuration::anthropic("sk-ant-x", "bad model").is_err());
        assert_eq!(
            crate::tests::config().provider(),
            Provider::OpenAi,
            "existing configurations stay on OpenAI"
        );
    }
}
