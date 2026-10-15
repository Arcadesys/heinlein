# Heinlein Studio: repository browser (pass 1)

An additive **read-only** native desktop foundation. Open a local checkout or
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
Generated compatibility sources are labeled. Every preview is read-only.
Large type, visible keyboard focus, semantic controls, and a high-contrast palette
are provided. Nothing is sent to an AI provider or remote service.

Recent folders persist locally in the OS application-data directory, in
`recent-folders-v1.json`. Only folders previously picked in this native host may
be reopened through an opaque recent ID. Missing folders give an error; use Open
folder to locate their new location. The renderer cannot submit an arbitrary root.
No Git commit, pull, checkout or push is performed.

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

See [the pass-1 decision](../docs/architecture/studio-pass-1.md). There is no
editor, autosave, agent grant, approval, publication command, MCP server, or
release machinery in this milestone. Read-only browsing does not implement the
future authenticated author-command protocol. Windows fails closed pending a
handle-based filesystem implementation and equivalent tests.
