# Human-operated standalone Save preview acceptance

This is a reconstructed, feature-only fixture from current main. The old preflight manifest recorded an uncommitted source directory that is now absent; its runtime and reviews are not evidence for this implementation.

**Source-only staging is NONLAUNCHABLE. No native acceptance has been run.** The stage CLI does not build, sign, install, or launch an app. Fresh raw/signed binary hashes and signature verification are missing until separately authorized. The default application and automated picker modes do not gain this manual path.

## Contract

Build-time feature: `standalone-native-acceptance` only. Exact native phase: `picker-manual-preview`. Diagnostic features are excluded. The old automated `picker`, `picker-reopen`, `picker-preview-only`, and `picker-d1` modes remain early unsupported. Default builds still reject the fixture flag before application startup. No managed runtime, provider service, account, real manuscript, default user store, or installed app is part of this fixture.

A later authorized run must bind a unique disposable identity, fresh canonical owned 0700 root and control directory, exact source/assets/config hashes, raw and signed executable hashes, signature, and unchanged HOME. TMPDIR and all Tauri app paths must remain inside the owned root; WebKit must be nonpersistent before fixture navigation. Do not reuse an old root, receipt, binary, profile, collector or app. Source-only `stage-only` produces a new empty root and distinct control directory, but **does not satisfy those binary or startup gates**.

## Human steps — after separate launch authorization

0. Keep the launch Terminal input connected. In an independent context, run the pinned observer after the launch-context handoff. Its output supplies exactly `ready STARTUP_NONCE`. Type that one command in the retained launch Terminal. The collector validates the bound proof while the exact child is live, then sends one bounded owned-stdin readiness line. Native latches it once under the same manual mutex before any picker action and acknowledges the nonce. Open stays disabled until native readiness; Stop remains available. Missing, early, duplicate, wrong, late or failed readiness is incomplete, without a retry or human-step deadline.
1. Read the exact synthetic folder/name cue. Choose **Step 1: Open picker**, then personally click **Cancel**. The genuine production rfd completion must return `None`.
2. Choose **Step 2: Open picker**, use ONLY the displayed owned `copy-targets` folder, type exactly `draft.md`, then personally click **Save**. Save returns a retained production preview token. It never places a copy. The native `FilePath::Path` must match the exact lexical path before resolution or candidate metadata access. URLs, aliases, external paths, duplicates, reversed order and unexpected nulls fail closed. Filename suggestion is disabled only for this fixture; default filename initialization remains unproved.
3. Read the verified status. Choose **Finish and close disposable test** only after the true token and exact original/no-copy readbacks. Native Finish first requires both earlier real readback bits and clear global/picker/manual failure latches before any final readback. It then rechecks those facts and failure latches before finish/guarded quit. Missing or delayed evidence cannot request quit. No close is initiated by a UI timer or by completion alone.
4. **Stop as incomplete** is always available. Stop/abort exits incomplete with 73. A failed or disconnected run is incomplete; do not retry, supply fake callbacks, place a copy, or automate the panel.

There are no human-step deadlines, panel hooks/timers, AX/XPC/private UI APIs, `ok:` calls, synthetic panel responses, or automatic button clicks. The renderer has no Place action, and its native request allowlist forbids Place. Placement confirmation count and automated-action count must both remain zero. Errors keep the manual screen available for Stop; they are not acceptance. A fixed nonsecret native failure event is emitted after the native failure latch. The renderer listener is registered before requests, rejects and clears pending verification, displays Incomplete with source/copy state unverified, disables Open/Finish, ignores late success, and keeps Stop available. It does not echo renderer-failed in response to native failure.

## Collector and durable evidence

`driver.py` provides a single-owned-child collector for a later separately authorized caller; the current CLI only stages source. The collector continuously drains both pipes, including after overflow, without forwarding child output while live. The exact owned child is polled every drain iteration. Human steps have no deadline while it is alive; after observed exit and reap, one fixed two-second monotonic grace drains remaining pipes. Bytes never reset this grace. Expiry preserves bounded evidence, records actual exit/reap and missing EOF streams, closes only owned reader handles, and durably finalizes incomplete. Forced closure is never recorded as EOF; no signals or descendant search occurs. A single bounded startup-storage worker keeps receipt/identity I/O off the pipe-drain loop; pending or failed storage prevents acceptance. Retention is capped at 128 KiB and 600 lines per stream, 32 KiB per partial line, and 2 MiB per final receipt. It sends no signals, operates no UI, installs no service, retries nothing and imposes no human deadline. The control stream permits human Stop; disconnect/any command makes the run incomplete. Overflow/truncation invalidates PASS while drainage continues; human Stop remains necessary if the child stays live.

