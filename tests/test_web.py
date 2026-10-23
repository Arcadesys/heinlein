"""Tests for `heinlein web` — upload + project pages."""
from __future__ import annotations

import shutil
from pathlib import Path
from unittest.mock import Mock

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from heinlein.web import create_app  # noqa: E402
from heinlein import web as web_mod  # noqa: E402
from heinlein.outputs.pdf import chrome_path  # noqa: E402

EXAMPLE_DIR = Path(__file__).resolve().parents[1] / "examples" / "la-ligne-du-marais"
MANUSCRIPT = b"---\r\ntitle: Test\r\nauthor: Me\r\n---\r\n\r\nExact author text.\r\n"


def _have_pandoc() -> bool:
    return shutil.which("pandoc") is not None


def _have_chrome() -> bool:
    try:
        chrome_path()
    except RuntimeError:
        return False
    return True


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


@pytest.fixture
def client(workspace: Path) -> TestClient:
    return TestClient(create_app(workspace))


@pytest.fixture
def fake_build(monkeypatch: pytest.MonkeyPatch) -> Mock:
    """Exercise HTTP/storage behavior without depending on a format renderer."""
    def build(cfg):
        cfg.output.mkdir()
        artifact = cfg.output / "test.html"
        artifact.write_text("<p>Synthetic output</p>", encoding="utf-8")
        return {"html": artifact}

    mocked = Mock(side_effect=build)
    monkeypatch.setattr(web_mod, "run_build", mocked)
    return mocked


@pytest.fixture
def existing_project(workspace: Path) -> Path:
    project = workspace / "existing"
    project.mkdir()
    source = project / "manuscript.md"
    source.write_bytes(b"Author-owned existing source\r\n")
    return source


def assert_only_existing(workspace: Path, existing_project: Path) -> None:
    assert list(workspace.iterdir()) == [existing_project.parent]
    assert existing_project.read_bytes() == b"Author-owned existing source\r\n"
    assert list(existing_project.parent.iterdir()) == [existing_project]


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


@pytest.mark.skipif(not (_have_pandoc() and _have_chrome()), reason="pandoc or Chrome not installed")
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
    assert len(artifacts) == 1
    assert {p.suffix for p in (pdir / "dist").iterdir()} >= {".pdf", ".epub", ".docx", ".html", ".txt"}
    assert (pdir / "manuscript.md").read_bytes() == md
    r = client.get(f"{loc}/file/{artifacts[0].name}")
    assert r.status_code == 200
    assert r.content == artifacts[0].read_bytes()

    # Index now lists the project.
    r = client.get("/")
    assert r.status_code == 200
    assert "La Ligne du Marais" in r.text


def test_upload_sanitizes_image_paths_without_changing_source(
    client: TestClient, workspace: Path, fake_build: Mock, tmp_path: Path,
) -> None:
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"Do not overwrite")
    r = client.post(
        "/upload",
        files=[
            ("manuscript", ("manuscript.md", MANUSCRIPT, "text/markdown")),
            ("cover", ("../../outside.png", b"Cover bytes", "image/png")),
            ("images", ("../nested/photo.jpg", b"Image bytes", "image/jpeg")),
        ],
        follow_redirects=False,
    )
    assert r.status_code == 303
    fake_build.assert_called_once()
    pdir = workspace / r.headers["location"].removeprefix("/project/")
    assert {p.name for p in pdir.iterdir()} == {"manuscript.md", "outside.png", "photo.jpg", "heinlein.yaml", "dist"}
    assert (pdir / "outside.png").read_bytes() == b"Cover bytes"
    assert (pdir / "photo.jpg").read_bytes() == b"Image bytes"
    assert (pdir / "manuscript.md").read_bytes() == MANUSCRIPT
    assert fake_build.call_args.args[0].cover == pdir / "outside.png"
    assert outside.read_bytes() == b"Do not overwrite"
    assert {p.name for p in tmp_path.iterdir()} == {"workspace", "outside.png"}


