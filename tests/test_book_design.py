"""Book design settings: plain style, page size, fonts, front matter and cover."""
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from heinlein import config as cfg_mod
from heinlein.build import build
from heinlein.outputs import pdf as out_pdf


def _project(tmp_path: Path, extra: str = "", formats: str = "[pdf]") -> Path:
    (tmp_path / "manuscript.md").write_text(
        "---\ntitle: A Test Book\nauthor: Example Author\n---\n\n## One\n\nBody text.\n",
        encoding="utf-8",
    )
    project = tmp_path / "heinlein.yaml"
    project.write_text(
        f"manuscript: manuscript.md\nformats: {formats}\n" + extra, encoding="utf-8"
    )
    return project


def _print_html(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, extra: str = "") -> str:
    """Build the PDF with Chrome stubbed out and return the print HTML."""
    printed: list[str] = []

    def fake_print(html: str, output: Path, **_: object) -> None:
        printed.append(html)
        output.write_bytes(b"%PDF-stub")

    monkeypatch.setattr(out_pdf, "_print_to_pdf", fake_print)
    build(cfg_mod.load(project_yaml=_project(tmp_path, extra)))
    return printed[0]


def test_plain_style_has_no_imprint_branding(tmp_path, monkeypatch):
    html = _print_html(
        tmp_path, monkeypatch,
        "imprint: plain\nmetadata:\n  publisher: Example Press\n  year: '2026'\n  issue: '01'\n",
    )
    for brand in ("FREE PLAY", "Arcades", "freeplay", "fin · merci", "endCoinGrad", "FP ·"):
        assert brand not in html.split("</style>", 1)[1], brand
    assert "Published by Example Press." in html
    assert 'class="page end"' not in html
    # Cover eyebrow must not start with a dangling separator.
    assert '<div class="cover-top">Issue 01 · 2026</div>' in html


def test_free_play_remains_the_publisher_default(tmp_path, monkeypatch):
    html = _print_html(tmp_path, monkeypatch)
    assert cfg_mod.load(project_yaml=tmp_path / "heinlein.yaml").imprint == "free-play"
    assert "FREE PLAY Publishing" in html
    assert 'class="page end"' in html


def test_front_matter_pages_can_be_turned_off(tmp_path, monkeypatch):
    html = _print_html(
        tmp_path, monkeypatch,
        "front_matter:\n  cover: false\n  copyright: false\n  title_page: false\n  end_page: false\n",
    )
    body = html.split("</style>", 1)[1]
    for page in ('class="page cover"', 'class="page colophon"', 'class="page title-page"', 'class="page end"'):
        assert page not in body
    assert "Body text." in body


def test_page_size_and_fonts_reach_the_print_template(tmp_path, monkeypatch):
    html = _print_html(
        tmp_path, monkeypatch,
        "imprint: plain\npage:\n  size: small\nfonts:\n  body: EB Garamond\n  display: Source Serif 4\n",
    )
    assert "size: 5.0in 8.0in" in html
    assert "--font-body: 'EB Garamond'" in html
    assert "--font-display: 'Source Serif 4'" in html
    assert "family=EB+Garamond" in html and "family=Source+Serif+4" in html
    assert "Set in EB Garamond and Source Serif 4." in html


def test_fonts_and_plain_tokens_reach_epub_and_html(tmp_path):
    project = _project(
        tmp_path, "imprint: plain\nfonts:\n  body: Crimson Pro\n", formats="[epub, html]"
    )
    out = build(cfg_mod.load(project_yaml=project))
    html = out["html"].read_text(encoding="utf-8")
    assert "body { font-family: 'Crimson Pro'" in html
    with zipfile.ZipFile(out["epub"]) as book:
        css = "\n".join(book.read(n).decode() for n in book.namelist() if n.endswith(".css"))
    assert "--neon-pink:    #111111;" in css
    assert "'Crimson Pro'" in css


@pytest.mark.parametrize(
    "extra, message",
    [
        ("imprint: mystery\n", "Unknown imprint"),
        ("fonts:\n  body: Comic Sans\n", "Unknown font"),
        ("fonts:\n  caption: Lora\n", "Unknown fonts key"),
        ("front_matter:\n  index: true\n", "Unknown front_matter key"),
        ("front_matter:\n  cover: maybe\n", "true or false"),
        ("page:\n  size: tabloid\n", "Unknown page size"),
        (
            "fonts:\n  body: EB Garamond\npdf:\n  reproducible: true\nmetadata:\n  date: 2026-01-01\n",
            "bundled fonts",
        ),
    ],
)
def test_invalid_design_settings_are_rejected(tmp_path, extra, message):
    with pytest.raises(ValueError, match=message):
        cfg_mod.load(project_yaml=_project(tmp_path, extra))
