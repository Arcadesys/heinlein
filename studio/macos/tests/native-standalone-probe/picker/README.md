# Disposable native standalone placement acceptance

This opt-in macOS fixture exercises the production standalone bridge, Save picker,
retained preview token, Place confirmation and post-dialog placement guards. It is
excluded from default builds and ordinary renderer assets. It is not a user app,
installer, credential test, physical keyboard test or VoiceOver test.

Build only after the fixture source/isolation review:

```sh
npx tsc --noEmit -p macos/tests/native-standalone-probe/picker/tsconfig.json
npx vite build --config macos/tests/native-standalone-probe/picker/vite.config.ts
cargo build --offline --locked --release -p heinlein-studio --features standalone-native-acceptance,tauri/custom-protocol
```

Do not execute during a native HOLD. Bind the reviewed source/asset hashes and
raw binary SHA256 in an external manifest before any authorized attempt. The
Python driver accurately records source provenance as unknown; binary hashes alone
cannot establish a source revision.

For the independently bounded picker Preview/Cancel scenario add `--preview-only`.
In both explicit picker fixture modes the suggested filename option is omitted: pinned
rfd otherwise appends the filename to an existing starting directory before
setDirectoryURL. Only after own panel/message/exact directory validation, the
main-only driver enters immutable `draft.md` via public setNameFieldStringValue
once per picker phase (including full-mode phase4), then rereads exact name/directory before any response action.
Production default still suggests `draft.md`. This proves real panel input/choice
and completion, not default suggested-filename initialization.

This selects one child and native phase `picker-preview-only`: native dispatch
rejects Place/OpenPlaced/discard and unrelated operations before production code,
allows only the exact synthetic source/read/save and two file previews, caps arms
at two, and makes alert arming an error. The renderer stops before its first
Place action. Completion requires the two actual panel responses, retained preview
token, exact original/no destination file/no placement receipt, zero alert calls
and the unchanged guarded normal Quit path. A legitimate in-memory preview intent
is not a published placement. There is no copy-reopen leg or Place acceptance in
this mode. The full Place scenario remains separately gated.

After explicit native preflight approval, invoke the driver with an owned raw
executable beneath `/private/tmp/heinlein-native47-`, authorization flag and an
external receipt path:

```sh
python3 macos/tests/native-standalone-probe/picker/driver.py \
  --authorized-synthetic-native-test --preview-only --binary /private/tmp/heinlein-native47-EXACT/bin/heinlein-studio \
  --receipt /private/tmp/heinlein-native47-EXACT-result.json
```

The driver creates a new UUID/private root and signed synthetic bundle. HOME is
preserved unchanged; only child TMPDIR points at the fixture root. Before WebKit,
plugin or store use, native startup validates the root/sentinel and all app paths.
A cfg-only immutable root resolver confines reserved-updater-path metadata checks;
it accepts no renderer destination authority or environment home override. The
own WebKit store must be nonpersistent before local asset navigation. No provider,
OsStore, managed updater runtime or external navigation handlers are registered.

The native main-thread observer captures only its exact writing window and that
window's reciprocal attached sheet. Every action revalidates parent identity,
private destination identity, dialog kind/content and enabled unique controls.
Public actions run from a one-shot timer registered in default and modal modes;
no Wry callback reentry, main-thread waiting, AX, XPC, private API, stopModal,
injected result or renderer-supplied path is used. The production builder sets the
fresh immutable initial directory before presentation and retains the checked
parent under the existing selection/close-exclusion guard through completion.

Public action issuance and return are distinct native states. The command worker
captures its immutable phase before presentation and, only after a genuine plugin
response, waits at most five seconds off-main for public-action-return bookkeeping.
No lock is held across the public action; the condition wait releases its lock.
Failure, abort or timeout wakes/fails waiters, and a late return cannot manufacture
completion. Both picker and alert paths use this protocol. This deterministic
bookkeeping fix does not establish the cause of a prior non-unwinding abort.

The first process requires actual picker Cancel (no file), actual picker OK
(preview token without publication), actual Place Cancel (no file), another
picker OK and actual Place OK (exact copy and retained original). A consumed token
must be rejected without another dialog/write. The second process reopens the
same source/revision and checks both original and copy bytes. Both processes must
complete the production guarded Quit path with exit 0. A watchdog/cooperative
abort is FAILURE, never Quit evidence; failed roots/logs remain available and no
signal or guessed cleanup is performed.

Save panels can render through an OS service. The scope is the app-requested
public controller, not all UI in-process or all OS bookkeeping confined. Do not
inspect its sidebar/private preferences or other processes. Unexpected identity,
path, sheet or timeout stops the attempt. Installed app, real manuscripts,
accounts, OS picker physical usability and VoiceOver remain separate acceptance.

The optional `--diagnostic-backtrace` flag is accepted only with `--preview-only`.
It adds only `RUST_BACKTRACE=1` to this child's sanitized environment; HOME and the
parent environment remain unchanged. It does not authorize execution by itself.
Backtrace timing and symbol/source accuracy can differ; a later pass would not
establish the cause of any earlier abort. No debugger or custom panic hook is used.

Output is continuously drained from both child pipes from startup through EOF.
There is no synchronous controller stdout/stderr forwarding while a child is live:
all bounded records and lifecycle milestones remain in the receipt; the small final
summary is emitted only after children have been reaped. Abort commands are sent
immediately after recording the reason, never behind reporter output.
Each stream retains its FIRST 128 KiB / 600 records; maximum partial line is32 KiB.
Separate budgets prevent stdout noise from consuming the first-panic stderr budget.
Unterminated EOF tails are preserved, user-home prefixes are redacted, and any
capture overflow/truncation is explicit, fails the attempt and requests cooperative
abort while draining continues. No signals, memory/locals/environment dumps or
OS-wide log reads are used. Unknown child state remains a stop/report condition.

Memory-only checks:

```sh
python3 -m unittest discover -s macos/tests/native-standalone-probe/picker -p 'test_*.py'
cargo test --offline --locked -p heinlein-studio --features standalone-native-acceptance,tauri/custom-protocol standalone_picker_acceptance::tests
```

### D1 terminal diagnostic (not acceptance)

Build with `standalone-ok-diagnostic,tauri/custom-protocol` and use the explicit
`--preview-only --diagnostic-ok-boundary` driver options. The separate
`standalone-ok-diagnostic-probes` feature contains no-GUI subprocess tests and
must not be included in the disposable GUI diagnostic build. Default builds and
ordinary fixture phases do not install the hook or use the action shim.

After immutable fixture gates, the first Rust panic emits one bounded static
location/checkpoint marker and terminates the diagnostic child without unwinding
(exit 71; reentry 72; marker failure 79). The fixed-enum Objective-C shim invokes
the same retained panel Cancel/OK action; a caught exception/object emits only a
category/phase and terminates (81/82; invalid dispatch 83). It does not inspect
exception content or fabricate a plugin response. Mixed-language catch coverage
is limited. Normal return still requires the genuine plugin result and the
existing off-main action-return handshake.

Every terminal outcome is failure. Instrumented normal flow is classified
`non_reproduction`, with `passed=false` and `acceptance=false`; it cannot establish
the cause of any historical abort or replace ordinary native acceptance. The
diagnostic changes timing and immediate terminal exit intentionally skips cleanup.
No native attempt is authorized merely by compiling this mode.
