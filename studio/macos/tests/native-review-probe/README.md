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
