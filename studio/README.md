# Heinlein Studio: local manuscript drafting

An additive native desktop editor with local autosave and explicit recovery decisions. Open a local checkout or
folder, browse its files, and use a scene manifest to navigate the manuscript.
The existing Python publisher and its CLI remain unchanged.

## Markdown Reading

Use **Reading** beside **Source** to read formatted Markdown in project documents
or standalone drafts. Reading includes your current unsaved text; returning to
Source keeps your selection and undo history. Switching views does not save or
change the manuscript. Headings, emphasis, lists, quotes, links and code are
rendered with your writing appearance settings. Link destinations appear as text,
embedded images are not loaded, and raw HTML stays literal. Frontmatter remains
available in Source. Resolve any pending recovery in Source first.

## Preferences and daily progress

The daily counter stays directly available in the writing header. Its width is
reserved so growing counts do not move or resize the writer; large counts use a
compact display with exact totals in the accessible label and tooltip.

Native Studio loads preferences before mounting the editor. Appearance, fonts,
zoom, navigation, accepted custom themes, the daily target/progress and sound
choice/volume live in one versioned `preferences-v1.json` in Tauri's app-config
directory (on macOS, `~/Library/Application Support/me.thearcades.heinlein.studio/`).
Using one atomic envelope keeps the initial target and progress migration together.
The stable production bundle identifier must be retained when packaging updates.

The first launch imports only allowlisted settings from the current WebKit
profile; existing native values win. It retains the original payloads for recovery
and leaves WebKit records untouched. Writes use an OS lock, revision checks,
atomic replacement, fsync and a previous-file backup. Unreadable/future native
schemas are preserved and shown as a loading error. Failed writes stay pending,
are visibly reported, and can be retried. Closing waits for settings writes or
requires an explicit choice to close with the last saved settings after writing
has passed its existing save guards. Sound resumes after a user keypress; saved
sound preferences do not imply audio is already playing.

Browser previews continue to use localStorage. Development/RC profiles remain
separate; this migration does not guess between conflicting historical profiles.
Manuscripts, project stores, recovery, credentials, conversations and review agents
retain their existing separate stores. Preferences do not provide cross-device sync.
Native builds require Rust 1.89 or newer for OS-backed file locking.

## 1.8 release packaging

Heinlein Studio is version **1.8.0**. The independent Python
publisher remains at **0.1.0**.

On an Apple Silicon Mac, build the version-pinned app with:

```sh
cd studio
npm ci
OPENSSL_STATIC=1 npm run tauri build -- --config src-tauri/tauri.release.conf.json --bundles app --ci
```

This produces **Heinlein Studio.app**, using the stable identifier
`me.thearcades.heinlein.studio`. Release downloads include an app ZIP and a DMG.
Both contain the same self-contained app; it does not fetch or rebuild moving
main when launched. The older RC1 app uses a separate profile and identifier.

Quit every other copy of Heinlein Studio before opening the downloaded app.
Expand the ZIP, or open the DMG and copy the app to Applications. Existing managed
source-update installations in `~/Applications` should use their own updater
instead of replacing their launcher with the standalone release app. The fixed
release app does not include that source-update launcher.

Standalone apps check published GitHub releases shortly after launch and hourly
while visible. **Update available…** or **Update needs attention…** appears without
changing the manuscript layout or keyboard focus. **Heinlein Studio → Check for
Updates…** also checks explicitly. Release downloads are installed manually after
saving and quitting; unpublished source changes are not release updates. Managed
source installations retain their separate source check and next-launch updater.

The build is ARM64 for Apple Silicon, ad-hoc signed, and not notarized or signed
with a Developer ID certificate. The declared packaging minimum is macOS 11;
older macOS runtime compatibility is not verified. No Intel, Linux or Windows
installer is included. Verify `SHA256SUMS` before opening a download. macOS may
require **Open Anyway** in **System Settings → Privacy & Security**.

Publisher wheel/source assets are separate from the app. Install the wheel in a
Python 3.11+ virtual environment. Python dependencies, Pandoc, and Chrome (for PDF)
are external prerequisites. Publisher source archives contain code, templates,
and package metadata; they exclude manuscripts, examples, credentials, and app
profiles. Release notes and the release manifest identify source provenance,
checks, and remaining runtime limits.

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

macOS is the current validation target. Install Node.js 22+, stable Rust
(1.90+), and the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
including Xcode command-line tools. Linux code paths remain, but Ubuntu
compilation and runtime behavior are no longer validated.

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

