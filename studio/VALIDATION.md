# Pass 1 validation

2026-10-14, Linux cloud workspace. Base: `679bd3e260d7529122d83a8519529cfe8a6946a8`.

- Rust core: 13 adversarial/unit tests passed; formatting and clippy with warnings
  denied passed
- Private writing-archive acceptance: 95 scenes across four volumes, fourteen
  chapters, ordered and readable with metadata; compatibility sources recognized.
  Private manuscript contents are not included as fixtures or artifacts
- TypeScript renderer: 14 mocked DOM/IPC tests and production Vite build passed
- Existing Python suite: 33 passed, 5 skipped, 4 failed due to Chromium startup in
  this environment. The untouched base revision was tested separately and produced
  the same four failures. No publisher Python, template or manuscript file changed
- Full native `cargo check -p heinlein-studio`: blocked by missing glib/GTK/WebKit
  development packages, before host compilation could be verified
- Native macOS build/picker, recent-folder OS persistence, VoiceOver, and physical
  keyboard/visual acceptance remain unverified. CI includes macOS/Linux builds,
  but configuration alone is not proof those runs pass
- Cloud Chromium UI screenshot attempt: blocked by socket permission failure;
  mocked DOM tests are not a substitute for a native visual smoke test

Independent review checked path-boundary and folder-selection races. Fixes include
no-follow descriptor traversal from the selected absolute root, retaining that
validated root without re-canonicalizing it, serialized native selection,
renderer selecting/request-generation guards, and copy-before-persist preferences.

Before promoting from draft: complete native CI/build, then open an actual local
checkout on macOS, cancel/reopen the picker, select a recent folder, browse both
views, open each Consequences scene, and verify keyboard/VoiceOver behavior.
Writing/editing and save-recovery remain outside this pass.

# Pass 2 validation

2026-10-15 UTC, fresh cloud checkout based on main `16d88b6` (PR15).

- Rust repository-core: 21 tests passed, one private fixture check ignored;
  strict core clippy and formatting passed
- Renderer: 35 tests passed across five files; TypeScript and production Vite
  build passed. Vite reports a non-failing 545.75 kB chunk-size warning
- Tests exercise expected-hash saves, no-op bytes, stale/external revisions,
  failed writes, repeated saves, generated-source protection, dirty navigation,
  save-and-continue double actions, typing during save, close synchronization,
  undo/redo/find, and exact saved mixed-newline restoration
- Existing Python suite: 33 passed, 5 skipped, same four Chromium failures as
  pass-1/base evidence above. No Python publisher or private manuscript changed
- Native cargo check remains blocked before host compilation by missing
  `gobject-2.0` >= 2.70 pkg-config development package
- Actual Chromium renderer preview attempted; browser failed at startup with
  `socket() failed: Operation not permitted`. No new screenshot was produced
- Native macOS/Linux runtime, production CSP/visual layout, actual keyboard,
  screen reader, picker, and OS close interactions remain unverified

Independent review found and repaired save/dialog navigation and close-IPC races,
CodeMirror production style policy, saved newline restoration, and PR15 font
fallback wiring. Final source review found no remaining blocking code findings.
All save tests use synthetic/temp fixtures. No source manuscripts are included.

# Pass 3 validation

2026-10-15 UTC, cloud branch based on main `0059f7f` (PR16).

- Full renderer suite: 94 passed across seven files; TypeScript and production
  Vite build passed. Existing chunk-size warning remains (559.13 kB output)
- Repository Core: 37 passed, 3 intentional ignores (private archive fixture,
  subprocess helper invoked by the crash test, optional benchmark); strict Core
  clippy and formatting passed
- Recovery tests cover durable stage/read/discard, abrupt process termination and
  reopen, failed writes, stale cleanup IDs, independent process ownership,
  stale-owner takeover, newer snapshots during pending saves, generated files,
  corrupt records, filesystem boundaries, and external conflicts
- Renderer tests cover idle and continuous-typing scheduling, stage-before-save,
  newer typing during save, recovery restore/discard, exact newline retention,
  read-only recovery failures and retry, navigation/close, and save errors
- Goal tests cover local midnight, restart/reload, scene switching, paste,
  undo/redo, deletion/retyping, programmatic/recovery changes, frontmatter,
  Unicode, storage failure and conservative multi-range counting. Manuscript
  totals exclude discarded unsaved text and preserve exact saved snapshots
