# Heinlein Review MVP

Heinlein Review is a bounded advisory module, separate from ordinary drafting
questions. The button captures the current editable source scene, or the ordered
source-scene snapshots underlying a mapped assembled chapter. A scene means its
source Markdown file; the Scenes drawer's `---` passage anchors do not redefine
this scope. Generated chapter exports and unmapped read-only files are never
review edit targets.

## Author flow

1. Choose **Heinlein Review** to inspect the exact captured sources. Unsaved editor
   text is included in scene review. No provider request or implicit save happens.
2. Choose **Run Heinlein Review** to send that snapshot through the existing
   selected ChatGPT account/model. The first MVP uses one proofreader/editor pass,
   returning separately attributed findings. It is not a configurable agent team.
3. Inspect the versioned JSON and each edit's original text, replacement and
   reason. **Accept edit** prepares the existing whole-source comparison, followed
   by the existing separate native author confirmation. **Reject edit** records a
   local immutable rejection receipt without changing manuscript content.
4. Save matching unsaved text before acceptance. Acceptance requires exact saved
   bytes, clean recovery and the existing one-use authority bindings. Ordinary
   typing and saving remain usable while review inference runs.

Connection setup opens the existing Questions account controls; reopen Review
and capture a fresh snapshot afterward. Opening another document or repository
clears the panel and cancels its in-flight request locally. Cancel and timeout
cannot recall already transmitted text or guarantee that usage was not charged.
Retry is explicit and uses the same previewed snapshot with a new request ID.

## Boundaries and contract

- `requestReview`, `prepareReviewEdit`, `rejectReviewEdit`, and `getReview` form the
  module interface. Custom agent configuration and multi-stage orchestration are
  future work, not extra UI in this MVP
- Schema version 1; at most 16 source scenes, 16,000 UTF-8 source bytes total,
  32 nonoverlapping edits, 4,000 bytes per original/replacement and 1,000 bytes per
  reason. Oversize scopes fail explicitly; there is no truncation or chunking
- Provider response is strict JSON, with no unknown fields. Scene indexes map
  only to supplied sources; offsets use raw UTF-8 bytes. Repeated text is bound by
  exact position. Invalid boundaries, overlaps, unchanged replacements,
  frontmatter edits, incomplete output and unsafe controls fail closed
- Original em dashes are protected. This conservative MVP declines edits whose
  original or replacement includes an em dash. Authorial fragments, repetition,
  sexuality and identity are not generic editing errors. Manuscript contents are
  untrusted data, with no tools or instruction authority
- Existing provider transport has a 60-second deadline and 2,000 output-token
  budget; the renderer also cancels locally after 65 seconds. Only source text
  and numeric scene indexes enter the review payload, not local paths, repository
  IDs or hashes. No account keys, new service or fallback billing route is added

## Targeted acceptance, audit and undo

The native host retains one bounded review session. Each target becomes an
existing pending proposal only when the author asks to accept it. This is not
approval. Whole-scene base/replacement/diff hashes and a short-lived one-use
review continue to gate the final native confirmation. Unsaved rejection uses a
rejection-only audit helper and grants no apply or revert capability.

Nonoverlapping edits can be accepted in any order. The native session advances
its expected source only after its own trusted successful apply, and adjusts
later original offsets using only these accepted edits. Arbitrary changed text,
external writes, unrelated proposals or Undo are never used as a rebasing input.
One prepared edit must be completed or rejected before another is prepared.
Canceling a comparison leaves that prepared edit available for reopening.

Completed applies retain existing attributed receipts and guarded same-session
reverts in **Proposed revisions**. A revert changes the source and can invalidate
remaining review findings; run a new review rather than silently rebasing them.
Receipts never reconstruct session authority. The UI survives its own approved
source reload so additional findings remain usable, but ordinary navigation
clears it. Native snapshots last until another review replaces them or the app
exits; proposal/decision records persist under existing local storage rules.

## Verification

Tests cover strict schema/invalid JSON, out-of-scope edits, Unicode and newline
boundaries, overlaps, protected frontmatter/em dashes, unsafe aggregate edits,
trusted sequential/reverse acceptance, rejection-only audit, snapshot capture,
unsaved text, cancel/retry/error recovery, late answers, navigation, concurrent
local typing/save, and native confirmation wiring. These are synthetic and
mocked provider tests. They do not establish real account plan/model support,
live review quality, native OS dialogue usability or macOS accessibility.

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
