from pathlib import Path

import pytest
from pypdf import PdfReader

from heinlein.outputs import dests


def test_markers_are_planted_only_for_linked_ids() -> None:
    html = (
        "<html><head></head><body>"
        '<h2 id="twine-start" class="twine-passage">Passage</h2>'
        '<h2 id="unlinked">Passage</h2>'
        '<a href="#twine-start">go</a>'
        "</body></html>"
    )
    marked_html, marked = dests.plant_markers(html)

    assert marked == ["twine-start"]
    assert "HLDEST[twine-start]" in marked_html
    assert "HLDEST[unlinked]" not in marked_html
    assert ".hl-dest-mark" in marked_html
    # The marker goes inside the element, so a page break before the heading
    # can't strand it on the previous page.
    assert '<h2 id="twine-start" class="twine-passage"><span class="hl-dest-mark">' in marked_html


def test_a_link_to_a_missing_id_is_skipped() -> None:
    html = '<html><head></head><body><a href="#nowhere">go</a></body></html>'
    marked_html, marked = dests.plant_markers(html)

    assert marked == []
    assert marked_html == html


_DOC = (
    "<html><head><style>@page{size:200pt 200pt;margin:0}"
    "h1{break-before:page}</style></head><body>"
    '<a href="#second">go</a>'
    '<h1 id="second">Second</h1>'
    "</body></html>"
)


def test_a_marked_render_locates_the_page_and_leaves_the_clean_one_alone(
    tmp_path: Path,
) -> None:
    from heinlein.outputs import pdf as out_pdf

    try:
        out_pdf.chrome_path()
    except RuntimeError:
        pytest.skip("Chrome is required to render a PDF to mark up.")

    marked_html, marked = dests.plant_markers(_DOC)
    clean = tmp_path / "clean.pdf"
    probe = tmp_path / "marked.pdf"
    out_pdf._print_to_pdf(_DOC, clean)
    out_pdf._print_to_pdf(marked_html, probe)

    found = dests.locate(probe, clean, expected=marked)
    assert found == {"second": 1}

    dests.write_named_destinations(clean, found)
    reader = PdfReader(str(clean))
    root = reader.trailer["/Root"]
    assert "/second" in root["/Dests"].get_object()
    tree = root["/Names"].get_object()["/Dests"].get_object()["/Names"]
    assert str(tree[0]) == "second"
    # The marker lived only in the throwaway render.
    assert "HLDEST" not in "".join(page.extract_text() for page in reader.pages)


def test_a_marker_that_never_rendered_is_an_error(tmp_path: Path) -> None:
    from pypdf import PdfWriter

    blank = tmp_path / "blank.pdf"
    writer = PdfWriter()
    writer.add_blank_page(200, 200)
    with blank.open("wb") as handle:
        writer.write(handle)

    with pytest.raises(RuntimeError, match="twine-start"):
        dests.locate(blank, blank, expected=["twine-start"])


def test_markers_that_moved_the_page_are_an_error(tmp_path: Path) -> None:
    from pypdf import PdfWriter

    def blank(name: str, pages: int) -> Path:
        path = tmp_path / name
        writer = PdfWriter()
        for _ in range(pages):
            writer.add_blank_page(200, 200)
        with path.open("wb") as handle:
            writer.write(handle)
        return path

    with pytest.raises(RuntimeError, match="pagination"):
        dests.locate(blank("a.pdf", 3), blank("b.pdf", 2), expected=[])
