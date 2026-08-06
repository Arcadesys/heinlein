"""Orchestrator: read manuscript + config, dispatch to output backends."""
from __future__ import annotations

import re
import tempfile
from importlib.resources import files
from pathlib import Path
from typing import Any

from heinlein import frontmatter, pandoc, twine
from heinlein.config import HeinleinConfig
from heinlein.outputs import docx as out_docx
from heinlein.outputs import epub as out_epub
from heinlein.outputs import html as out_html
from heinlein.outputs import pdf as out_pdf
from heinlein.outputs import text as out_text

# FREE PLAY Publishing imprint defaults — used in cover/colophon/end pages.
FREE_PLAY_DEFAULTS = {
    "imprint_name": "FREE PLAY Publishing",
    "imprint_tagline": "short fiction",
    "imprint_tagline_long": "Pay one coin. Get one story.",
    "imprint_blurb": "A fiction imprint of The Arcades.",
    "imprint_url": "freeplay.thearcades.me",
}

# Imprint presets, selected by the `imprint:` slug in heinlein.yaml. Any field
# can be overridden per-project via the matching `metadata:` key.
IMPRINTS = {
    "free-play": FREE_PLAY_DEFAULTS,
    "insert-coin": {
        "imprint_name": "Insert Coin",
        "imprint_tagline": "fiction",
        "imprint_tagline_long": "Drop a coin. Fall into the story.",
        "imprint_blurb": "A fiction imprint of The Arcades.",
        "imprint_url": "thearcades.me",
    },
}


def _imprint(cfg: HeinleinConfig) -> dict[str, str]:
    """Resolve the imprint preset for this build, with metadata overrides."""
    resolved = dict(IMPRINTS.get(cfg.imprint, FREE_PLAY_DEFAULTS))
    for key in resolved:
        override = cfg.metadata.get(key)
        if override:
            resolved[key] = str(override)
    return resolved


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


def _colophon_intro(title: str, imprint_name: str, imprint_blurb: str) -> str:
    """Italic Lora intro line that opens the colophon — matches the design
    system's CopyrightPage."""
    blurb = imprint_blurb.rstrip(".")
    if blurb:
        blurb = blurb[0].lower() + blurb[1:]
    return (
        f"<em>{title}</em> is a publication of {imprint_name}, "
        f"{blurb}. Set in Lora and Inter. "
        "Designed and edited in Chicago."
    )


def _isbn_lines(cfg_meta: dict[str, Any]) -> list[str]:
    """ISBN block — accepts a string, list, or dict ({ebook, paperback})."""
    raw = cfg_meta.get("isbn")
    if not raw:
        return []
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, dict):
        out: list[str] = []
        for kind in ("ebook", "paperback", "hardcover"):
            if raw.get(kind):
                out.append(f"ISBN {raw[kind]} ({kind})")
        for k, v in raw.items():
            if k not in ("ebook", "paperback", "hardcover") and v:
                out.append(f"ISBN {v} ({k})")
        return out
    return [str(line) for line in raw]


def _issue_tag(cfg_meta: dict[str, Any]) -> str:
    """Bottom-of-colophon mono tag, e.g. "IC · 26 · 001". """
    year = str(cfg_meta.get("year") or cfg_meta.get("date") or "")[:4]
    yy = year[-2:] if len(year) >= 2 else ""
    issue = str(cfg_meta.get("issue") or "").strip()
    if issue:
        try:
            issue = f"{int(issue):03d}"
        except ValueError:
            pass
    parts = ["FP"]
    if yy:
        parts.append(yy)
    if issue:
        parts.append(issue)
    return " · ".join(parts)


