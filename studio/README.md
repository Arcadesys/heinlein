# Heinlein Studio: local manuscript drafting

An additive native desktop editor with local autosave and explicit recovery decisions. Open a local checkout or
folder, browse its files, and use a scene manifest to navigate the manuscript.
The existing Python publisher and its CLI remain unchanged.

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
This milestone does not install, sign, distribute, or auto-update the app.
`npm run dev` alone serves the renderer for development; a normal browser has
no repository access and displays a native-app requirement.

## Use

Choose **Open folder** using the operating system's native folder picker. Select
your existing `writing-archive` checkout (or the Singularity Log project folder).
The File tree preserves normal directory navigation. The Manuscript view lists
supported `scene-manifest.json` files and uses manifest array order, including
volumes, chapters and scenes. Version 1 of the writing-archive scene manifest is
supported. Unsupported or invalid manifests produce an error, never a migration.

Click a document to preview its exact UTF-8 source. YAML frontmatter is shown
separately as source metadata, without parsing/reformatting it or executing tags.
Markdown scenes open in a plain-source editor with Undo, Redo, Find and explicit Save (Cmd/Ctrl+S). Generated compatibility sources remain read-only. Edits schedule local autosave after a short idle interval; Save (Cmd/Ctrl+S) flushes it immediately. Each manuscript save first stages a durable recovery snapshot. Unsaved changes prompt before navigation and close. Conflicts and write errors retain your buffer. Reopening an interrupted scene offers Restore or Discard, with both the recovery draft and current disk text available for comparison. A crash before a snapshot completes can still lose the newest keystrokes.
Large type, visible keyboard focus, semantic controls, and a high-contrast palette
are provided. Nothing is sent to an AI provider or remote service.

The writing bar shows scene and background manuscript word counts, excluding opening frontmatter. The adjustable daily goal starts at 1,000 words. Daily growth credit counts words above each scene’s earlier peak, using this computer’s local date; deleting text preserves credit, while undo/redo, recovery, and retyping to the same peak earn none. Rewrites below an earlier peak, complex replacements, and multi-cursor edits may be undercounted. Progress stays on this device. Optional synthesized typewriter sounds start off each launch.

Recent folders persist locally in the OS application-data directory, in
`recent-folders-v1.json`. Only folders previously picked in this native host may
be reopened through an opaque recent ID. Missing folders give an error; use Open
folder to locate their new location. The renderer cannot submit an arbitrary root.
No Git commit, pull, checkout or push is performed.

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
cargo test -p repository-core
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

The core tests run without GTK/WebKit. The full workspace/native host requires
platform desktop dependencies. CI checks both macOS and Linux compilation.
A passing mocked renderer test does **not** establish native picker behavior,
macOS accessibility, or physical keyboard/screen-reader behavior.

## Boundaries

See [pass 3](../docs/architecture/studio-pass-3.md), [pass 2](../docs/architecture/studio-pass-2.md) and [the pass-1 decision](../docs/architecture/studio-pass-1.md). There is no
agent grant, publication command, MCP server, or
release machinery in this milestone. Local editing does not implement the
future authenticated author-command protocol. Windows fails closed pending a
handle-based filesystem implementation and equivalent tests.

## Ask about a selection

Highlight one passage in an editable scene and choose **Ask about selection**.
The dialog prepares a question for manual copy/paste into ChatGPT; it has no
connected AI provider and sends nothing automatically. Optional nearby context
starts off and is previewed before copying. You can paste a proposed replacement,
review it, and explicitly apply it to the working draft. Changed text, selection,
scene, recovery or session state prevents stale application. The regular local
save/recovery path handles an accepted edit.

See [the selection-question contract](../docs/architecture/studio-selection-question.md)
for exact anchors, clipboard considerations and integration limits.
