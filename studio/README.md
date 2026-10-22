# Heinlein Studio: local manuscript drafting

An additive native desktop editor with local autosave and explicit recovery decisions. Open a local checkout or
folder, browse its files, and use a scene manifest to navigate the manuscript.
The existing Python publisher and its CLI remain unchanged.

## rc1 candidate packaging

The literal release tag is `rc1`; Studio's internal SemVer is `1.5.0-rc.1`.
The existing Python publisher remains independently versioned at `0.1.0`.

On an Apple Silicon Mac, build the separate candidate with:

```sh
cd studio
npm ci
npm run tauri build -- --config src-tauri/tauri.rc.conf.json --bundles app --ci
```

This produces **Heinlein Studio RC1.app** with bundle identifier
`me.thearcades.heinlein.studio.rc1` and separate app data, leaving an existing
Heinlein Studio installation/profile alone. It is a self-contained build of the
checked-out source: no launcher fetches or rebuilds moving main on launch.
The RC configuration uses ad-hoc signing, not a certified Developer ID or Apple
notarization. An ARM64 build supports Apple Silicon; it is not a universal,
Intel, Windows or Linux release. macOS 11 is the packaging minimum, not a claim
that runtime acceptance was performed on every supported OS.

Extract the app ZIP, keep its RC1 name, and copy it to your user Applications
folder or run it from the extracted folder. Do not replace the stable app.
macOS may require Finder's **Open** or **System Settings → Privacy & Security**
approval for this non-notarized candidate. Verify the published SHA256 before
opening it; never disable Gatekeeper globally. Removing the RC app does not
remove its isolated guide/recovery data.

Python wheel/source assets are separate from the Mac app. Install the wheel in
a dedicated Python 3.11+ environment; Python dependencies, Pandoc and Chrome
(for PDF) are external prerequisites, not bundled in the app or wheel. The
source archive is restricted to publisher code/templates/package metadata;
no manuscripts, examples, credentials or native app profiles belong in assets.
Release notes and checksums identify the exact source commit and observed
architecture/signing. A successful package build is not OS picker, VoiceOver,
provider, live Linux or power-loss acceptance.

## GitHub projects

Choose **GitHub projects…** to open an existing github.com repository as a separate
copy on this computer. Connect the Arcadesys **Heinlein Studio** GitHub App, install
it only for chosen repositories, and confirm your GitHub account. The App needs
Contents and Pull requests write access; your account also needs write access.
GitHub connection is separate from your assistant account. Credentials stay in
macOS Keychain or Linux Secret Service; no browser or plaintext fallback is used.

After confirming the account, choose **Load repositories**, then **Preview** beside
the project you want. Review its account, name and visibility before opening the
separate local copy. If none appear, use **Choose repositories for Heinlein on
GitHub**, grant only your chosen repositories, and **Refresh repository list**.
An organization may require approval or SSO. Signing in again is not needed just
to refresh access. **Open by repository URL instead** remains available. Loading,
previewing and opening a copy never sends writing to GitHub.

Continue writing offline. **Save a version on this computer** selects exactly which
saved writing files, author name/email and message to commit locally. **Send local
versions to GitHub** explicitly pushes the separate working branch. **Request
feedback** creates a draft pull request. Each sharing action previews its account,
visibility, branch and files and requires native confirmation. GitHub automation
may run when you send. Saving locally never means sent or published.

**Review incoming changes** previews the whole result. Conflicting passages show
Original / Your writing / GitHub writing; explicitly choose a version or write your
own result. Structure and reading order use scene identities. Save local changes
as a version before applying an incoming batch. Cancel preserves source. Interrupted
operations block reopening until explicit recovery; unknown network results have a
read-only check action and never retry automatically. After closed/merged feedback,
review the original branch before starting a fresh feedback branch.

