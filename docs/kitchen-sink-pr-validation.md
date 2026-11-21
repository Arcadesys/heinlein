# Kitchen-sink PR validation

Validated on macOS on 2026-11-05 before updating PR #122. The combined source
includes review authentication recovery, typing controls, Create Scene with
unrelated file drift, and scene/group/manuscript word counts.

## Complete integration check

The full `python3 tools/validate.py studio` run passed on local `c29db90` plus
the word-count changes. File fingerprints confirmed those 18 changed/new files
were unchanged during the run. The validation command used an isolated browser
port and temporary diagnostic directory, with the existing shared Cargo cache.
No production or test source changed after the passing run; this report only
records its outcome.

- Renderer: **1,253 tests across 101 files passed**.
- TypeScript and production Vite build: **passed**.
- Full Chromium browser acceptance: **500 passed, 2 skipped** in 11.8 minutes.
  The retained narrow-project skips cover desktop-only library-layout and
  docked-chat cases. All 14 added word-count cases passed.
- Native boundary validation: **passed**, including updater/provenance tests,
  synthetic in-memory auth retry, all six core crates, **167 Studio native
  tests**, the **44-test authority harness**, and **30-test review-state harness**.
- Workspace formatting and strict workspace/harness Clippy: **passed**.
- Three isolated fixture builds, four native feature-isolation tests, and strict
  feature Clippy: **passed**.
- Production native Tauri build (`--no-bundle`): **passed**.
- `git diff --check`: **passed**. Independent read-only review of Create Scene
  and the word-count integration found no actionable correctness issue.

The renderer runner retained the documented Node 26/jsdom compatibility flag.
The Vite build retained its existing large-chunk advisory. Native suites retained
existing ignored subprocess helpers and opt-in private archive, fsync benchmark,
and real-converter cases.

## Scope and limits

Tests used synthetic fixtures. They did not call a live model provider, perform
OAuth, access the author's credentials, modify a real manuscript, or launch or
replace the installed application. Chromium/jsdom acceptance does not establish
native WebKit, physical IME, or VoiceOver behavior. The primary checkout and its
unrelated changes were preserved. Packaging the merged source is a separate
step after merge; this report does not claim installation or runtime acceptance.

Component evidence remains in `review-typing-pr-validation.md`,
`create-scene-drift-validation.md`, and `word-counts-validation.md`.
