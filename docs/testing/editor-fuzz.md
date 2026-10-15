# Editor and Studio async state-machine testing

All inputs are synthetic. These suites instantiate the real CodeMirror editor and
`mountStudio` in jsdom; only the native `LocalCore` boundary is simulated. They
never open an author's repository, call a model, or publish anything.

## Run and replay

From `studio/`, `npm test` retains the existing suite and adds the bounded CI
campaigns: 12 editor seeds × 100 operations; 8 Studio seeds × 100 operations,
8 reordered-recovery scenarios, and focused regressions.

Larger campaigns are configurable without a new dependency:

```sh
EDITOR_FUZZ_FIRST_SEED=1 EDITOR_FUZZ_SEEDS=100 EDITOR_FUZZ_STEPS=200 \
  npm test -- --reporter=dot src/editor.fuzz.test.ts
STUDIO_FUZZ_FIRST_SEED=1 STUDIO_FUZZ_SEEDS=64 STUDIO_FUZZ_STEPS=150 \
  npm test -- --reporter=dot src/studio.fuzz.test.ts
```

Run large campaigns in sequential batches (for example editor start seeds
1, 101, …, 901), rather than retaining thousands of jsdom cases in one process.
An initial oversized parallel campaign ended with Vitest `ERR_IPC_CHANNEL_CLOSED`;
it is **not** counted as a completed validation run.

Failures print a seed-specific command, the operation prefix, and the underlying
assertion. Set `*_FUZZ_SEEDS=1` and reduce `*_FUZZ_STEPS` to minimize a prefix.
One-step prefixes are supported; no random per-seed coverage quota can make them
fail. Seed ranges must stay within 1–4294967295, with no wrap into xorshift's
zero-state. Each completed process prints `EDITOR_FUZZ_COVERAGE` or
`STUDIO_FUZZ_COVERAGE` JSON counters. These are operation counts, not code-coverage
percentages or proof of all possible event schedules.

## Oracles and coverage

### CodeMirror byte/history state machine

- Independent raw-token model: CRLF is one displayed UTF-16 unit; lone CR and LF
  are distinct tokens. Non-overlapping edits use old-document offsets
- Unicode includes surrogate pairs, ZWJ emoji, combining marks, CJK, a musical
  symbol, U+2028, tabs, protected em dashes, literal script text, empty sources,
  frontmatter-like text, LF, CRLF, lone CR, and mixed endings
- User edits, programmatic changes, multiple changes in one transaction, saved
  checkpoints, selection/read-only toggles, undo and redo
- Exact raw string checks for generated edits and every ordinary intermediate
  undo/redo checkpoint, not only equality after newline normalization
- Every displayed UTF-16 offset is checked against the independent raw-token
  mapping after every operation, including undo/redo
- Grouped and multi-transaction history is additionally covered by minimized
  regressions; compact history metadata is bounded on a 262-KB synthetic scene
  with 100 grouped keystrokes

### Studio async state machine

A manually driven host queues recovery staging, manuscript saves, and CAS cleanup.
The seeded driver reorders eligible completions, delays them across later typing,
injects I/O failures, triggers debounce timers, issues repeated manual saves,
undo/redo, programmatic changes, navigation/close attempts, and `beforeunload`.

Invariants include serialized stage/save calls, durable staging before every save,
no replacement of newer visible text by an older success/error, no accidental
close or navigation over dirty/pending work, no writing credit for history or
programmatic changes, and convergence after explicit successful retries. CAS
cleanup refusal preserves a newer recovery copy and is not misclassified as
manuscript data loss; a later clean retry must settle redundant recovery.

Separate seeded scenarios deliver stale recovery successes/errors after a newer
scene wins, restoring the new recovery only after an explicit action. Focused
regressions verify exact mixed-ending bytes through actual Studio save/read
round trips, canceled repository pickers, and late programmatic edits during a
successful repository switch.

The long Studio save campaign compares disk text to the visible editor after
newline normalization. Its purpose is async ordering and loss prevention. Exact
raw bytes are covered by the editor campaign and focused Studio round trips;
the broad async campaign does not independently model raw bytes at every event.

## Confirmed defects and minimized regressions

1. **Lone CR + LF boundary fusion**, first found at editor seeds 77 and 141.
   Deleting `b` in `a\rb\nc` serialized `a\r\nc`, collapsing two displayed line
   breaks into one and invalidating later raw offsets. `applyRawChanges` now
   assembles unchanged source spans once and inserts a boundary separator only
   when separate CR/LF breaks would fuse. The saved result is `a\r\n\nc`.
   Inserted-newline and multiple simultaneous boundary joins have focused tests.