On relaunch, Studio reopens the last project and its last editable source document,
with the saved cursor/selection, scroll position, and Source or Reading view.
Position metadata stays in the local project library and is flushed on native
close. Folder identity, source hash, scene identity, and recovery checks still
apply: changed or missing writing opens the project overview with a message;
an unavailable project leaves drafts and Projects usable. Earlier libraries
without a recorded last project keep the existing drafts startup. Closing from
standalone writing returns to drafts, retaining project positions for later.

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

**More actions → MCP connection…** lets you explicitly allow the current saved
source file for a reusable local MCP connection. Review the full file list in
the native confirmation. Add files individually; allowing a source from another
project replaces the selection. **Disconnect all project access** stops reads
and proposals. Project opening alone grants nothing, and unsaved buffers remain
private. Configure Codex once with the server's `--studio-selection` launch mode;
the same running server follows confirmed project changes and invalidates old
snapshots. See the launch instructions below for the one-time setup.

The **Revisions** button lists external proposals, saved in-app suggestions,
and decision history for the selected repository. Save and resolve recovery
first. Inspect the displayed diff, then choose **Accept** once to apply it.
**Details** opens optional scene context. Changed comparisons must be refreshed
and accepted again; guarded revert retains its separate native confirmation. MCP itself can only read explicitly selected persisted
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
still need author review after path changes. Publication is deferred.

**Export manuscript…** is a visible button in the Library header, the first
project action, and a command-palette entry. It opens one dialog for PDF, EPUB,
Markdown, HTML and DOCX. Group/folder actions use the same dialog with an explicit
scope label. Reference sheets are excluded by default and can be included with a
checkbox. Native legacy reading order is preserved even when the host supplies a
synthesized Library tree. Indexed folder sheets follow that same order.

The dialog captures current editor text, adds headings and omits per-sheet YAML.
Its optional author field supplies the export byline. It writes a new file outside
the source project; existing files are never replaced. No source edits or automatic
uploads occur. Conversion failures and canceled location pickers leave a retryable
dialog. Local image attachments are not bundled in this version.

Markdown requires no converter. Other formats use the bundled Heinlein publishing
adapter plus a locally installed Python runtime with Heinlein's dependencies and
Pandoc; PDF also requires Chrome/Chromium. The adapter reuses the existing Pandoc
and EPUB/DOCX writers and the Chrome PDF renderer, using plain manuscript styling
without publication branding or colophon pages. Chrome runs with a disposable
profile; conversions are staged privately and bounded to three minutes. Missing
converters produce an actionable error before a destination file is created.

For an isolated review build (separate application identity and user-data profile):

```sh
OPENSSL_STATIC=1 CARGO_NET_OFFLINE=true npm run tauri build -- --config src-tauri/tauri.export-preview.conf.json --bundles app --ci
```

This builds **Heinlein Studio Export Preview.app** without replacing the installed
app or importing its project/account lists. Production release configuration also
bundles the publishing adapter but retains the stable production identifier.

## Tests

```sh
npm test
npm run build
cargo test -p repository-core -p github-workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

The core tests run without GTK/WebKit. The full workspace/native host requires
platform desktop dependencies. Validation now focuses on macOS; the automatic
security-boundary job and manual hosted fallback builds target macOS only.
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
selection. Review the exact pending proposal, then choose Accept
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
npm run test:browser:smoke
# Full acceptance before merging a pull request (also available on demand):
npm run test:browser:full
```

Local validation is the default for renderer tests, builds, native lint, and
publishing. From the repository root, run `python3 tools/validate.py quick` for
renderer/build/smoke or `python3 tools/validate.py studio` for full local Studio
validation. See [the local validation runbook](../docs/testing/local-validation.md)
for prerequisites, suites, publishing goldens, and platform limits.

Full browser acceptance runs locally before pushing. The macOS hosted browser
job is an explicit manual fallback for platform comparisons. An automatic
macOS boundary-regression job preserves auth/updater/MCP/native question/proposal/
review checks. The complete macOS native build job and publishing workflow
are also manual hosted fallbacks; pushes to `main` do not repeat them. New PR
pushes cancel obsolete boundary runs. `test:theme:browser` remains an alias for
the full suite. GitHub no longer enforces browser results before merge; record
local acceptance evidence with the pull request.

