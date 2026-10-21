"""Inspect actual distributable contents, including wheel rebuilt from source."""
from pathlib import Path
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]

def test_publisher_archives_include_runtime_assets_without_workspace_data(tmp_path):
    # uv builds the wheel from this sdist by default, proving it can stand alone.
    subprocess.run(["uv", "build", "--offline", "--out-dir", str(tmp_path)], cwd=ROOT, check=True, capture_output=True, text=True)
    source = next(tmp_path.glob("*.tar.gz"))
    with tarfile.open(source) as archive:
        names = archive.getnames()
        relative = [name.split("/", 1)[1] for name in names if "/" in name]
        assert all(name.startswith("heinlein/") or name in {"pyproject.toml", "README.md", "LICENSE", "PKG-INFO"} for name in relative), relative
        assert not any({"__pycache__", "node_modules", ".venv", "examples", "tests", "studio", ".git"}.intersection(name.split("/")) for name in names)
    with zipfile.ZipFile(next(tmp_path.glob("*.whl"))) as archive:
        names = archive.namelist()
        expected = [str(path.relative_to(ROOT)) for path in (ROOT / "heinlein").rglob("*") if path.is_file() and path.suffix in {".py", ".j2", ".css", ".lua"}]
        assert set(expected).issubset(names), set(expected) - set(names)
        assert not any({"__pycache__", "node_modules", ".venv", "examples", "tests", "studio", ".git"}.intersection(name.split("/")) for name in names)
        metadata = next(name for name in names if name.endswith(".dist-info/METADATA"))
        assert "License: MIT" in archive.read(metadata).decode()
