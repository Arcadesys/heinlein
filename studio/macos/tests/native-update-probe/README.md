# Disposable native Updates acceptance

This compile-feature-only fixture uses the production Studio/Updates panel,
LocalCore invoke bridge, registered `update_request`, native operation/exiting
and Quit guards, bounded production status parser, standalone store/editor/flush,
and normal save-and-quit callback. It never supplies updater status from JS.

The native Runtime's test-only Script returns labelled synthetic JSON bytes
**after** the real operation/exiting gates and **before** codesign/Python. It
cannot fall through to a real updater. Scheduling changes memory only. Neither
Runtime::acquire nor real service startup/handlers/plugins are called. Synthetic
revision rejection exercises the real standalone save guard; the later valid
save is genuine, with its acknowledgment held in the test bridge (not slow disk).

An explicit flag + fresh canonical owned mode0700 UUID root + exclusive sentinel
are required before paths/stores/WebView. AppDirectoriesOverride confines all
Tauri paths; own WKWebsiteDataStore must be nonpersistent before local assets.
Navigation is queued from a worker only after the inspection callback and outer
call return. CSP and native navigation/window checks reject external activity.
The host registers only standalone list/create/open/save/release, dirty/close,
quit-finished and update IPC. There are no auth/provider/external handlers.

The scenario requires initial source labels, busy/duplicate suppression, a real
native Quit refusal during held Check, fetch-failure/explicit retry, defer without
schedule, stale response ignored after reopen, one in-memory schedule, visible
real stale-save failure preserving text, held genuine save acknowledgment and
production guarded normal Quit. Actual owned-window/editor focus is observed.
Programmatic native/DOM actions are not physical keyboard or VoiceOver proof.

Build (from `studio`; use an owned disposable target/output):

```
npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
./node_modules/.bin/tsc --noEmit -p macos/tests/native-update-probe/tsconfig.json
./node_modules/.bin/vite build --config macos/tests/native-update-probe/vite.config.ts
CARGO_TARGET_DIR=/private/tmp/heinlein-native42-build/target cargo build --offline --locked -p heinlein-studio --features update-native-acceptance,tauri/custom-protocol
python3 macos/tests/native-update-probe/driver.py --authorized-synthetic-native-test --binary /private/tmp/heinlein-native42-build/target/debug/heinlein-studio --receipt /OWN/ARTIFACT/receipt.json
```

The driver creates/signs a uniquely identified disposable app; child has a new
session and known PID. Timeout requests cooperative abort; nonzero/abort is FAIL.
A noncooperative child/root is preserved for separately authorized handling, not
signalled or treated as Quit evidence. No automatic retry or cleanup.

Default features remain empty. Ordinary build excludes the host/backend/commands
and assets; the fixture flag exits64 before normal startup. Feature build refuses
ordinary startup; it cannot be installed as normal Studio. Independent source and
binary hashes must be captured before each run; driver source provenance is null
unless trustworthy binary-bound metadata exists. Keep real-account/installed-app,
OS picker/dialog, physical keyboard, VoiceOver and user acceptance separate/open.

Memory-only checks:
```
python3 -m unittest discover -s macos/tests/native-update-probe -p test_driver.py
cargo test --offline --locked -p heinlein-studio --features update-native-acceptance,tauri/custom-protocol update
```
