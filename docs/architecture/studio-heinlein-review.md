# Heinlein Review: author-approved revision workflow

Heinlein Review extends the existing selected-account provider, proposal store
and native approval authority. It is advisory. No style finding is a publication
gate, and no reviewer can save, publish, expand context or choose another account.

## Author flow

1. Open **Heinlein Review** in an editable source scene or mapped assembled
   chapter. The captured text includes unsaved editor text; no implicit save or
   provider request occurs. Generated/unmapped exports cannot be edit targets.
2. Choose editable source files; unchecked captured files are read-only context.
   Optional author notes are also read-only. Choose one to three reviewer
   instances (one initially), then **Preview reviewer batch**. Inspect the exact
   sources, core/context byte ranges, reviewer definitions and call count.
3. **Run Heinlein Review** sends at most eight serial calls through the existing
   explicitly selected ChatGPT account/model. **Continue next reviewer batch**
   authorizes another bounded batch on the same captured scope and definition
   snapshots. There is no aggregator model, automatic retry or account fallback.
4. Each pending card shows its file, original UTF-8 byte range, full before/after
   diff, comments and reviewer provenance. Captured line/column is derived from the
   immutable baseline (one-based Unicode characters); byte ranges remain authority. **Approve…** prepares this exact patch
   and opens the ONE existing native final confirmation. There is no manual copy
   or separate comparison step. Save matching text and resolve recovery first.
5. Overlapping/dependent suggestions have no default winner. Choosing an
   alternative does not apply it. Final approval names the chosen finding and
   all competing alternatives to dismiss; changed membership invalidates it.
   Competitors become `supersededByAuthorChoice`, with audit retained.
6. **Reject edit** durably records rejection before the card disappears. Reload
   saved reviews after navigation or restart without running reviewers again.
   Versioned JSON/history retains accepted, rejected, superseded and blocked
   findings. Exact rejected fingerprints stay dismissed in regenerated results.

## Definitions, bounds and truthful coverage

Reviewer definitions are data: stable ID, version, display name and bounded
instructions. Mechanical and contextual definitions seed this version. Every run
stores the exact selected snapshots/hashes and distinct instance IDs. A later
custom-definition menu is deliberately outside this implementation. Definition
text is untrusted review data and grants no tools, file access or write authority.
A definition change cannot rewrite an existing run's provenance.

Combined selected text, read-only context and notes are limited to 1 MiB; notes
are at most 4,000 UTF-8 bytes. There are at most 128 editable/context windows
(384 calls with three reviewers) and 1,024 retained findings. Oversize inputs
fail explicitly without truncation. Each call keeps the existing 16,000-byte
text bound, 32 edits, 4,000 bytes per before/replacement and bounded output. Core
and neighboring context boundaries preserve UTF-8/CRLF. Read-only context is
windowed too: every selected byte is covered, but one call does NOT see the whole
work. When context needs more windows, editable cores can be revisited with a
different window. The preview discloses this limited global context.

Coverage records queued, running, completed, failed, cancelled and not-run calls
individually. Each running intent and settled result is persisted before the next
call. Valid siblings survive schema failures/cancellation. Interrupted running
calls are not automatically repeated; preserve the record and explicitly start
a fresh review if needed. Finding-cap failure retains the whole valid prior
result, never a silently truncated call. Incomplete coverage is not a complete
review, and zero findings is valid. An active batch must settle before approval.

Provider JSON is strict and uses indexed sources, not private paths or project
IDs. Native code validates ranges, exact before text, core scope, protected
frontmatter/em dashes and selected model. Native call IDs and available provider
response IDs are recorded separately. Responses cannot edit read-only context.
Intentional fragments, repetition, sexuality, identity and em dashes remain
protected author choices. Austen's profile is opt-in, not a default identity.

## Consolidated record, lineage and persistence

Private `review-records-v2` records use schema version 2, stable native review and
finding IDs, project/source hashes, ordered source manifests, baseline text once
per source, editable ranges/read-only context, definition snapshots, coverage,
canonical patch/hash, comments, provenance, choices and immutable decision
entries. Existing proposal receipts/journals remain the source-write audit.
Atomic private writes use revision compare-and-swap; a record-write failure must
not hide rejection. No review data is written inside the manuscript repository.

Identical source/range/before/replacement findings deduplicate deterministically
with all comments/provenance. Distinct overlaps, same-point insertions, insertions
at replacement boundaries and demonstrable adjacent dependencies become explicit
conflicts. Late exact duplicates inherit terminal status. Late conflicts with an
applied decision are blocked for fresh review rather than composed.