def build(cfg: HeinleinConfig, *, debug_dir: Path | None = None) -> dict[str, Path]:
    """Run the pipeline. Returns {format: output_path} for each format that was built."""
    cfg.output.mkdir(parents=True, exist_ok=True)

    if cfg.source_format == "twine1":
        front, body_md = twine.load_twine1(
            cfg.manuscript,
            start=cfg.twine_start,
            exclude=cfg.twine_exclude,
            restart_label=cfg.twine_restart_label,
            back_label=cfg.twine_back_label,
        )
    else:
        front, body_md = frontmatter.parse_file(cfg.manuscript)
        body_md = frontmatter.strip_title_block(body_md)

    cover = cfg.cover
    if cover is None and front.get("cover"):
        cover = (cfg.manuscript.parent / front["cover"]).resolve()

    title = cfg.metadata.get("title") or front.get("title") or cfg.manuscript.stem
    subtitle = cfg.metadata.get("subtitle") or front.get("subtitle") or ""
    author = cfg.metadata.get("author") or front.get("author") or ""
    genre = front.get("genre", "") or ""
    language = cfg.metadata.get("language", "en-US")
    slug = _slug(title)
    imprint = _imprint(cfg)
    edition_front = {**front, "title": title, "author": author}

    templates = _templates_dir()
    tokens_css = (templates / "tokens.css").read_text(encoding="utf-8")
    accents_override = _accents_override_css(cfg.accents)
    if accents_override:
        tokens_css = tokens_css + "\n" + accents_override

    dedication_lines = _dedication_lines(front, cfg.metadata)

    # HTML body for the print template (drop-cap markup applied)
    body_html = pandoc.md_to_html(body_md)
    body_html = _mark_story_openers(body_html)

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
        "bleed_in": cfg.page.bleed_in,
        "sheet_w": cfg.page.width_in + 2 * cfg.page.bleed_in,
        "sheet_h": cfg.page.height_in + 2 * cfg.page.bleed_in,
        "margin_top": cfg.page.margin_top,
        "margin_side": cfg.page.margin_side,
        "cover_eyebrow": _cover_eyebrow(cfg.metadata, imprint["imprint_name"]),
        "cover_uri": cover.as_uri() if cover else None,
        "imprint_name": imprint["imprint_name"],
        "imprint_tagline": imprint["imprint_tagline"],
        "imprint_tagline_long": imprint["imprint_tagline_long"],
        "imprint_blurb": imprint["imprint_blurb"],
        "imprint_url": imprint["imprint_url"],
        "colophon_lines": _colophon_lines(front, cfg.metadata, title, author),
        "colophon_intro": _colophon_intro(title, imprint["imprint_name"], imprint["imprint_blurb"]),
        "isbn_lines": _isbn_lines(cfg.metadata),
        "issue_tag": _issue_tag(cfg.metadata),
        "dedication_lines": dedication_lines,
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
        epub_css = _epub_css_for(templates, cfg.accents)
        try:
            out_epub.build(
                body_md=_epub_body(body_md, title, author, dedication_lines),
                front=edition_front,
                cfg_meta=cfg.metadata,
                cover=cover,
                css=epub_css,
                output=out,
                lua_filter=templates / "mark_openers.lua",
                toc=cfg.chapters,
            )
        finally:
            if epub_css != templates / "epub.css":
                epub_css.unlink(missing_ok=True)
        results["epub"] = out

    resource_path = cover.parent if cover else None

    if "docx" in cfg.formats:
        out = cfg.output / f"{slug}.docx"
        out_docx.build(
            body_md=_docx_body(body_md, title, author, cover, dedication_lines),
            output=out,
            resource_path=resource_path,
            toc=cfg.chapters,
        )
        results["docx"] = out

    if "html" in cfg.formats:
        out = cfg.output / f"{slug}.html"
        include_header = _html_include_header(cfg.accents)
        try:
            out_html.build(
                body_md=_html_body(body_md, title, author, cover, dedication_lines),
                template=templates / "html-preview.html.j2",
                output=out,
                resource_path=resource_path,
                include_in_header=include_header,
                toc=cfg.chapters,
            )
        finally:
            if include_header is not None:
                include_header.unlink(missing_ok=True)
        results["html"] = out

    if "text" in cfg.formats:
        out = cfg.output / f"{slug}.txt"
        out_text.build(body_md=body_md, output=out)
        results["text"] = out

    return results


_OPENER_RE = re.compile(
    r"(<h2[^>]*>.*?</h2>\s*)<p\b(?![^>]*class=)([^>]*)>",
    flags=re.DOTALL | re.IGNORECASE,
)
_FIRST_P_RE = re.compile(r"<p\b([^>]*)>", flags=re.IGNORECASE)


def _mark_story_openers(body_html: str) -> str:
    """Tag the first <p> of each story with class="first" so it gets a drop cap.

    A story opener is the first <p> following any <h2>. Also tags the very
    first <p> of the body (the case where the manuscript opens with a story
    title or with prose directly), unless it already carries a class — so we
    don't clobber attributes pandoc may emit or double-tag a story opener
    that the H2 pass already handled. Any pre-existing attributes on the
    paragraph tag are preserved.
    """
    out = _OPENER_RE.sub(r'\1<p class="first"\2>', body_html)
    m = _FIRST_P_RE.search(out)
    if m and "class=" not in m.group(1):
        attrs = m.group(1)
        out = out[: m.start()] + f'<p class="first"{attrs}>' + out[m.end() :]
    return out


