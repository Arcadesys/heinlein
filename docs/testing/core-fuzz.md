# Repository-core deterministic state-machine campaigns

These tests only create synthetic repositories and native-private recovery stores
inside temporary directories. They never open an archive, call GitHub, use the
network, publish, or change a real manuscript. They supplement, rather than
replace, the existing focused regressions and actual SIGKILL/reopen tests.

## Run and replay

From `studio/`, the ordinary bounded CI suite is:

```sh
cargo test --locked -p repository-core
cargo clippy --locked -p repository-core --all-targets -- -D warnings
```

Only run the property families:

```sh
cargo test --locked -p repository-core --lib seeded_ -- --nocapture
```

Defaults are six seeds per family and 48 steps per seed. The first 15 save/recovery
steps and first 14 structure steps deliberately visit each operation category;
remaining operations and all generated operands use seeded SplitMix64. No new
runtime or dev dependencies are required.

The larger bounded campaign is opt-in:

```sh
HEINLEIN_FUZZ_SEED=0x4845494e4c45494e \
HEINLEIN_FUZZ_SEEDS=1024 HEINLEIN_FUZZ_STEPS=64 \
cargo test --locked -p repository-core --lib seeded_ -- --nocapture
```

Seeds are consecutive wrapping `u64` values starting at `HEINLEIN_FUZZ_SEED`
(decimal or `0x` hexadecimal). The seed may be zero. Seed count is bounded to
1–100,000; steps to 1–1,024 (below repository cardinality limits). The transaction family uses `ceil(steps / 8)` batch
rounds, since each round visits every mutation boundary. Small CI defaults stay
fast; the environment settings are not intended as a resource-free upper limit.

A failed run prints its family, exact seed, settings, and complete operation
trace. Replay with the printed seed, `HEINLEIN_FUZZ_SEEDS=1`, and the same steps;
filter to that test's name. Reduce steps to the first failing prefix, then turn the
smallest necessary operation sequence into a focused regression before changing
production code. Random choices and generated text are deterministic; production
UUIDs, timestamps, and temporary directory names remain naturally variable and
are checked by their invariants rather than against predetermined values.

## State models and invariants

### Saves and recovery

A three-document reference model tracks exact disk bytes, permission bits and the
latest acknowledged recovery snapshot independently of later reads. Successful
staging is checked against the requested path, base hash, exact text, actor/client,
and UUID. Every step compares disk bytes, reported size/hash, recovery contents,
permissions and temporary-file cleanup for all documents.

Operations include stage/save/clear, stage-only, external edit with a stale base,
metadata-preserving no-op save, stale compare-and-delete, read-only write failure,
injected save/stage failure before publication, competing store ownership, owner
exit/reopen and repeated unobserved-recovery retries, source removal, staging-time
external edit, same-content inode replacement, invalid inputs, and clean-recovery
whole-scene saves. Failed operations must preserve the latest accepted snapshot
and the externally modified source, if any.

Text varies LF/CRLF, terminal-newline presence, raw YAML/JSON frontmatter, unknown
metadata, BOMs, combining characters, non-Latin scripts, multi-codepoint emoji,
tabs and authorial em dashes. It is synthetic prose with no asset references.

### Manuscript structure

A separate ordered scene model tracks stable IDs and paths through create,
move, copy, reorder, ordinary save, move/undo, guarded undo after an external edit,
restart, stale source/index/membership previews, explicit reconciliation of
added/missing files, pending recovery, and ownership transfer. Newly allocated IDs
are captured only at creation and checked for validity and uniqueness; subsequent
operations must retain the expected identities. Copies must receive new IDs.
Initial allocated titles/group IDs are captured from the returned state and subsequently checked for preservation; independent initial
title/group allocation is outside this generated model and remains covered by the
focused scene/group regressions.

After every operation, the test compares scene order and membership plus the
complete set of ordinary files, exact bytes and modes. Interrupted flags, temporary
files, and stale private transaction receipts must be absent after successful
completion. Empty directories left by rollback/undo are intentionally permitted,
as specified by the architecture.

### Transaction failure and restart

Each random one-to-four-file copy/move batch tests every post-edit failure point,
including after the manifest write. The test demands byte-for-byte and mode-for-
mode restoration of the entire repository, journal removal, private receipt and
temporary-file cleanup, and a usable state.

