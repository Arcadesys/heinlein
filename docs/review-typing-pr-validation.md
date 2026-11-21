# Combined review recovery and typing controls validation

Validated locally on macOS on 2026-11-05 in an isolated publication worktree,
based on `a2ac379` (the same source tree as `20bf853`). This combines the
previous authentication recovery, typing controls, and baseline regression fixes.

## Final checks

All Studio validation stages passed across the following runs:

- Renderer: **1,233 tests passed across 98 files**, plus TypeScript and the
  production Vite build. The validation runner applies the documented Node 26
  `--no-experimental-webstorage` compatibility flag.
- `python3 tools/validate.py browser`: **486 passed, 2 skipped**, covering the
  entire browser suite in desktop and 320px configurations. The two existing
  narrow-project skips are desktop-specific library layout and docked-chat cases.
- The eight affected Reading/Questions/revision navigation cases passed focused
  verification before the full run. Daily-goal cases passed **48 repeated checks**.
- `python3 tools/validate.py boundaries`: passed after formatting cleanup,
  including Python updater/provenance tests, synthetic Keychain retry tests,
  all six core crates, 167 Studio native tests, and the 44-test proposal-authority
  and 30-test review-state harnesses.
- `python3 tools/validate.py native`: passed, including workspace formatting,
  strict workspace/harness Clippy, all three isolated fixture builds, four native
  feature-isolation tests, strict feature Clippy, and the production native build
  (`npm run tauri build -- --no-bundle`).
- `git diff --check`: passed. Independent source review found no actionable
  issue in the combined changes or the test adaptations.

The native suites retain their existing ignored subprocess helpers and opt-in
private archive, fsync benchmark, and real-converter cases. They do not establish
real OAuth, Keychain, provider, or private-manuscript acceptance.

## Acceptance fixes found before publication

The first full browser run exposed four test flows that typed and immediately
clicked tools now intentionally hidden. Each now uses the real **Show tabs and
tools** button first. All manuscript, selection, stale-anchor and apply-guard
assertions remain unchanged.

The next run exposed a timing-sensitive daily-goal assertion comparing expanded
pane height with a pane currently collapsing after typing. The test now checks
pane position/width and manuscript width during typing, then restores tools and
polls for the original full pane geometry. It still verifies the same editor,
document, selection, visible counter and absence of horizontal overflow.

The native formatting gate found 13 existing hunks in five unchanged files. The
same failure was reproduced on clean `20bf853`. This PR includes only the
formatter's wrapping, indentation, optional trailing commas and equivalent
closure block formatting in those files. Independent review confirmed that
conditions, calls, error messages and test assertions did not change. Boundary
checks and the complete native validation were rerun afterward.

## Scope and limits

The prior component reports are historical evidence; this report records the
later complete pre-push acceptance. Browser evidence uses synthetic Chromium
fixtures, not native WebKit, physical IME or screen-reader testing. No live OAuth,
provider call, manuscript change, app restart or installation was performed.
The existing primary checkout and its unrelated changes were preserved.
