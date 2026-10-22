# Managed macOS source updates

This tracked launcher/updater replaces the former machine-local installer code.
It builds only `https://github.com/Arcadesys/heinlein.git`, branch `main`, in a
private archived checkout. It never builds a developer checkout or changes its
branches. Python 3, Node/npm, Rust and Apple command-line build tools are external
prerequisites. The current ad-hoc signing policy is not Developer ID signing or
notarization. macOS may request permission to read a previously saved Keychain
item after a rebuild; credential retention does not promise prompt-free access.

In a managed protocol-v1 install, **Updates…** shows the installed source commit
and local generation. **Check for updates** contacts only the source repository;
**Update on next launch** records the checked commit. The running payload is never
replaced. **Save and quit when ready** uses the normal save/recovery and native
operation guards. Closing the panel defers the update. Each normal launch checks
main, builds a forward commit if available, and falls back to the valid previous
app on fetch/build/sign failure. A scheduled check pins its exact reviewed source.
The marketing version may stay the same while commit/generation changes.

## Transaction and lifetime contract

The only live target is `~/Applications/Heinlein Studio.app`; RC1 and other apps
are outside this updater. Private source/build/status/journal files live under
`~/Library/Application Support/Heinlein Studio/updater`. Full app-only stages and
backups live on the same filesystem under `~/Applications/.heinlein-updates`.
The updater never copies profiles, GitHub credentials or manuscripts into them.
App identity, GitHub client ID, service/account names, record-v1 schema and private
GitHub workspace/auth storage paths remain unchanged. Confirmed and unconfirmed
accounts resume separately. Generic store errors do not delete or replace records
or start OAuth. A failed renewal write stays in memory for **Retry saved GitHub
connection**; normal quit is blocked until that write succeeds. A crash during
such an OS-store failure still cannot guarantee recovery of a rotated token.

The existing `update.lock` inode serializes updater transactions. New launchers
also acquire `lifetime.lock` before installation/startup, transfer the same open
file description to the native process, and close their own copy without an
explicit unlock. Native code validates the inherited inode and sets close-on-exec
so unrelated child tools cannot retain the lease. A second launch activates the
existing owner. Direct native execution also acquires the lifetime lease before
constructing a writing window. PID/process scans are not the exclusion mechanism.

Every complete candidate is architecture/identity/signature/manifest validated.
Nested native code has explicit identifier `me.thearcades.heinlein.studio.native`;
the outer launcher/app uses `me.thearcades.heinlein.studio`. The signed manifest
hashes files other than itself, the outer CodeSignature and the main executable
(to avoid a self-referential signature). The outer signature seals those files;
the external journal hashes **all** bundle files, including signatures/manifest.
A fsynced journal records candidate/previous hashes, source/tree/generation and a
random readiness nonce before a native `RENAME_SWAP`. Crash recovery accepts only
the known previous bundle or verified candidate with a matching readiness receipt.
Readiness means native setup/recents initialization before writing, not VoiceOver
or renderer acceptance. A live or uncertain child is never killed or replaced.
Known child exit permits rollback; unknown/failed rollback stops safely. Backups
are retained. File fsync/journal tests are not physical power-loss certification.

## Legacy bootstrap is a separate maintenance operation

`install.py install` and automatic launch installation **refuse legacy protocol**
with `legacy-bootstrap-required`. There is no bypass flag. For later supervised
preparation, `python3 -I -S studio/macos/install.py stage` fetches/builds a complete
candidate and full external app-only rollback, validates both, and writes a
public receipt. It performs no live swap and never imports historic dirty source.
Do not run this against an installed app as part of ordinary tests.

A one-time legacy replacement needs a separately authorized maintenance window:
fully stage/verify candidate, rollback and reviewed source receipt first; then
have the author save/quit and agree not to launch. Establish exit of native,
legacy launcher, updater and related in-flight builds. Hold the existing owned
`update.lock` inode continuously; recheck baseline and activity under that lock
immediately before a journaled full-bundle exchange. First start requires an
explicit lock handoff into the new protocol and expected-process/source ready
receipt, not just `open`. On uncertainty, do not forcequit or roll back over a
possibly running app. Keep rollback until acceptance; leave profiles untouched.

These checks reduce risk but cannot exclude already queued/preloaded launches or
direct legacy-native execution. They are **not race-free or unattended safety**.
Root/user must explicitly accept that residual supervised-window risk. Guaranteed
exclusion needs a separately designed offline/logged-out-user procedure; neither
chmod, renaming executables, resigning live code, LaunchServices bookkeeping nor
process scans create an atomic fence. This source does not automate that bootstrap.

## Checks and genuine synthetic credential proof

Normal CI runs `python3 -m unittest discover -s tests -p test_studio_updater.py`,
auth/native/renderer tests and browser accessibility checks. macOS file tests use
only temporary code bundles (including actual signing and atomic exchange), never
Keychain. Linux skips the two native macOS file tests. CI runs the probe’s memory-only retry unit tests below; it never executes its
Keychain main. Mock/path tests do not establish real OS-store retention.

Only after root GO, worker3 may build different A/B probes in separate target dirs:

```sh
HEINLEIN_PROBE_BUILD=A cargo build --locked --release --manifest-path studio/macos/tests/keychain-probe/Cargo.toml --target-dir /tmp/heinlein-probe-a
HEINLEIN_PROBE_BUILD=B cargo build --locked --release --manifest-path studio/macos/tests/keychain-probe/Cargo.toml --target-dir /tmp/heinlein-probe-b
python3 -I -S studio/macos/tests/probe_update.py --authorized-synthetic-keychain-test --probe-a /tmp/heinlein-probe-a/release/heinlein-synthetic-keychain-probe --probe-b /tmp/heinlein-probe-b/release/heinlein-synthetic-keychain-probe --cleanup-after-success
```