The immutable baseline plus this review's verified accepted-patch ledger advances
only its own source lineage. An earlier Unicode-length change shifts later
nonoverlapping ranges by the recorded byte delta. Reverse order, other files and
repeated identical passages remain distinct; no text searching or guessed rebase
is permitted. External saves, path/scene reassignment, unrelated edits or Undo
block the affected source, while other files remain available.

On reopen, native code validates the record, definition/patch hashes and completed
receipt chain against current disk hashes. Receipt-before-record crashes are
reconciled informationally without replaying Approve. Stored JSON and receipts
never mint a native apply capability: every approval still needs a fresh
session-bound one-shot plan, final native author confirmation and source/save/
recovery/mutation/revision checks. Competing decisions cannot change during the
final local write. Existing guarded same-session reverts remain in **Proposed
revisions**; reverting makes affected remaining source lineage stale.

## Verification boundaries

Focused tests use synthetic text, local private temp stores and mocked provider
responses. Native integration exercises production proposal/file/receipt gates,
including restart and crash gaps, without driving an OS dialog. Real Chromium
exercises the production Studio/panel on an explicitly synthetic browser host,
including keyboard, 200% text, 320px reflow, axe, explicit conflict choice,
sequential approvals and rejection after reload. Its confirmation surrogate is
NOT native UI proof. Live provider quality/usage, native WebKit/dialog/VoiceOver
and other OS runtime acceptance remain separate manual checks.

## Deterministic safety campaigns (2026-10-16)

All campaigns use synthetic prose and replayable seeds. They are regression
coverage, not exhaustive proof of safety:

- Native review state: seeds 1–256 XOR `0x454449544c494e45`, 64 attempted
  transitions each (16,384). Exercises preparation, trusted application,
  independent rejection, generic proposal rejection, incorrect bindings and
  terminal decisions, comparing exact expected source after each transition
- Real filesystem proposal authority: seeds 1–64 XOR `0x4845494e4c45494e`,
  48 operations each (3,072). Exercises apply/revert, external changes, stale
  hashes, wrong sessions, cancellation, rejection, restart and dirty guards;
  asserts disk bytes and receipt uniqueness after each operation
- Provider schema/offset validation: four fixed seeds
  `0x4845494e4c45494e`, `0x2026101600000001`, `0xdeadbeefcafebabe`,
  `0x0123456789abcdef`; 20,000 known-unsafe mutations and 4,000 arbitrary
  offsets, alongside 20,000 valid baselines

Run the Rust campaigns with `cargo test -p drafting-questions` in `studio`,
plus `cargo test --manifest-path crates/review-state-test-harness/Cargo.toml`
and `cargo test --manifest-path crates/proposal-authority-test-harness/Cargo.toml`.
Renderer campaign instructions and seed controls are in `src/review.fuzz.test.ts`.

Independent review found and minimized two recoverable lifecycle bugs:
`prepare A → cancel comparison → reject B`, and
`prepare A → reject A in Proposed revisions → prepare B`. Both now have direct
regressions: rejection has a separate candidate path and native generic rejection
updates the retained review session. **Refresh review** reconciles that panel's
displayed decisions with the native host. No fuzz-discovered manuscript corruption
or approval bypass was observed in these runs.

Renderer stateful campaign: seeds 1–64, 384 operation attempts each (24,576),
including 908 dispatched requests, 267 malformed responses, 341 canceled late
completions, 24 blocked stale guards, 72 authority reviews and 64 explicit
confirmations. Effective local actions include 1,614 typing operations, 1,581
saves and 1,566 navigations. A known successful acceptance prelude per seed
ensures successful approvals are exercised alongside random interrupted paths.
Every step checks exact expected working/disk state and unrelated bytes. Replay
with `HEINLEIN_REVIEW_FUZZ_START`, `HEINLEIN_REVIEW_FUZZ_SEEDS`, and
`HEINLEIN_REVIEW_FUZZ_STEPS`; failures report seed and operation trace.

Cloud validation also passed the full frontend suite and production build,
provider tests, authority/session harness tests, and 138 other Rust regression
tests (four intentional ignores). Full native application compilation stops at
missing `glib-2.0.pc`, before host code compilation. Cloud Chromium screenshot
attempts failed at browser startup, so no visual/native-runtime acceptance is
claimed. No live provider request, real manuscript edit, macOS change, push,
PR or merge was performed.
