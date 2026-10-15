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
