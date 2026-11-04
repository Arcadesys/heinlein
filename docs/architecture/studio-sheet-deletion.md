# Sheet deletion

The Library actions menu for every regular or reference sheet offers **Delete
sheet…**. The confirmation names the sheet and displays its Markdown path.
**Cancel** receives initial focus; Escape cancels. **Delete sheet** is the only
action that applies deletion. Unsaved writing is saved before the preview; cancel
does not undo that ordinary save.

Deletion removes that Markdown file and its indexed scene/library entry. It does
not remove a group, other sheets, linked assets, or unrelated unlisted files.
Discovered reference sheets can be deleted without adding them to the index.
Missing indexed sheets can be removed without creating a replacement file.
Existing legacy/generated-file restrictions remain authoritative.

The structural transaction guards the preview's index, file membership, exact
source bytes and permissions, and pending recovery. A changed preview fails
without deleting newer content. Failed writes roll back, and interrupted writes
use the existing guarded recovery journal.

**Undo last change** in the project actions menu restores the original bytes,
permissions, identity, classification, library position and index during the
current app session. A replacement at the deleted path blocks Undo. Deletion is
not the macOS Trash, and restarting the app ends session Undo. Links to deleted
sheets are not rewritten. Existing explicit GitHub sharing controls still apply.

Deleting the active sheet clears its writer. Deleting another sheet preserves
the active editor instance, text, cursor and text geometry. Deleted document tabs
and saved references become unavailable instead of retaining a live writer.

Filesystem tests use temporary synthetic projects. Renderer and browser tests
use an isolated synthetic boundary; they never delete author manuscripts.
