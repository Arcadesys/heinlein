# Review startup recovery validation

2026-11-05, Apple Silicon macOS. Tested locally against source based on
`85416d2` (the concurrently completed Revisions UI work was preserved).

## Behavior

Opening a project, including automatic restoration of the last project, attempts
its unfinished saved review jobs. The existing review ID, captured sources,
reviewer definitions, account/model, completed chunks, assessments and decisions
are retained. Healthy remaining batches continue until finished. Native checks
reject changed source/context or scene mapping. Cancelled jobs and permanent
failures do not start automatically; explicit cancellation remains durable even
before admission or while credentials are loading. Recovery stops after a failed
batch or one making no progress, and does not retry a job repeatedly in the same
renderer session.

The editor remains usable. Startup recovery does not open Editors, move focus or
change manuscript geometry. Completion reports results; when any job needs
attention, the notification opens the first such job. Native continuation and
read-only saved-review viewing cannot replace another active batch's cache.

## Passed checks

- 121 focused renderer tests across reviewWorkflow, reviewRecovery.integration,
  reviewPanel and review.integration. Includes duplicate startup triggers,
  multiple jobs, hidden-pane and connection-loading races, stale replies,
  cancellation, unchanged captures, account/model mismatch and no-progress stops.
- Production TypeScript checking and Vite build. Existing large-chunk warning
  remains non-failing.
- 12 Chromium browser tests on this Mac: startup/reload recovery, background
  review and chapter review at desktop and narrow widths, including existing
  100%/200% zoom cases. Recovery screenshots were visually inspected. Synthetic
  restart test reloads during an unfinished call, preserves the completed call's
  request ID, completes remaining calls, then reloads again without dispatching.
  Source bytes, editor focus and geometry remain unchanged; activity accessibility
  checks pass.
- 24 review-state harness tests and strict harness clippy.
- 11 native questions/progress tests, 95 drafting-questions tests, native cargo check and
  strict native clippy.
- Git diff whitespace checks.

Node 26 exposes an experimental global storage API that conflicts with the test
DOM. Renderer checks used `NODE_OPTIONS=--no-experimental-webstorage` so jsdom owns
its storage, matching the suite's intended browser environment. Chromium required
the normal local test permission outside the macOS command sandbox.

## Aggregate suite and remaining boundary

The full renderer suite reports **1,166 passed / 1 failed** across 97 files.
The failure is `questionPanel.integration.test.ts:235`, which expects the rejected
receipt in the default Revisions tab after the new UI moved it under Done. The
same failure was reproduced in a separate clean archive of `85416d2`, without
this recovery patch (21 passed / 1 failed in that test file). It is a baseline
Revisions assertion issue, not a startup-recovery regression, and was not changed
as part of this work.

All browser/provider data was invented. No live provider requests, private
manuscript edits, installed-app restart/replacement, Git commits, pushes, releases
or deployment were performed for this patch. The installed 1.8.0 app has not been
updated. A true installed-app quit/relaunch against a live provider remains
unverified and should wait until the author is ready to save and quit.

## Latest main integration

Fetched and fast-forwarded the existing checkout to `d8d9037`, the main merge
of Claude's design pass in PR #119. The before/after Git tree IDs are identical
(`a42e8a72eac1da30faa6ff2ece89c8e6567810e0`), so this introduced no file changes
or conflicts. The uncommitted tracked patch was verified byte-for-byte unchanged,
and working-tree status was preserved. No unrelated files were overwritten.

After integration, reran all 121 focused renderer tests, production build,
native cargo check, all 24 harness tests, all 95 drafting-questions tests, and
11 native questions/progress tests: all passed. The aggregate receipt-tab
assertion caveat above still applies to this identical main tree. No app
installation, restart or push occurred.
