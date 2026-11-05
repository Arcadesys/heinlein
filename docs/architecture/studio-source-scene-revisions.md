# Source scenes, assembled chapters, and proposed revisions

## Unified revisions view

The header's Revisions button opens an overlay for the selected project. External
proposals, saved in-app review findings, and recorded decisions share one list,
with All, Pending, and History filters and scene/phrase search. Prepared in-app
proposals are deduplicated by review/finding identity; their operation receipts
replace decided finding cards. Receipt previews expose the before/after bytes
already retained in immutable intents and rejections, without changing storage.
Refresh and Close stay at the top of the overlay. Loading failures retain their
actual error in expandable details and leave the other available source visible.
Outdated, already-present, and exact duplicate proposals remain inspectable in
History instead of being counted as actionable Pending revisions. This display
classification neither rejects an author's alternatives nor rewrites records.

Both sources use the same before/after renderer: red highlighted strikethrough
for removals, green highlighted underline for additions. Accept is the single author action for either source. It prepares an in-app
finding if needed, verifies the displayed proposal binding or finding identity,
and applies through the native source/recovery/receipt guards without a second
confirmation. A changed comparison is refused and refreshed for another explicit
Accept. Details opens the optional whole-scene comparison; guarded revert retains
its separate native confirmation. New apply receipts record studioAuthorAccept;
legacy studioNativeAuthor receipts remain readable. Keep mine uses each
source's existing explicit rejection path. Opening, searching, and filtering the
list neither sends a model request nor creates an apply grant. This is proposal
and decision history, not a log of individual typing/autosave operations.

## Reading the revision workflow

Review results show a read-only stage strip (Ask, Review run, Decide, Done) and, above
the suggestion cards, a consensus summary: reviewer count, how many suggestions two or
more reviewers agreed on, and how many spans have competing alternatives. Agreement is
derived from the saved reviewer provenance; it is a signal, never a decision. Cards are
ordered agreed, then alternatives, then single-reviewer, and each shows "Agreed by ..."
or "Only ...". There is intentionally no bulk Accept: every apply keeps its own native
confirmation, stale-source check, and receipt. Accept opens the exact comparison;
the decline action is **Keep mine** on every surface (review cards, chat revision cards,
and the Revisions overlay). "Reject" remains only in receipts and internal names.

## Independent proposal changes

Local MCP proposals can be prepared against a newer saved scene when their exact
changes are disjoint from the intervening edits. Preparation uses a bounded
three-way comparison in original UTF-8 coordinates. It preserves saved changes,
skips identical changes already present, and refuses overlapping or ambiguous
positions. Proposal records remain immutable. Cards show the refreshed comparison
or explain why a proposal is unavailable; listing creates no apply authority.

Opening review binds the current full source and reconciled replacement to new
hashes before author confirmation. Later disk changes still invalidate that live
review; apply never rebases or substitutes text after confirmation. Receipts and
guarded revert retain the actual reviewed bytes. Native model review findings
continue using their verified accepted-edit lineage and offset mapping.

## Source mapping

Source scenes are the editable Markdown files. A manifest's chapter `source` may
name its first scene; that scene stays editable unless explicitly declared as a
generated output in `sources`. The chapter reading action is distinct from
opening that entry scene. An assembled chapter is a reading
view built from the current scene snapshots in manifest order. Its exported file
is never a save target. “Assembled” describes the file relationship, not whether
an author or a model wrote the prose.

Opening a mapped chapter reads its source scenes, strips their frontmatter for
the reading view, and retains an offset map into each original scene. This works
even when the exported chapter is stale or absent. Repeated passages resolve by
position, never text search. Raw CRLF and Unicode are preserved when the source is
opened and saved; offsets in the reading view use CodeMirror's normalized UTF-16.

Select a passage and choose **Revise source passage** (or Cmd/Ctrl+Alt+Enter).
Studio opens the source scene, verifies its full text and saved hash still match
the displayed snapshot, selects the same passage, and opens Questions in revision
mode. Nothing is sent or saved by navigation. The author can edit the source
directly, or explicitly request a proposed revision and use the existing exact
before/after review, native confirmation, receipt, and revert workflow.