Before launch, the caller must establish explicit launch authorization and the exact owned signed executable hash. After actual startup an independent observer must verify the *current* collector/native PIDs, their process start identities, exact binary/root binding and the fresh startup nonce in the separate incomplete `startup.json` receipt. That worker never overwrites the final `receipt.json`. The observer writes a private `startup-observed.json` containing matching `pid`, `collectorPID`, `childStart`, `collectorStart`, `startupNonce`, `signedSha256`, `root`, plus its distinct `observerPID`, `observerConfirmedLive:true` and `observedAt` after startup. This independent observation must survive the launching tool context; `start_new_session=True` alone proves no survival. That gate is source-defined, not demonstrated here.

PASS requires exactly ordered real native Cancel, preview and final exact/no-copy readbacks; actual token; zero Place/alerts/automated actions; one guarded normal exit; both pipe EOFs; child reap; matching independent startup observation; no Stop/disconnect, overflow, truncation or storage failure. A native result line, in-memory flag, old receipt, or missing EOF is insufficient. Finalization is one-shot per fresh control/run identity. The caller supplies independent expected `runId`, `receiptNonce`, `binary`, `signedSha256` and `root`; never derive them from the receipt candidate. Before publishing any pass-shaped candidate, the writer exclusively creates and syncs `receipt.attempt` and a bound `receipt.pending` guard, including the directory. The attempt marker persists and prevents retry or reuse. The bounded private candidate is file-synced, atomically replaced, directory-synced and exactly read back, then independently checked for binding and completion. Any failure keeps the pending guard; optional candidate deletion is never authority. Only successful unlink of `receipt.pending` commits. Guard unlink failure is incomplete. There is no fallible validation or cleanup reported as finalization failure after that commit point. No post-unlink directory sync is needed for safety: a resurrected pending guard after a crash only causes conservative rejection.

**Required later verification:** use `read_final_receipt(control, independent_expected_binding, independent_control_identity)`. Obtain binding and directory device/inode identity from the fresh stage/authorized startup evidence, not the candidate JSON. This official reader opens an owned private control-directory fd with no-follow semantics, requires pending-guard ENOENT before and after bounded no-follow receipt reads, checks owner/type/link/size, exact schema/state/binding and complete evidence, and detects directory/receipt replacement. Any guard entry (even malformed), lookup error, malformed/unknown state, wrong or stale binding, unsafe owner/type, or detected replacement returns unverified/incomplete. A committed matching receipt can be verified after restart. **JSON `acceptance:true` alone is NEVER acceptance authority**, including when replacement succeeded before directory sync/readback failed and candidate unlink also failed. Storage or setup failure does not authorize signaling or UI automation. Setup exceptions record the known child PID/binary and actual unreaped/EOF state while closing only owned handles. Read errors retain bounded prefixes and record readError/missing EOF; they never fabricate EOF.

## Local synthetic checks

Run the pure Rust manual contract with `rustc --test`; run `python3 -m unittest discover -s .../manual -p test_driver.py`, the manual state Vitest file, fixture TypeScript/Vite, acceptance-feature/default Cargo checks, and offline browser layout tests. The mocked collector uses no subprocess; browser `?simulated` callbacks are visibly SIMULATED and cannot establish native acceptance. No Tauri native flag is invoked by those UI checks. Synthetic success and source compilation are distinct from native physical/keyboard/VoiceOver acceptance.

Default assets must exclude this fixture. Preserve all existing worktrees, previews, native apps, profiles and unrelated writing. No source publication, issue closure, install, release or real-writing action is authorized by these local checks.

## Reusable signed preparation — separate from source staging

`prepare_signed.py` prepares a **new** locally ad-hoc signed disposable package on
macOS. It never launches a native binary (including rejection probes), collector,
launcher or observer. Running preparation requires separate build/sign permission;
these checked-in scripts do not grant it. Select an exact reviewed commit containing
these helpers, an existing offline toolchain/node_modules cache, and existing owned
0700 output and temporary-work parents. No dependency installation is performed.

