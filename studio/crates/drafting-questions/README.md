# Bounded drafting questions

Bounded native Responses API transport, independent of the repository core and
GTK. Explicit **Ask** returns read-only advice. Explicit **Suggest revision**
returns a strictly validated, unapproved replacement for a separately previewed
selection. This crate has no file paths, repository handles, tools, save APIs,
background requests, filesystem persistence, or automatic retries.

The native host uses the adjacent `heinlein-chatgpt-auth` crate for explicit
Continue with ChatGPT, account-specific model selection, and protected credentials.
There is no API-key fallback or environment credential lookup. Tests use fake
credentials and mocked transport only; they never make real model calls or grants.
Live consent, account eligibility, and end-to-end inference require native testing.

## Bounds and behavior

- Question: 4,000 UTF-8 bytes; context: 16,000 UTF-8 bytes
- History: at most eight messages, only user/assistant roles
- Question + context + history: at most 32,000 UTF-8 bytes
- Revision requests require empty history and a nonempty target of at most
  16,000 UTF-8 bytes. Question + optional context + target share the 32,000-byte
  budget; only those exact author-previewed strings enter the provider payload
- Fixed provider URL: `https://api.openai.com/v1/responses`
- `store: false`, `stream: true`, no tools, at most 2,000 output tokens
- HTTPS only, no redirects or proxies, including environment proxies
- 10-second connect timeout; 60-second total request timeout
- At most 1,000,000 stream bytes and 256,000 bytes per event/response
- At most 32,000 answer UTF-8 bytes, displayed as inert plain text
- Only a terminal response is returned. In Ask mode an explicitly incomplete
  answer is marked `incomplete: true`; interrupted/failed streams return safe errors
- One in-flight request, including native credential preflight. Cancellation drops the HTTP future and prevents a late
  result, but cannot guarantee that the provider has stopped processing or billing
- Bounded recent IDs reject accidental duplicate sends and handle cancellation
  arriving before the ask command. Callers must use a fresh request ID each time
- Native Send binds the visible account, model, and connection generation. An
  invalidated account lease prevents inference and rejects late answers
- A structured ChatGPT app-usage-limit error pauses that account's further sends.
  An explicit connection recheck permits another user-directed attempt; it does
  not claim the limit reset and never switches to another billing route

## Pending revisions

Revision mode uses Responses `text.format` with `type: json_schema`, `strict:
true`, and an object containing exactly the required string fields `explanation`
and `replacement`. Unsupported models fail without falling back to plain text.
Only a completed response with one assistant output-text part is accepted.
Refusals, incomplete responses, missing/duplicate/unknown fields, Markdown fences,
trailing prose, and malformed JSON cannot become proposals. Explanation must be
nonblank; an empty replacement is valid deletion for separate author review.
The encoded JSON and combined explanation/replacement are each capped at 32,000
UTF-8 bytes. Literal spaces, Unicode, and line endings remain unchanged.

`PreparedRevision` retains the in-flight slot after HTTP completion. Accepted
cancellation before persistence prevents any proposal. `persist` enters a short,
atomic committing phase, then releases its service mutex before local filesystem
work. Once committing, cancellation returns false and connection-changing controls
return busy; the pending proposal may already be storing. Status remains responsive.
Dropping a prepared response before persistence abandons it without a proposal.

The native host captures the saved source, repository session, path, hash, edit
generation, and raw UTF-8 selection before inference. The full source stays local.
It rejects dirty/recovery-pending/generated sources; rechecks the same source and
edit generation before pending storage; and calls `proposal-store::submit_checked`
with another check after temporary-file fsync. An edit followed by undo still
invalidates the captured generation. No inference-time filesystem locks are held.

The pure splice helper replaces exactly prefix + replacement + suffix. It rejects
split Unicode characters or CRLF pairs, accidental new CRLF joins, YAML-frontmatter
overlap/creation (including CR-only line endings), and unchanged replacements.
The native result returns explanation, selected replacement, and pending proposal
ID. Existing native Review/Apply remains the separate manuscript-write authority;
creating a pending proposal never saves the manuscript or grants approval.

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
SSE fragmentation, cancellation, timeout, duplicate-ID, safe-error, strict-revision
parsing, byte-exact splice, and committing-phase responsiveness tests.
`cargo clippy -p drafting-questions --all-targets -- -D warnings` checks the crate.
Native GUI compilation requires the normal Tauri platform dependencies.

Protocol references:

- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

