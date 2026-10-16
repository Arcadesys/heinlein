# Offline manuscript search

This slice adds literal text search across the manuscript currently displayed in
Studio's outline: either `ms/manuscript.json` or a selected legacy scene manifest.
Use **Find in manuscript** in the outline or command palette, or Cmd/Ctrl+Shift+F.
Cmd/Ctrl+F remains the current-scene Find command.

## Read and navigation contract

Opening the nonmodal panel and entering a query perform no reads. Search starts
only on explicit submission. Each search captures the open editor's exact buffer,
including unsaved changes, and reads other scenes through the existing authorized
repository read boundary. It searches source text, including frontmatter. It does
not recursively search unrelated repository files, build an index, persist queries
or results, or transmit anything to a provider. Em dashes and all source text are
preserved; result snippets are rendered as text, never HTML.

Results include the scene title, relative path, source line and a bounded excerpt.
Matching is literal, non-overlapping and case-insensitive by default, with a Match
case option. Unicode regex matching retains original UTF-16 offsets rather than
computing positions from lowercased copies. Raw CRLF offsets are converted only
when selecting in CodeMirror; source bytes are unchanged.

A result is a snapshot. Clicking a result for the current buffer preserves its
editor and undo history. Another scene uses the existing save/discard/cancel
navigation guard and recovery checks. The whole target source must still equal
the searched snapshot before a range is highlighted. A changed source asks the
author to search again; it never guesses a relocated match. Manuscript scope is
checked before reads and before rendering so a late result cannot reopen a scene
from a manuscript the author has since left. Newer document navigation also keeps
the existing request-generation guard.

## Bounds and responsiveness

A search permits at most 256 UTF-16 query code units, 500 unique scenes, 2,000,000
UTF-16 source code units per scene, 8,000,000 total searched source code units, and
200 results. Unreadable and oversized scenes are reported explicitly. Reaching a
bound is reported as a partial search, never as exhaustive absence of matches.
Native repository reads retain their existing file-size and path checks.

Scans yield to the event loop between scenes, including cached/mock reads. The
panel stays nonmodal, with ordinary Tab navigation and Escape/Close. Cancel,
query/case changes, closing, disposal, and manuscript changes invalidate pending
results. A native read already in progress may finish, but its stale response
cannot append results or start another read. Typing, save and recovery have no
search or inference dependency. These bounds are implementation safeguards, not
a measured keystroke-latency guarantee on reference hardware.

## Verification

Synthetic unit and DOM integration tests cover literal metacharacters, Unicode
case folding, mixed CR/LF source lines, em dashes, limits and skipped files,
unsaved-buffer capture, safe text rendering, cancellation, reordered asynchronous
completion, close/reopen, manuscript/repository changes, exact passage selection,
stale disk/buffer results, and the unsaved-navigation guard. No private manuscript
or credentials are used. No live inference is needed.

Run from `studio/`:

```sh
npm test -- --maxWorkers=2
npm run build
```

The worker bound avoids resource exhaustion in constrained cloud test runners; it
does not change the test corpus. Native application smoke testing, visual layout
inspection, physical keyboard/IME and screen-reader testing remain separate from
DOM automation. The existing ChatGPT-answer issue #22 remains open and unchanged.
