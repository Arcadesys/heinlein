"""Real native snapshot -> unchanged existing CLI, without manuscripts or providers."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parents[1]

class Headings(HTMLParser):
    def __init__(self):
        super().__init__()
        self.current = None
        self.headings = []
    def handle_starttag(self, tag, attrs):
        if tag in ("h1", "h2", "h3"):
            self.current = []
    def handle_data(self, data):
        if self.current is not None:
            self.current.append(data)
    def handle_endtag(self, tag):
        if tag in ("h1", "h2", "h3") and self.current is not None:
            self.headings.append("".join(self.current))
            self.current = None

def test_native_first_story_copy_builds_html_and_epub(tmp_path):
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    subprocess.run(["cargo", "run", "--locked", "--manifest-path", str(ROOT / "studio/Cargo.toml"), "-p", "repository-core", "--example", "first_story_handoff", "--", str(tmp_path / "handoff")], check=True, env=env, capture_output=True, text=True)
    project = tmp_path / "handoff/copies/release"
    source = tmp_path / "handoff/source"
    before = {p: p.read_bytes() for p in source.rglob("*") if p.is_file()}
    receipt = json.loads((project / "source-receipt.json").read_text())
    assert [s["path"] for s in receipt["sources"]] == ["ms/z-opening.md", "ms/a-ending.md"]
    for item in receipt["sources"]:
        assert hashlib.sha256((source / item["path"]).read_bytes()).hexdigest() == item["contentHash"]
    for name, key in [("manuscript.md", "manuscriptHash"), ("heinlein.yaml", "configHash")]:
        assert hashlib.sha256((project / name).read_bytes()).hexdigest() == receipt[key]
    subprocess.run([sys.executable, "-m", "heinlein", "build"], cwd=project, env=env, check=True, capture_output=True, text=True)
    html = next((project / "dist").glob("*.html")).read_text()
    parser = Headings(); parser.feed(html)
    assert parser.headings.count("Scene opening") == 1, "CLI must preserve the first source heading"
    assert parser.headings.count("Synthetic First Story") == 1, "Generated title must not be duplicated"
    assert html.index("First scene") < html.index("Second scene") < html.index("THE END")
    assert "Organization only" not in html
    assert "Example Author" in html
    with zipfile.ZipFile(next((project / "dist").glob("*.epub"))) as book:
        text = "\n".join(book.read(p).decode() for p in book.namelist() if p.endswith((".xhtml", ".opf")))
        assert "Scene opening" in text and "First scene" in text and "THE END" in text
        assert "Example Author" in text
    assert {p: p.read_bytes() for p in before} == before
    assert hashlib.sha256((project / "manuscript.md").read_bytes()).hexdigest() == receipt["manuscriptHash"]