Only existing nonempty github.com repos, ordinary Markdown and schema-v2 ms
workspaces are supported. Choose/create a working branch, commit exact saved files, send, and create a draft
or ready PR with separate confirmations. Local branches retain unsent commits.
Marking a draft ready is separate from merging. In-app merge remains unavailable
until this connection can prove no rule bypass; Open on GitHub is available.
No SSH, forks, LFS/submodules, force push, repo creation, default-branch writes or
release action. Unsafe or
unsupported source is rejected. Reopen existing managed copies without a network;
missing copies are never recloned over drafts. Technical contracts and evidence
limits are in [GitHub workspaces](../docs/architecture/studio-github-workspaces.md).
The public client ID is configured natively; an empty/invalid
`HEINLEIN_GITHUB_CLIENT_ID` disables connection without fake login. Linux builds
also require `libdbus-1-dev` and a running Secret Service for connected actions.

## Your first story

Choose **First story** for an optional guide from an idea to a publishing copy.
It can help you choose a folder and start a manuscript, or resume work already
underway. Each stage offers one next action, a readiness check and optional help.
Use a light plan or discover the story while writing. Skip stages, return to them,
or close and resume; resetting the guide asks for confirmation and leaves story
files unchanged. Progress and planning answers stay in local app data, outside
the manuscript. No checkbox edits prose or sends it to a provider.

Revision separates the story/structure pass from sentence/voice work. Optional
Heinlein Review remains advisory and runs only when requested. Proof applies to a
saved revision; later source edits clear proof and release checks. Intentional
style has no score or gate to pass.

**Preview publishing copy** prepares a new, text-only snapshot of a drafting
manuscript. Review all included scenes in order, metadata and text treatment.
Scene frontmatter, links, images and include directives require a separately
configured publishing project; the guide reports them rather than dropping them.
Groups stay organizational. Supply your own author/rights information and
explicitly approve the no-cover choice and the existing FREE PLAY / The Arcades
branding (including its preset colophon). If you do not want that branding, use a
separate manual publisher configuration; there is no generic unbranded preset.

Choose an existing parent folder with the native picker. Only an additional
native confirmation creates a **new** folder with `manuscript.md`, `heinlein.yaml`
and a source-hash receipt. Existing folders/files are never replaced. Dirty,
stale, missing or unsafe source and pending recovery stop the copy. Your original
story remains authoritative; copies never synchronize in either direction.

In the new copy folder, use the separately installed existing CLI:

```sh
heinlein build
heinlein serve --host 127.0.0.1 --port 8765
```

Studio does not run these commands, share files, distribute a book or connect a
publishing account. Check the actual HTML and chosen output before sharing. PDF
needs Chrome; the other conversion formats use the existing Pandoc setup.
See [the architecture boundary](../docs/architecture/studio-ms-drafting.md).

## Run

macOS and Linux are the first supported platforms. Install Node.js 22+, stable
Rust (1.90+), and the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
(Xcode command-line tools on macOS; GTK/WebKit development libraries on Linux).

```sh
cd studio
npm ci
npm run tauri dev
```

For an unsigned local executable: `npm run tauri build -- --no-bundle`.
The tracked [managed macOS updater](macos/README.md) provides local main-source
updates for protocol-v1 installs, with full app staging/rollback and an inherited
native lifetime lease. The legacy installation requires a separate supervised
bootstrap; automatic installation refuses it. Ad-hoc signing may require macOS
permission for existing Keychain items. This work does not change RC1 distribution.
`npm run dev` alone serves the renderer for development; a normal browser has
no repository access and displays a native-app requirement.

## Use

Choose **Open folder** using the operating system's native folder picker. Select
your existing `writing-archive` checkout (or the Singularity Log project folder).
The File tree preserves normal directory navigation. The Manuscript view lists
supported `scene-manifest.json` files and uses manifest array order, including
volumes, chapters and scenes. Version 1 of the writing-archive scene manifest is
supported. Unsupported or invalid manifests produce an error, never a migration.