def _accents_override_css(accents: dict[str, str]) -> str:
    """Render an :root{} block that overrides token CSS variables.

    Keys are the variable names without the leading `--`. Values are any valid
    CSS color literal.
    """
    if not accents:
        return ""
    lines = [f"  --{k}: {v};" for k, v in accents.items()]
    return "/* per-project accent overrides */\n:root {\n" + "\n".join(lines) + "\n}\n"


def _epub_css_for(templates: Path, accents: dict[str, str]) -> Path:
    """Return a CSS path for the EPUB build, with accent overrides applied.

    If there are no overrides, returns the bundled epub.css path directly.
    Otherwise writes a temp file containing the base CSS plus an override block
    and returns its path — the caller is responsible for deleting it.
    """
    base = templates / "epub.css"
    if not accents:
        return base
    css = base.read_text(encoding="utf-8") + "\n" + _accents_override_css(accents)
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".css", delete=False, encoding="utf-8"
    )
    tmp.write(css)
    tmp.close()
    return Path(tmp.name)


def _html_include_header(accents: dict[str, str]) -> Path | None:
    """Write a temp HTML fragment with an accents override <style> block.

    Returns None when there are no overrides. The caller deletes the file.
    """
    if not accents:
        return None
    block = "<style>\n" + _accents_override_css(accents) + "</style>\n"
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".html", delete=False, encoding="utf-8"
    )
    tmp.write(block)
    tmp.close()
    return Path(tmp.name)


def _cover_eyebrow(cfg_meta: dict[str, Any], imprint_name: str = "FREE PLAY Publishing") -> str:
    eyebrow = cfg_meta.get("cover_eyebrow")
    if eyebrow:
        return str(eyebrow)
    issue = cfg_meta.get("issue")
    year = cfg_meta.get("year") or cfg_meta.get("date") or ""
    parts = [imprint_name]
    if issue:
        parts.append(f"Issue {issue}")
    if year:
        parts.append(str(year)[:4])
    return " · ".join(parts)


def _dedication_lines(front: dict[str, Any], cfg_meta: dict[str, Any]) -> list[str]:
    """Pull the dedication text from metadata or frontmatter.

    Accepts a string (single line), a list of strings (one per line), or
    nothing (returns []).
    """
    raw = cfg_meta.get("dedication") or front.get("dedication")
    if not raw:
        return []
    if isinstance(raw, str):
        return [raw]
    return [str(line) for line in raw]


def _dedication_md(lines: list[str]) -> str:
    """Render a dedication as a fenced div so pandoc emits
    `<div class="dedication">…</div>` for EPUB/HTML/DOCX.
    Returns empty string when there's no dedication."""
    if not lines:
        return ""
    inner = "\n\n".join(f"*{line}*" for line in lines)
    return f"::: {{.dedication}}\n{inner}\n:::\n"


def _epub_body(body_md: str, title: str, author: str, dedication: list[str]) -> str:
    """For pandoc EPUB/HTML, prepend the title + byline as a markdown H1 + italic
    so the EPUB has a nice opening (matches the prototype's source manuscript)."""
    parts = [f"# {title}", f"*by {author}*"]
    ded = _dedication_md(dedication)
    if ded:
        parts.append(ded)
    parts.append(body_md)
    return "\n\n".join(parts)


def _html_body(body_md: str, title: str, author: str, cover: Path | None, dedication: list[str]) -> str:
    """HTML preview gets the cover image as a hero up top, then title + byline."""
    if cover is None:
        return _epub_body(body_md, title, author, dedication)
    parts = [f'![{title} — cover]({cover.name})', f"# {title}", f"*by {author}*"]
    ded = _dedication_md(dedication)
    if ded:
        parts.append(ded)
    parts.append(body_md)
    return "\n\n".join(parts)


_H2_BREAK_RE = re.compile(r"^(##[^#])", flags=re.MULTILINE)


def _docx_body(body_md: str, title: str, author: str, cover: Path | None, dedication: list[str]) -> str:
    """DOCX gets the cover image first, then a page break, then title + byline.

    Each `## h2` is treated as a chapter break, so we emit a `\\newpage`
    before it — pandoc translates that to a Word page break.
    """
    body_md = _H2_BREAK_RE.sub(r"\\newpage\n\n\1", body_md)
    if cover is None:
        return _epub_body(body_md, title, author, dedication)
    parts = [f'![{title} — cover]({cover.name})', '\\newpage', f"# {title}", f"*by {author}*"]
    ded = _dedication_md(dedication)
    if ded:
        parts.append(ded)
    parts.append(body_md)
    return "\n\n".join(parts)
