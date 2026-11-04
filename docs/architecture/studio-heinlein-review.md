# Heinlein Review: author-approved revision workflow

Heinlein Review extends the existing selected-account provider, proposal store
and native approval authority. It is advisory. No style finding is a publication
gate, and no reviewer can save, publish, expand context or choose another account.

## Author flow

1. Open **Heinlein Review** in an editable source scene or mapped assembled
   chapter. The captured text includes unsaved editor text; no implicit save or
   provider request occurs. Generated/unmapped exports cannot be edit targets.
2. Choose editable source files; unchecked captured files are read-only context.
   Optional author notes are also read-only. Choose one to 52 reviewer
   instances (one initially), then **Preview reviewer batch**. Inspect the exact
   sources, core/context byte ranges, reviewer definitions and call count.
3. **Run Heinlein Review** sends at most eight serial calls through the existing
   explicitly selected ChatGPT account/model. **Continue next reviewer batch**
   authorizes another bounded batch on the same captured scope and definition
   snapshots. Transient chunk failures retry up to three attempts with cancellable
   backoff; successful chunks are retained. Auth, quota and invalid output failures
   stay terminal. There is no account or model fallback. Retries may incur usage.
4. Each pending card shows its file, current and proposed text in byte-verified
   context, comments and reviewer; exact UTF-8 byte range, patch and full provenance
   are under **Exact patch details**. Captured line/column is derived from the
   immutable baseline (one-based Unicode characters); byte ranges remain authority. **Approve this change…** prepares this exact patch
   and opens the ONE existing native final confirmation. There is no manual copy
   or separate comparison step. Save matching text and resolve recovery first.
5. Overlapping/dependent suggestions have no default winner. Choosing an
   alternative does not apply it. Final approval names the chosen finding and
   all competing alternatives to dismiss; changed membership invalidates it.
   Competitors become `supersededByAuthorChoice`, with audit retained.
6. **Reject this change** durably records rejection before the card disappears. Reload
   saved reviews after navigation or restart without running reviewers again.
   Versioned JSON/history retains accepted, rejected, superseded and blocked
   findings. Exact rejected fingerprints stay dismissed in regenerated results.
