# Disposable native scene insertion acceptance

This explicit macOS feature loads the production drafting panel in WKWebView and
uses the production `load_drafting`, `preview_drafting_change`, and
`apply_drafting_change` Tauri commands. No synthetic drafting backend is used.

It creates a fresh private UUID directory containing a synthetic indexed scene,
an unrelated missing index entry, and an unlisted notes file. Both Cancel actions
must leave native state unchanged and send no preview/apply calls. Four repeated
Add above/below actions must each preview/apply once. A second process reopens the
same manuscript. Native verification independently checks persisted order, empty
new files, exact Unicode/CRLF source bytes, retained unlisted notes and retained
missing metadata.

```sh
cd studio
npx vite build --config macos/tests/native-scene-probe/vite.config.ts
cargo build --locked --manifest-path src-tauri/Cargo.toml --features scene-native-acceptance
python3 macos/tests/native-scene-probe/driver.py \
  --binary target/debug/heinlein-studio --receipt /tmp/native-scene-result.json
```

The driver signs and starts only a separately named disposable app bundle.
`TMPDIR` and all Tauri application directories are confined to the private root;
the webview is incognito. Only the four listed production IPC commands are
registered. No provider, account, installed app, repository picker, or manuscript
outside that root is used. Fixture builds refuse production startup, and normal
builds refuse the fixture flag. A watchdog exits its own fixture on failure; the
driver never sends signals. Evidence and synthetic sources are retained.

This verifies native WebKit/IPC/persistence plumbing using programmatic DOM
activation of the production panel. It does not claim physical mouse/keyboard or
VoiceOver acceptance, or end-to-end testing of the full Studio shell (covered
separately by the existing scene insertion integration and browser tests).
