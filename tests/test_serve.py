"""Smoke tests for `heinlein serve`."""
from __future__ import annotations

import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from heinlein import config as cfg_mod
from heinlein.serve import Server

EXAMPLE_DIR = Path(__file__).resolve().parents[1] / "examples" / "la-ligne-du-marais"


def _have_pandoc() -> bool:
    return shutil.which("pandoc") is not None


@pytest.fixture
def example_dir(tmp_path: Path) -> Path:
    dest = tmp_path / "la-ligne-du-marais"
    shutil.copytree(EXAMPLE_DIR, dest)
    return dest


def _get(url: str, *, timeout: float = 5.0) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _wait_until(predicate, *, timeout: float = 3.0, interval: float = 0.05) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(interval)
    return False


@pytest.mark.skipif(not _have_pandoc(), reason="pandoc not installed")
def test_serve_routes(example_dir: Path) -> None:
    cfg = cfg_mod.load(
        project_yaml=example_dir / "heinlein.yaml",
        formats_override="html,text",
    )
    server = Server(cfg, host="127.0.0.1", port=0)
    server.initial_build()
    server.start()
    try:
        host, port = server.address
        base = f"http://{host}:{port}"

        status, body = _get(f"{base}/")
        assert status == 200
        text = body.decode("utf-8")
        assert "La Ligne du Marais" in text
        assert "Live preview" in text

        status, body = _get(f"{base}/preview")
        assert status == 200
        assert b"/preview/raw" in body

        status, body = _get(f"{base}/preview/raw")
        assert status == 200
        assert b"<html" in body.lower() or b"<!doctype" in body.lower()

        status, body = _get(f"{base}/download/html")
        assert status == 200
        assert len(body) > 100

        status, _ = _get(f"{base}/download/pdf")
        # pdf wasn't built in this run; expect 404
        assert status == 404

        status, _ = _get(f"{base}/static/tokens.css")
        assert status == 200
    finally:
        server.shutdown()


@pytest.mark.skipif(not _have_pandoc(), reason="pandoc not installed")
def test_archive_and_traversal(tmp_path: Path, example_dir: Path) -> None:
    archive = tmp_path / "archive"
    archive.mkdir()
    # Drop a fake archived project with one html artifact.
    fake = archive / "old-project"
    fake.mkdir()
    (fake / "old-project.html").write_text("<html><body>old</body></html>", encoding="utf-8")

    cfg = cfg_mod.load(
        project_yaml=example_dir / "heinlein.yaml",
        formats_override="text",
        archive_override=archive,
    )
    server = Server(cfg, host="127.0.0.1", port=0)
    server.initial_build()
    server.start()
    try:
        host, port = server.address
        base = f"http://{host}:{port}"

        status, body = _get(f"{base}/")
        assert status == 200
        assert b"old-project" in body

        status, body = _get(f"{base}/archive/old-project/old-project.html")
        assert status == 200
        assert b"old" in body

        # Path traversal should be rejected.
        status, _ = _get(f"{base}/archive/old-project/../../etc/passwd")
        assert status == 404

        # Disallowed extension should be rejected even if file exists.
        (fake / "secret.env").write_text("KEY=1", encoding="utf-8")
        status, _ = _get(f"{base}/archive/old-project/secret.env")
        assert status == 404
    finally:
        server.shutdown()


@pytest.mark.skipif(not _have_pandoc(), reason="pandoc not installed")
def test_watcher_triggers_reload_event(example_dir: Path) -> None:
    cfg = cfg_mod.load(
        project_yaml=example_dir / "heinlein.yaml",
        formats_override="text",
    )
    server = Server(cfg, host="127.0.0.1", port=0)
    server.initial_build()
    server.start()
    try:
        client_q = server.clients.register()
        # Touch the manuscript with new content.
        msm = example_dir / "manuscript.md"
        original = msm.read_text(encoding="utf-8")
        msm.write_text(original + "\n\nA new line.\n", encoding="utf-8")
        # Wait up to ~3s for watcher debounce + rebuild + broadcast.
        got = False
        end = time.monotonic() + 5.0
        while time.monotonic() < end:
            try:
                evt = client_q.get(timeout=0.5)
                if evt == "reload":
                    got = True
                    break
            except Exception:
                continue
        assert got, "expected a reload event after manuscript edit"
    finally:
        server.shutdown()