Click a document to preview its UTF-8 source. In editable Markdown, opening YAML frontmatter is tucked into a closed **Document details** disclosure with readable labels and values. **Edit source fields** reveals the original fields in the same editor; Save, Undo, recovery, and conflict handling still apply to the complete source. Comments, unknown fields, and newline bytes are preserved, never regenerated from the friendly view. Search or a selection inside hidden fields reveals them at their original positions. Backspace at the start of prose reveals hidden fields before allowing their deletion. Malformed or unterminated frontmatter remains visible. Generated/read-only files retain their raw-source preview.
Markdown scenes open in a plain-source editor with Undo, Redo, Find and explicit Save (Cmd/Ctrl+S). Generated compatibility sources remain read-only. Edits schedule local autosave after a short idle interval; Save (Cmd/Ctrl+S) flushes it immediately. Each manuscript save first stages a durable recovery snapshot. Unsaved changes prompt before navigation and close. Conflicts and write errors retain your buffer. Reopening an interrupted scene offers Restore or Discard, with both the recovery draft and current disk text available for comparison. A crash before a snapshot completes can still lose the newest keystrokes.
Large type, visible keyboard focus, semantic controls, and a high-contrast palette
are provided. Local editing and saving send nothing to an AI provider. Optional
drafting questions send only the explicitly previewed payload when you choose Send.

The writing bar shows scene and background manuscript word counts, excluding opening frontmatter. The adjustable daily goal starts at 1,000 words. Daily growth credit counts words above each scene’s earlier peak, using this computer’s local date; deleting text preserves credit, while undo/redo, recovery, and retyping to the same peak earn none. Rewrites below an earlier peak, complex replacements, and multi-cursor edits may be undercounted. Progress stays on this device. Optional synthesized typewriter sounds start off each launch.

Recent folders persist locally in the OS application-data directory, in
`recent-folders-v1.json`. Only folders previously picked in this native host may
be reopened through an opaque recent ID. Missing folders give an error; use Open
folder to locate their new location. The renderer cannot submit an arbitrary root.
No Git commit, pull, checkout or push is performed.

## Layout and keyboard

The page fills the window. Everything else floats: a status pill at the top
(project, scene, word count, save state, daily goal, proposals), the file browser,
manuscript outline, and scene passages in one tabbed navigation drawer on the left (Cmd/Ctrl+\
opens or closes it; Left/Right and Home/End switch tabs, Escape closes the drawer),
and Questions as a card docked right while the page stays full width behind it.
Hover over the Manuscript tab while dragging a repository file to reveal its
existing import targets; imports still require their usual preview and confirmation.
The pill fades while you type and returns when the pointer moves.

- **Cmd/Ctrl+K** jumps to a scene, **Cmd/Ctrl+P** browses files and
  **Cmd/Ctrl+Shift+P** lists every command. Type `/` or `>` to switch scope, Tab
  cycles scopes, and Alt+↑/↓ reorders the highlighted ms/ scene through the usual
  previewed change.
- **Cmd/Ctrl+Shift+F** opens Find in manuscript, also available in the outline
  and command palette. Search literal text across the selected manuscript, with
  optional case matching. Results include the current unsaved buffer and saved
  text in other scenes. Click a result to select its exact passage; changed
  snapshots require a new search. Search is local, cancelable and bounded, with
  skipped scenes and partial results reported. **Cmd/Ctrl+F** still finds within
  the current scene. See [the search contract](../docs/architecture/studio-manuscript-search.md).
- **Cmd/Ctrl+J** captures the highlighted passage into Questions, or opens and
  closes Questions when nothing is highlighted. Highlighting text also shows a
  small toolbar: Ask Heinlein, Suggest revision, and the selection's word count.
  Nothing is sent until you press Send.
- **Cmd/Ctrl+,** opens Appearance: four themes (Arcades, Midnight, Paper, High
  contrast), four accents, interface/text/monospace fonts with one-click presets
  (including Courier New), text size, line width, line spacing, fading chrome, and
  dimming all but the current paragraph. Changes apply instantly and are saved on
  this device. Lora, Inter, JetBrains Mono, Atkinson Hyperlegible and OpenDyslexic
  ship with Studio, so they work offline.
