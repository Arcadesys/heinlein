import shutil
import subprocess
from pathlib import Path

import pytest

from heinlein import config as cfg_mod
from heinlein.build import build

EXAMPLE_DIR = Path(__file__).resolve().parents[1] / "examples" / "la-ligne-du-marais"


@pytest.fixture
def example_dir(tmp_path: Path) -> Path:
    """Copy example into a tmp dir so output goes there, not into the repo."""
    dest = tmp_path / "la-ligne-du-marais"
    shutil.copytree(EXAMPLE_DIR, dest)
    return dest


def _have_chrome() -> bool:
    paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    return any(Path(p).exists() for p in paths) or any(
        shutil.which(x) for x in ("google-chrome", "chromium", "chrome")
    )


def _have_pandoc() -> bool:
    return shutil.which("pandoc") is not None


@pytest.mark.skipif(not _have_pandoc(), reason="pandoc not installed")
def test_text_output_only(example_dir: Path) -> None:
    """Lightest smoke test — just plain text via pandoc."""
    cfg = cfg_mod.load(
        project_yaml=example_dir / "heinlein.yaml",
        formats_override="text",
    )
    results = build(cfg)
    assert "text" in results
    out = results["text"]
    assert out.exists()
    assert out.stat().st_size > 0
    assert out.read_text(encoding="utf-8").lower().startswith("tuck spent a month")


@pytest.mark.skipif(not _have_pandoc(), reason="pandoc not installed")
def test_epub_output(example_dir: Path) -> None:
    cfg = cfg_mod.load(
        project_yaml=example_dir / "heinlein.yaml",
        formats_override="epub",
    )
    results = build(cfg)
    out = results["epub"]
    assert out.exists()
    assert out.stat().st_size > 5_000  # rough sanity


def test_project_styles_resolve_and_validate(tmp_path: Path) -> None:
    manuscript = tmp_path / "manuscript.md"
    manuscript.write_text("---\ntitle: Test\n---\n\n# Test\n", encoding="utf-8")
    print_css = tmp_path / "print.css"
    print_css.write_text(".body-section { color: black; }\n", encoding="utf-8")
    epub_css = tmp_path / "epub.css"
    epub_css.write_text("body { color: black; }\n", encoding="utf-8")
    project = tmp_path / "heinlein.yaml"
    project.write_text(
        "\n".join(
            [
                "manuscript: manuscript.md",
                "styles:",
                "  print: print.css",
                "  epub: epub.css",
            ]
        ),
        encoding="utf-8",
    )

    cfg = cfg_mod.load(project_yaml=project)
    assert cfg.styles == {"print": print_css, "epub": epub_css}

    project.write_text(
        "manuscript: manuscript.md\nstyles:\n  kindle: missing.css\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="Unknown style target"):
        cfg_mod.load(project_yaml=project)


def test_missing_project_style_fails_fast(tmp_path: Path) -> None:
    manuscript = tmp_path / "manuscript.md"
    manuscript.write_text("---\ntitle: Test\n---\n", encoding="utf-8")
    project = tmp_path / "heinlein.yaml"
    project.write_text(
        "manuscript: manuscript.md\nstyles:\n  print: missing.css\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="Style file not found"):
        cfg_mod.load(project_yaml=project)


@pytest.mark.skipif(
    not (_have_pandoc() and _have_chrome()),
    reason="pandoc or chrome missing",
)
def test_full_pipeline(example_dir: Path) -> None:
    cfg = cfg_mod.load(project_yaml=example_dir / "heinlein.yaml")
    results = build(cfg)
    for fmt in ("pdf", "epub", "docx", "html", "text"):
        assert fmt in results
        assert results[fmt].exists()
        assert results[fmt].stat().st_size > 0

    head = subprocess.check_output(["file", str(results["pdf"])], text=True)
    assert "PDF document" in head
    head = subprocess.check_output(["file", str(results["epub"])], text=True)
    assert "EPUB" in head
