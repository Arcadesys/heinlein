# Studio: ms drafting workspace

Studio prioritizes writing and arranging author-controlled source. The first-story
guide adds one narrow compilation exception: an explicitly confirmed, text-only,
one-way snapshot for the existing external Python publisher. Studio does not run
a publishing engine, distribute files, manage publishing accounts or synchronize publishing copies. The separate
[GitHub workspace](studio-github-workspaces.md) flow manages author-confirmed
source versions and feedback; it does not change this one-way publishing boundary.

## Source authority

An explicitly created manuscript uses `ms/` beneath the selected project root.
Markdown files remain ordinary editable files. `ms/manuscript.json` records stable
scene IDs, explicit reading order, and optional grouping metadata. A scene move
keeps its ID; a copied scene receives a new ID. Order is independent of filenames.
Nested folders remain available for organizing source files.

Legacy schema-v1 `scene-manifest.json` manuscripts continue to open and edit with
their existing generated-source protections. Opening a repository never migrates
or rearranges the writing archive. Untracked Markdown under ms is surfaced for
explicit inclusion; missing files are reported rather than silently removed.

## Structural operations

Creating a manuscript, creating a scene, importing a file, moving a scene, and
reordering are explicit author actions. File/manifest changes use a preview and
revision checks. Collisions and external modifications stop the operation rather
than replacing another file. Undo is guarded by the post-operation state; it must
not overwrite edits made afterward.

Repository-to-manuscript imports move source files. External imports copy files
selected through native authorization. The renderer cannot supply an arbitrary
absolute source path. Keyboard controls provide the same essential workflow as
dragging. Dirty edits and pending saves/recovery must settle before a structural
operation; uncertain recovery is a blocker, not an invitation to delete a draft.

Daily goal identity uses stable scene IDs for these manuscripts, preserving the
scene's baseline across path changes. Counts include the declared manuscript
members in their current buffers or saved files; generated publication output is
outside this slice.

## Acceptance

Tests must use synthetic fixtures. Cover stable IDs/order, loose scenes, nested
paths, collisions, traversal/symlink rejection, stale preview/application, partial
failure rollback, guarded undo, recovery interaction, and legacy compatibility.
Native drag/drop and picker behavior require an actual desktop smoke test beyond
mocked renderer tests and compilation.

## Initial import limits

The first import workflow accepts individual Markdown files, not directory trees
or an asset-copying pipeline. An explicit legacy import creates an independent
copy under ms and leaves the original legacy manuscript unchanged; the two do not
synchronize. Moving a source referenced by a legacy manifest is rejected, with
copy/import offered instead. The application never chooses a replacement
canonical manuscript for the author automatically.

Recognized relative asset/reference-bearing content blocks directory-changing
imports and moves rather than rewriting prose or silently breaking its references.
This is a conservative safeguard, not a universal Markdown/HTML dependency parser.
Incoming links elsewhere can still require author review after a path change.
Reordering alone changes the manifest order and preserves path-based resolution.

Structural moves preserve file bytes and mode bits through guarded copy/delete;
they do not promise preservation of ACLs, extended attributes, or timestamps.
Interrupted-operation rollback restores a safe state and is intentionally not
undoable: recreating a partial transaction would discard its recovery protection.
Normal completed structural operations retain guarded Undo.


## Optional first-story guide

The First story entry works before a folder or manuscript exists: it routes to
native folder selection and the existing manuscript-creation controls. Six
resumable stages cover idea, discovery writing or a light plan, a draft with an
ending, separate structure and sentence/voice passes, proofing a stable saved
revision, and publishing preparation. Coaching and examples are optional.
Progress is author-declared, not inferred from writing, a style score or provider
output. Heinlein Review opens only on explicit request and remains advisory.

Version-1 guide state lives in native app data at
`first-story-v1/<repository-project-key>.json`, scoped explicitly to
`ms/manuscript.json`. It is outside manuscript text. Writes use a revision token,
a private temporary file and atomic replacement; malformed/unsupported state is
preserved until an author-confirmed guide-only reset. Skip requires confirmation;
close/resume preserves notes. Source fingerprints bind the complete manifest and
all included scene hashes. Source edits clear proof and publishing checks while
retaining earlier progress and intentional skips. This is not evidence that an
author has actually completed a review or published anything.

## Text-only publishing copy boundary

Only a valid schema-v2 ms manuscript is supported. Every declared scene is
included in explicit manifest order, independently of filenames and groups.
Untracked files are not manuscript members; missing/unsafe members stop the copy.
Groups add no chapters. The preview lists each scene and exposes the exact
combined Markdown, configuration, source hashes and manifest revision. Exact
scene bytes are joined with `\n\n---\n\n`. Scene frontmatter, link/asset/reference
syntax, HTML and include directives are rejected with an actionable error, never
silently stripped or rewritten. This conservative guard is not an asset resolver.

The snapshot adds a generated title/byline and metadata frontmatter so the
existing Python CLI strips only that generated block, preserving the first
source heading. Metadata requires author-entered title, author, rights, language,
formats, and explicit approval of no cover and existing FREE PLAY branding.
There are no inherited author identities, rights statements or editorial profiles.
FREE PLAY also includes the existing publisher's preset colophon text; selecting
an unknown imprint does not avoid its fallback. A different imprint/cover/assets
requires a separately configured manual publishing project in this first version.

