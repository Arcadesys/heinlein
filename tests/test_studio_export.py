from pathlib import Path
import os
import subprocess
import sys

import pytest

from heinlein import studio_export
from heinlein.outputs import pdf


def test_studio_export_works_without_optional_pdf_normalizer(tmp_path):
    script = r'''
import builtins
from pathlib import Path
import sys
original_import = builtins.__import__
def without_normalizer(name, *args, **kwargs):
    if name.split(".")[0] == "pikepdf":
        raise ModuleNotFoundError("Synthetic missing pikepdf", name="pikepdf")
    return original_import(name, *args, **kwargs)
builtins.__import__ = without_normalizer
from heinlein import studio_export
studio_export.pandoc.md_to_html = lambda text: "<p>Exact — body.</p>"
root = Path(sys.argv[1])
source = root / "source.md"
source.write_text("# Original\n\nExact — body.\n")
before = source.read_bytes()
output = studio_export.export(manuscript=source, output_dir=root / "output",
    format="html", title="Synthetic review", author="Writer")
assert "Exact — body." in output.read_text()
assert source.read_bytes() == before
'''
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr


def test_html_is_a_plain_manuscript_with_escaped_title(tmp_path, monkeypatch):
    source = tmp_path / "snapshot.md"
    source.write_text("# Original\n\nExact — body.\n")
    monkeypatch.setattr(studio_export.pandoc, "md_to_html", lambda source: "<p>Exact — body.</p>")
    output = studio_export.export(manuscript=source, output_dir=tmp_path / "out", format="html", title="<Review>", author="Writer")
    text = output.read_text()
    assert "&lt;Review&gt;" in text
    assert "Exact — body." in text
    assert "FREE PLAY" not in text
    assert source.read_text() == "# Original\n\nExact — body.\n"


@pytest.mark.parametrize("format", ["docx", "epub"])
def test_document_formats_reuse_existing_writers_without_publication_matter(tmp_path, monkeypatch, format):
    source = tmp_path / "snapshot.md"
    source.write_text("# Original\n\nFirst — scene.\n")
    calls = []
    def capture(**kwargs):
        calls.append(kwargs)
        return kwargs["output"]
    monkeypatch.setattr(getattr(studio_export, format), "build", capture)
    studio_export.export(manuscript=source, output_dir=tmp_path / "out", format=format, title="Review", author="Writer")
    assert len(calls) == 1
    assert "# Review" in calls[0]["body_md"]
    assert "*by Writer*" in calls[0]["body_md"]
    assert "First — scene." in calls[0]["body_md"]
    assert "FREE PLAY" not in calls[0]["body_md"]


def test_pdf_export_uses_a_disposable_chrome_profile(tmp_path, monkeypatch):
    monkeypatch.setattr(pdf, "chrome_path", lambda: "/synthetic/chrome")
    profiles = []
    def run(command, **kwargs):
        profile = next(x.split("=", 1)[1] for x in command if x.startswith("--user-data-dir="))
        profiles.append(Path(profile))
        assert profiles[-1].is_dir()
        assert kwargs["timeout"] == 90
    monkeypatch.setattr(pdf.subprocess, "run", run)
    pdf._print_to_pdf("<p>Synthetic — output</p>", tmp_path / "out.pdf")
    assert len(profiles) == 1
    assert not profiles[0].exists()