@pytest.mark.parametrize("field", ["manuscript", "cover", "images"])
@pytest.mark.parametrize("excess", [0, 1], ids=["exact-limit", "over-limit"])
def test_upload_byte_limits(
    client: TestClient, workspace: Path, existing_project: Path,
    fake_build: Mock, monkeypatch: pytest.MonkeyPatch, field: str, excess: int,
) -> None:
    limit = len(MANUSCRIPT)
    monkeypatch.setattr(web_mod, "MAX_UPLOAD_BYTES", limit)
    payload = MANUSCRIPT + b"x" * excess
    files = [("manuscript", ("manuscript.md", payload if field == "manuscript" else MANUSCRIPT, "text/markdown"))]
    if field != "manuscript":
        files.append((field, ("image.png", payload, "image/png")))
    response = client.post("/upload", files=files, follow_redirects=False)
    if excess:
        assert response.status_code == 413
        fake_build.assert_not_called()
        assert_only_existing(workspace, existing_project)
    else:
        assert response.status_code == 303
        fake_build.assert_called_once()
        project = workspace / response.headers["location"].removeprefix("/project/")
        assert (project / "manuscript.md").read_bytes() == MANUSCRIPT
        if field != "manuscript":
            assert (project / "image.png").read_bytes() == payload
        assert existing_project.read_bytes() == b"Author-owned existing source\r\n"


def test_invalid_utf8_never_builds_or_creates_a_project(
    client: TestClient, workspace: Path, existing_project: Path, fake_build: Mock,
) -> None:
    response = client.post("/upload", files={"manuscript": ("bad.md", b"invalid\xff", "text/markdown")})
    assert response.status_code == 400
    assert "not valid UTF-8" in response.json()["detail"]
    fake_build.assert_not_called()
    assert_only_existing(workspace, existing_project)


@pytest.mark.parametrize("field,name", [("cover", ".hidden.png"), ("cover", "script.js"), ("images", "script.js")])
def test_invalid_images_remove_the_partial_upload(
    client: TestClient, workspace: Path, existing_project: Path, fake_build: Mock, field: str, name: str,
) -> None:
    response = client.post("/upload", files=[
        ("manuscript", ("manuscript.md", MANUSCRIPT, "text/markdown")),
        (field, (name, b"untrusted bytes", "application/octet-stream")),
    ])
    assert response.status_code == 400
    fake_build.assert_not_called()
    assert_only_existing(workspace, existing_project)


def test_build_failure_removes_partial_outputs_and_preserves_existing_projects(
    client: TestClient, workspace: Path, existing_project: Path, fake_build: Mock,
) -> None:
    def fail(cfg):
        assert cfg.manuscript.read_bytes() == MANUSCRIPT
        cfg.output.mkdir()
        (cfg.output / "partial.pdf").write_bytes(b"incomplete")
        raise RuntimeError("synthetic renderer failure")

    fake_build.side_effect = fail
    response = client.post("/upload", files={"manuscript": ("manuscript.md", MANUSCRIPT, "text/markdown")})
    assert response.status_code == 500
    assert "build failed" in response.json()["detail"]
    fake_build.assert_called_once()
    assert_only_existing(workspace, existing_project)


@pytest.mark.parametrize("route", ["file/private.html", "preview"])
@pytest.mark.parametrize("link", ["project", "dist", "artifact"])
def test_artifact_routes_never_serve_symlink_escapes(
    client: TestClient, workspace: Path, tmp_path: Path, route: str, link: str,
) -> None:
    outside = tmp_path / "private"
    outside.mkdir()
    secret = outside / "private.html"
    secret.write_bytes(b"PRIVATE: must not be returned")
    project = workspace / "project"
    if link == "project":
        (outside / "dist").mkdir()
        (outside / "dist" / "private.html").write_bytes(secret.read_bytes())
        project.symlink_to(outside, target_is_directory=True)
    else:
        project.mkdir()
        dist = project / "dist"
        if link == "dist":
            dist.symlink_to(outside, target_is_directory=True)
        else:
            dist.mkdir()
            (dist / "private.html").symlink_to(secret)
    response = client.get(f"/project/project/{route}")
    assert response.status_code == 404
    assert b"PRIVATE" not in response.content
    assert secret.read_bytes() == b"PRIVATE: must not be returned"


def test_artifact_downloads_allow_only_supported_outputs(client: TestClient, workspace: Path) -> None:
    dist = workspace / "project" / "dist"
    dist.mkdir(parents=True)
    (dist / "secret.pem").write_bytes(b"PRIVATE")
    (dist / "book.html").write_bytes(b"<p>Published artifact</p>")
    assert client.get("/project/project/file/secret.pem").status_code == 404
    response = client.get("/project/project/file/book.html")
    assert response.status_code == 200
    assert response.content == b"<p>Published artifact</p>"
    assert client.get("/project/project/preview").content == response.content
