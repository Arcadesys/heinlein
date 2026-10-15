//! Deterministic synthetic campaigns. Reproduce with HEINLEIN_FUZZ_START/SEEDS.
use super::tests::*;
use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

fn seeds() -> std::ops::Range<u64> {
    let start = std::env::var("HEINLEIN_FUZZ_START")
        .map(|s| s.parse().unwrap())
        .unwrap_or(1);
    let count = std::env::var("HEINLEIN_FUZZ_SEEDS")
        .map(|s| s.parse::<u64>().unwrap())
        .unwrap_or(16);
    assert!((1..=1024).contains(&count));
    start..start.checked_add(count).unwrap()
}
fn next(state: &mut u64) -> usize {
    *state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    (*state >> 32) as usize
}
fn decode(bytes: &[u8], chunks: usize) -> Result<String, QuestionError> {
    let mut stream = ResponseBody::new(None)?;
    for chunk in bytes.chunks(chunks.max(1)) {
        stream.push(chunk)?;
    }
    parse_response("fuzz", &stream.finish()?).map(|v| v.text)
}

#[test]
fn connection_fuzz_protocol() {
    let mut counts = [0; 21];
    for seed in seeds() {
        let mut rng = seed;
        for step in 0..64 {
            let kind = next(&mut rng) % counts.len();
            counts[kind] += 1;
            // The same transport serves suggestions: malformed advice must
            // never become a replacement that could reach proposal persistence.
            let mut revision = answer_value();
            let replacement = format!("Synthetic replacement {seed}/{step} 🦊");
            let revision_kind = (seed as usize + step) % 8;
            let revision_text = match revision_kind {
                0 => serde_json::to_string(
                    &json!({"explanation":"Synthetic reason", "replacement":replacement}),
                )
                .unwrap(),
                1 => "{\"explanation\":\"reason\"}".to_owned(),
                2 => "{\"explanation\":\"reason\",\"replacement\":\"a\",\"replacement\":\"b\"}"
                    .to_owned(),
                3 => "```json\n{\"explanation\":\"reason\",\"replacement\":\"a\"}\n```".to_owned(),
                4 => "{\"explanation\":\"reason\",\"replacement\":\"a\",\"apply\":true}".to_owned(),
                5 => "{\"explanation\":\"reason\",\"replacement\":null}".to_owned(),
                6 => "fuzz-secret advice, not a revision".to_owned(),
                _ => "x".repeat(MAX_ANSWER_BYTES + 1),
            };
            revision["output"][0]["content"][0]["text"] = json!(revision_text);
            let parsed = parse_revision("revision", &serde_json::to_vec(&revision).unwrap());
            if revision_kind == 0 {
                assert_eq!(parsed.unwrap().1, replacement);
            } else {
                assert!(parsed.is_err(), "revision seed={seed} step={step}");
            }
            let mut value = answer_value();
            let text = format!("Synthetic {seed}/{step} 🦊 é — <script>inert</script>");
            value["output"][0]["content"][0]["text"] = json!(text);
            let mut bytes = event("response.completed", value.clone());
            match kind {
                0 => {}
                1 => {
                    bytes = String::from_utf8(bytes)
                        .unwrap()
                        .replace("\r\n", "\n")
                        .into_bytes()
                }
                2 => {
                    let mut prefix =
                        b": heartbeat\n\nevent: ignored\ndata: {\"type\":\"future.event\"}\n\n"
                            .to_vec();
                    prefix.extend(bytes);
                    bytes = prefix;
                }
                3 => bytes.truncate(next(&mut rng) % bytes.len()),
                4 => {
                    let index = next(&mut rng) % bytes.len();
                    bytes[index] = 255;
                }
                5 => {
                    value["output"][0]["role"] = json!("tool");
                    bytes = event("response.completed", value);
                }
                6 => {
                    value["usage"] = json!({"input_tokens":-1});
                    bytes = event("response.completed", value);
                }
                7 => {
                    value["status"] = json!("incomplete");
                    bytes = event("response.incomplete", value);
                }
                8 => {
                    bytes = event(
                        "response.failed",
                        json!({"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"fuzz-secret"}}),
                    )
                }
                9 => {
                    value["output"][0]["content"] = json!([{"type":"refusal","refusal":text}]);
                    bytes = event("response.completed", value);
                }
                10 => {
                    value["output"][0]["content"][0]["text"] =
                        json!("x".repeat(MAX_ANSWER_BYTES + 1));
                    bytes = event("response.completed", value);
                }
                11 => {
                    value.as_object_mut().unwrap().remove("model");
                    bytes = event("response.completed", value);
                }
                12 => bytes = b"data: [DONE]\n\n".to_vec(),
                13 => bytes = b"data: {\n data: ignored\ndata: \"type\":\"unknown\"}\n\n".to_vec(),
                14 => {
                    value["output"][0]["content"][0]["text"] = json!(null);
                    bytes = event("response.completed", value);
                }
                15 => {
                    value["status"] = json!("in_progress");
                    bytes = event("response.completed", value);
                }
                _ => {}
            }
            if kind == 20 {
                bytes = String::from_utf8(bytes)
                    .unwrap()
                    .replace("\r\n", "\r")
                    .into_bytes();
            }
            if (16..20).contains(&kind) {
                value = answer_value();
                value["object"] = json!("response");
                value["output"][0]["content"][0]["text"] = json!(text);
                if kind == 17 {
                    value["status"] = json!("in_progress");
                }
                bytes = serde_json::to_vec(&value).unwrap();
                if kind == 18 {
                    bytes.pop();
                }
                if kind == 19 {
                    value["error"] = json!({"code":"subscription_sharing_usage_limit_exceeded", "message":"fuzz-secret"});
                    bytes = serde_json::to_vec(&value).unwrap();
                }
                let run = |size: usize| {
                    let mut body = ResponseBody::new(Some("application/json; charset=utf-8"))?;
                    for chunk in bytes.chunks(size) {
                        body.push(chunk)?;
                        assert!(!body.terminal());
                    }
                    parse_response("fuzz", &body.finish()?).map(|v| v.text)
                };
                let whole: Result<String, QuestionError> = run(bytes.len());
                assert_eq!(
                    whole,
                    run(1 + next(&mut rng) % 97),
                    "seed={seed} step={step}"
                );
                if kind == 16 {
                    assert_eq!(whole.unwrap(), text);
                } else {
                    assert!(whole.is_err());
                }
                continue;
            }
            let whole = decode(&bytes, bytes.len());
            let fragmented = decode(&bytes, 1 + next(&mut rng) % 97);
            assert_eq!(whole, fragmented, "seed={seed} step={step} kind={kind}");
            if matches!(kind, 0 | 1 | 2 | 7 | 9 | 20) {
                assert_eq!(whole.unwrap(), text, "seed={seed} step={step}");
            } else if matches!(kind, 5 | 6 | 8 | 10 | 11 | 12 | 14 | 15) {
                assert!(whole.is_err(), "seed={seed} step={step}");
            }
            if let Err(error) = fragmented {
                assert!(!serde_json::to_string(&error)
                    .unwrap()
                    .contains("fuzz-secret"));
            }
        }
    }
    eprintln!("protocol operation counts: {counts:?}");
}

#[tokio::test(start_paused = true)]
async fn connection_fuzz_lifecycle() {
    let mut counts = [0; 8];
    for seed in seeds() {
        let service = QuestionService::default();
        let mut rng = seed;
        for step in 0..64 {
            let kind = next(&mut rng) % counts.len();
            counts[kind] += 1;
            let id = format!("s{seed}-{step}");
            let calls = AtomicUsize::new(0);
            if kind == 1 {
                service.cancel(&id).unwrap();
            }
            let (tx, rx) = tokio::sync::watch::channel(false);
            let mut configuration = config();
            if kind == 2 {
                tx.send(true).unwrap();
                configuration.cancelled = Some(rx);
            }
            let result = service
                .ask_with(
                    request(&id),
                    configuration,
                    |_, _| async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        match kind {
                            3 => std::future::pending().await,
                            4 => Err(QuestionError::usage_limited()),
                            5 => Ok(b"fuzz-secret malformed".to_vec()),
                            6 => {
                                service.cancel(&id).unwrap();
                                Ok(answer_bytes())
                            }
                            _ => Ok(answer_bytes()),
                        }
                    },
                    Duration::from_millis(1),
                )
                .await;
            match kind {
                0 | 7 => assert!(result.is_ok(), "seed={seed} step={step}"),
                1 | 6 => assert_eq!(result.unwrap_err().code, "cancelled"),
                2 => assert_eq!(result.unwrap_err().code, "staleConnection"),
                3 => assert_eq!(result.unwrap_err().code, "timeout"),
                4 => {
                    assert_eq!(result.unwrap_err().code, "usageLimit");
                    service.clear_usage_limit("").unwrap();
                }
                _ => assert_eq!(result.unwrap_err().code, "invalidResponse"),
            }
            assert_eq!(
                calls.load(Ordering::SeqCst),
                usize::from(!matches!(kind, 1 | 2))
            );
            assert!(service.state.lock().unwrap().active.is_none());
            let duplicate = service
                .ask_with(
                    request(&id),
                    config(),
                    |_, _| async { panic!("duplicate sent") },
                    REQUEST_TIMEOUT,
                )
                .await;
            assert!(duplicate.is_err());
        }
    }
    eprintln!("lifecycle operation counts: {counts:?}");
}
