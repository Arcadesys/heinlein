"""Studio Publish reuses the full designed-book pipeline on live Studio text."""
from pathlib import Path
import shutil
import zipfile

import pytest

from heinlein import studio_publish

LIVE = "# My Book\n\n## Opening\n\nFirst scene — exact words. {>>private note<<}\n\n## Ending\n\nTHE END.\n"


def test_publish_calls_the_cli_build_with_studio_metadata(tmp_path, monkeypatch):
    source = tmp_path / "live.md"
    source.write_text(LIVE)
    seen = {}

    def fake_build(cfg):
        seen["cfg"] = cfg
        seen["manuscript"] = cfg.manuscript.read_text()
        return {}

    monkeypatch.setattr(studio_publish, "build", fake_build)
    studio_publish.publish(manuscript=source, output_dir=tmp_path / "out", formats=["pdf", "epub", "docx"],
                           title="My Book", author="Example Author", rights="Example retains rights.")
    cfg = seen["cfg"]
    assert cfg.formats == ("pdf", "epub", "docx")
    assert cfg.output == (tmp_path / "out").resolve()
    assert cfg.imprint == "free-play"
    assert cfg.metadata["title"] == "My Book" and cfg.metadata["author"] == "Example Author"
    assert cfg.metadata["rights"] == "Example retains rights."
    assert seen["manuscript"].startswith('---\n{"title": "My Book", "author": "Example Author"')
    assert seen["manuscript"].endswith(LIVE)
    assert source.read_text() == LIVE, "Studio source text is never modified"


def test_project_yaml_design_applies_but_studio_text_and_metadata_win(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    (project / "old.md").write_text("STALE SNAPSHOT")
    (project / "heinlein.yaml").write_text(
        "manuscript: old.md\nimprint: insert-coin\npage:\n  size: trade\nmetadata:\n  title: Old title\n  dedication: For you\n"
    )
    source = tmp_path / "live.md"
    source.write_text(LIVE)
    seen = {}
    monkeypatch.setattr(studio_publish, "build", lambda cfg: seen.setdefault("cfg", cfg) and {})
    studio_publish.publish(manuscript=source, output_dir=tmp_path / "out", formats=["epub"], title="My Book",
                           project_config=project / "heinlein.yaml")
    cfg = seen["cfg"]
    assert cfg.imprint == "insert-coin" and cfg.page.size == "trade"
    assert cfg.metadata["title"] == "My Book" and cfg.metadata["dedication"] == "For you"
    assert cfg.manuscript.name == "manuscript.md" and cfg.manuscript.parent != project
    assert cfg.output == (tmp_path / "out").resolve()


@pytest.mark.parametrize("formats,title", [([], "Book"), (["pdf", "pdf"], "Book"), (["sh"], "Book"), (["pdf"], "  ")])
def test_publish_rejects_bad_requests(tmp_path, formats, title):
    source = tmp_path / "live.md"
    source.write_text(LIVE)
    with pytest.raises(ValueError):
        studio_publish.publish(manuscript=source, output_dir=tmp_path / "out", formats=formats, title=title)
    assert not (tmp_path / "out").exists()


@pytest.mark.skipif(shutil.which("pandoc") is None, reason="needs Pandoc")
def test_real_epub_and_docx_are_designed_books_without_private_notes(tmp_path):
    source = tmp_path / "live.md"
    source.write_text(LIVE)
    out = tmp_path / "out"
    studio_publish.main(["--input", str(source), "--output-dir", str(out), "--formats", "epub,docx",
                         "--title", "My Book", "--author", "Example Author"])
    assert sorted(p.name for p in out.iterdir()) == ["my-book.docx", "my-book.epub"]
    with zipfile.ZipFile(out / "my-book.epub") as book:
        text = "\n".join(book.read(p).decode() for p in book.namelist() if p.endswith((".xhtml", ".opf")))
    assert "Opening" in text and "First scene — exact words." in text and "THE END." in text
    assert "Example Author" in text
    assert "private note" not in text
