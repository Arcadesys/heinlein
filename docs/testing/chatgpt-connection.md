# ChatGPT connection repair and deterministic fuzzing

## 2026-10-16 completed-item repair checkpoint

Route: bounded workhorse pass, medium requested, one context. Runtime model/effort
switching was unavailable; no enforced model substitution is claimed.

A fresh synthetic probe with the saved selected account and `gpt-6.1-sol`
identified the failure: the HTTP 200 SSE stream carried a completed assistant
message in `response.output_item.done`, while `response.completed.response.output`
was empty. The old decoder discarded the completed item. Only event structure,
field names and text lengths were inspected; no credentials or response bodies
were logged or saved.

The decoder now retains bounded, ordered completed items and fills an empty
terminal output array only after a matching response ID reaches its terminal
event. It rejects duplicate IDs/indices, unfinished message items and mismatched
responses. It never reconstructs answers from deltas. Existing answer/revision
validation, cancellation, size limits and no-retry behavior remain in force.

Current evidence:

- 56 drafting-questions tests passed, including every two-chunk split of the
  observed event pattern, interrupted/duplicate/mismatched streams, tool output
  rejection and strict revision validation; default deterministic fuzz corpus passed.
- Repository-core tests passed (two existing intentional ignores); workspace
  strict Clippy, Rust formatting and diff whitespace checks passed.
- TypeScript/frontend and native release build passed; local bundle signature verified.
- Native Ask returned `Connection OK`, followed by `Follow-up OK` with the same
  selected account/model. The follow-up included only the synthetic first turn.
  Both requests sent zero manuscript context; no revisions were requested/applied.
  Three live requests total: one structural probe and two native questions.
- The follow-up answer was visible in the native panel at the existing large text
  size, wrapped alongside metadata, and exposed in the accessibility tree.
  No frontend styles or interactions changed; this is not an app-wide accessibility audit.
- The synthetic 58-byte source remained byte-identical. No manuscript files changed.

Local repair bundle:
`/Users/arcades/Documents/Codex/heinlein-response-fix/Heinlein Studio.app`.
It opens the repaired native executable directly. Existing updater-enabled apps
were preserved and still follow remote main; this branch is not merged/deployed.
Issue #22 stays open pending integration and remaining restart/author acceptance.
The separate native Documents-folder opening stall reproduced; using a fixture
under `/private/tmp/heinlein-response-smoke` allowed the live connection check.
No macOS security settings changed.

The following sections record the earlier 2026-10-15 work and its then-open live
acceptance boundary.

## Outcome boundary

The native smoke test reproduced the reported failure. The first two synthetic
requests returned HTTP 200 but failed the old Content-Type gate. The third request,
after bounded wire-format decoding replaced that gate, reached response validation
and reported no answer text. **A successful live answer is not established.**

The authorized budget was three small requests total. All used the previously
selected account and `gpt-5.6-luna`, Ask mode, the question
`Reply with exactly: Connection OK`, no manuscript context and no history.
There were no retries, model/account substitutions, API-key fallbacks, or additional
live requests. HTTP response bodies and credentials were not saved or logged.
The exact unexpected header value and whether the third response was incomplete
were not captured; do not infer them from the generic earlier error.

## Changes

- Identify bounded SSE or JSON Responses bytes instead of rejecting a successful
  response solely because its Content-Type is missing or nonstandard. This does
  not switch endpoints or issue a fallback request.
- SSE still requires an explicit terminal event. JSON requires EOF, `object:
  response`, an explicit terminal status, and the same answer/revision validation.
  Deltas, truncated streams, HTML, unexpected shapes, failed or nonterminal
  responses do not become answers. JSON error envelopes retain known usage-limit
  handling. Revision proposals retain the strict structured-output validator.
- Handle LF, CRLF and CR event lines, a leading UTF-8 BOM, and fragmented input.
  Detect the format in linear time with bounded buffering; a large first SSE chunk
  is subject to stream limits rather than the smaller individual-event limit.
- Add optional fixed `diagnostic` categories to native `QuestionError` IPC. Keep
  sanitized HTTP status/request IDs through body and response validation failures.
  The renderer displays only recognized diagnostic labels and bounded metadata as
  text. No credential, raw provider message or manuscript enters diagnostics.
- Distinguish completed-without-text, incomplete-without-text, and a documented
  output-token-limit response. Keep the existing 2,000-token budget unchanged.

## Reproducible campaigns

`HEINLEIN_FUZZ_START` defaults to 1 and `HEINLEIN_FUZZ_SEEDS` defaults to 16
(the ordinary CI corpus). Each seed generates 64 operations. The full campaign
uses seeds 1–1024 inclusive for each family. Failures include seed/step information;
reduce the seed count to 1 and set the starting seed to replay a failure.

From `studio/`:

