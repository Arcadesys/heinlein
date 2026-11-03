# Passage Questions verification

Passage chips open the question, answer, and marked Original/Suggested comparison within the Source editing workspace. A stable Questions toolbar control provides the keyboard and screen-reader entry point. Collapse retains completed work and explicitly sent requests; Cancel request remains separate. Adjacent anchors share one large chip so targets cannot overlap. Stale suggestions remain readable through the Passages picker but cannot apply.

## Boundaries

The pane uses the existing proposal authority and native author confirmation. Its optional review presenter displays the exact whole-scene replacement without another renderer dialog. Other proposal and revert entry points retain their current presentation. Exact source, CRLF, Unicode, em dashes, receipts, and source-generation guards are preserved.

Passage sessions are transient and bounded to four turns/64,000 bytes of retained question/context/answer text. Existing project chat persistence keeps its original project/account/model key and format; saved history does not reconstruct author approval or range capabilities. The current scene context limits, Reading view, document tabs, typewriter input, and existing recovery behavior remain intact. No native API or storage-schema changes are introduced.

Questions is a modal overlay at every integrated width. The navigation drawer suspends interaction without changing its saved preference or taking away its desktop layout space. At narrow widths it remains closed on return to writing, avoiding a modal reopening over the editor. Collapsing reveals the retained source selection using only its owning scroll pane; it does not pan the overflow-hidden workspace. At narrow widths the entire passage gutter yields its space to the manuscript. Wide layout overlays the manuscript without resizing the preview or navigator. The background is inert while Questions is open, and focus stays inside the dialog. Dedicated layout is based on both window width and actual rendered text size, rather than media-query rem units alone.

## Reproduction

From `studio/`:

```sh
npm ci
npm test
npx playwright test questions.pw.ts
npm run build
```

On hosts whose experimental Node Web Storage globals override jsdom storage, run the renderer suite with `NODE_OPTIONS=--no-experimental-webstorage npm test`. The normal browser configuration requires its configured port to be free; an isolated test server can use another local port.

## Evidence

The isolated PR checkout incorporates current main, including the merged Library and writing-layout changes. It preserves unrelated edits in the author’s original checkout. Renderer tests and browser fixtures use synthetic text and mocked transport, not real manuscripts, credentials, sign-in, or provider calls.

Initial local validation: 945 renderer tests across 71 files, 16 focused browser checks, the TypeScript/Vite production build, and diff whitespace checks passed. The browser checks include both the new passage flow and existing project-chat, Markdown-answer, and chapter-to-source journeys. Full current-main browser verification and hosted CI are reported separately on the pull request. Browser coverage includes 1600 × 1000, 1200, 700, and 320 pixel widths; 200% and 400% text; wide-window text zoom forcing dedicated layout; keyboard focus trapping/return; axe checks; no outbound requests; no framework overlay or runtime exceptions; and geometry checks that opening/collapsing Questions and highlighting/clearing a passage preserve the manuscript width, line positions and scroll location.

Visual comparison covers chip placement, stacked comparison labels, dotted removals/solid additions, primary Apply versus secondary Dismiss, inherited typography/contrast, and responsive reflow. The approved adaptations are Collapse, the existing gutter without added line numbers, the current Studio chrome, explicit response mode, and grouped adjacent anchors. Browser inspection uses Playwright because the Browser plugin is unavailable.

The existing current-main fixtures also needed precise control selectors: scoped Return to writing/Close/Undo/Redo, accessible tab labels, and the intended document badge. These corrections change tests, not manuscript behavior. Disposable-file tests use the platform temporary directory. The document-end shortcut follows the host platform while preserving exact unsaved-byte assertions. At narrow widths the command toolbar scrolls independently, and the redundant split summary yields while an open source/reference pane has focus. Existing enlarged-text checks require readable prose and reachable controls in default and high-contrast themes.

Native OS confirmation usability, installed-app behavior, native WebKit/VoiceOver speech, and live-provider acceptance remain unverified. Browser mocks establish renderer behavior and the native-command binding, not physical native confirmation.

## Unified Heinlein pane

Use the Heinlein toolbar button and Passage / Whole scene views. Ask and Suggest
rewrite are separate explicit sends. Account settings and manual Copy as prompt
remain available inside the pane. Verify tab switching preserves an in-flight
whole-scene review without resending, returns focus to the writer on collapse,
and leaves source bytes, width, line positions and scroll unchanged. Streaming
previews are untrusted text, do not enter saved history until the answer completes,
and must not move keyboard focus. Check at 320px and at 200% text size.