Selections crossing scene boundaries require a narrower selection or an explicit
source-scene choice. Changed scenes open for inspection without a stale revision
target. Recovery failures remain visible and fail closed. Unmapped assembled
files remain readable, with an explanation to open their source scenes. Exported
chapter files are refreshed by the existing publishing build, not this view.

The reader supports keyboard selection, a focus indicator, an announced read-only
state, large labeled controls, and narrow reflow. Its editor is separate from the
source editor so save/recovery and temporary read-only changes cannot enable
chapter edits. Folder selection restores a temporary read-only setting only on
the editor that had that setting; a new source editor does not inherit it.

## Review an entire chapter for targeted edits

From a chapter source scene, open **Heinlein → Whole scene → Entire chapter…**.
Studio captures every source scene in manifest order (or the current drafting
chapter's order), including the active editor's text. The manuscript view and
selection stay in place. An assembled chapter already opens review at chapter
scope. The review tab reads **Whole chapter** once chapter scope is captured.

Opening and capturing are local preparation. **Preview review** shows the exact
bounded calls; **Run review** explicitly sends them with the selected account
and model. Long chapters use the existing chunk and Continue workflow. Each call
has bounded context; this does not promise the entire chapter in every call.
Returned edits identify their own source file and exact range. Each edit keeps
the existing author confirmation, stale-source checks, receipt, and revert flow.

Capture fails without replacing the scene scope if a source is missing,
generated, or the active document or chapter mapping changes during loading.
Limits remain 128 source files and 1 MiB in the workflow host; older hosts retain
their 16-scene / 16,000-byte review limit. Nothing is silently truncated.

### Chapter review checkpoint · 2026-11-04

- Route: one workhorse pass at ordinary implementation effort in the existing
  chat. No model or effort switch was enforced; no agents were delegated.
- Scope: chapter capture from source-scene review, scope labels, synthetic
  regression fixtures. Existing unrelated worktree changes are preserved.
- Evidence: focused integration checks cover legacy manifest order, current
  drafting order, missing/generated sources, navigation during capture, and
  disk drift without implicit saves, sends, or applies. Desktop and 320px synthetic browser
  checks cover keyboard capture, explicit preview/send, edits in two source
  files, Axe accessibility, and unchanged editor dimensions and text.
- Final checks: 1,031 frontend tests, 14 browser smoke cases, and the production
  frontend build pass. The chapter/source-reading browser regression passes at
  both widths. Rust core suites, 131 native boundary tests, 33 proposal-authority
  tests, 17 review-lineage tests, formatting, and workspace/harness Clippy pass.
  Existing ignored Rust tests were not run. Browser plugin unavailable; the
  repository Playwright workflow provided rendered evidence.
- Limits: provider behavior is mocked in browser checks. Installed-app,
  physical VoiceOver, and live-provider acceptance are not established here.

## Checkpoint

- Route: one bounded workhorse pass at ordinary implementation effort. Model
  switching was not enforced; the existing chat settings were retained.
- Scope: Studio document navigation, source mapping, terminology, and the native
  read-only error. No manuscript edits, AI sends, or publication.
- Evidence: 423 frontend tests pass, including repeated-text, CRLF/Unicode,
  stale-source, cross-scene, editable-source and save regression cases. 192 Rust core,
  proposal, MCP, questions, and auth tests pass; workspace Clippy passes.
- Rendered evidence: synthetic browser fixture at 1280×900 and 390×844;
  keyboard passage selection, opening the matching editable source, typed save,
  no horizontal document overflow, 19px source text, no page errors.
- Environment: Browser plugin unavailable; bundled Playwright used. Node 26 tests
  require NODE_OPTIONS=--no-experimental-webstorage to use jsdom localStorage.
- Native acceptance: production Tauri build and signature verification pass.
  The installed app opens a chapter whose entry file is also a source scene;
  keyboard selection opens its exact proposed-revision target. A synthetic source
  edit saved through the app was read back byte-for-byte with CRLF preserved;
  the exported chapter was unchanged. No model request was sent. An author-owned
  source scene was then opened and confirmed editable in the installed app,
  with no edits made to that manuscript.

- Final checks: 9 native question-host tests and 30 proposal-authority harness
  tests pass; authority-harness Clippy and workspace formatting pass. The
  installed app was verified with an editable author-owned source scene.