A second path publishes the real durable journal/receipt, applies a chosen prefix
(including no edits or all edits), drops both handles, reopens, and explicitly
rolls back. Interrupted rollback must not offer Undo. Recovered move batches are
then committed and undone again to prove the recovered state remains usable.

The prefix test simulates an abrupt stop at application-level durable boundaries;
it is not a hardware power-loss simulator. Existing focused tests cover actual
SIGKILL, corrupt/untrusted receipts, tampered journals, symlinks, external links,
limits, and additional unsafe-path cases. These bounded campaigns do not prove
OS-wide compare-and-swap, arbitrary crash timing, or all filesystem error modes.

## Recorded campaign: 2026-10-15

Completed in the Linux cloud worktree on `test/overnight-drafting-hardening`, using
only synthetic temporary repositories. The stop condition was the complete
planned seed range and all generated operation categories, followed by the normal
regression and static-check suite.

- Seed range: `0x4845494e4c45494e` through `0x4845494e4c454d4d`, inclusive
- 1,024 distinct seeds, applied to each of three families: 3,072 seed/family executions
- 64 steps per seed; transaction recovery uses eight batch rounds per seed
- Primary generated-operation coverage: **182,129 operations; zero failures**
- No confirmed production defect or production behavior change

| Family | Generated operations |
| --- | ---: |
| saves-recovery | 65,536 |
| structure | 65,536 |
| transaction-recovery | 51,057 |

These counts describe generated operations, not every API call or invariant
assertion. Several operations intentionally issue multiple rejected calls.
The combined run took 1,064.06 seconds. Save/recovery was independently
rerun with exact requested snapshot-field assertions (48.39 seconds), and the
transaction family was rerun with private receipt/temp cleanup assertions at
every rollback/reopen/commit/undo boundary (349.80 seconds). The primary counts
above use the latest full run of each family; repeated executions are **not**
counted as additional distinct coverage.

### Per-operation coverage

#### saves-recovery

| Generated operation | Count |
| --- | ---: |
| clean-recovery-save | 4,455 |
| external-stale-save | 4,478 |
| failed-save-io | 4,315 |
| failed-stage-io | 4,398 |
| invalid-input | 4,285 |
| missing-source | 4,309 |
| noop | 4,464 |
| ownership-busy | 4,328 |
| readonly-save | 4,282 |
| restart-unobserved | 4,346 |
| same-bytes-inode-swap | 4,408 |
| stage | 4,412 |
| stage-save-clear | 4,307 |
| staging-external-edit | 4,388 |
| stale-discard | 4,361 |

#### structure

| Generated operation | Count |
| --- | ---: |
| copy | 4,709 |
| create | 4,718 |
| guarded-undo | 4,572 |
| move | 4,637 |
| owner-transfer | 4,678 |
| pending-recovery | 4,625 |
| reconcile-removal | 4,671 |
| reorder | 4,745 |
| restart | 4,671 |
| save | 4,718 |
| stale-index-plan | 4,718 |
| stale-membership-reconcile | 4,706 |
| stale-source-plan | 4,687 |
| undo-move | 4,681 |

#### transaction-recovery

| Generated operation | Count |
| --- | ---: |
| failed-io-rollback | 38,806 |
| interrupted-reopen-rollback | 8,192 |
| post-recovery-commit-undo | 4,059 |

### Additional validation and limits

- Final ordinary `cargo test --locked -p repository-core`: 58 passed, zero failed;
  four top-level ignored entries remain (private archive acceptance, timing
  benchmark, and two subprocess helper entrypoints exercised by their parent tests)
- Final `cargo clippy --locked -p repository-core --all-targets -- -D warnings`: passed
- `cargo fmt --check -p repository-core` and scoped `git diff --check`: passed
- Supplemental boundary replay used seeds `0xffffffffffffffff` and `0`, 16 steps
  per seed, across all three families: 81 additional generated operations passed;
  excluded from the primary coverage count
- Before the recorded campaign, moving a mode-0640 scene, externally editing it,
  and rejecting undo exposed a harness-only guarded-undo oracle bug. The
  implementation correctly retained mode 0640; the initial model incorrectly
  assumed 0600. The model now retains the prior mode. No production fix was needed
- No real archive fixture was opened or changed. No external services were used
- Results cover this Linux filesystem. macOS/native desktop interactions, actual
  power loss, arbitrary scheduling races, and unmodeled filesystem failures remain
  outside this campaign's evidence