2. **Intermediate undo changed newline bytes.** Starting at `a\r\nb\nc`, append
   `x`, delete displayed positions 2–4, and undo. The previous serializer
   reinserted the deleted LF as CRLF unless returning to the initial/latest
   saved baseline. Raw text now lives in a CodeMirror state field; inverted
   history effects preserve compact newline metadata for each history group.
   Grouped typing retains one metadata snapshot, not full source strings per
   keystroke. This supersedes the ordinary-history limitation in the older
   `studio-pass-2.md` architecture snapshot.
3. **Late edits lost during repository selection.** A programmatic edit arriving
   while the native picker was pending was replaced by its successful response.
   The picker now pauses editing, saving, navigation, and autosave. If a late
   programmatic edit still arrives and the native session changes, its buffer
   is retained with an explicit copy/reopen warning. A detached-session guard
   prevents all stale-session persistence. Cancel/error preserves that warning;
   explicit discard and valid reopening restores normal persistence.

## Boundaries and remaining desktop checks

- Native file-system durability, ownership, and path containment are exercised
  by the separate repository-core suites, not established by mocked IPC here
- Physical keyboard/IME, native dialogs, operating-system close delivery,
  accessibility, real audio, and desktop drag/drop still require native testing
- Generated edits use Unicode code-point boundaries; this is not an exhaustive
  grapheme/IME campaign or invalid UTF-8/native serialization test
- `Transaction.addToHistory: false` document changes invalidate mapped exact
  newline metadata. Undo preserves unrelated visible text but reinserted lines
  can use the current newline convention. This case is explicitly regression
  tested and is not claimed as byte-exact history; Studio currently has no such
  non-history document writers
- Effects contain newline metadata rather than source text. The history-size
  regression checks retained metadata structure; it is not a system-wide heap
  or long-running native-app memory benchmark
- Error messages, recovery warnings, and explicit preservation matter as well as
  clean success. The tests do not treat retained recovery after CAS refusal as
  permission to delete another snapshot

## Completed validation (2026-10-15)

The final compact-history implementation passed the original tests plus new
regressions: **174 tests in 9 files**, followed by TypeScript checking and a Vite
production build. Vite retains its existing non-blocking bundle-size warning.

The completed editor campaign ran **seeds 1–1000, 200 steps each** in ten
sequential 100-seed processes: **200,000 generated operations**, all passing.
Recorded operation counts:

| Operation | Count |
| --- | ---: |
| Input-tagged edits | 79,751 |
| Delete-tagged edits/replacements | 20,032 |
| Programmatic edits | 19,991 |
| Mark-saved checkpoints | 20,086 |
| Undo | 19,971 |
| Redo | 20,072 |
| Selection/read-only toggles | 20,097 |
| Multi-change transactions (subset of edits) | 15,800 |

The ten completed editor processes totaled 191.98 seconds of reported Vitest
runtime. One-step prefix replay and the highest valid seed (4294967295) were
also checked separately. Earlier failed/aborted development campaigns are not
included in these passing totals.

The final Studio campaign ran **seeds 1–256, 150 steps each** in four sequential
64-seed processes: **38,400 generated operations plus 256 reordered-recovery
scenarios**, all passing. Each process also reran the three focused Studio
regressions. Its four completed processes totaled 107.35 seconds of Vitest
runtime.

| Studio operation/event | Count |
| --- | ---: |
| User edits | 8,822 |
| Programmatic edits | 2,908 |
| Undo / redo | 2,968 / 2,954 |
| Explicit save requests from generated operations | 2,906 |
| Timer advances | 2,994 |
| Before-unload events | 2,989 |
| Dirty/pending close guard checks | 2,848 |
| Dirty/pending navigation guard checks | 2,841 |
| Explicit Keep editing choices, close / navigation | 288 / 289 |
| Recovery stage requests / successes / injected failures | 3,993 / 3,456 / 537 |
| Manuscript save requests / successes / injected failures | 1,825 / 1,495 / 202 |
| Save guards for unavailable fake-disk paths in recovery-response scenarios | 128 |
| Recovery cleanup requests / successes / injected failures | 1,255 / 863 / 133 |
| Cleanup CAS refusals preserving newer recovery | 259 |
| Stale recovery responses, success / error | 129 / 127 |
| Explicit recovered-draft restores | 128 |

IPC totals include the seeded recovery scenarios, deterministic cleanup/retry
steps, and focused regressions repeated per batch. They are not extra generated
operations and should not be added to the 38,400 operation total. Across both
families, the final campaigns exercised **1,256 seed runs and 238,400 generated
operations**, without counting earlier development/replay runs.
