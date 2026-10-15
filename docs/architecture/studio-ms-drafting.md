# Studio: ms drafting workspace

This slice prioritizes writing and arranging a manuscript. Publishing, compiled
manuscripts, and Python publisher integration are deferred.

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
