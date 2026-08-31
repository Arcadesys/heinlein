import shutil
import subprocess
from pathlib import Path

import pytest

from heinlein import config as cfg_mod
from heinlein import pandoc
from heinlein.build import (
    _docx_body,
    _epub_body,
    _html_body,
    _insert_major_section_blank_leaves,
    build,
)


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "major-section-breaks"


def _have_chrome() -> bool:
    paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    return any(Path(path).exists() for path in paths) or any(
        shutil.which(name) for name in ("google-chrome", "chromium", "chrome")
    )


def test_marked_major_section_gets_one_print_only_blank_leaf() -> None:
    body = pandoc.md_to_html(
        "# Afterword: Pass It On {.major-section-break}\n\nAfterword body.\n"
    )

    rendered = _insert_major_section_blank_leaves(body)

    assert rendered.startswith('<div class="major-section-blank" aria-hidden="true">&nbsp;</div>')
    assert '<h1 class="major-section-break"' in rendered
    assert _insert_major_section_blank_leaves("<h1>Unmarked</h1>") == "<h1>Unmarked</h1>"


def test_major_section_marker_remains_semantic_outside_print_pdf() -> None:
    body = "# Afterword: Pass It On {.major-section-break}\n\nAfterword body.\n"

    for rendered in (
        _epub_body(body, "Book", "Austen", []),
        _html_body(body, "Book", "Austen", None, []),
        _docx_body(body, "Book", "Austen", None, []),
    ):
        assert "# Afterword: Pass It On {.major-section-break}" in rendered


@pytest.mark.skipif(
    not (_have_chrome() and shutil.which("pandoc") and shutil.which("pdftotext")),
    reason="pandoc, Chrome, or pdftotext not installed",
)
def test_marked_major_section_has_a_blank_unnumbered_pdf_leaf(tmp_path: Path) -> None:
    project = tmp_path / "major-section-breaks"
    shutil.copytree(FIXTURE_DIR, project)
    cfg = cfg_mod.load(project_yaml=project / "heinlein.yaml")

    pdf = build(cfg)["pdf"]
    pages = subprocess.check_output(["pdftotext", "-layout", str(pdf), "-"], text=True).split("\f")
    story_page = next(index for index, page in enumerate(pages) if "THE STORY ENDS HERE" in page)
    afterword_page = next(index for index, page in enumerate(pages) if "AFTERWORD STARTS HERE" in page)

    assert afterword_page == story_page + 2
    assert pages[story_page + 1].strip() == ""
