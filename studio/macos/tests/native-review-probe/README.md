# Disposable native review acceptance

This macOS-only, explicit compile feature runs the **production Review panel and
native review/proposal commands** against two synthetic files. It starts no
provider, account service, GitHub service, updater acquisition, or installed app.

The native confirmation test seam accepts only the startup-declared synthetic
choice and exact retained review/finding/proposal/patch identities. The normal
build retains its original OS confirmation dialog. This fixture **does not prove
OS-dialog usability, physical keyboard access, VoiceOver, or live-provider use**.

From an owned temporary source checkout at
`/private/tmp/heinlein-revision-native-acceptance`:

```sh
cd studio
npm ci
npx vite build --config macos/tests/native-review-probe/vite.config.ts
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  --features revision-native-acceptance revision_native_acceptance::tests
cargo build --locked --manifest-path src-tauri/Cargo.toml \
  --features revision-native-acceptance
python3 macos/tests/native-review-probe/driver.py \
  --binary target/debug/heinlein-studio --receipt /private/tmp/native44-receipt.json
```

The driver signs a clearly disposable bundle, allocates a fresh private UUID root,
sets TMPDIR before startup, and runs `first`, waits for its normal exit, then runs
`reopen` against that same root. Each process uses a fresh repository session and
nonpersistent WebKit store, verified before navigation. All Tauri path resolvers
must remain beneath the root before any review store or webview is opened.
Only review IPC commands are registered. Diagnostics/finish events cannot approve
an edit; the native finish verifier independently reads source bytes, persisted
review decisions and proposal receipts.

The first process rejects a finding, approves a Unicode-length-changing edit and
a later independent edit in repeated text, refuses an unchosen overlap, then
chooses and approves one alternative. Closing/reopening the panel keeps rejection.
The second process restores decisions and accepted lineage, then freshly prepares
and approves an independent edit in a second file. It does not replay an Approve.
Exact UTF-8/CRLF bytes, four accepted findings, one rejection, one superseded
alternative, and five receipts are checked natively.

Failures/timeouts are failures, never acceptance. Roots and failure evidence stay
available for inspection. The parent sends no signals; an uncertain live child
requires separately authorized exact-child intervention. No automatic cleanup
searches or real-app interactions occur. Fixture builds refuse ordinary startup;
normal builds refuse the fixture flag before production startup.

## Actual production OS confirmation mode

On macOS the production review/revert builder is attached to the already
validated writing window. Both public handles are borrowed once from that exact
owner; missing/closing parents fail without an unparented system-alert fallback.
The existing selection/close-exclusion guard remains held through completion.
The helper refuses main-thread use before any blocking window query or wait.
Title, retained-plan body, OK/Cancel labels and postdialog apply guards are
unchanged. Other platforms retain their existing attachment behavior.

The explicit `--actual-dialog` driver mode uses this **same production builder**,
not the synthetic confirmation return. It arms an immutable native expectation,
then observes only the captured parent's attached sheet on the main runloop in
explicit default and modal-panel modes. Reciprocal sheet ownership, exact unique
contents and enabled OK/Cancel controls must match before a one-shot public
`performClick`. No global window search, Accessibility, input injection,
stopModal/endSheet, delegate replacement or injected result is used.

Stage source-bound signed bundles and fresh roots before requesting native-run
approval (from an owned temporary checkout at
`/private/tmp/heinlein-review-os-confirmation`):

```sh
python3 macos/tests/native-review-probe/driver.py \
  --binary target/debug/heinlein-studio --actual-dialog --stage-only \
  --receipt /private/tmp/native44-os-staged.json
# Only after the source/binary/isolation review permits the owned native run:
python3 macos/tests/native-review-probe/driver.py \
  --binary target/debug/heinlein-studio --actual-dialog \
  --staged /private/tmp/native44-os-staged.json \
  --receipt /private/tmp/native44-os-result.json
```

Actual mode first cancels a real sheet and checks unchanged source bytes and
receipt IDs (normal prepared-proposal metadata already exists), then freshly
confirms the original patches. A second process restores the durable decisions.
A separate fresh-root case changes synthetic source while its verified sheet is
open, performs the real OK action, and requires the normal postdialog source
validation to refuse applying; the external bytes remain and no receipt appears.

The actual boolean comes from the plugin's ordinary result channel. Timeouts or
ambiguous sheet contents fail; cleanup may cancel only a positively identified
own sheet and never counts as success. A successful run proves programmatic OS
dialog plumbing, **not physical keyboard/focus/VoiceOver usability**. No real
writing, credentials or provider are used. No HOME override is permitted; TMPDIR
alone is the freshly allocated private fixture root. Ordinary OS UI bookkeeping
is not claimed to be entirely confined to that root.
