"""Give Chrome's internal PDF links somewhere to land.

Chrome's `--print-to-pdf` writes a /Link annotation for every `href="#id"` in
the document and points it at `/Dest /id` — but it never writes the destination
side. The catalog comes out with no /Dests dictionary and no /Names name tree,
so every one of those annotations dangles and the reader is left tapping a
choice that does nothing. That is fatal for a Twine gamebook, where the links
*are* the book.

Nothing in the PDF says which page an HTML id ended up on, and Chrome won't
tell us, so we ask the render itself. A second, throwaway copy of the document
is printed with an invisible marker planted inside each linked element, and its
page text is scanned to find where each marker landed. The marker is
transparent and kerned to no width so it cannot move the page it is measuring —
and the two renders are compared page for page to prove it didn't. Only the
clean render is kept, so nothing of this shows up in the shipped text layer.
"""
from __future__ import annotations

import re
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    NameObject,
    TextStringObject,
)

MARKER_CSS = """
.hl-dest-mark {
  font-size: 1pt;
  letter-spacing: -0.62pt;
  line-height: 0;
  color: transparent;
}
"""

_HREF_RE = re.compile(r'href="#([^"#\s]+)"')
_MARKER_RE = re.compile(r"HLDEST\[([^\]]+)\]")
# Chrome renders through OpenType ligatures, so an id containing "fi" or "fl"
# comes back out of the text layer as a single glyph.
_LIGATURES = str.maketrans({"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl"})


def _opening_tag(html: str, element_id: str) -> re.Match[str] | None:
    return re.search(rf'<[^<>]*\sid="{re.escape(element_id)}"[^<>]*>', html)


def plant_markers(html: str) -> tuple[str, list[str]]:
    """Plant a locator marker inside every element an internal link points at.

    Returns the rewritten HTML and the ids that were marked. Ids that are
    linked but never defined are skipped — Chrome emits a dangling annotation
    for those too, but there is no element to mark and nothing we can do here.
    """
    targets: list[str] = []
    seen: set[str] = set()
    for element_id in _HREF_RE.findall(html):
        if element_id not in seen:
            seen.add(element_id)
            targets.append(element_id)

    marked: list[str] = []
    for element_id in targets:
        match = _opening_tag(html, element_id)
        if match is None:
            continue
        marker = f'<span class="hl-dest-mark">HLDEST[{element_id}]</span>'
        html = html[: match.end()] + marker + html[match.end() :]
        marked.append(element_id)

    if marked and "</head>" in html:
        html = html.replace(
            "</head>", f"<style>{MARKER_CSS}</style>\n</head>", 1
        )
    return html, marked


def _page_text(page) -> str:
    text = (page.extract_text() or "").translate(_LIGATURES)
    # Long ids can be broken across lines inside the 1pt marker.
    return re.sub(r"\s+", "", text)


def locate(marked_pdf: Path, clean_pdf: Path, *, expected: list[str]) -> dict[str, int]:
    """Read the marked render for page numbers, checking it against the clean one.

    Raises if a marker never made it into the text layer, or if planting the
    markers moved anything — either way the page numbers would be a guess, and a
    destination pointing at the wrong page is no better than one pointing
    nowhere.
    """
    marked = PdfReader(str(marked_pdf))
    clean = PdfReader(str(clean_pdf))
    if len(marked.pages) != len(clean.pages):
        raise RuntimeError(
            f"Destination markers changed the pagination: {len(clean.pages)} pages "
            f"clean, {len(marked.pages)} marked."
        )

    found: dict[str, int] = {}
    for number, (marked_page, clean_page) in enumerate(zip(marked.pages, clean.pages)):
        text = _page_text(marked_page)
        for name in _MARKER_RE.findall(text):
            found.setdefault(name, number)
        if _MARKER_RE.sub("", text) != _page_text(clean_page):
            raise RuntimeError(
                f"Destination markers changed the text on page {number + 1}."
            )

    missing = [name for name in expected if name not in found]
    if missing:
        raise RuntimeError(
            "Could not locate PDF destination(s) in the rendered text layer: "
            + ", ".join(missing)
        )
    return found


def write_named_destinations(pdf: Path, destinations: dict[str, int]) -> None:
    """Write `destinations` into `pdf` as both spellings a viewer might consult.

    The catalog /Dests dictionary is what a name-object `/Dest /id` like
    Chrome's resolves against; the /Names /Dests name tree is where every modern
    reader looks first. Each destination is /Fit — a marker locates a page, not
    a point on it, and /Fit survives the page transforms a presentation pass may
    apply later.
    """
    if not destinations:
        return

    writer = PdfWriter(clone_from=str(pdf))

    dests = DictionaryObject()
    tree_names = ArrayObject()
    for name in sorted(destinations):
        page = writer.pages[destinations[name]]
        destination = writer._add_object(
            ArrayObject([page.indirect_reference, NameObject("/Fit")])
        )
        dests[NameObject(f"/{name}")] = destination
        tree_names.append(TextStringObject(name))
        tree_names.append(destination)

    tree = DictionaryObject()
    tree[NameObject("/Names")] = tree_names
    names = DictionaryObject()
    names[NameObject("/Dests")] = writer._add_object(tree)

    root = writer.root_object
    root[NameObject("/Dests")] = writer._add_object(dests)
    root[NameObject("/Names")] = writer._add_object(names)

    with pdf.open("wb") as handle:
        writer.write(handle)
