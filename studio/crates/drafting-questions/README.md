# Bounded drafting questions

Read-only native Responses API transport, independent of the repository core and
GTK. The author supplies the question, optional context, and bounded in-memory
conversation. There are no file paths, repository handles, tools, edit APIs,
background requests, persistence, or automatic retries.

The native host uses the adjacent `heinlein-chatgpt-auth` crate for explicit
Continue with ChatGPT, account-specific model selection, and protected credentials.
There is no API-key fallback or environment credential lookup. Tests use fake
credentials and mocked transport only; they never make real model calls or grants.
Live consent, account eligibility, and end-to-end inference require native testing.

## Bounds and behavior

- Question: 4,000 UTF-8 bytes; context: 16,000 UTF-8 bytes
- History: at most eight messages, only user/assistant roles
- Question + context + history: at most 32,000 UTF-8 bytes
- Fixed provider URL: `https://api.openai.com/v1/responses`
- `store: false`, `stream: true`, no tools, at most 2,000 output tokens
- HTTPS only, no redirects or proxies, including environment proxies
- 10-second connect timeout; 60-second total request timeout
- At most 1,000,000 stream bytes and 256,000 bytes per event/response
- At most 32,000 answer UTF-8 bytes, displayed as inert plain text
- Only a terminal response is returned. An explicitly incomplete answer is
  marked `incomplete: true`; interrupted/failed streams return safe errors
- One in-flight request, including native credential preflight. Cancellation drops the HTTP future and prevents a late
  result, but cannot guarantee that the provider has stopped processing or billing
- Bounded recent IDs reject accidental duplicate sends and handle cancellation
  arriving before the ask command. Callers must use a fresh request ID each time
- Native Send binds the visible account, model, and connection generation. An
  invalidated account lease prevents inference and rejects late answers
- A structured ChatGPT app-usage-limit error pauses that account's further sends.
  An explicit connection recheck permits another user-directed attempt; it does
  not claim the limit reset and never switches to another billing route

No provider error body, request text, or key is logged or reflected in errors.
Errors preserve only documented machine codes, recognized parameter paths,
bounded provider request IDs, and observed HTTP status for safe diagnosis.
Credentials remain native-only and are marked sensitive in HTTP headers. The
payload excludes conversation IDs, previous response IDs, files, and attachments.
`store: false` is a Responses API setting, not a promise of zero provider retention.

The Tauri adapter in `src-tauri/src/questions.rs` verifies the main window for
all question and account controls. Its opener accepts only the native-generated
OpenAI authorization URL or the fixed ChatGPT Usage settings URL. No credential
or authorization URL crosses renderer IPC. The renderer has no general network
or opener permission.

## Validation

`cargo test -p drafting-questions` runs mocked protocol, bounds, serialization,
SSE fragmentation, cancellation, timeout, duplicate-ID, and safe-error tests.
`cargo clippy -p drafting-questions --all-targets -- -D warnings` checks the crate.
Native GUI compilation requires the normal Tauri platform dependencies.

Protocol references:

- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

