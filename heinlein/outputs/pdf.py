"""Render styled HTML → PDF via Chrome headless."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

from heinlein.outputs import dests as dests_mod

CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]


def chrome_path() -> str:
    for p in CHROME_PATHS:
        if Path(p).exists():
            return p
    found = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chrome")
    if found:
        return found
    raise RuntimeError(
        "Chrome / Chromium not found. Install Google Chrome (macOS) or pass --pdf-engine."
    )


def _render_html(
    *,
    templates_dir: Path,
    title: str,
    title_html: str,
    subtitle: str,
    author: str,
    genre: str,
    language: str,
    page_w: float,
    page_h: float,
    bleed_in: float,
    sheet_w: float,
    sheet_h: float,
    margin_top: str,
    margin_side: str,
    cover_eyebrow: str,
    cover_uri: str | None,
    imprint_name: str,
    imprint_tagline: str,
    imprint_tagline_long: str,
    imprint_blurb: str,
    imprint_url: str,
    colophon_lines: list[str],
    colophon_intro: str,
    isbn_lines: list[str],
    issue_tag: str,
    dedication_lines: list[str],
    body_html: str,
    tokens_css: str,
) -> str:
    env = Environment(
        loader=FileSystemLoader(str(templates_dir)),
        autoescape=select_autoescape(enabled_extensions=("j2",), default_for_string=False),
    )
    tmpl = env.get_template("print.html.j2")
    return tmpl.render(
        title=title,
        title_html=title_html,
        subtitle=subtitle,
        author=author,
        genre=genre,
        language=language,
        page_w=page_w,
        page_h=page_h,
        bleed_in=bleed_in,
        sheet_w=sheet_w,
        sheet_h=sheet_h,
        margin_top=margin_top,
        margin_side=margin_side,
        cover_eyebrow=cover_eyebrow,
        cover_uri=cover_uri,
        imprint_name=imprint_name,
        imprint_tagline=imprint_tagline,
        imprint_tagline_long=imprint_tagline_long,
        imprint_blurb=imprint_blurb,
        imprint_url=imprint_url,
        colophon_lines=colophon_lines,
        colophon_intro=colophon_intro,
        isbn_lines=isbn_lines,
        issue_tag=issue_tag,
        dedication_lines=dedication_lines,
        body_html=body_html,
        tokens_css=tokens_css,
    )


def _print_to_pdf(html: str, output: Path, *, keep_html: Path | None = None) -> None:
    """Run one Chrome print. `keep_html` writes the source next to the PDF."""
    if keep_html is not None:
        keep_html.parent.mkdir(parents=True, exist_ok=True)
        keep_html.write_text(html, encoding="utf-8")
        html_path = keep_html
        cleanup = False
    else:
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".html", delete=False, encoding="utf-8"
        )
        tmp.write(html)
        tmp.close()
        html_path = Path(tmp.name)
        cleanup = True

    try:
        cmd = [
            chrome_path(),
            "--headless",
            "--disable-gpu",
            "--no-pdf-header-footer",
            f"--print-to-pdf={output}",
            f"file://{html_path}",
        ]
        subprocess.run(cmd, check=True, capture_output=True)
    finally:
        if cleanup:
            html_path.unlink(missing_ok=True)


def build(*, ctx: dict[str, Any], output: Path, debug_dir: Path | None = None) -> Path:
    """
    Build PDF. `ctx` is the shared template context built by build.py.
    Writes the rendered HTML to a tempfile (or debug_dir if given), then
    runs Chrome --headless --print-to-pdf.

    Chrome writes internal links but never the destinations they point at, so a
    document with any `href="#id"` is printed a second time with locator markers
    planted, and the page numbers that come out of the throwaway copy are
    written into the real one. See heinlein.outputs.dests.
    """
    html = _render_html(**ctx)
    marked_html, marked = dests_mod.plant_markers(html)

    _print_to_pdf(html, output, keep_html=debug_dir / "print.html" if debug_dir else None)

    if marked:
        with tempfile.TemporaryDirectory(prefix="heinlein-dests-") as directory:
            probe = Path(directory) / "marked.pdf"
            _print_to_pdf(marked_html, probe)
            destinations = dests_mod.locate(probe, output, expected=marked)
        dests_mod.write_named_destinations(output, destinations)
    return output
