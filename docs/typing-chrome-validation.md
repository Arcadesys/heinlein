# Typing chrome: local renderer validation

Date: 2026-11-05. Base: `20bf853d7c8a3d212ab3a005576decac0c9a4943`.

## Behavior

Project document tabs, Markdown editor tools and saved split actions slide away
on real source-editor typing/deletion/Enter. Their existing DOM nodes and action
handlers remain intact. A discoverable “Tabs and tools” button restores them;
Escape restores without moving focus, after editor handlers have had priority.
Tab restores them before normal traversal. The collapsed controls are inert and
outside the accessibility tree. Pointer restoration retains the writer's focus
and selection; keyboard activation of the restore button enters the controls.

IME motion waits for a committed composition. Cancellation, paste/drop, history,
programmatic changes, chat/settings input and read-only views do not trigger it.
Document remounts, Source/Reading switches, external focus and disposal restore
controls and clear transient state. No preference or manuscript format changes.

The writer's inline size and line wrapping do not change. Scrolled passages stay
anchored where the resized pane can display them; a caret close to a stacked
reference pane stays inside the writer's new boundary. The restore row grows
with enlarged text instead of covering prose, including 320px at 300% zoom.
Reduced-motion users receive no slide animation. Project navigation and the
save/error notice row stay outside the collapse.

## Checks

All tests use invented fixture text. No live manuscript or installed application
was changed, restarted, or used for a write. No push or native install occurred.

- Production build: `cd studio && npm run build`, TypeScript and Vite pass.
  Vite retains its existing bundle-size advisory.
- Full renderer: `NODE_OPTIONS=--no-experimental-webstorage npm test`.
  1223 pass; the one baseline receipt-panel assertion fails (97 test files
  pass, one test file fails). The flag is the repository's documented Node 26
  workaround for jsdom's localStorage, not an application change.
- Focused unit: `src/typingChrome.test.ts`, all 19 cases pass.
- Focused Chromium: `typing-chrome.pw.ts` and `document-tabs.pw.ts`, desktop and
  320px, including accessibility scanning, repeated restore, keyboard/menu/view
  interactions, IME commit/cancel, reduced motion, text zoom, saved split actions,
  chat input, remounts, source/selection preservation and scrolled caret geometry.
  All 22 cases pass (18 new chrome cases and four existing tab cases).
- Related Chromium regressions: `editor-shift.pw.ts`, `writing-layout.pw.ts`,
  `chapter-source-reading.pw.ts`, `file-split.pw.ts`, desktop and 320px, with
  `--workers=2`: 42 pass; only the four independently reproduced baseline
  hidden-button height assertions fail. No additional regression failures.
- `git diff --check` passes. The complete patch applies cleanly with
  `git apply --check` against clean `20bf853`.

An earlier broad 482-case browser attempt was interrupted while implementation
was still changing (82 passed, one editor-shift failure during development,
one interrupted, 398 not run). That mixed-development run is **not** acceptance
evidence. The final focused and relevant regression runs use unchanged final
source. A complete final full-browser run has not been performed.

## Existing baseline failures

Both were separately reproduced on clean `20bf853` in an isolated worktree:

- `questionPanel.integration.test.ts`: “shows native-origin proposal rejection
  and immutable decision receipts without changing the manuscript” expects
  `Receipt: receipt` in the selected panel. This is the known receipt-panel
  assertion, unrelated to chrome presentation.
- Four `writing-layout.pw.ts` “writing gets remaining space” cases (desktop and
  narrow; default and 200% contrast) assert all status-pill buttons are at least
  48px high, including an existing hidden button whose rectangle is zero.

At 320px, baseline and patch both have a command-bar height of 88.796875px and
scrollHeight 160px. The partially visible lower toolbar row is its existing
scrollable design. Focusing “Editing actions” scrolls it fully into view with an
actual successful pointer hit test in both versions.

## Boundaries

Chromium's IME events test renderer composition behavior; this does not establish
physical macOS IME, native WebKit, screen-reader or native-picker behavior. No
native/Rust behavior was changed, and no native package or cargo suite was run.
