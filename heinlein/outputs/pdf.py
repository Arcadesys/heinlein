"""Render styled HTML → PDF via Chrome headless."""
from __future__ import annotations

from datetime import date, datetime, timezone
from importlib.metadata import version
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape
import pikepdf

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
    body_font_size: int,
    body_line_height: float,
    prose_font_size: int,
    prose_line_height: float,
    local_fonts: bool,
    font_css: str,
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
        body_font_size=body_font_size,
        body_line_height=body_line_height,
        prose_font_size=prose_font_size,
        prose_line_height=prose_line_height,
        local_fonts=local_fonts,
        font_css=font_css,
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
        # Keep exports out of the author's running Chrome profile/session.
        with tempfile.TemporaryDirectory(prefix="heinlein-chrome-") as profile:
            cmd.insert(1, f"--user-data-dir={profile}")
            subprocess.run(cmd, check=True, capture_output=True, timeout=90)
    finally:
        if cleanup:
            html_path.unlink(missing_ok=True)


def _normalized_dates(value: Any) -> tuple[str, str]:
    """Return PDF and XMP forms of a fixed metadata date.

    Reproducible output must not silently inherit the machine clock, so callers
    must provide metadata.date. Date-only values intentionally start at UTC
    midnight; explicit ISO timestamps are converted to UTC.
    """
    if not value:
        raise ValueError("pdf.reproducible requires metadata.date")
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, datetime.min.time())
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(
                "metadata.date must be an ISO date or timestamp when pdf.reproducible is true"
            ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return (
        parsed.strftime("D:%Y%m%d%H%M%SZ"),
        parsed.strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def _normalize_reproducible_pdf(
    output: Path,
    *,
    title: str,
    author: str,
    metadata_date: Any,
) -> None:
    """Make Chrome's PDF metadata and file ID deterministic.

    Chrome writes wall-clock metadata. pikepdf rewrites the completed PDF after
    optional named destinations have been added, so the final file has one
    timestamp, Heinlein provenance, synchronized XMP/docinfo, and a stable ID.
    """
    pdf_date, xmp_date = _normalized_dates(metadata_date)
    creator = f"Heinlein {version('heinlein')}"
    with pikepdf.open(output, allow_overwriting_input=True) as pdf:
        with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as meta:
            meta["dc:title"] = title
            meta["dc:creator"] = [author]
            meta["xmp:CreatorTool"] = creator
            meta["xmp:CreateDate"] = xmp_date
            meta["xmp:ModifyDate"] = xmp_date
            meta["xmp:MetadataDate"] = xmp_date
        pdf.docinfo["/Title"] = title
        pdf.docinfo["/Author"] = author
        pdf.docinfo["/Creator"] = creator
        pdf.docinfo["/Producer"] = creator
        pdf.docinfo["/CreationDate"] = pdf_date
        pdf.docinfo["/ModDate"] = pdf_date
        pdf.save(
            output,
            deterministic_id=True,
            recompress_flate=True,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
        )


def build(
    *,
    ctx: dict[str, Any],
    output: Path,
    debug_dir: Path | None = None,
    reproducible: bool = False,
    metadata_date: Any = None,
) -> Path:
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
    if reproducible:
        _normalize_reproducible_pdf(
            output,
            title=ctx["title"],
            author=ctx["author"],
            metadata_date=metadata_date,
        )
    return output
