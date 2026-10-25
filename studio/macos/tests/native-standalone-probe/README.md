# Disposable native standalone acceptance

This fixture is compiled only with `standalone-native-acceptance`; defaults are empty.
It cannot run ordinary Studio startup. Conversely the default binary rejects the explicit
fixture flag with exit 64 before production startup/store/runtime/WebView initialization.
Normal configuration selects `studio/dist`, never this renderer/configuration.

The fixture shares production standalone commands, BrowserState, editor, standalone
flush, Studio allowLeave/quitSafely, native AppKit adapter and run-event exit guards.
Only unrelated startup is replaced: no managed Runtime acquisition or recents discovery,
no plugins, inert empty recent-repository/font responses, optional provider/status APIs
absent. Native handler allows only list/create/open/save/release plus dirty/close/finish.
No provider/auth/updater/external-open constructor or handler is reachable through it.
Unexpected calls, external navigation/new windows and renderer failures abort evidence.

Before creating a WebView or opening a draft store, an explicit invocation validates an
owned canonical 0700 fresh UUID root and creates an exclusive 0600 sentinel. Process two
reuses and validates only this same root/UUID. `AppDirectoriesOverride::Root` is set before
Builder.build; all resolved app config/data/local/cache/log/temp paths are checked inside
that root before WebView creation. TMPDIR is bound by the driver. Incognito WKWebView
starts at about:blank; its own websiteDataStore.isPersistent must be false before any
local fixture asset navigation/store IPC. No persistent/default fallback exists. These
options are supported by pinned Tauri 2.12.4/tauri-utils 2.10.2/Wry 0.57.0. CSP denies
external connections; only own local assets and exact Tauri IPC transport are allowed.

From `studio`, in a worker-owned isolated source archive:

```sh
npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
npx vite build --config macos/tests/native-standalone-probe/vite.config.ts
CARGO_TARGET_DIR=/private/tmp/heinlein-native47-OWN/target cargo build --offline --locked -p heinlein-studio --features standalone-native-acceptance,tauri/custom-protocol
python3 macos/tests/native-standalone-probe/driver.py --authorized-synthetic-native-test --binary /private/tmp/heinlein-native47-OWN/target/debug/heinlein-studio --receipt /PRIVATE/OWN/receipt.json
```

The first process creates synthetic raw text with mixed CRLF/LF/CR and Unicode using
real native IPC, releases its lease and lets normal Studio restore it. A real editor
transaction appends text. Autosave performs real native Save; the wrapper holds only
its renderer acknowledgment while an asynchronously queued own AppKit terminate:
passes through the production Cancel/deferred bridge and unchanged renderer quit flow.
Quit must wait for the acknowledgment and dirty sync before the production guarded
requestClose(true) and one approved Some(0). This proves pending acknowledgment, not
artificially delayed disk durability. The driver never calls requestClose directly.
A second fresh process restores the same draft ID and exact raw text through native IPC,
then follows the same normal Quit route. Hash diagnostics contain synthetic text hashes
only, never tokens or user writing.

Child watchdog requests cooperative fixture exit 73 after 40s. Parent writes literal
`abort` after 65s and bounds acknowledgment. Timeout/abort is failure, never Quit proof.
A noncooperative child is left with exact PID/executable/root/stage for a separate
termination decision; no signals, broad matching or guessed cleanup. Failed roots remain.
Successful roots remain until exact-owned cleanup after the receipt is saved.

This establishes isolated WebKit/Tauri IPC/persistence/normal-Quit acceptance only.
It does not establish installed/full-startup/updater/auth/Keychain/provider behavior,
OS picker/confirmation, physical keyboard, VoiceOver or human issue acceptance.

The first attempt stalled before renderer IPC because the original fixture called navigate
inside with_webview. Pinned runtime source establishes same-thread window-id mutex
reacquisition; no runtime stack was captured. The corrected callback only inspects its
own WK object, emits plain stages and sends an owned boolean. A separate ordinary worker
waits for both gate success and the outer with_webview return, rechecks terminal state,
then queues navigation off-main. Missing/error/timeout/persistent/terminal paths cannot
navigate. Native retry is separately coordinated after source/check receipt.

ACK correction: `ack.ts` owns eager independent close and genuine native-success latches.
The close wrapper records state and dispatches the unchanged production callback
synchronously. Neither diagnostic promises nor quit completion control these latches.
The genuine result is validated against independently declared text/hash/base revision,
then released once after both gates. Failures, duplicates, cancellation and late events
invalidate acceptance. The explicit inserted-output oracle uses CRLF; untouched mixed
seed bytes remain exact. Required receipt flushing is a separate bounded 3s barrier
inside the fixture bridge, after production flush/dirty/revision guards and before
forwarding production requestClose(true). A timeout/rejection fails the fixture; it
cannot count as successful Quit. No sleep is used to manufacture ordering.

Focused deterministic checks:

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run macos/tests/native-standalone-probe/ack.test.ts
```

Both historical failed attempts are retained separately: first stalled after WK gate
with unknown exit, second advanced through real Save and native Cancel but watchdog
aborted73 before ACK release. Neither is normal-Quit/reopen acceptance. The second
attempt's LF oracle was wrong; its stalled diagnostic/latch promise was not identified
conclusively from available logs. Do not relabel either attempt after later success.