```sh
HEINLEIN_FUZZ_SEEDS=1024 cargo test --locked -p drafting-questions connection_fuzz -- --nocapture
HEINLEIN_FUZZ_SEEDS=1024 cargo test --locked -p heinlein-chatgpt-auth connection_fuzz -- --nocapture
HEINLEIN_FUZZ_SEEDS=1024 npm test -- --run src/questionPanel.fuzz.test.ts
```

All credentials, callbacks, responses, manuscripts and persistence directories in
these campaigns are synthetic. Authentication tests use local loopback callbacks
and fake HTTP transport. The campaign never sends generated traffic to OpenAI.
The authentication corpus can be sharded into non-overlapping seed ranges; each
seed has independent temporary storage. Full runs are intentionally outside the
ordinary CI seed count.

| Family | Assertions |
| --- | --- |
| Protocol | Chunk-invariant decoding, UTF-8, event framing, malformed/unknown fields and events, refusal/incomplete/failure states, byte limits, JSON transport, strict revision JSON including duplicate fields and fenced advice |
| Lifecycle | Cancellation before/during completion, timeout, duplicate IDs, stale account leases, quota blocking/recheck, slot release, at most one transport call |
| Authentication | Malformed callbacks/catalogs, model restrictions, stale generations, refresh rotation, cancellation during rotation, pre-rotation network failure, private persisted-state reopening, no token reflection |
| Renderer | Async success/failure, cancellation, close/reopen, wrong request IDs, invalid Unicode, incomplete answers, safe diagnostic rendering, restored controls, focus preservation, no automatic network/storage/manuscript mutation |

Additional focused regressions cover interrupted refresh rotation, account/model
switches, revision proposal authority, exact boundary sizes and invalid terminal
metadata. Passing fuzz campaigns establish these bounded cases, not all possible
protocols, interleavings or provider behavior.

## Native verification

- Saved account and model survived app restarts. An explicit connection recheck
  refreshed the account's model catalog; no selection changed.
- Error text and controls were inspected in the native app at 200% text size in
  1200px and approximately 700px windows. Text wrapped; keyboard Tab reached Send
  with a visible focus ring; the scrollable error remained readable. Text size was
  restored to 150%. Existing global toolbar clipping at high zoom is outside this
  connection repair; this is a question-panel check, not an app-wide accessibility
  certification.
- Synthetic source was unchanged. The original app was retained for rollback.
- A diagnostic launch stalled reopening a Documents recent folder at native
  `openat`; an explicit picker and a synthetic folder outside Documents worked.
  No security settings were changed. The cause of that separate folder-access
  issue is unconfirmed.

## Verification checkpoint

Base: `8f7579c364252e0ca81a53bea78161216f37f6fe` on isolated
`codex/fix-chatgpt-connection`. Requested execution route: workhorse, medium, one
context; runtime model switching was unavailable and no override is claimed.

Full campaigns completed on macOS on 2026-10-15:

| Family | Seeds | Generated operations | Failures |
| --- | ---: | ---: | ---: |
| Protocol | 1,024 | 65,536 | 0 |
| Lifecycle | 1,024 | 65,536 | 0 |
| Authentication | 1,024 | 65,536 | 0 |
| Renderer | 1,024 | 65,536 | 0 |
| **Total** | **4,096 seed/family runs** | **262,144** | **0** |

Repeated development runs are excluded. Each operation may assert several
invariants or issue multiple fake/local calls. Authentication ran in eight
non-overlapping 128-seed shards; the longest shard took 820.17 seconds. The final
protocol campaign took 52.92 seconds; the clean renderer campaign took 146.59
seconds including runner setup.

Validation completed:

- 54 drafting-questions unit/regression tests; 42 authentication tests.
- 371 renderer tests; TypeScript and production frontend build.
- Required repository-core, proposal-store and local-MCP tests, with four existing
  intentional ignores. No Python publisher code changed.
- Nine native question-boundary tests and 30 proposal-authority harness tests.
- Workspace strict Clippy, proposal-authority strict Clippy, Rust formatting and
  scoped diff whitespace checks.
- Native release build, ad-hoc code-signature verification and native launch.

The host uses Node 26, whose experimental global web storage conflicts with this
repository's jsdom setup. The full renderer suite passed with
`NODE_OPTIONS=--no-experimental-webstorage npm test`; CI already uses Node 22.
An initial full renderer fuzz run passed its assertions but failed the test-runner
RPC heartbeat because a microtask-only loop starved timers. The harness now yields
between seeds; the clean rerun is the campaign counted above. A development
format detector also exposed quadratic whitespace-prefix work; the final detector
is linear and the long-prefix regression passes.

The final packaged executable SHA-256 is
`c2931946077922395e04b129ba06222a74b51f00998f7c5a7bb4b90fad127f7b`.
The preserved rollback executable SHA-256 is
`5298338f6e9015fa73aad49ba8fbbef2ca57847c604caaaa892b32697fb9db52`.
The final build adds more precise no-text diagnostics after the last live attempt;
it has not consumed any additional live request.
Live budget: 3/3 used. Remaining blocker: the provider response yielded no answer
text; successful answering and a successful follow-up remain unverified.