- Existing Python suite: 33 passed, 5 skipped, same four Chromium failures as
  earlier base validation. No Python publisher or private manuscript changed
- Synthetic 100-operation Linux/debug benchmark on approximately 23 KiB text:
  recovery stage p50 2.985 ms / p95 4.413 ms; stage + guarded manuscript save +
  matching cleanup p50 6.517 ms / p95 8.325 ms. These are local filesystem
  measurements, not native input-latency or real-device performance guarantees
- Native application compile remains blocked before host compilation by missing
  GTK/GLib pkg-config libraries. No native CI run has been triggered for this
  unpublished branch. Native visual, physical keyboard, VoiceOver and OS-close
  acceptance require an actual macOS/Linux application smoke test

Independent safety review found no remaining P1/P2 blockers after fixes for
cross-process recovery ownership, stale takeover, unknown recovery reads,
continuous-typing scheduling, generated-file classification, discarded manuscript
counts and false daily-goal credit. An interrupted save can conservatively reopen
as a recovery conflict; both versions remain preserved. Recovery is one latest
snapshot per scene, not a full browsable revision history. Recent typing before a
durable stage completes remains vulnerable to forced termination.

# ms drafting validation

2026-10-15 UTC, local branch based on the reviewed pass-3 patch.

- 122 frontend tests passed; TypeScript and production Vite build passed
  (non-failing 577.03 kB JavaScript chunk warning)
- Core reports 55 passed, 4 intentional ignores, strict Core clippy and workspace
  formatting passed. Tests cover preview/apply stale checks, collisions,
  safe file moves/imports, journal provenance, interrupted rollback, guarded undo,
  ownership-aware pending saves, legacy protection and asset-reference blocking
- UI tests separately cover repository move drags, stable-ID pane reordering,
  native-authorized Finder-drop copies, keyboard import/move controls, explicit
  independent legacy copies, dirty/recovery synchronization, stale responses,
  close protection and nullable undo after interrupted recovery
- Independent source review found no remaining P1/P2 findings after fixes
- Native compile remains unverified: missing dbus-1.pc blocks the host build.
  Browser screenshot also failed at Chromium process-singleton socket creation
  (Operation not permitted). No bypass was attempted; temporary harness removed
- Native picker/drag/drop, macOS accessibility/physical keyboard and full desktop
  flow require actual application smoke testing. Mocked tests do not establish it
- Existing Python publisher was unchanged; its pass-3 baseline remains applicable

Publication/export, asset migration and directory-tree imports remain deferred.
Legacy copies are explicitly independent; sources referenced by legacy manifests
cannot be moved. Structural moves preserve bytes/mode bits, not ACL/xattr/time
metadata. Normal structural undo is revision guarded; interrupted rollback is not
undoable because recreating a partial transaction would discard its protection.

# Integrated 1.5.0 candidate validation

2026-10-15 UTC, cloud workspace; software remains unreleased.

- 135 renderer tests passed across seven files; TypeScript and Vite production
  build passed (584.00 kB JavaScript chunk warning remains)
- 79 Core/store/MCP tests passed, with four intentional Core ignores; strict
  clippy passed for all three crates and targets
- 24 tests execute the actual native proposal-authority source in its standalone
  harness; strict harness clippy passed. These cover review binding, expiry,
  changed source/draft state, stale operations, receipts, failure and revert
- Workspace formatting passed after normalizing one host conditional
- Optimized MCP CLI release build at 1.5.0 and its help command passed
- Read/propose MCP subprocess tests exercise the real stdio server. No client
  account configuration or persistent grants were installed
- Independent authority review found no remaining P1/P2 blockers. Approval remains
  an explicit native action; pending proposals cannot write canonical manuscripts
- Full native Tauri compilation remains blocked by missing dbus-1.pc before host
  type checking. The standalone authority harness and renderer mocks do not
  verify the complete native bridge, OS dialogs, drag/drop or real application UX
- No GitHub CI, tag, release, merge or installation was performed for this patch

Proposal snapshots are byte-hash-bound rather than a complete authenticated
revision ledger. A late typing notification is protected by native mutation
checks and renderer buffer retention; this is not an atomic transaction between
OS input delivery and filesystem replacement. Ambiguous intent receipts fail
closed for manual review. Revert authority is limited to the current native
session. Native end-to-end smoke testing remains a release gate.
