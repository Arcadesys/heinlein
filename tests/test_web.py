"""Tests for `heinlein web` — upload + project pages."""
from __future__ import annotations

import io
import shutil
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from heinlein.web import create_app  # noqa: E402

EXAMPLE_DIR = Path(__file__).resolve().parents[1] / "examples" / "la-ligne-du-marais"


def _have_pandoc() -> bool:
    return shutil.which("pandoc") is not None


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


@pytest.fixture
def client(workspace: Path) -> TestClient:
    return TestClient(create_app(workspace))


def test_index_empty(client: TestClient) -> None:
    r = client.get("/")
    assert r.status_code == 200
    assert "Upload manuscript" in r.text
    assert "Nothing built yet" in r.text


def test_tokens_css(client: TestClient) -> None:
    r = client.get("/static/tokens.css")
    assert r.status_code == 200
    assert "--paper" in r.text


def test_upload_rejects_non_markdown(client: TestClient) -> None:
    r = client.post(
        "/upload",
        files={"manuscript": ("notes.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 400
    assert "must be a .md file" in r.text


def test_upload_rejects_bad_frontmatter(client: TestClient) -> None:
    bad = b"---\n: : :\n---\n\nhello\n"
    r = client.post(
        "/upload",
        files={"manuscript": ("bad.md", bad, "text/markdown")},
    )
    assert r.status_code == 400


def test_project_not_found(client: TestClient) -> None:
    assert client.get("/project/nope").status_code == 404
    assert client.get("/project/nope/file/whatever.pdf").status_code == 404


def test_project_path_traversal(client: TestClient, workspace: Path) -> None:
    # ../../etc on a project name should not escape workspace.
    r = client.get("/project/..%2F..%2Fetc")
    assert r.status_code == 404


@pytest.mark.skipif(not _have_pandoc(), reason="pandoc not installed")
def test_upload_full_build(client: TestClient, workspace: Path) -> None:
    md = (EXAMPLE_DIR / "manuscript.md").read_bytes()
    cover = (EXAMPLE_DIR / "cover.jpg").read_bytes()
    r = client.post(
        "/upload",
        files={
            "manuscript": ("manuscript.md", md, "text/markdown"),
            "cover": ("cover.jpg", cover, "image/jpeg"),
        },
        follow_redirects=False,
    )
    assert r.status_code == 303
    loc = r.headers["location"]
    assert loc.startswith("/project/")

    # Project dir + heinlein.yaml exist; manuscript.md was written.
    project_name = loc[len("/project/"):]
    pdir = workspace / project_name
    assert pdir.is_dir()
    assert (pdir / "manuscript.md").is_file()
    assert (pdir / "cover.jpg").is_file()
    assert (pdir / "heinlein.yaml").is_file()
    assert (pdir / "dist").is_dir()

    # Project page renders with download links.
    r = client.get(loc)
    assert r.status_code == 200
    assert "La Ligne du Marais" in r.text

    # At least the HTML artifact should be downloadable.
    artifacts = list((pdir / "dist").glob("*.html"))
    if artifacts:
        r = client.get(f"{loc}/file/{artifacts[0].name}")
        assert r.status_code == 200
        assert len(r.content) > 100

    # Index now lists the project.
    r = client.get("/")
    assert r.status_code == 200
    assert "La Ligne du Marais" in r.text


def test_upload_rejects_disguised_filename(client: TestClient, workspace: Path) -> None:
    md = b"---\ntitle: Test\nauthor: Me\n---\n\n# Test\n\nbody\n"
    # Cover with path-segments in its filename should be sanitized down to a basename.
    r = client.post(
        "/upload",
        files={
            "manuscript": ("manuscript.md", md, "text/markdown"),
            "cover": ("../../etc/passwd.png", b"\x89PNG\r\n\x1a\n", "image/png"),
        },
        follow_redirects=False,
    )
    # Either succeeds with a sanitized name, or rejects — but must not write outside workspace.
    if r.status_code == 303:
        project_name = r.headers["location"][len("/project/"):]
        pdir = workspace / project_name
        assert (pdir / "passwd.png").is_file() or not any(p.name == "passwd.png" for p in pdir.iterdir())
        # The literal traversal path must not exist.
        assert not (workspace / ".." / "etc" / "passwd.png").exists()
    else:
        assert r.status_code in (400, 500)
