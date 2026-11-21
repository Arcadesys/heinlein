# Authentication recovery validation

Local macOS validation, 2026-11-05. Isolated branch `codex/review-auth-recovery`, based on installed source `20bf853`. No installed app, live review, manuscript, account credentials, or remote branch was changed.

## Behavior

- Failed HTTP 401/403 review calls now show an authorization error instead of a generic invalid-response message. An authentication failure stops the current batch immediately, retaining completed assessments, suggestions, decisions, and remaining queued calls.
- Recovery has two separate explicit actions: reconnect the original ChatGPT account, then retry unfinished calls. Rechecking configuration alone does not authorize retry. Reconnecting does not dispatch model calls or restart the review.
- Native recovery validates the original account and model, source/context snapshots, scene mapping, and review revision before and after the existing same-account OAuth flow. It grants a nonpersisted, one-use proof bound to review revision and connection generation. Dispatch consumes that proof and revalidates current source, account/model, and reviewer inputs. A second authentication failure requires another reconnect.
- Renderer guards reject mismatched accounts, models, review identities, older revisions, duplicate actions, and late completion after clearing the review. Native checks remain authoritative.
- Optional diagnostics retain only bounded HTTP status, an allowlisted provider error code, and a validated provider request ID. Response bodies, messages, headers, tokens, and credentials are not persisted or rendered. Historical records without diagnostics still load; their precise upstream cause cannot be recovered retroactively.

## Checks

- Native tests: 319 passed (102 drafting-questions, 50 chatgpt-auth, 167 Studio), with 2 existing ignored tests.
- Focused renderer tests: 115 passed across review workflow, Studio review integration, and startup recovery. Includes separate reconnect/retry, repeated authentication failure, wrong account/model/review, older revision, unsafe diagnostic strings, duplicate action, and late response after clear.
- Full renderer run: 1,213 passed and one existing receipt-tab assertion failed (`questionPanel.integration.test.ts`, `Receipt: receipt`). The identical failure was reproduced on the unchanged `20bf853` baseline. No assertion was weakened.
- Strict Clippy for drafting-questions and Studio, all targets, passed with warnings denied.
- TypeScript and production Vite build passed. The existing large-bundle warning remains.
- On Node 26, tests use `NODE_OPTIONS=--no-experimental-webstorage` because its experimental global localStorage interferes with JSDOM. No dependency or application setting was changed.
- Synthetic browser fixture `tests/browser/review-auth.html` was checked in desktop Chrome and at a 320px viewport. Reconnect kept the model-call counter at zero; a separate keyboard retry incremented it exactly once. Repeated authentication failure required a new reconnect. The manuscript text and editor dimensions were identical before and after desktop recovery. The narrow recovery button wrapped without horizontal overflow. No native calls or provider access occurred. The development fixture used fallback fonts because Vite did not serve font assets through the temporary external node_modules symlink; the production build bundled the fonts successfully. Browser checks establish behavior and layout preservation, not final font fidelity.
- `git diff --check` passed.

Real OAuth and the historical live job were deliberately not executed. Installation and an author-approved reconnect/retry are separate steps before claiming live recovery.