The harness generates a unique synthetic service and temporary profile; it never
uses the real GitHub service/account. Random test material stays in memory and
anonymous stdin pipes. A writes confirmed/unconfirmed records; production bundle
transaction code replaces A with B; B compares in-process and returns booleans.
Public binary hashes/designated requirements are included, never token material
or token digests. The operator handles OS prompts; cancellation retains items and
permits retry without OAuth. Only the two exact synthetic items can be cleaned up.
An interrupted run may leave those items; use its exact synthetic-service receipt
for separately authorized cleanup. This proof does not test GitHub HTTPS/device
flow, user account access, installed native UI or live author data. No genuine
Keychain proof or installed update is claimed until this procedure is authorized
and actually executed. VoiceOver and physical power-loss acceptance stay separate.


After a successful proof or explicitly reported controlled abort, authorized
worker3 can remove exactly a retained run’s two synthetic items without its seed:

```sh
python3 -I -S studio/macos/tests/probe_update.py --authorized-synthetic-keychain-test --probe-a /ABSOLUTE/RETAINED-FIXTURE/home/Applications/Heinlein\ Studio.app/Contents/MacOS/heinlein-native --cleanup-service me.thearcades.heinlein.synthetic-update-EXACT-UUID --cleanup-profile /ABSOLUTE/RETAINED-FIXTURE/profile
```

Use that run’s actual canonical private fixture path and exact UUID (including
old aborted run `3529adfd-a979-4307-8234-0415db612b5b` only when authorized). The
cleanup command rejects real service names and non-fixture profiles, invokes only
`cleanup` with no seed/stdin, reports typed access failures, and never enumerates
or reads Keychain contents. OS approval may still be required. A failure does not
claim either item was absent/deleted; retain the exact receipt for follow-up.


## Native Quit and disposable builds

Native AppKit Quit (menu/CmdQ/Dock/terminate) is cancelled immediately by a
missing-selector-only `applicationShouldTerminate:` extension on the verified
pinned Tao delegate. It preserves the delegate and existing lifecycle methods;
any changed class, inherited selector, dependency pin or registration failure
stops startup before writing. The callback only coalesces and queues a main-loop
request, returning `NSTerminateCancel`; deferred work enters the existing author
save flow. Window close uses that same flow. Cancellation resets coalescing so a
later Quit can retry. No synchronous application exit occurs inside the delegate. A renderer-approved exit grants one-shot permission only after
native selection/GitHub/save/update guards pass; the application event loop
consumes that permission and rechecks the guards before allowing exit. New
activity invalidates the grant even after a save has completed. Final guards
seal new or queued mutations, GitHub operations and update work before releasing
their locks. The renderer remains inert until exit or a native refusal message. A newly
pending renewal or save refuses exit and consumes the old grant, requiring fresh
author permission after retry. No restart or forcequit bypass is introduced.

Disposable `build-<UUID>` trees now have ownership leases and child-group state.
Completion/failure/partial checkout cleans them; the next launch reaps quiescent
interrupted work. Child commands inherit the lease and run in their own recorded
process group; a still-live group or lease is preserved. A crash in the spawn /
PID-record gap stays uncertain rather than being guessed safe. At two retained
unknown/in-use trees, further builds stop instead of growing disk use; existing
valid app launch remains available. Unknown historical trees need supervised
maintenance. Separate `.heinlein-updates` app backups are never build GC targets.
Only timeout of an updater-owned build group can terminate those build tools;
this never targets the app/native writer process group.

The explicit native fixture is a workspace package, not a Studio launch mode:

```sh
cd studio
cargo build --locked --release -p heinlein-native-quit-probe
# Worker3 only after isolation inspection: create a fresh canonical private
# /private/tmp/heinlein-native-quit-<UUID> directory (mode700), then:
target/release/heinlein-native-quit-probe /private/tmp/heinlein-native-quit-EXACT-UUID
```

It has unique app identity `me.thearcades.heinlein.synthetic-quit`, obvious test
window/menu name and an incognito local-only webview. No OsStore is constructed;
production Auth uses an in-memory store/provider, with only lock files in the
temporary StateDir. It cannot call GitHub/model providers. It includes the exact
production AppKit adapter, Quit gate and MutationGate. After the current native
callback returns, a queued main-loop turn activates its own actual Quit menu
selector and directly invokes its own `terminate:`. Both must return Cancel and
remain responsive. Approved author work subsequently posts the preventable Wry
`ExitRequested` with `Some(0)`; these are separate native and programmatic legs,
not a physical keyboard or accessibility injection. The sequence refuses pending
renewal, explicitly retries its memory write, refuses a save, consumes a grant
when a new save races delivery, refuses reuse, and permits normal exit only after
a fresh grant. Flushed bounded stages identify the last completed boundary and
a boolean-only final receipt names those checks. Send literal `abort` on its own
stdin for an orderly test-only failed exit. Its 30-second watchdog also requests
that failed exit; timeout/abort never counts as passing. If the event loop itself
hangs, stop and retain the exact process receipt for separately authorized
cleanup; do not launch another fixture or kill broad process matches. Worker3 owns execution
and cleanup of that fixture; compilation/unit tests alone are not live menu proof.
No installed stable app, profile, real Keychain or RC1 is part of this fixture.
