from __future__ import annotations

from datetime import date
from hashlib import sha256
from pathlib import Path

import pikepdf
import pytest

from heinlein import build as build_mod
from heinlein import config as cfg_mod
from heinlein.outputs import pdf as out_pdf


def _project(tmp_path: Path, *, page: str = "", pdf: str = "", metadata: str = "") -> Path:
    manuscript = tmp_path / "manuscript.md"
    manuscript.write_text(
        "---\ntitle: A Test Book\nauthor: Austen Tucker\n---\n\nBody.\n",
        encoding="utf-8",
    )
    project = tmp_path / "heinlein.yaml"
    project.write_text(
        "manuscript: manuscript.md\nformats: [pdf]\n" + page + pdf + metadata,
        encoding="utf-8",
    )
    return project


def test_letter_large_print_and_reproducible_options_are_opt_in(tmp_path: Path) -> None:
    project = _project(
        tmp_path,
        page="page:\n  size: letter\n  large_print: true\n",
        pdf="pdf:\n  reproducible: true\n",
        metadata="metadata:\n  date: 2026-08-24\n",
    )
    cfg = cfg_mod.load(project_yaml=project)

    assert (cfg.page.width_in, cfg.page.height_in) == (8.5, 11.0)
    assert cfg.page.large_print is True
    assert cfg.pdf.reproducible is True

    default = cfg_mod.load(manuscript=tmp_path / "manuscript.md")
    assert default.page.size == "digest"
    assert default.page.large_print is False
    assert default.pdf.reproducible is False


@pytest.mark.parametrize(
    ("config", "message"),
    [
        ("page:\n  large_print: maybe\n", "page.large_print"),
        ("pdf:\n  reproducible: maybe\n", "pdf.reproducible"),
    ],
)
def test_pdf_options_require_boolean_values(tmp_path: Path, config: str, message: str) -> None:
    project = _project(
        tmp_path,
        page=config if config.startswith("page") else "",
        pdf=config if config.startswith("pdf") else "",
    )
    with pytest.raises(ValueError, match=message):
        cfg_mod.load(project_yaml=project)


def test_large_print_context_uses_local_fonts_only_for_reproducible_pdf(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(
        tmp_path,
        page="page:\n  large_print: true\n",
        pdf="pdf:\n  reproducible: true\n",
        metadata="metadata:\n  date: 2026-08-24\n",
    )
    cfg = cfg_mod.load(project_yaml=project)
    captured: dict[str, object] = {}

    monkeypatch.setattr(build_mod.pandoc, "md_to_html", lambda _: "<p>Body.</p>")

    def fake_pdf_build(**kwargs: object) -> Path:
        captured.update(kwargs)
        output = kwargs["output"]
        assert isinstance(output, Path)
        output.write_bytes(b"%PDF-test")
        return output

    monkeypatch.setattr(build_mod.out_pdf, "build", fake_pdf_build)
    build_mod.build(cfg)

    ctx = captured["ctx"]
    assert isinstance(ctx, dict)
    assert ctx["body_font_size"] == 15
    assert ctx["body_line_height"] == 1.65
    assert ctx["prose_font_size"] == 15
    assert ctx["prose_line_height"] == 1.65
    assert ctx["local_fonts"] is True
    assert "Inter-Regular.ttf" in str(ctx["font_css"])
    assert captured["reproducible"] is True
    assert captured["metadata_date"] == date(2026, 8, 24)


def _blank_pdf(path: Path) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)


def test_reproducible_normalization_syncs_metadata_and_id(tmp_path: Path) -> None:
    first = tmp_path / "first.pdf"
    second = tmp_path / "second.pdf"
    _blank_pdf(first)
    _blank_pdf(second)

    for output in (first, second):
        out_pdf._normalize_reproducible_pdf(
            output,
            title="It Takes a Zoo",
            author="Austen Tucker",
            metadata_date="2026-08-24",
        )

    assert sha256(first.read_bytes()).hexdigest() == sha256(second.read_bytes()).hexdigest()
    with pikepdf.open(first) as pdf:
        assert str(pdf.docinfo["/Title"]) == "It Takes a Zoo"
        assert str(pdf.docinfo["/Author"]) == "Austen Tucker"
        assert str(pdf.docinfo["/Creator"]) == "Heinlein 0.1.0"
        assert str(pdf.docinfo["/Producer"]) == "Heinlein 0.1.0"
        assert str(pdf.docinfo["/CreationDate"]) == "D:20260824000000Z"
        assert str(pdf.docinfo["/ModDate"]) == "D:20260824000000Z"
        assert pdf.trailer["/ID"]
        with pdf.open_metadata() as meta:
            assert str(meta["dc:title"]) == "It Takes a Zoo"
            assert meta["dc:creator"] == ["Austen Tucker"]
            assert str(meta["xmp:CreatorTool"]) == "Heinlein 0.1.0"


def test_reproducible_pdf_requires_a_fixed_date(tmp_path: Path) -> None:
    output = tmp_path / "book.pdf"
    _blank_pdf(output)
    with pytest.raises(ValueError, match="metadata.date"):
        out_pdf._normalize_reproducible_pdf(
            output,
            title="Book",
            author="Author",
            metadata_date=None,
        )
