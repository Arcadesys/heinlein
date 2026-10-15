# In-app drafting questions

Heinlein's drafting conversation is an optional aid alongside the editor.
Its model transport is distinct from the external MCP revision workflow.

## Author control

Opening the panel, typing, saving, navigating, and recovering a draft do not send
anything to a provider. Each request requires an explicit Send action. The panel
shows the question, captured context and conversation history being shared.
Context starts empty when opened from the toolbar; the author can choose a bounded
selection or scene snapshot. The contextual Ask Heinlein action explicitly captures
the highlighted passage and focuses the question field without sending.
Later typing never silently changes an already captured context snapshot.

Advice is displayed as text. An explicit Suggest revision request produces a
pending, source-bound proposal. No provider response executes tools or changes a
manuscript. Existing review/apply safeguards remain the route for proposed edits.
Conversation state is session-local. Closing or clearing it invalidates pending
results, and cancellation does not imply that already processed provider work was
free or withdrawn.

## Native boundary

Only the bundled main window can call the fixed native question commands. The
renderer receives configuration status, model labels and bounded answers; it
never receives credentials. The native transport targets OpenAI's public Responses
API, disables redirects and automatic retries, bounds input/output and runtime,
and requests `store: false`. This storage flag does not promise zero retention
under every account's data policy.

The transport shares no files, paths, hidden repository context or tools. It uses
only the author-previewed request payload. Typing and Core persistence continue
independently of the pending model request.

## Validation boundary

Development and automated tests use synthetic data and mocked transport. They do
not create credentials, sign in, transmit real manuscript text or incur model
charges. Live authentication, account-specific model availability and desktop
interaction require a separate user-driven smoke test.

Official references:
- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://developers.openai.com/api/reference/overview
- https://developers.openai.com/api/docs/guides/your-data
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

## ChatGPT account connection

This slice uses the official open-source Sign in with ChatGPT flow. It never
silently falls back to an API key or another billing route. Eligibility, workspace
policy, granted plan-use permission and account-specific model availability are
confirmed by OpenAI during the user's local sign-in. A paid subscription alone
is not treated as proof that every integration or model is enabled.

The author starts **Continue with ChatGPT**, reviews the requested access in the
system browser, then selects a model available to that account. The native host
owns the loopback callback, PKCE/state/nonce checks, ID-token verification and
protected token storage. Model requests use the selected account's grant and
show quota/eligibility failures explicitly. Existing MCP registration supplies
none of this authentication.

The user can manage plan usage at https://chatgpt.com/settings/usage . Signing out
ends local use of the account; remote revocation status must be reported honestly.

Official account-flow references:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery

The credential-store implementation currently supports macOS and Linux. Other
platforms reject connection rather than storing tokens without these protections.
The saved registration is retained after sign-out so reauthorization can reuse
its issued client identity. Conversation history remains in memory only.

## Suggested revisions

The author explicitly chooses Ask or Suggest revision. Revision requests require a
clean saved source and an exact selected passage. The native host retains the source
binding before inference; the complete local source is not implicitly sent to the
provider. Only the previewed question, selection and opted-in context are shared.

A structured revision response separates explanation from replacement text. A
refusal, incomplete result, malformed response, cancellation, or changed source
cannot become an applicable proposal. The native host constructs the whole-scene
candidate from the retained prefix, replacement and suffix and stores it through
the existing proposal store. It never applies it automatically.

Review shows the exact before/after source and recorded OpenAI/model/request
origin. Stored metadata does not authenticate an author or grant write authority.
The existing separate native author confirmation binds application to the displayed
patch and current source; dirty buffers/recovery conflicts block application.
Reject creates an immutable local decision receipt without changing the manuscript.
Cancellation accepted before local proposal commit prevents creation. Once that
short commit phase starts, cancellation cannot retract its pending record; the UI
reports that possibility and the author can reject it. Filesystem work does not
hold the question-service mutex or block status/typing.
Accepted proposals retain operation receipts and the existing guarded revert path.

This is a pending-revision and local-receipt workflow. The broader authenticated
revision ledger in ADR-001 remains future work. Current guarded revert is available
for confirmed applies in the same Studio session and refuses intervening edits.