- **Cmd/Ctrl+/** or **?** shows every shortcut.

## Local MCP proposals

The **MCP proposals** button lists pending proposals for the selected repository
and attributed local operation receipts. Save and resolve recovery first. Review
the full before/after source, then explicitly confirm the retained change in a
separate native dialog. MCP itself can only read explicitly selected persisted
scenes and propose changes; it cannot write or approve a draft. No client is
installed or configured automatically.

Completed applies have a source-hash-guarded **Review revert** in the current Studio
session. Reverts retain the original receipt. Interrupted or uncertain operations
stop for inspection rather than replaying, and receipt JSON cannot recreate revert
authority after restart. Client/session labels remain explicitly unverified;
these records are not a complete authenticated revision ledger or release approval.

See [the local proposal contract and verification limits](../docs/architecture/studio-local-proposals.md)
and [explicit MCP server launch instructions](crates/local-mcp/README.md).

## Drafting in ms/

Choose **ms drafting**, then **Create ms manuscript** to start an explicit local
manuscript. **New scene** creates Markdown under `ms/` and opens it for writing.
The ordered pane uses stable scene IDs in `ms/manuscript.json`; reorder with drag
or the keyboard-accessible move controls without renaming files. Optional groups
and nested scene folders are supported.

**Import files…** copies individually selected Markdown files from the native
picker; native file drops use the same host-authorized copy flow. **Import
repository files…** or repository dragging moves eligible Markdown files into ms.
Every structural change has a preview and guarded Undo. Save/recovery must settle
first. External file changes invalidate stale previews and undo operations.

To draft an existing legacy piece, use **Copy legacy scenes…**. These are explicit
independent copies: the old manuscript is unchanged and the two do not synchronize.
Moving files referenced by a legacy manifest is blocked. Opening a folder never
migrates or rearranges your archive.

Directory-tree imports and asset migration are deferred. Recognized relative
asset references block directory-changing operations so their bytes are not
silently rewritten or their references knowingly broken. Incoming links elsewhere
still need author review after path changes. Export and publication are deferred.

## Tests

```sh
npm test
npm run build
cargo test -p repository-core -p github-workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

The core tests run without GTK/WebKit. The full workspace/native host requires
platform desktop dependencies. CI checks both macOS and Linux compilation.
A passing mocked renderer test does **not** establish native picker behavior,
macOS accessibility, or physical keyboard/screen-reader behavior.

## Boundaries

See [pass 3](../docs/architecture/studio-pass-3.md), [pass 2](../docs/architecture/studio-pass-2.md) and [the pass-1 decision](../docs/architecture/studio-pass-1.md). There is no
agent draft-write grant, publication command, or release machinery in this milestone.
The separate local MCP server supports bounded read/proposal operations only. Local editing does not implement the
future authenticated author-command protocol. Windows fails closed pending a
handle-based filesystem implementation and equivalent tests.

## Ask about a selection

Highlight one passage in an editable scene and choose **Ask about selection**.
This separate dialog prepares a question for manual copy/paste into ChatGPT and
sends nothing automatically. For connected, read-only Q&A, use the Questions panel below. Optional nearby context
starts off and is previewed before copying. You can paste a proposed replacement,
review it, and explicitly apply it to the working draft. Changed text, selection,
scene, recovery or session state prevents stale application. The regular local
save/recovery path handles an accepted edit.

See [the selection-question contract](../docs/architecture/studio-selection-question.md)
for exact anchors, clipboard considerations and integration limits.

## Drafting questions with ChatGPT

Highlight a passage and choose the contextual **Ask Heinlein** button to open the
**Questions** side panel with that exact selection captured. This prepares your
question; it does not send it. The panel also opens from the toolbar without
sharing any manuscript context. Choose
**Continue with ChatGPT**, review the plan-use permission in your system browser,
and choose a model available to that account. Model availability and plan eligibility
are determined by OpenAI; Heinlein does not silently switch to API-key billing.

Context starts empty. Capture a selection or the current scene only when you want
to include it, inspect the exact context/history preview, then choose **Send to
OpenAI**. You can keep writing and saving while the answer is pending. Ask returns
advice. Choose **Suggest revision** explicitly for a proposed edit to a clean saved
selection. Review the exact pending proposal, then accept through native confirmation
or reject it. Changed source or dirty/recovery conflicts block application. Accepted
changes keep attributed receipts and the existing guarded, same-session revert.

Sign-in and model transport live in the native host. No credential belongs in the
renderer, repository, chat transcript or browser storage. Development tests are
mocked; complete sign-in and a real question locally to verify your account.
Protected account storage currently supports macOS and Linux; other platforms
reject connection until an equivalent secure storage implementation is available.
See [drafting question boundaries](../docs/architecture/studio-drafting-questions.md).

## Vibecode your theme

Open **Appearance → Vibecode theme**. Describe the aesthetic, review the exact
outgoing prompt, and choose **Generate theme candidate**. Generation uses the
account/model explicitly selected in Questions and its plan allowance. Nothing
from the manuscript, selection, or conversation is included. There are no
automatic retries, model/account changes, or billing fallbacks. Connection and
empty-answer failures remain visible; issue [#22](https://github.com/Arcadesys/heinlein/issues/22)
has separate live/native acceptance requirements.

The agent returns nine opaque colour tokens and a bounded corner radius, rather
than executable CSS. Each text/status/accent colour must reach 4.5:1 against all
three backgrounds; borders must reach 3:1. The accent is the focus ring. Studio
chooses black or white primary-button text for contrast. It derives a neutral
selection fill with 3:1 contrast against the backgrounds and 4.5:1 for selected
text; palettes without room for both are rejected. Fonts, type size,
spacing, selectors, layout, logic and content cannot be changed by these tokens.
URLs, imports, arbitrary CSS, alpha colours, and additional fields are rejected.
The sample shows controls, disabled/hover/selection states, secondary text and
status colours. Review its scoped CSS and the accepted-to-candidate token diff.

**Apply theme** saves the accepted theme and its previous value together on this
device. Candidates stay in memory and are discarded on close. **Discard candidate**
keeps the accepted theme. **Revert accepted theme** swaps the saved current and
previous theme; **Reset to baseline** restores the selected built-in preset,
without changing fonts, zoom or manuscript text. Choosing a built-in theme/accent
also leaves the custom theme. A storage error leaves the accepted theme unchanged
and keeps the candidate reviewable; stale writes or preset selections from another window are visibly rejected.
Corrupt saved themes fall back to the built-in preset with a repair message.
Aesthetic descriptions and provider responses are not stored with accepted themes.

You can also give another coding agent the exact prompt, then paste its JSON
under **Use another coding agent**. Pasted output goes through the same validation
and explicit preview/apply flow. No raw agent CSS is executed.

### Repeatable browser checks

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:theme:browser
```

This feature smoke runs real Chromium at 1280px and 320px, checks keyboard focus,
axe contrast/semantics, sample/control states, candidate isolation, apply/revert/
reset, reload persistence, provider failure and storage failure. It also opens the
normal renderer. Generation checks use an explicitly labeled synthetic provider
in `tests/browser/fixture.html`, with the real Studio/theme implementation and
synthetic prose. That fixture has no credentials, native filesystem or paid calls
and is not part of the production build. It is not evidence of live agent answers,
native WebKit persistence, screen-reader acceptance or resolution of issue #22.

## Heinlein Review

Choose **Heinlein Review** in a source scene or mapped assembled chapter. Choose
editable sources versus read-only context, one to three reviewer instances and
optional author notes, then **Preview reviewer batch**. **Run Heinlein Review**
uses only your selected ChatGPT account/model, at most eight serial calls per
explicit batch. Continue explicitly for remaining coverage; partial results stay
available. Combined selected context is bounded to 1 MiB and 128 windows, with no
silent truncation or automatic retry.

The consolidated versioned JSON contains exact prepared patches, comments,
locations, immutable reviewer snapshots, coverage and decisions. **Approve…**
applies an exact patch only after the existing native final confirmation. Choose
conflicting alternatives explicitly; unrelated suggestions remain usable after
approved byte shifts. **Reject edit** persists before dismissal, including across
reopen/restart/regenerated duplicates. Saved review reload never runs providers.
See [the review contract](../docs/architecture/studio-heinlein-review.md) for
limits, lineage, source safety and synthetic versus native/live evidence.
