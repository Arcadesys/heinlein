# Local-work consolidation — 2026-11-05

This branch starts at `a43bf0894530ea4e44568741d9ae7ac2d75a32bf` and retains
missing local Heinlein work without replacing newer main-branch behavior. Topic
commits keep the Studio, MCP, publishing, and native-fixture changes separable.
No manuscript, real project, credential store, installed app, or release is
changed by preparing this PR.

## Retained behavior

- **Projects:** distinct New project/Open existing folder actions, native parent
  selection and confirmation, descriptor-bound no-overwrite creation, and clear
  failure/collision handling. Existing unsaved writing passes its leave guards.
- **Standalone drafts:** in-app questions, review agents and saved revisions use
  the draft's own identity and native storage adapter. Cmd/Ctrl+N consistently
  creates an independent draft. Project scene creation remains explicit.
- **MCP:** one explicit Codex registration, project-level grants, a reusable
  headless stdio entry, and descriptor-bound revocable manuscript scopes. This PR
  does not run registration or grant access to any actual project.
- **GitHub chooser:** one credential read supplies account status and the initial
  repository list. Cancellation is not retried, overlapping status reads are
  coalesced only until another author action, and rotation/account guards remain.
- **Publishing:** opt-in large-print/letter PDFs, bundled licensed fonts and
  deterministic PDF metadata, per-project print/EPUB/HTML styles, plus scene-break
  preview consistency and supported Twine guidance. Defaults remain opt-in; no
  source manuscript is rewritten and Studio text wrapping is not changed.
- **Accessible connection dialog:** keep enlarged status labels intact at 320px
  by limiting nested padding; text size and control targets are unchanged.
- **Native fixture preparation:** pin Python's framework launcher and runtime
  image separately. Synthetic preparation tests cover malformed and changed
  pins. No human-only probe is launched. A pure signing-policy helper is retained
  with its tests; it is deliberately not activated by the updater.

## Committed-source accounting

All source tips and detached checkout heads were captured in a local Git bundle
before integration. Dirty index/worktree patches, source files, and hashes were
captured separately. The recovery archive is local and is not part of this PR.

| Inventoried source | Disposition |
|---|---|
| `ao/persistence-tests/git-workflow` (`7c9a4eba`) | Managed branch/PR flow already exists on main; retain newer native/UI guards. |
| `ao/persistence-tests/root` (`b1a76348`) | Native recents persistence tests and complete native test invocation already exist on main. |
| `codex/fix-new-project-flow` (`ff97d140`) | Integrated as its own topic commit. |
| `codex/standalone-draft-review` (`c9d1e13b`) | Integrated as its own topic commit, retaining the independent Cmd/Ctrl+N policy. |
| `codex/heinlein-large-print` (`acef9fa3`) | Integrated, including font licenses, tests, dependency lock and restricted package contents. |
| `fre-37-estelles-interior` (`60ba588f`) | Integrated project styles alongside the newer publishing configuration. |
| `codex/sidebar-rename` (`ef8df1c3`) | Previewed rename/undo already shipped through PR #83; do not replace later file and revision safeguards. |
| `wip/local-uncommitted-2026-10-14` (`0fb0e670`) | Keep scene-break test, missing preview ink rule and supported Twine guidance. Major-section/Twine implementation is already on main. Do not revive an old package-version bump. |
| `codex/markdown-rendering` (`6692e0bb`) | Standalone Source/Reading mode, safe Markdown and its browser coverage already exist on main. |
| `codex/consolidate-proposal-revisions` (`af6a2512`) | Proposal diffs and native display-only previews are already present in the newer PR #119 Revisions queue. |
| `codex/project-mcp-access` (`10b2159d`) | Retain missing MCP work from `a8b8bb2`, `f0682d6`, `c049172`; keep main's later 1.8.0, scene and review fixes rather than replaying the integration merge. |

## Dirty-source accounting

The capture covered **92 checkouts**, **nine Git repositories**, and **25 dirty
checkouts**. One orphaned registered worktree also had 13 remaining source
files; all matched known committed or captured dirty source, and a separate
recovery copy was retained. Every changed-path observation has a local manifest entry. Sources
were left in place; this branch does not stash, reset, clean, or switch them.

- The GitHub/keychain investigation's chooser changes and pure signing helper are
  retained, with fixture integration updated for the single-read request.
- The manual Python-runtime-identity patch is retained with all five changed files.
- The source-less legacy-output guards and their regression tests already exist
  on current main; no duplicate guard/parser implementation is added.
- The Reading-to-Source passage-jump corrections and regression coverage already
  exist on main. They remain in the integrated Studio implementation.
- The older project-sensitive Cmd/Ctrl+N variant conflicts with the newer explicit
  standalone-draft policy. Its raw patch is preserved locally; the newer
  independent-draft flow and save/navigation guards are retained in this PR.
- Primary-checkout and temporary review-retry/live-review/typing variants are
  superseded by PRs #121/#122 and their stronger authentication, diagnostic,
  source-hash, guarded retry and visible-chrome coverage. No old whole-file copy
  is applied over those fixes.
- Temporary document-tab fixtures predate current title and keyboard coverage;
  keep the later main-branch fixtures. Historical create-scene validation notes
  remain in the recovery capture instead of being presented as fresh evidence.
- Generated Tauri permission manifests, build products, dependency caches,
  synthetic results and compiled app copies are excluded from the PR. Their
  originals remain intact; generated metadata is recorded in the capture.

## Validation

PR review found that importing the new PDF normalization dependency at module
startup broke ordinary Studio exports in an existing CLI environment. The
dependency is now loaded only for explicitly reproducible PDFs. Reproducibility
settings and dependencies are checked before rendering, so invalid configuration
cannot replace a previous export before failing. Four regression cases reproduce
these failures and pass after the fix. The complete publishing suite passes
147 tests, and the native converter smoke verifies all five export formats with
the existing CLI runtime, without upgrading or modifying that environment.

The repository requires `python3 tools/validate.py full` before a push touching
both Studio and publishing. Consolidation acceptance is recorded in the PR after
that complete run; older feature-validation documents describe their original
source revisions and do not establish acceptance of this combined branch.

The rendered target flows are Projects → New project, project/standalone writing
→ Cmd/Ctrl+N → independent draft → Review, and project access → explicit MCP
connection/grant controls. Browser plugin not available; the repository's
Playwright fixtures provide desktop and 320px checks, keyboard/focus/contrast,
no-reflow regressions, screenshots and interaction evidence. Provider calls,
installed-app GUI/VoiceOver, live GitHub credentials, physical printing, and
human-only native probes are outside this PR's acceptance.
