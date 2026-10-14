"""Slice 0: golden-file characterization of the Python publishing pipeline.

These tests pin down what `heinlein build` produces TODAY for the non-PDF
formats, so later slices can prove they did not change publisher behavior.

Rules:
  * Tests only. No behavior change to heinlein/.
  * Goldens live in tests/golden/<case>/ and are plain files in git.
  * Volatile bytes (EPUB UUID, modified timestamps, DOCX core.xml) are
    normalized before comparing. Everything else must match exactly.
  * HTML is compared on <body> only: <head> keeps remote font links when the
    network is blocked and embeds them when it is open.
  * Goldens are tied to one pandoc version (tests/golden/PANDOC_VERSION).
    Other versions skip with a clear reason instead of failing.
  * PDF is out of scope here (needs Chrome). It stays covered by smoke tests.

Regenerate after an INTENDED change:
    UPDATE_GOLDEN=1 python -m pytest tests/test_golden.py
Then review `git diff tests/golden` before committing.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest
import yaml

from heinlein import config as cfg_mod
from heinlein.build import build

REPO = Path(__file__).resolve().parents[1]
EXAMPLE_DIR = REPO / "examples" / "la-ligne-du-marais"
GOLDEN = Path(__file__).resolve().parent / "golden"
FORMATS = "text,html,epub,docx"
UPDATE = os.environ.get("UPDATE_GOLDEN") == "1"


def _pandoc_version() -> str | None:
    exe = shutil.which("pandoc")
    if not exe:
        return None
    out = subprocess.check_output([exe, "--version"], text=True)
    return out.splitlines()[0].split()[1]


PANDOC = _pandoc_version()
PINNED = (GOLDEN / "PANDOC_VERSION").read_text().strip() if (GOLDEN / "PANDOC_VERSION").exists() else None

pytestmark = pytest.mark.skipif(PANDOC is None, reason="pandoc not installed")


def _skip_if_version_drift() -> None:
    if UPDATE:
        return
    if PINNED and PANDOC != PINNED:
        pytest.skip(f"goldens pinned to pandoc {PINNED}; found {PANDOC}")


# ---------------------------------------------------------------- cases


def _case_default(tmp: Path) -> Path:
    dest = tmp / "project"
    shutil.copytree(EXAMPLE_DIR, dest)
    return dest / "heinlein.yaml"


def _case_variants(tmp: Path) -> Path:
    dest = tmp / "project"
    shutil.copytree(EXAMPLE_DIR, dest)
    path = dest / "heinlein.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    raw["chapters"] = True
    raw["accents"] = {"accent": "#aa3300"}
    raw["metadata"]["dedication"] = ["For the ones who always bet on red."]
    raw["metadata"]["author"] = "Golden Test Author"
    path.write_text(yaml.safe_dump(raw, allow_unicode=True), encoding="utf-8")
    return path


def _case_twine(tmp: Path) -> Path:
    dest = tmp / "project"
    dest.mkdir()
    passages = [
        ("StoryTitle", "Golden Gamebook"),
        ("StoryAuthor", "Golden Test Author"),
        ("Start", "You stand at a door.\\n\\n[[Open it|Room]]\\n[[Walk away|Street]]"),
        ("Room", "Dust and a lamp.\\n\\n[[Take the lamp|End]]"),
        ("Street", "Rain, mostly.\\n\\n[[Go back|Start]]"),
        ("End", "The lamp is warm. The end."),
    ]
    divs = "".join(f'<div tiddler="{t}" tags="">{x}</div>' for t, x in passages)
    (dest / "story.html").write_text(
        f'<html><div id="storeArea">{divs}</div></html>', encoding="utf-8"
    )
    (dest / "heinlein.yaml").write_text(
        "manuscript: story.html\nsource_format: twine1\n"
        "metadata:\n  language: en-US\n  date: \"2026\"\n",
        encoding="utf-8",
    )
    return dest / "heinlein.yaml"


def _write_project(tmp: Path, manuscript: str, yaml_text: str) -> Path:
    dest = tmp / "project"
    dest.mkdir()
    (dest / "manuscript.md").write_text(manuscript, encoding="utf-8")
    (dest / "heinlein.yaml").write_text(yaml_text, encoding="utf-8")
    return dest / "heinlein.yaml"


_MIN_YAML = "manuscript: manuscript.md\nmetadata:\n  language: en-US\n  date: \"2026\"\n"


def _case_no_cover(tmp: Path) -> Path:
    """No cover anywhere: exercises the cover-is-None branches in build.py."""
    manuscript = (
        "---\ntitle: Quiet Door\nauthor: Golden Test Author\ngenre: short fiction\n---\n\n"
        "# Quiet Door\n\n*by Golden Test Author*\n\n"
        "The door had no sign. Nobody knocked.\n\n"
        "Inside, a lamp burned low.\n"
    )
    return _write_project(tmp, manuscript, _MIN_YAML)


def _case_scene_breaks_emdash(tmp: Path) -> Path:
    """Scene breaks, em dashes, chapter headings, fragments: author style stays intact."""
    manuscript = (
        "---\ntitle: Dashes and Breaks\nauthor: Golden Test Author\ngenre: short fiction\n---\n\n"
        "# Dashes and Breaks\n\n*by Golden Test Author*\n\n"
        "## One\n\n"
        "She said it once\u2014then twice\u2014then not at all.\n\n"
        "Fine.\n\n"
        "No.\n\n"
        "* * *\n\n"
        "Later, the rain stopped. It always does\u2014eventually.\n\n"
        "> A quoted line, with *emphasis* and a dash\u2014here.\n\n"
        "## Two\n\n"
        "Damn it, Marcus. Damn it all.\n\n"
        "* * *\n\n"
        "The end\u2014for now.\n"
    )
    return _write_project(tmp, manuscript, _MIN_YAML + "chapters: true\n")


CASES = {
    "example-default": _case_default,
    "example-variants": _case_variants,
    "twine-gamebook": _case_twine,
    "no-cover": _case_no_cover,
    "scene-breaks-emdash": _case_scene_breaks_emdash,
}

# ---------------------------------------------------------- normalizers

_VOLATILE = [
    (re.compile(r"urn:uuid:[0-9a-fA-F-]{36}"), "urn:uuid:NORMALIZED"),
    (re.compile(r"(<meta property=\"dcterms:modified\">)[^<]*(</meta>)"), r"\1NORMALIZED\2"),
]


def _norm_text(data: bytes) -> bytes:
    text = data.decode("utf-8")
    for pattern, repl in _VOLATILE:
        text = pattern.sub(repl, text)
    return text.encode("utf-8")


def _html_body(data: bytes) -> str:
    text = data.decode("utf-8")
    m = re.search(r"<body\b[^>]*>.*</body>", text, flags=re.DOTALL)
    assert m, "html output has no <body>"
    return m.group(0) + "\n"


def _zip_snapshot(path: Path, *, skip: set[str], readable: re.Pattern[str]) -> tuple[dict[str, str], dict[str, bytes]]:
    """Return (manifest of sha256 per part, readable parts to store as files)."""
    manifest: dict[str, str] = {}
    keep: dict[str, bytes] = {}
    with zipfile.ZipFile(path) as z:
        for name in sorted(z.namelist()):
            if name in skip or name.endswith("/"):
                continue
            data = z.read(name)
            if name.endswith((".opf", ".ncx", ".xhtml", ".xml", ".css")):
                data = _norm_text(data)
            manifest[name] = hashlib.sha256(data).hexdigest()
            if readable.search(name):
                keep[name] = data
    return manifest, keep


# ------------------------------------------------------------ comparing


def _check_file(golden: Path, actual: bytes) -> None:
    if UPDATE:
        golden.parent.mkdir(parents=True, exist_ok=True)
        golden.write_bytes(actual)
        return
    assert golden.exists(), f"missing golden {golden.relative_to(REPO)}; run with UPDATE_GOLDEN=1"
    expected = golden.read_bytes()
    assert actual == expected, f"golden drift in {golden.relative_to(REPO)}"


def _check_manifest(golden: Path, manifest: dict[str, str]) -> None:
    _check_file(golden, (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode())


@pytest.mark.parametrize("case", sorted(CASES))
def test_golden_case(case: str, tmp_path: Path) -> None:
    _skip_if_version_drift()
    project_yaml = CASES[case](tmp_path)
    cfg = cfg_mod.load(project_yaml=project_yaml, formats_override=FORMATS)
    results = build(cfg)
    assert set(results) == {"text", "html", "epub", "docx"}

    gdir = GOLDEN / case
    _check_file(gdir / "book.txt", results["text"].read_bytes())
    _check_file(gdir / "book.body.html", _html_body(results["html"].read_bytes()).encode())

    manifest, keep = _zip_snapshot(
        results["epub"],
        skip=set(),
        readable=re.compile(r"^EPUB/(text/.*\.xhtml|nav\.xhtml|content\.opf)$"),
    )
    _check_manifest(gdir / "epub.manifest.json", manifest)
    for name, data in keep.items():
        _check_file(gdir / "epub" / name.removeprefix("EPUB/"), data)

    manifest, keep = _zip_snapshot(
        results["docx"],
        skip={"docProps/core.xml"},
        readable=re.compile(r"^word/document\.xml$"),
    )
    _check_manifest(gdir / "docx.manifest.json", manifest)
    for name, data in keep.items():
        _check_file(gdir / "docx" / name.replace("/", "_"), data)

    if UPDATE:
        (GOLDEN / "PANDOC_VERSION").write_text(f"{PANDOC}\n")
