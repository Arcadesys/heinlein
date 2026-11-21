# Baseline regression validation

Local macOS validation on 2026-11-05, in the isolated
`/tmp/heinlein-baseline-regressions` worktree at `20bf853` with the frozen typing
chrome and authentication recovery patches applied. This follow-on changes tests
and this report only. Earlier production patches and their reports are preserved.

## Findings and fixes

- Reproduced the receipt integration failure and all four writing-layout failures
  before modifying their tests. The receipt was intentionally moved from **To
  decide** to **Done**, not lost. The updated test selects Done immediately and
  checks it again after close/reopen. It verifies the receipt ID, exact hashes,
  native provider/model/request attribution and explicit rejection provenance;
  freezes the returned receipt and its origin; checks a single rejection; and
  verifies that the manuscript is unchanged and neither save nor apply runs.
- The layout selector included intentionally hidden status buttons with zero
  height. It now checks only visible buttons, requires every tested control group
  to be nonempty, and explicitly requires the project picker, More actions,
  active tab and editing-actions control. The 48px minimum and existing prose,
  caret, keyboard, hit-test, overflow and accessibility checks remain intact.
- The desktop save/notice branch was unreachable because it expected a 1200px
  viewport, while the configured desktop viewport is 1280px. It now uses the
  desktop project identity. Running this coverage exposed an invalid comparison
  between caret positions before and after typing more text. The test now holds
  the failing save, measures the already-edited text while Saving, then releases
  the save and checks unchanged caret geometry and width in Paused state. Actual
  edits may wrap/scroll; status changes must not reflow the text.

## Final combined checks

Run from `studio`, using existing copied dependencies and no installation:

- `NODE_OPTIONS=--no-experimental-webstorage npm test`: **1,233 passed across
  98 files**. The flag avoids Node 26 experimental localStorage shadowing jsdom;
  it does not change app behavior. Final run completed in 23.89 seconds.
- `npm run build`: **passed** (TypeScript and production Vite). The existing
  large-bundle advisory remains.
- Focused receipt and revisions tests: **35 passed** across two files.
- `HEINLEIN_BROWSER_PORT=1470 TMPDIR=/tmp/heinlein-baseline-final-browser npm run
  test:browser:full -- writing-layout.pw.ts typing-chrome.pw.ts
  document-tabs.pw.ts review-recovery.pw.ts`: **40 passed**, desktop and 320px.
  This includes all 16 layout cases, all 22 typing/tab cases, and two restart
  recovery cases. Final run completed in approximately 1.1 minutes.
- Restored desktop 200% high-contrast save/notice case, `--repeat-each 5`:
  **5 passed**. Separate port and result directory were used.
- Additional synthetic authentication fixture checks at **1280px and 320px**:
  reconnect sends no review call, separate keyboard retry increments the count
  once, another auth failure requires another reconnect, completed feedback and
  manuscript bytes remain unchanged, and panel-open editor geometry stays fixed.
  The narrow reconnect control wraps without horizontal overflow. Fonts loaded
  from the worktree's copied dependencies. No native or provider calls occurred.
- `git diff --check`: **passed**.

Evidence logs and the standalone auth verification script are in
`/tmp/heinlein-baseline-test-run/`. Final browser screenshots are under
`/tmp/heinlein-baseline-final-browser/heinlein-theme-browser-results/`.

## Limits

This is focused browser acceptance, not the complete browser suite. No native
code was changed by this follow-on, so Cargo checks were not repeated; see the
separate authentication recovery report for its native validation. Synthetic
Chromium/jsdom results do not establish live OAuth, native WebKit, physical IME,
Keychain, or screen-reader behavior. No push, installation, app restart, live
manuscript change, or provider job was performed.
