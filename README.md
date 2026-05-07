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
