# Create Scene with unrelated manuscript files

Local macOS validation, 2026-11-05. Isolated branch `codex/fix-create-scene-drift`, based on `a2ac379`. No installed app, live manuscript, review, account state, or remote branch was changed.

## Diagnosis and fix

The reported error was `The manuscript or files changed; refresh and preview the change again`. Native `preview_drafting_inner` rejected ordinary `CreateScene` whenever the manuscript had existing untracked Markdown files or missing indexed files. The failure was reproduced with disposable fixtures containing unrelated Markdown files. Refreshing does not resolve this condition.

The existing `CreateSceneAdjacent` operation already allows unrelated drift without reconciling it. The fix gives `CreateScene` the same narrow permission. It still creates only the requested new scene and its index entry. It does not import support files, remove missing entries, change existing writing, or weaken stale-revision, collision, generated-output, recovery, or post-preview validation.

## Validation

- Before the production change, both new primary regressions failed with `DraftingChanged` on a disposable fixture.
- Coverage checks root/group creation, untracked/missing entries, cancellation, repeated creation, exact undo, original identity/order/content preservation, and refusal of changes to membership, manifest, or destination after preview.
- Additional tests ensure an indexed missing path cannot be reused and unrelated author edits made after preview survive both creation and undo.
- Full repository-core suite passed: 146 tests, with 6 existing ignored tests. Strict Clippy for all repository-core targets passed with warnings denied.
- Existing scene-insertion and Studio/project renderer suites passed: 157 tests.
- TypeScript and production Vite build passed, with the existing large-bundle warning.
- `git diff --check` passed.
- Independent code review found no blocking safety or correctness issue.

Only synthetic fixture files were created by execution tests. The running app was not exercised or replaced. Until an updated app is installed, “Add scene above” or “Add scene below” on an existing scene uses the already-supported adjacent-creation path.
