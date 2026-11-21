# Standalone draft review validation

2026-11-05, macOS, base `a43bf0894530ea4e44568741d9ae7ac2d75a32bf`.

## Behavior

- Cmd/Ctrl+N creates an independent standalone draft even with a project open.
  Existing writing must pass its save/recovery guards before switching.
  Project scene creation remains an explicit Library/palette action.
- Standalone drafts expose in-app Heinlein questions, passage revisions, review
  agents, saved review history, and guarded revision apply/revert.
- A native, single-document adapter reads and writes the existing draft store.
  Its lease is revocable; drafts have separate stable history identities and
  ephemeral writer sessions. No project or second manuscript copy is created.
- Existing native confirmation, source-hash, recovery and commit-boundary checks
  remain enforced. External MCP, project filesystem and sharing commands do not
  gain access to private standalone storage.
- Editors use the existing gutter when space permits. Save completion refreshes
  review availability. Source and Reading layouts do not reflow when chats open.

## Passed checks

- Complete renderer suite: **1,268 tests in 102 files**; TypeScript and production
  Vite build passed. Existing non-failing bundle-size warning remains.
- Scoped browser suite: **34 tests** across desktop and narrow projects covering
  `new-scene-shortcut.pw.ts`, `standalone.pw.ts`, and
  `standalone-markdown.pw.ts`. Includes keyboard guards, exact-byte preservation,
  failed-save recovery, independent drafts, Reading, accessibility checks, and
  the wide chat no-reflow regression.
- Standalone repository-core tests: **14 passed, 1 intentional subprocess helper
  ignored** (the helper is exercised by its parent test).
- Native host tests: **171 passed, 2 intentional ignores** (real converters and
  a subprocess helper). Includes standalone proposal apply/revert/lease release
  and saved review restoration across writer sessions.
- Exact-source proposal-authority harness: **45 passed**.
- Exact-source review-state harness: **30 passed**.
- Workspace rustfmt and strict workspace/all-target Clippy passed. Both isolated
  harnesses passed strict Clippy. Native standalone fixture builds, **4 isolation
  tests**, and strict feature-enabled Clippy passed.
- `npm run tauri build -- --no-bundle` passed and produced the local optimized
  `studio/target/release/heinlein-studio` executable.
- Independent code review found two UI integration issues; both were corrected
  and regression-tested. Re-review found no remaining P1/P2 findings.

## Limits and interrupted checks

The full 508-case browser suite and aggregate security-boundary run were
interrupted by an execution-session interruption. The browser log recorded 125
passing cases before stopping. Neither interrupted aggregate is claimed complete;
focused checks above were completed afterward. A prior authentication-permission
fixture failed inside the shell sandbox and passed unchanged outside it. Browser
Chromium launch also required running outside the shell sandbox.

No real provider call, real-manuscript edit, installed-app GUI smoke, GitHub push,
release, or app installation was performed. Validation uses synthetic fixtures.
Re-run the complete Studio aggregate before an authorized push or release.