```text
python3 manual/prepare_signed.py --repo REPOSITORY --commit REVIEWED_FULL_SHA \
  --output-parent PRIVATE_ARTIFACT_PARENT --work-parent PRIVATE_TEMP_PARENT \
  --node-cache EXISTING_NODE_MODULES
```

The command is shown relative to this fixture's parent directory. Every run creates
new control/build directories and a unique canonical direct synthetic root under
`/private/tmp`; it never reuses an old app, profile, root or receipt. The root remains
empty and `app-data` is reserved only. HOME is unchanged; inherited credentials and
Tauri overrides are excluded. The Git archive must contain regular files only;
symlinks/submodules fail closed rather than extracting outside the snapshot.
Original Git bytes and modes are checked before and after building. Intermediate
source/cache/logs remain private working material, outside Git. A failed attempt is
incomplete; preserve it, do not treat a partial bundle as prepared or retry its run.

Preparation builds all referenced fixture contexts and default frontend assets from
the archive. The acceptance-only ARM64 release uses locked/offline Cargo,
`--no-default-features`, and exactly
`standalone-native-acceptance,tauri/custom-protocol`. The supported inline
`TAURI_CONFIG` supplies a generated disposable identifier, the absolute **actual
private manual dist**, and `app.windows: []`; production configuration is not rewritten.
No diagnostic feature or normal production startup is enabled. Source guards are
static witnesses and must fail closed on relevant source drift, not invoke probes.

The app seals source/actual-asset/overlay/raw evidence first, then signs native and
outer bundle. External preflight hashes are taken **after outer sealing**, avoiding a
self-hash cycle. Strict deep signature verification, ARM64 and symbol exclusions,
host dylib file/load-path pins, OS-version and Python pins are static evidence only.
The package is host-bound; it is not an installer, portable library bundle, release,
managed source-update manifest or proof of runtime-loaded libraries.

A single generated `HANDOFF.md` retains an **independent preflight SHA-256**. Keep
that pin outside candidate runtime output. `signedPrepared=true` does not change
`launchAuthorized`, `launchReady`, `nativeExecuted` or `acceptance`: all remain false.
The source-only stage CLI remains NONLAUNCHABLE and supplies no signed binary proof.
#47 stays open until separately authorized native acceptance establishes its contract.

### Future controls — never invoked by preparation

Only after separate explicit launch authorization, use the pinned Python/script
files in the generated control directory with its exact preflight and independently
retained hash. Do not run from a heredoc, redirected/EOF stdin, background service or
automatically opened Terminal. A user must own the Terminal input for the full run.

- `launch_future.py --preflight PREFLIGHT --preflight-sha256 INDEPENDENT_PIN
  --authorize-native-launch --operator-owned-terminal`: denies without both explicit
  flags and a live Terminal FD. It exclusively claims and syncs `launch.attempt`
  **before any spawn**, duplicates and retains the operator FD through collection,
  and preserves the original. Double invocation or sync failure cannot retry. The
  existing reviewed `driver.collect_owned` remains the only native-child collector.
- `observe_future.py --preflight PREFLIGHT --preflight-sha256 INDEPENDENT_PIN
  --independent-context-confirmed`: use a genuinely independent context after the
  launch-context handoff, before any human picker steps. It examines only this run's
  claimed child/collector PIDs, start identities and exact executable paths. It
  records source-defined startup observation and prints the one Terminal readiness
  command; a process session alone proves no survival. The observer does not unlock
  Open itself. Type the command in the retained launch Terminal, then wait for native
  readiness. Receipt protocol requires the unique matching nonce ACK before the first
  native picker readback; late observation cannot authorize completed steps. Mismatch is incomplete; no scans, retries, signals or automatic UI.
- `verify_future.py --preflight PREFLIGHT --preflight-sha256 INDEPENDENT_PIN`: calls
  the official guarded `driver.read_final_receipt` with expected run/binary/root and
  control identity from the independently pinned preparation, never the candidate.
  A pending guard, mismatch or storage failure stays unverified. Candidate JSON
  `acceptance:true` alone never establishes authority.

Human Cancel/Save-preview/Finish stay user-paced, with no human-step deadline or
Place/automation. The manual-only observation gate preserves default and nonmanual fixture behavior. Mock/static
checks use `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s manual
-p test_preparation.py -v`; they build/sign/launch nothing. Their success is neither
native acceptance nor permission to run a generated helper.