The full suite includes theme checks in real Chromium at 1280px and 320px: keyboard focus,
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
locations, immutable reviewer snapshots, coverage and decisions. **Approve this change…**
applies an exact patch only after the existing native final confirmation. Choose
conflicting alternatives explicitly; unrelated suggestions remain usable after
approved byte shifts. **Reject this change** persists before dismissal, including across
reopen/restart/regenerated duplicates. Saved review reload never runs providers.
See [the review contract](../docs/architecture/studio-heinlein-review.md) for
limits, lineage, source safety and synthetic versus native/live evidence.

Markdown files and assembled chapters have an explicit **Source / Reading** control,
defaulting to Source for the session. Reading formats the current text from the one
writer, using the Markdown parser the editor already ships. Raw HTML stays literal,
code never runs, images are not loaded, links do not navigate and unsafe link schemes
are labelled. Waiting review suggestions stay clickable where their exact source text is
visible; suggestions that change only markup get a **Formatting suggestion** button.
Reading has no editing selection, so Ask, Split, Undo, Redo and Find need Source. It is
bounded to 2 MiB, shows entities literally, and is not a full CommonMark renderer. Saved
references have the same control, with no suggestions or writing authority. Reading is
separate from AI answer rendering, whose links are active: manuscript text is the
author's, so Reading keeps exact source positions and never navigates.

### Open a GitHub repository

Use **Open from GitHub…** in Repository navigation (or **Choose a GitHub repository…** on the welcome page). Heinlein manages the working files on this Mac. Recent GitHub repositories reopen by their native registry identity, including offline; no local folder picker or clone path is required. **Local folders** and standalone **Drafts** remain separate.

**Saved on this Mac** acknowledges local preservation only. Save a version, review the exact files, and explicitly choose **Send** to share changes. Send history is labelled as history, never a fresh server or whole-folder synchronization check. Pending/recovery/unknown states do not imply sharing succeeded. Branch, PR and native confirmation guards remain in effect; in-app Merge remains unavailable without the existing policy proof.

Send to GitHub is a separate, explicit action beside the active repository status. It can save an exact-file local version internally, then asks for native confirmation before uploading all unsent versions. Earlier unsent files are included in the preview even when not selected for the new version. Local autosave never sends; failed or uncertain uploads retain local work and require explicit recovery/reconciliation.

AI answers and review comments render Markdown headings, emphasis, lists, quotations, code, tables, and links. Raw HTML remains visible text; embedded images show their description without fetching an image. Only HTTP, HTTPS, and email links are active. Questions, manuscript editors, context snapshots, and proposed replacement comparisons retain their exact source text.

ChatGPT connection persistence: native OAuth access/refresh/ID tokens and the
refresh replay guard are stored in macOS Keychain (Linux: Secret Service) under
`me.thearcades.heinlein.studio.chatgpt`, scoped to a hash of the stable native
auth-directory path. Non-secret registrations, account/model choices and host
identity remain in private app-data `chatgpt-auth/auth.json`. A locked one-time
migration verifies the vault write before sanitizing the old JSON. Vault failure
leaves the legacy file intact and fails closed; no plaintext fallback is used.
Migrated metadata uses schema 2 so older clients refuse it rather than overwriting
the vault-backed profile on downgrade. Back up private app-data before downgrading;
older app versions cannot use these securely stored sessions.
An interrupted cleanup uses the newer vault state, never the old refresh token.
Keep the bundle identifier, app-data path and signing identity stable across
updates. Keychain prompts/access continuity require validation with the signed
release app; synthetic tests do not exercise the user's actual Keychain.

Opening ChatGPT questions or Review restores an existing authorized connection
and verifies the saved model catalog once per process. This does not sign in,
choose a replacement model, clear usage limits or send manuscript text. Offline
or unavailable models keep Send disabled; explicit Recheck can recover.

Review workflow chunks retry transport interruptions/timeouts and transient
server failures up to three attempts with cancellation-aware backoff. Successful
chunks are persisted once and not resent. Quota/auth/invalid-output failures do
not automatically retry. After exhaustion, **Retry failed chunks** continues the
same saved review, preserving completed results. Interrupted or cancelled chunks
can resume explicitly after reopening. Any continuation requires unchanged captured
source/context, so finish remaining batches before applying suggestions. Ambiguous transport failures and retries may incur additional
plan usage. Nothing is automatically applied to manuscript files.
