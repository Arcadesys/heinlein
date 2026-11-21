# Failed review recovery validation

Local macOS validation, 2026-11-05. Based on `21ee8ca` with the existing, uncommitted startup-recovery changes preserved. No installed app, provider job, manuscript, live review record, or remote branch was changed.

## Behavior

- `Retry failed chunks` is an explicit author action for recoverable invalid output as well as transport failures. Automatic startup and transport retry policies are unchanged. Auth, account/model mismatch, quota, invalid saved context, unknown errors, and unsafe request/edit errors stay terminal.
- Native continuation checks every original target and context snapshot before requeueing anything. Changed source is refused without mutation. Completed assessments, patches, accepted/rejected decisions, and call identities are preserved. The dependent consolidation call can run after the failed individual pass succeeds.
- A failed continuation cannot fall back to submitting the entire old capture through the generic Retry button.
- `Start a new review` reads current text for the saved scope, retains target/context roles and available reviewers, invalidates the previous preview, and requires another preview/send. It does not create a provider request by itself. Missing reviewers are reported rather than replaced. A saved review opened from another library scope cannot inherit that library's capture callback or context filter.
- The production recapture hook refuses unsaved/recovery work, a changed project/document during capture, missing/generated sources, duplicate paths, and oversized source. It does not navigate or change the editor.
- Showing an idle results pane reloads its saved decisions. Identity/revision checks and the existing generation/busy guards prevent stale results, late completion after closing, and competing operations. Active work is not refreshed over.

## Checks

- Native: 100 drafting-questions tests and 29 saved-review state tests passed. `cargo check -p heinlein-studio` and strict Clippy for drafting-questions and heinlein-studio, all targets, passed.
- Full renderer run: 1,204 passed; one unrelated existing failure in `questionPanel.integration.test.ts`, expecting `Receipt: receipt`. The same failure was reproduced in an isolated checkout at the exact pre-fix source plus startup-recovery patch. It was not weakened or changed.
- Final focused renderer suite: 106 tests passed. It covers review workflow, Studio integration, and startup recovery, including manual-only invalid-output retry, current chapter capture, wrong library scope, excluded target preservation, unavailable reviewers, late capture/refresh, repeated clicks, source rejection, and stale decision refresh.
- Production TypeScript/Vite build passed. Existing large-bundle warning remains.
- 14 Playwright tests passed on macOS Chromium: background review at 100% and 200%, chapter review, startup recovery, and explicit failed-output recovery at desktop and 320px widths. The new retry flow was rerun after final guard changes. Accessibility checks passed and editor text/geometry were unchanged.
- `git diff --check` passed.

Synthetic fixtures only were used for execution tests. Historical `invalidResponse` records do not contain a precise rejection reason; no historical failed call was retried. New consolidation model mismatches use the terminal `invalidReviewOrModel` category instead of the generic recoverable output category.

## Publication validation

The isolated publication branch is based on latest main `21ee8ca`, including
merged PR #120, and includes the previously approved startup-recovery patch.
The complete local `boundaries` validation passed on macOS. The full 470-case
browser run reported 462 passing, 2 skipped, and 6 failures. Two failures exposed
a quiet-refresh highlight regression, which was fixed and covered by a new unit
test; all 48 revision/retry/recovery browser cases then passed. The remaining
four writing-layout control-height failures reproduce unchanged on the exact
pre-fix baseline. No failing assertion was removed or weakened.

The final renderer suite reports 1,204 passing and the same existing receipt-tab
failure. Production build and whitespace checks pass. Publication is a draft PR;
no merge or installation is part of this validation.
