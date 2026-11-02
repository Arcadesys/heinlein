# Passage Questions checkpoint

## Outcome and scope

The editable Source view has passage chips and one integrated question/revision pane. Collapse retains an explicitly sent request; Cancel request and document/project changes cancel it. Multiple passage sessions retain drafts and answers within the existing four-turn/64,000-byte session budget. Exact-source edits, including edit-and-undo, invalidate suggestions. No provider requests are made by selecting, collapsing, reopening, or typing.

Routing: requested workhorse / medium effort, in this existing chat without delegation. No model switch was enforced; model usage and provider-cost counters are unavailable.

## Implementation boundary

CodeMirror uses raw-source-aware ranges and a reserved right gutter. Adjacent anchors share one chip to prevent overlapping targets. Gutters are hidden from CodeMirror's accessibility tree; chip buttons are outside the Tab order. Questions in the toolbar and the pane's Passages picker provide the keyboard and screen-reader equivalent. At narrow widths the gutter is hidden and the pane becomes a focus-bounded dialog. Existing Appearance fonts, colours, zoom, and spacing remain authoritative.

The proposal panel accepts an optional review presenter. Question revisions call the existing native author-confirmation command with the original review bindings. When the authoritative whole-scene review is exactly the displayed passage diff, Apply goes directly to that confirmation; otherwise, or on request, the whole-scene comparison appears inside the pane first. Other proposal/revert entry points retain their existing dialogs. Dismiss uses the existing immutable rejection receipt. There are no native API or storage-schema changes.

## Evidence and remaining checks

Synthetic unit/integration and browser fixtures cover retained background requests, exact CRLF/Unicode/em-dash comparisons, cancellation, multiple passages, stale source, guarded review, and dismissal. Browser tests use the existing Playwright installation because the Browser plugin is not available. QA artifacts live outside the repository in `/tmp/heinlein-questions-*`.

The approved concept is `/Users/arcades/.codex/generated_images/01a19d63-1f53-76a3-a524-d5f7c9c5907f/exec-c655c576-c959-4583-a8db-f80b59016e2b.png`. Visual comparison checks chip placement, comparison labels, change styling, primary/secondary actions, typography inheritance, and responsive reflow. Intentional adaptations: Collapse replaces Close; no added line numbers; existing Studio document chrome and Appearance settings are retained; response mode remains explicit; adjacent anchors share a chip.

On this host Node's experimental global Web Storage overrides jsdom storage unless disabled. Use `NODE_OPTIONS=--no-experimental-webstorage npm test` for the renderer suite. Initial failures under ordinary `npm test` were environment/storage failures; the isolated setting changes no repository configuration or user data.

Final verification on 2026-11-02: **648 renderer tests across 46 files passed; all 8 browser checks passed; TypeScript/Vite production build passed; `git diff --check` passed.** The build retains its existing large-chunk advisory.

Browser identity/nonblank content, absence of framework overlays, runtime exceptions, outbound requests, visible state transitions, focus return/trapping, and automated axe checks passed. The fixtures use 1600 × 1000, 1200, 700, and 320 pixel widths, enlarged text at 200% and 400%, and a wide window with enlarged text that must become a dedicated pane. Both desktop and narrow Playwright projects pass. The final narrow preview additionally shows the comparison at 700 pixels and 200% text, with no horizontal overflow. The isolated browser server used `http://127.0.0.1:64162`; the normal repository command is `npx playwright test questions.pw.ts` when its configured port is free.

Final screenshots and verification logs: `/Users/arcades/.codex/visualizations/2026/11/02/01a19d63-1f53-76a3-a524-d5f7c9c5907f/heinlein-passage-questions/`.

| Concept comparison | Rendered result |
| --- | --- |
| Passage chip beside manuscript | Reserved right gutter; no text overlap; nearby anchors grouped |
| Original/Suggested blocks | Stacked, labeled, exact text with word-level changes |
| Change recognition | Dotted removals, solid additions, explicit legend; colour is supplemental |
| Apply/Dismiss hierarchy | Strong primary Apply, secondary Dismiss, native confirmation retained |
| Question and follow-up flow | Question, explanation, diff, actions, follow-up; secondary details collapsed |
| Typography/palette | Existing Appearance tokens retained; high-contrast/gold/monospace fixture matches the reference direction |
| Responsive layout | Docked when readable, dedicated when window width or actual rendered text size requires it |

The accepted concept and final rendered screenshots were inspected with `view_image` at the concept's 1600 × 1000 size. Above-the-fold copy retains the approved Questions, Original, Suggested, Apply…, Dismiss, and selected-passage labels. Agreed adaptations are Collapse and the existing gutter; existing document chrome and the explicit Response mode control remain. No unresolved clipping or overflow remains in the tested Questions states. Native OS confirmation interaction, packaged-app behavior, and VoiceOver speech are not established by these mocked browser checks. No real manuscript or provider transport is used by the fixture.
