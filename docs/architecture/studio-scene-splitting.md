# Studio: split an ms scene

This drafting-focused slice closes the scene-splitting portion of Slice 1b.
Publishing, external inference, and client setup remain outside this workflow.

## Author workflow

Place a single cursor inside an editable scene belonging to the open `ms/`
manuscript, then choose **Split scene at cursor** (Cmd/Ctrl+Shift+Enter). Supply the new scene's title
and Markdown path and review the structural change before applying it.

The original scene retains its stable ID, path, group, metadata, and exact text
before the cursor. The new scene receives a fresh ID, the same group, the exact
remaining text, and a position immediately after the original. The new title is
manifest metadata; the operation does not inject or duplicate frontmatter.

A split needs nonempty text on both sides. It cannot divide a Unicode character,
a CRLF pair, or opening frontmatter. This is a literal source split, not a Markdown
rewrite; inspect formatting and cross-scene references when choosing a boundary.
Directory-changing splits retain the existing conservative relative-reference
safeguards. Filenames need not encode reading order.

## Integrity

The cursor is captured against exact editor bytes. Dirty edits must save and
recovery decisions must settle before preview. Changes to the source, selected
scene, or captured editor state invalidate the operation rather than shifting its
boundary silently. Core independently checks the expected source hash and the
manifest revision.

The existing structural transaction writes both scene files and the manifest.
The split-specific journal validation requires an exact prefix/suffix relationship;
it does not admit arbitrary in-place text replacements. Failure rollback and
interrupted-transaction recovery use the same existing safeguards. Guarded Undo
is available for the completed operation; later edits to either scene block it.

Splitting earns no daily writing credit. The new scene starts with its existing
text as its baseline. The original scene keeps its conservative daily high-water
mark, so new writing there may temporarily undercount after the split. Structural
undo does not become a user-typing event.

## Verification

Synthetic Core and actual Studio-renderer tests cover byte preservation, Unicode
and line-ending boundaries, frontmatter, stable identity/order/group, stale hashes,
collisions, failed writes/rollback, undo after edits, dirty save failures and late
editor changes. Native desktop interaction still requires a desktop smoke test.

Run the focused renderer regression with `cd studio && npm test -- src/sceneSplit.integration.test.ts src/writingPanel.test.ts`. Core split regressions run with `cargo test -p repository-core split`. The full Studio workflow also runs renderer/build, Core/store/MCP, native-authority tests, clippy, and macOS/Linux native compilation.