Native authority retains a preview token and OS-selected parent directory; the
renderer cannot supply a root or destination path. A final native confirmation
shows title/author/rights/formats and the new destination. Selected-root, dirty-edit
epoch, repository-save, structural-transaction, source-revision and clean-recovery
barriers are rechecked. Files are synced inside a new staging directory and
exposed by an exclusive no-replace rename: even an existing empty directory or
symlink is not replaced. The same regression runs on macOS and Linux using their
platform-exclusive rename implementation. Failed staging is cleaned up; a
post-rename directory-sync error reports uncertain completion, never permission
to overwrite/retry the destination. Power-loss durability is not proven by these
tests.

The new folder contains `manuscript.md`, `heinlein.yaml` and
`source-receipt.json` (manifest revision, ordered scene hashes, combined/config
hashes, and treatment). It must be outside the source repository. Source remains
canonical; later edits require a fresh copy at a new destination. There is no
reverse sync, overwrite, automatic publication or distribution.

Run `heinlein build` and `heinlein serve --host 127.0.0.1 --port 8765` in the new
folder using the existing Python environment. Studio never launches these
commands. Inspect the HTML and chosen format before sharing. The normal Python
suite's `tests/test_first_story_handoff.py` runs the production Rust example and
existing CLI to verify HTML/EPUB title/order/provenance and unchanged source.
This is core-snapshot-to-CLI proof, not native IPC, picker or screen-reader proof.

## Standalone writing before a destination

Studio can mount its raw-text editor without selecting a repository. This is a
standalone document, not an implicit `ms` project. The native private store and
writer lease preserve it independently of recent folders. Choosing a destination
is an explicit copy operation; it does not retarget the editor. See
[Standalone drafts](studio-standalone-drafts.md) for preservation, recovery and
placement boundaries.

The narrow `LiteralScene` core operation creates a new source scene from a
native-retained exact UTF-8 snapshot in the existing scene/manifest transaction.
It neither imports an unselected external file nor creates an empty scene followed
by a separate save. Ordinary Create scene keeps its existing empty-body contract.

## Project library and return-to-writing hints

The Projects library is private metadata in `projects-v1/library-v1.json`.
Each native-generated project UUID names either a validated local writing-root
identity or an existing managed GitHub workspace UUID. The label is editable;
renaming it never moves writing or changes the repository/account binding.
Library listing and switching use local metadata, not credential storage or a
network request. Local-folder history is imported once, retained unchanged,
and exposed through a compatibility view of the library. Managed projects
remain bound to the existing workspace registry; library metadata cannot grant
GitHub authority. Missing locations stay unavailable and are never recreated.

A switch first settles acknowledged local writes and captures a source-hash-bound
relative document/scene and UTF-16 cursor/scroll hint. Native one-shot activation
rechecks the source session, mutation generation, project revision and target
identity. Writing-save failure, cancellation, concurrent editor changes or an
unavailable target leaves the current writing intact. Resume metadata is best
effort after writing is settled: a clean externally changed/missing file or root
cannot trap departure or an approved Quit. Switch and Quit share the same best-effort
capture, skip an explicitly discarded dirty buffer, and retain concurrent-edit and
pending-recovery barriers. Reopening validates any retained hint and uses the overview
for a changed or missing source instead of guessing a passage. Stable root-based recovery keys and GitHub
workspace/account/branch authority are unchanged; unresolved Send receipts stay
with their original workspace and are never replayed by switching projects.

The library holds no manuscript text, credentials or copied Git capabilities.
Atomic private metadata writes, a stable cross-process lock and revision CAS
preserve other projects and reject stale edits. Bounds are explicit (4,096
entries and the existing private-record byte budget); recency never evicts
writing or project records. Standalone drafts remain independent and immediately
editable without creating a project. Their existing explicit copy-and-retain
placement flow registers a destination only after successful native selection;
returning to a kept draft restores its durable identity and hides project Send.

The Manuscript tab exposes **Add scene** and **Add chapter** together. Add chapter
uses the existing stable scene-group primitive: it starts empty and never inserts
prose or changes existing author groups. The list labels these as chapters and
scene groups and shows empty counts. Add scene explicitly chooses its chapter/group
(defaulting only from the currently open validated scene), previews the existing
no-replace transaction, and opens an empty source file after confirmation. Standalone
and uninitialized-project states explain setup rather than implicitly creating a
manuscript. Cancellation leaves source and manifest unchanged; focus returns to
the initiating control. Structural save/recovery/session guards remain unchanged.

Manuscript move controls use native `PlaceScene` (explicit membership and native
before/after/end anchor) and `ReorderGroup` plans. Drag grips and the keyboard Move
form submit the same intent; hover and canceled previews write nothing. Existing
trusted native approval, revision/source hashes, recovery and save barriers remain
required. Only the manifest changes: scene IDs, authored group names/types, paths
and raw source bytes remain intact. A group moves only its members, keeping their
internal order; ungrouped scenes are not cargo. Preview states the exact resulting
flat reading order and adjacent scenes, which is also the publishing-copy order.

Whole-group movement requires contiguous members and nonempty group metadata order
matching flat reading order. Ambiguous legacy layouts refuse group movement and
inferred empty-group insertion, without normalizing them. Explicit individual
scene placement remains available. Empty group slots are durable metadata; later
Create scene or Move into that empty group inserts before the next nonempty group,
or at the actual document end. Consecutive empty slots use the same rule. Same-slot
moves are true no-ops and do not rewrite the manifest or create an undo journal.
