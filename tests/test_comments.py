import shutil
import zipfile
from pathlib import Path

import pytest

from heinlein import comments, studio_export
from heinlein import config as cfg_mod
from heinlein.build import build

EXAMPLE_DIR = Path(__file__).resolve().parents[1] / "examples" / "la-ligne-du-marais"
needs_pandoc = pytest.mark.skipif(shutil.which("pandoc") is None, reason="pandoc not installed")


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("new {>>x<<}.", "new."),
        ("Start{>>tight<<} end", "Start end"),
        ("two  {>>x<<}.", "two ."),
        ("a {>>one<<} {>>two<<} b", "a b"),
        ("Wraps {>>over\r\na line<<} — fine.\r\n", "Wraps — fine.\r\n"),
        ("{>>lead<<}Body\n\nNext {>>x<<}\n", "Body\n\nNext\n"),
        ("No notes — 🐺 <<} stray close\n", "No notes — 🐺 <<} stray close\n"),
    ],
)
def test_strip_comments_removes_notes_and_one_leading_space(source, expected):
    assert comments.strip_comments(source) == expected


@pytest.mark.parametrize(
    "source",
    [
        "Body {>>never closed\n",
        "Body {>>split\n\nlater<<} text",
        "Body {>>split\r\n \r\nlater<<}",
        "ok {>>x<<} then {>>open",
    ],
)
def test_strip_comments_refuses_an_unclosed_comment(source):
    with pytest.raises(ValueError, match="A scene has an unfinished comment. Close or remove it before exporting."):
        comments.strip_comments(source)


@needs_pandoc
def test_studio_epub_never_contains_author_comments(tmp_path):
    source = tmp_path / "snapshot.md"
    original = "# Scene\n\nShe left {>>make this colder<<}.\n\nThe door — shut {>>tense?\nmaybe<<}.\n"
    source.write_text(original, encoding="utf-8")
    output = studio_export.export(manuscript=source, output_dir=tmp_path / "out", format="epub", title="Review", author="Writer")
    with zipfile.ZipFile(output) as epub:
        xhtml = "".join(epub.read(name).decode("utf-8") for name in epub.namelist() if name.endswith(".xhtml"))
    assert "She left." in xhtml
    assert "{&gt;&gt;" not in xhtml and "{>>" not in xhtml
    assert "colder" not in xhtml and "tense?" not in xhtml
    assert source.read_text(encoding="utf-8") == original


def test_studio_export_fails_on_an_unclosed_comment(tmp_path):
    source = tmp_path / "snapshot.md"
    source.write_text("She left {>>unfinished\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unfinished comment"):
        studio_export.export(manuscript=source, output_dir=tmp_path / "out", format="html", title="Review", author="")


@needs_pandoc
def test_cli_build_strips_comments_before_every_writer(tmp_path):
    project = tmp_path / "book"
    shutil.copytree(EXAMPLE_DIR, project)
    manuscript = project / "manuscript.md"
    manuscript.write_text(manuscript.read_text(encoding="utf-8") + "\nA last line {>>private note<<}.\n", encoding="utf-8")
    results = build(cfg_mod.load(project_yaml=project / "heinlein.yaml", formats_override="text"))
    text = results["text"].read_text(encoding="utf-8")
    assert "A last line." in text
    assert "private note" not in text and "{>>" not in text

    manuscript.write_text("Open {>>never closed\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unfinished comment"):
        build(cfg_mod.load(project_yaml=project / "heinlein.yaml", formats_override="text"))
