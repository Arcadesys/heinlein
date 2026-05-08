"""Orchestrator: read manuscript + config, dispatch to output backends."""
from __future__ import annotations

import re
from importlib.resources import files
from pathlib import Path
from typing import Any

from heinlein import frontmatter, pandoc
from heinlein.config import HeinleinConfig
from heinlein.outputs import docx as out_docx
from heinlein.outputs import epub as out_epub
from heinlein.outputs import html as out_html
from heinlein.outputs import pdf as out_pdf
from heinlein.outputs import text as out_text

# Insert Coin imprint defaults — used in cover/colophon/end pages.
INSERT_COIN_DEFAULTS = {
    "imprint_name": "Insert Coin",
    "imprint_tagline": "short fiction",
    "imprint_tagline_long": "Pay one coin. Get one story.",
    "imprint_blurb": "A fiction imprint of The Arcades.",
    "imprint_url": "insertcoin.thearcades.me",
}


def _templates_dir() -> Path:
    return Path(str(files("heinlein").joinpath("templates")))


def _slug(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "manuscript"


def _title_html(title: str) -> str:
    """The cover/title-page break the title across two lines on whitespace.
       For multi-word titles, split at the midpoint word boundary."""
    words = title.split()
    if len(words) <= 1:
        return title
    mid = len(words) // 2
    if len(words) % 2:
        mid += 1
    first = " ".join(words[:mid])
    rest = " ".join(words[mid:])
    return f"{first}<br>{rest}"


def _colophon_lines(front: dict[str, Any], cfg_meta: dict[str, Any], title: str, author: str) -> list[str]:
    override = cfg_meta.get("colophon")
    if override:
        if isinstance(override, str):
            return [override]
        return [str(line) for line in override]

    rights = cfg_meta.get("rights") or f"“{title}” © {author}. All rights reserved."
    return [
        rights,
        "Set in Lora, Inter, and JetBrains Mono. Designed for screen and small format.",
    ]


def build(cfg: HeinleinConfig, *, debug_dir: Path | None = None) -> dict[str, Path]:
    """Run the pipeline. Returns {format: output_path} for each format that was built."""
    cfg.output.mkdir(parents=True, exist_ok=True)

    front, body_md = frontmatter.parse_file(cfg.manuscript)
    body_md = frontmatter.strip_title_block(body_md)

    cover = cfg.cover
    if cover is None and front.get("cover"):
        cover = (cfg.manuscript.parent / front["cover"]).resolve()

    title = front.get("title", cfg.manuscript.stem)
    subtitle = front.get("subtitle", "") or ""
    author = front.get("author", "") or cfg.metadata.get("author", "") or ""
    genre = front.get("genre", "") or ""
    language = cfg.metadata.get("language", "en-US")
    slug = _slug(title)

    templates = _templates_dir()
    tokens_css = (templates / "tokens.css").read_text(encoding="utf-8")

    # HTML body for the print template (drop-cap markup applied)
    body_html = pandoc.md_to_html(body_md)
    body_html = body_html.replace("<p>", '<p class="first">', 1)

    pdf_ctx = {
        "templates_dir": templates,
        "title": title,
        "title_html": _title_html(title),
        "subtitle": subtitle,
        "author": author,
        "genre": genre,
        "language": language,
        "page_w": cfg.page.width_in,
        "page_h": cfg.page.height_in,
        "margin_top": cfg.page.margin_top,
        "margin_side": cfg.page.margin_side,
        "cover_eyebrow": _cover_eyebrow(cfg.metadata),
        "cover_uri": cover.as_uri() if cover else None,
        "imprint_name": INSERT_COIN_DEFAULTS["imprint_name"],
        "imprint_tagline": INSERT_COIN_DEFAULTS["imprint_tagline"],
        "imprint_tagline_long": INSERT_COIN_DEFAULTS["imprint_tagline_long"],
        "imprint_blurb": INSERT_COIN_DEFAULTS["imprint_blurb"],
        "imprint_url": INSERT_COIN_DEFAULTS["imprint_url"],
        "colophon_lines": _colophon_lines(front, cfg.metadata, title, author),
        "body_html": body_html,
        "tokens_css": tokens_css,
    }

    results: dict[str, Path] = {}

    if "pdf" in cfg.formats:
        out = cfg.output / f"{slug}.pdf"
        out_pdf.build(ctx=pdf_ctx, output=out, debug_dir=debug_dir)
        results["pdf"] = out

    if "epub" in cfg.formats:
        out = cfg.output / f"{slug}.epub"
        out_epub.build(
            body_md=_epub_body(body_md, title, author),
            front=front,
            cfg_meta=cfg.metadata,
            cover=cover,
            css=templates / "epub.css",
            output=out,
        )
        results["epub"] = out

    resource_path = cover.parent if cover else None

    if "docx" in cfg.formats:
        out = cfg.output / f"{slug}.docx"
        out_docx.build(
            body_md=_docx_body(body_md, title, author, cover),
            output=out,
            resource_path=resource_path,
        )
        results["docx"] = out

    if "html" in cfg.formats:
        out = cfg.output / f"{slug}.html"
        out_html.build(
            body_md=_html_body(body_md, title, author, cover),
            template=templates / "html-preview.html.j2",
            output=out,
            resource_path=resource_path,
        )
        results["html"] = out

    if "text" in cfg.formats:
        out = cfg.output / f"{slug}.txt"
        out_text.build(body_md=body_md, output=out)
        results["text"] = out

    return results


def _cover_eyebrow(cfg_meta: dict[str, Any]) -> str:
    eyebrow = cfg_meta.get("cover_eyebrow")
    if eyebrow:
        return str(eyebrow)
    issue = cfg_meta.get("issue")
    year = cfg_meta.get("year") or cfg_meta.get("date") or ""
    parts = ["Insert Coin"]
    if issue:
        parts.append(f"Issue {issue}")
    if year:
        parts.append(str(year)[:4])
    return " · ".join(parts)


def _epub_body(body_md: str, title: str, author: str) -> str:
    """For pandoc EPUB/HTML, prepend the title + byline as a markdown H1 + italic
    so the EPUB has a nice opening (matches the prototype's source manuscript)."""
    return f"# {title}\n\n*by {author}*\n\n{body_md}"


def _html_body(body_md: str, title: str, author: str, cover: Path | None) -> str:
    """HTML preview gets the cover image as a hero up top, then title + byline."""
    if cover is None:
        return _epub_body(body_md, title, author)
    return (
        f'![{title} — cover]({cover.name})\n\n'
        f"# {title}\n\n*by {author}*\n\n{body_md}"
    )


def _docx_body(body_md: str, title: str, author: str, cover: Path | None) -> str:
    """DOCX gets the cover image first, then a page break, then title + byline."""
    if cover is None:
        return _epub_body(body_md, title, author)
    return (
        f'![{title} — cover]({cover.name})\n\n'
        '\\newpage\n\n'
        f"# {title}\n\n*by {author}*\n\n{body_md}"
    )
