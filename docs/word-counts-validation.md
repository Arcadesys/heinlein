# Word counts: renderer validation

Date: 2026-11-05. Integration base: the auth recovery, typing chrome and baseline
regression changes in PR #122 (`1ac4861ac01cc25740199d7cb54e28a0c59797b5`).

## Behavior and boundaries

A labelled **Word counts** button stays in the header when tabs and tools hide.
The command palette also offers it. Its read-only dialog shows the current scene,
whole manuscript, group totals including descendants, and individual scene totals.
Duplicate titles include paths, and the current scene has a textual marker.

The existing manifest defines the manuscript. Indexed source scenes count once;
reference sheets, untracked files, deleted scenes and generated chapter exports do
not. Legacy volume/chapter manifests are supported. An uninitialized manifest is
not reported as a zero-word manuscript. Missing and pending reads are explicit.

The existing Unicode word counter runs on Markdown source, removing complete
opening frontmatter. Punctuation, emoji and formatting alone do not count. Words
in code and link destinations do. This does not count rendered HTML, change source
text or alter daily-growth credit rules.

Open scene/group buffers replace saved counts. Per-scene successful save snapshots
update the baseline immediately, even if later recovery cleanup fails or newer
edits remain. Late reads cannot overwrite saves or a newer manuscript. Membership
refreshes retain unsaved buffers and exclude deleted scenes until restored.
Saved-source reads are sequential; typing causes no filesystem reads. The dialog
updates count text without rebuilding the editor or focused controls, and does not
announce every keystroke through a live region.

Closing returns focus without scrolling, saving or changing selection. The dialog
uses native modal semantics, visible focus, 48px targets, high-contrast theme
colors and bounded responsive layout. A hidden group selector stays out of the
accessibility tree when no manuscript is selected.

## Validation

All edit, save, delete/restore and browser tests use synthetic fixtures. No actual
manuscript, installed application, provider action or native package was used.

- Full renderer: `NODE_OPTIONS=--no-experimental-webstorage npm test`, **1,253
  tests in 101 files pass**. The flag is the existing Node 26/jsdom workaround.
- Production build: `npm run build`, TypeScript and Vite pass. The existing
  large-bundle advisory remains.
- Focused count/dialog/writing/chapter unit tests: **71 pass** in an independent
  run. They are a subset of the full renderer total, not additional tests.
- Relevant Chromium regressions: **102/102 pass** at desktop and 320px, including
  all **14 word-count cases**. Selection: `word-counts.pw.ts`, `daily-goal.pw.ts`,
  `typing-chrome.pw.ts`, `document-tabs.pw.ts`, `writing-layout.pw.ts`,
  `group-deletion.pw.ts`, `sheet-deletion.pw.ts`, `markdown-reading.pw.ts` and
  `chapter-source-reading.pw.ts`, using `npm run test:browser:full --` followed
  by those file names. This is a relevant regression selection, not the complete
  browser suite.
- The corrected strict caret case separately passes **10/10 repeated runs**
  (five per viewport). These repeat runs are not additional unique cases.
- `git diff --check` passes. The narrow patch passes `git apply --check` against
  PR #122's `1ac4861` and its Create Scene follow-up `c29db90`.
- Independent Chromium checks used a 240-paragraph scene at desktop and 320px,
  scrolled 9,724/14,498px. Four close/reopen cycles with delayed recounts preserved
  the focused selector, selected group, editor identity, text, selection, width
  and exact scroll. A queued earlier close event did not steal new focus.
- No-manuscript group/recount controls are absent from the accessibility tree.
  The permanent button remains visible and clickable during fade/collapse.
  High-contrast dialog layouts and hit targets were checked at 100/200/300% text.

## Caret fixture correction

The new header button adds a wrapped row at 320px/200%. An existing collapse test
centered the *top* of its 48px-high caret in the now smaller editor pane, putting
it where ordinary native input also scrolls. Its strict caret test initially
failed by 0.59375px. No tolerance or production scroll compensation was changed.

Independent controls on clean pre-feature source, five runs per condition:

| Condition | Caret movement | Result |
| --- | ---: | --- |
| Original header | +0.40625px | Strict assertion passes |
| Header spacer matching the feature, no word-count code | -0.59375px | Same failure |
| Matching header with collapse suppressed | -1px | Ordinary input scrolls by 1px |
| Matching header with full caret centered | +0.40625px | Strict assertion passes |

The exact browser scrolling mechanism was not identified. The fixture now centers
the full caret rectangle, verifies it is fully visible,
and keeps the original `<0.5px` assertion and real keyboard input. Four cycles
compare collapse and restore against one fixed baseline, undoing the inserted
character between cycles. Independent ten-cycle checks on both matching baseline
and feature had +0.40625px collapse movement, exactly zero restore/scroll drift,
and constant 312px editor width. `typingChrome.ts` is byte-identical to the
integration baseline. This avoids suppressing legitimate native caret scrolling
on wrap, newline, paste or composition.

## Limits

Chromium and jsdom checks do not establish native WebKit, physical macOS IME or
VoiceOver behavior. No native/Rust production behavior changed. No native package
was built or installed, and no app was restarted by this feature validation.
