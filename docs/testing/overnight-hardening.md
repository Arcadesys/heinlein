# Overnight drafting hardening

Base candidate: `7761aa1b266c4e6383fb8238bec9eda16f07909d`.
Synthetic documents only; no user archive, client configuration or external
service is exercised by these tests. Existing regression tests remain in place.

## Campaign goals

- Deterministic editor/model replay including exact text, mixed line endings,
  Unicode, undo/redo and out-of-order asynchronous host responses
- At least 1,000 seeds per Core family covering saves/recovery, manuscript
  structure and interrupted transaction recovery, with operation counts
- Minimized regression examples for every confirmed defect, followed by seed
  replay and a fresh complete campaign
- Existing proposal/store/MCP and native authority regression suites retained
- Integrated test/build/lint checks and independent review before delivery

The additional proposal-authority fuzz task could not run because the execution
platform blocked that task. It was stopped without alternate execution. Existing
approved regression suites remain usable and passed (24 store/MCP and 24 native
module tests); new proposal fuzz coverage is not claimed.

Native Tauri application interaction, OS dialogs and physical input remain
unverified in this cloud environment. Host compilation previously stopped at a
missing DBus development dependency. Seeded renderer tests run the actual editor
with a simulated host and do not replace native acceptance testing.

The GitHub Actions workflow now runs the existing MCP/store tests and standalone
native authority harness on both supported platforms, in addition to Core,
renderer, lint and native builds. These workflow edits are local and have not
been run by GitHub Actions.

Final campaign results and reproducible commands are recorded in the adjacent
core-fuzz.md and editor-fuzz.md reports when complete.

## Findings and changes

- Fixed a visible-text mismatch when an edit joined a lone CR and an LF. Raw
  serialization now preserves two intended line breaks at that boundary
- Improved exact intermediate undo/redo for mixed endings with compact newline
  history metadata. Original/saved checkpoint behavior is retained; mapped
  non-history changes have an explicitly documented normalization fallback
- Fixed late editor updates during repository selection: ordinary editing and
  saving pause during selection, unexpected late text remains visible, and a
  detached session cannot keep issuing futile persistence requests. The notice
  explains copying the text before discarding/reopening a valid folder
- Independent review caught a full-source-per-keystroke history implementation
  during development. The delivered replacement retains one compact metadata
  effect per grouped event. A separate 270,000-character/100-keystroke jsdom probe
  measured about 2.1 MB post-GC growth, versus about 27.8 MB for the rejected
  intermediate implementation. These are diagnostic cloud measurements

Core's completed primary campaign passed 182,129 generated operations across
1,024 seeds per family. No production Core defect was found. Integrated Rust
regressions passed: 82 Core/store/MCP tests plus 24 native authority-module tests;
four intentional Core ignores remain. Strict clippy and formatting passed.
Independent code/oracle review found no remaining blockers after fixes.

Renderer's primary campaigns passed 200,000 editor operations (1,000 seeds),
38,400 asynchronous Studio operations (256 seeds), and 256 reordered-recovery
scenarios. Combined generated-operation total with Core: 420,529. Supplemental
replays and ordinary tests are excluded from that number. Final renderer suite:
174 tests passed; TypeScript and Vite production build passed. Details and
per-operation counts are in editor-fuzz.md.