7. Waiting suggestions are marked inline in the open source file or mapped assembled
   chapter as CodeMirror decorations; they change no text. Clicking one, or
   Cmd/Ctrl+Alt+] and [ then Cmd/Ctrl+Alt+O, only opens its card; competing
   alternatives open as a group with nothing chosen. A mark needs the same repository
   and path, clean text, no `sourceStale`, and exact `original` bytes at the range,
   plus the baseline hash. After approvals, the open text with accepted patches
   reversed on a copy must hash to that baseline, so a change anywhere else in the
   file removes the marks. Any edit clears them until **Refresh review**; text is
   never searched and ranges are never mapped forward.

## Definitions, bounds and truthful coverage

Reviewer definitions are data: stable ID, version, display name and bounded
instructions. Mechanical and contextual definitions seed this version. Every run
stores the exact selected snapshots/hashes and distinct instance IDs. A later
custom-definition menu is deliberately outside this implementation. Definition
text is untrusted review data and grants no tools, file access or write authority.
A definition change cannot rewrite an existing run's provenance.

Combined selected text, read-only context and notes are limited to 1 MiB; notes
are at most 4,000 UTF-8 bytes. There are at most 128 editable/context windows
(384 individual reviewer/chunk calls, plus one consolidation call) and 1,024 retained findings. Oversize inputs
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

Hiding a running review keeps its captured scope and native request alive, including
when the author opens another scene in the same repository. A fixed top-right radial
shows completed-call counts without changing manuscript geometry. Completion produces
a persistent, polite toast with Open review and Dismiss actions; it never steals
editor focus. Failed or incomplete batches are labeled as needing attention. Repository
changes, explicit cancellation and disposal still clear the captured review.

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

Refresh and reopen compare the cached and persisted review revisions. A newer
record is validated/restored before replacing the cache, including clearing its
prepared candidates; rollback or invalid data preserves the old cache and fails
closed. Legacy session-only reviews do not require a version-2 record. Retained
native plans still recheck current decisions and the final persisted revision.

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

## Passage Ask and revision diffs

Passage revision inference returns `{explanation, edits: [{original, replacement}]}`
instead of a complete rewritten passage. The strict schema allows up to 32
small edits, bounded to 4,000 UTF-8 bytes per side. Every original must occur
exactly once in the immutable captured passage; edits must appear in source
order and cannot overlap. Insertions carry an existing textual anchor. Missing,
ambiguous (including overlapping matches), malformed or reordered anchors fail
closed. No model-produced offsets or fuzzy matching are used. Empty edits means
no change and creates no pending proposal.

Native code assembles the verified patches into the existing immutable proposal;
the saved-source checks, cancellation barrier, whole-scene comparison and native
author confirmation remain in force. The pane displays compact, expandable diff
chips showing only removed/added spans. Chips are presentation, not apply authority;
**Review changes…** reviews the proposal's changes together. Dismiss uses the
existing rejection receipt. Unchanged passage prose is available in the full-scene
comparison rather than repeated in the answer.

Ordinary Ask remains read-only advice. Its instructions request small fenced diff
blocks for wording suggestions, never a rewritten passage. Valid simple diff
blocks render as read-only chips; malformed blocks stay literal text. Ask chips
cannot apply edits or create proposals. All generated strings stay inert text or
pass through the existing safe Markdown renderer. Chips live inside the overlay
and do not change manuscript layout.


### Consolidated reading assessment

New Studio workflow requests set `workflow.consolidate`. The plan appends a
`consolidation` coverage row after all reviewer/chunk calls. It counts toward the
same eight-call native batch limit and uses the same account, model,
cancellation and progress handling. Older saved plans omit the flag and retain
their original coverage.

The final pass receives the validated, persisted individual assessments rather
than another copy of the manuscript. It combines repeated observations, retains
important disagreements and scope limits, and must provide substantive strengths
and improvement assessments. An explanation that no change is warranted is valid;
empty findings and edits remain valid. Consolidation cannot create or decide
patches. Its schema and parser reject edits and findings with edit authority.

The consolidated assessment is the default result. The labelled Review assessment
selector retains every individual reviewer/chunk assessment, including its
existing diff links. All assessments survive saved-review reopening. If an
individual pass fails or an assessment is missing, consolidation is marked
incomplete without sending partial reports. A consolidation failure, cancellation
or input exceeding the 200,000-byte request cap retains individual results and
is shown in call details. There are no automatic retries or silent truncation.


### One-action chapter review

The chapter toolbar keeps **Review chapter** visible beside Source/Reading. It
captures all chapter sheets, selects both built-in reviewers (mechanical and
story/clarity) and every saved custom agent, previews internally, and sends using
the selected ChatGPT account and model. Completed batches continue automatically through the final
consolidation without requiring Preview, Run or Continue clicks. The saved
custom-agent catalog is refreshed before capturing definitions; a
catalog-loading failure stops the run before sending. Up to 52 reviewers are
supported (50 custom plus two built-ins), within the existing 384 individual-call
limit. Oversize plans fail without dropping reviewers.

The run stops on cancellation, a failed call, an invalid response, or continuation
without progress or after bounded transient retries are exhausted. Explicit
**Retry failed chunks** continues the saved review while preserving completed
results. **Resume interrupted chunks** explicitly resumes interrupted/cancelled calls
after reopening; the native single-review gate prevents replacing an active batch.
All continuation requires unchanged captured source/context; finish batches before
applying suggestions, or start a fresh review after changing the capture. Completed individual
assessments remain persisted in the native review record. Success opens and
focuses consolidated feedback; Review assessment switches to any individual
pass. Existing advanced review setup retains explicit batch controls. Review
chapter starts a new run; it never applies manuscript edits.

### Scene and chapter threads

The left navigator selects scenes and chapter/group manuscripts. Each chapter
name opens its descendant source sheets in library order; its separate expansion
button changes only the scene tree. Legacy chapter entries use their explicit
source mapping. Reference-sheet exclusions remain in force.

Chats live in a separate right rail. A scene shows its own conversations and
reviews. A chapter aggregates its own threads and those of descendant scenes and
nested sections. Opening a scene thread from a chapter keeps the chapter selected;
that chat uses its own sheet as context. Back to threads restores the chapter list.

The rail docks only when the manuscript's actual geometry leaves enough space.
Otherwise it opens as a right-side dialog. Opening or closing it never resizes
manuscript text. The native dialog owns focus/inert behavior on narrow layouts;
the dock leaves navigation and writing available on wide layouts.

`threadStore.ts` keeps a bounded, project-specific local metadata index. Threads
have explicit open/resolved status, independent of patch decisions. Resolve keeps
the underlying conversation or native review; Show resolved threads exposes Reopen.
Sending a new question reopens a resolved discussion. The index grants no proposal
authority. Individual reviewer assessments remain available alongside consolidation.

New conversations use independent local history keys per thread and account/model,
with the existing per-conversation storage bounds. Other threads are not sent as
history. Earlier project chat retains its project scope. Saved replies restore
text and advisory diffs only, never source snapshots or approval controls. Threads
from another account/model can be read locally but cannot send with the current
connection.

### Editable chapter manuscript

A chapter is a source-mapped editor projection, joined by `\n\n---\n\n` breaks.
Frontmatter stays in its original sheet and is hidden in the projection. Body edits
map by position, preserving untouched raw bytes, mixed line endings, and authorial
style. Sheet joins are protected against edits that would silently merge sheet
ownership. Undo/redo restores exact per-sheet source bytes.

Chapter saves stage all changed sheets in local recovery, preflight their disk
hashes, then save them individually through the existing guarded native command.
This is not an atomic multi-file transaction: a later write failure can leave
previous sheets saved, while remaining edits and recovery drafts stay available.
Newer typing during a save is retained and staged against the updated hashes.
Recovery drafts or unreadable recovery records block chapter editing until the
writer resolves them in their source sheets. The synthetic chapter path is never
written as manuscript source.

Chapter reviews retain per-sheet editable ranges and use bounded read-only context
from adjacent sheets, separated by `---`. Full selected-context mode retains its
existing explicit bounds. Final consolidation combines individual assessments;
no model output automatically changes the chapter or its source sheets.
