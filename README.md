# Heinlein

Insert Coin's publishing pipeline. Markdown manuscript in, PDF / EPUB / DOCX / HTML / plain text out — all branded in the **Insert Coin** imprint design system.

Named after Heinlein because it's the publishing machine for fiction.

## Install

Requires Python 3.11+, [pandoc](https://pandoc.org), and Google Chrome (for PDF).

```sh
git clone <this repo> ~/code/heinlein
cd ~/code/heinlein
uv tool install -e .
```

`heinlein` is now on your `PATH`.

## Usage

### One-shot from a manuscript

```sh
heinlein build path/to/manuscript.md --output ./dist --formats pdf,epub
```

The manuscript needs YAML frontmatter:

```yaml
---
title: La Ligne du Marais
subtitle: A Halloween story
author: Austen Tucker
cover: cover.jpg          # relative to the manuscript
genre: short fiction / horror
---

# La Ligne du Marais

*by Austen Tucker*

Tuck spent a month in Paris…
```

The leading `# Title` and `*by Author*` lines get stripped — they're rebuilt on the title page.

### Project mode

Drop a `heinlein.yaml` next to your manuscript:

```yaml
manuscript: manuscript.md
cover: cover.jpg
imprint: insert-coin
page:
  size: digest             # digest=5.5x8.5, trade=6x9, mass=4.25x6.87
  margins: { top: 0.85in, side: 0.7in }
metadata:
  rights: "© 2026 Austen Tucker. All rights reserved."
  publisher: "Insert Coin (a fiction imprint of The Arcades)"
  language: en-US
  cover_eyebrow: "Insert Coin · Issue 01 · 2026"
formats: [pdf, epub, docx, html, text]
output: dist/
```

Then:

```sh
cd path/to/project && heinlein build
```

### Flags

| flag                | default     | meaning                                            |
| ------------------- | ----------- | -------------------------------------------------- |
| `--output, -o`      | `./dist`    | Output directory.                                  |
| `--formats, -f`     | `all`       | Comma list of `pdf,epub,docx,html,text` or `all`.  |
| `--debug-html`      | off         | Keep the rendered `print.html` next to the PDF.    |
| `--config`          | auto-find   | Explicit path to a `heinlein.yaml`.                |

### Preview server

```sh
cd path/to/project && heinlein serve
```

Runs a local server (default `http://127.0.0.1:8765`) with:

- **Gallery** at `/` — current project + every archived project with per-format download links.
- **Live preview** at `/preview` — the HTML output in an iframe. Edits to `manuscript.md`, the cover, or `heinlein.yaml` trigger a rebuild and the iframe reloads automatically (SSE).

Add an `archive:` line to `heinlein.yaml` (or pass `--archive PATH`) pointing at a parent directory of past builds — each subdirectory is shown as a card with download links for whatever PDF/EPUB/DOCX/HTML/text artifacts are present.

| flag             | default     | meaning                                   |
| ---------------- | ----------- | ----------------------------------------- |
| `--archive PATH` | unset       | Parent directory of archived projects.    |
| `--port`         | `8765`      | Bind port.                                |
| `--host`         | `127.0.0.1` | Bind host (warns on non-loopback).        |
| `--no-open`      | off         | Don't open the gallery in a browser.      |
| `--no-build`     | off         | Skip the initial build on startup.        |

## Design tokens

The Insert Coin design system is the source of truth for colours and typography. Tokens live in `heinlein/templates/tokens.css`. To re-sync from the design-system HTML:

```sh
python -m heinlein.scripts.sync_design_tokens \
       --source ~/Downloads/Insert\ Coin\ Design\ System.html
```

## Tests

```sh
uv run pytest
```

The full pipeline test runs only when both `pandoc` and Chrome are present.

## What it doesn't do (yet)

- MOBI/AZW3 (kindlegen is deprecated; skip).
- Cover image generation.
- Multi-title catalog mode.
- Imprints other than Insert Coin.
