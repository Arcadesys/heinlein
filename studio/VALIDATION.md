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
