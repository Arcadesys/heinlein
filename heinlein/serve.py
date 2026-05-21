"""Local preview + gallery server for heinlein.

`heinlein serve` boots a small stdlib HTTP server that:
  - rebuilds the active manuscript on file change and live-reloads the preview
  - shows a gallery of past builds under a configured archive root
"""
from __future__ import annotations

import html
import json
import mimetypes
import queue
import re
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape

from heinlein import frontmatter
from heinlein.build import build as run_build
from heinlein.config import HeinleinConfig

FORMAT_EXT = {
    "pdf": ".pdf",
    "epub": ".epub",
    "docx": ".docx",
    "html": ".html",
    "text": ".txt",
}
ARCHIVE_EXTS = {".pdf", ".epub", ".docx", ".html", ".txt"}
WATCH_INTERVAL = 0.5
DEBOUNCE = 0.2


def _templates_dir() -> Path:
    return Path(str(files("heinlein").joinpath("templates")))


def _slug(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "manuscript"


@dataclass
class ProjectEntry:
    title: str
    author: str
    subtitle: str
    dir: Path
    files: dict[str, Path]   # ext (without dot) -> file path

    def url_files(self, prefix: str) -> dict[str, str]:
        return {ext: f"{prefix}/{p.name}" for ext, p in self.files.items()}


class _SSEClients:
    """Fan-out broadcaster for live-reload events."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queues: list[queue.Queue[str]] = []

    def register(self) -> queue.Queue[str]:
        q: queue.Queue[str] = queue.Queue(maxsize=16)
        with self._lock:
            self._queues.append(q)
        return q

    def unregister(self, q: queue.Queue[str]) -> None:
        with self._lock:
            if q in self._queues:
                self._queues.remove(q)

    def broadcast(self, event: str) -> None:
        with self._lock:
            qs = list(self._queues)
        for q in qs:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass


class Server:
    """Heinlein preview/gallery server.

    Runs a ThreadingHTTPServer in a background thread when started via `start()`,
    or call `serve_forever()` to block on the foreground thread.
    """

    def __init__(
        self,
        cfg: HeinleinConfig,
        *,
        host: str = "127.0.0.1",
        port: int = 8765,
    ) -> None:
        self.cfg = cfg
        self.host = host
        self.port = port
        self.clients = _SSEClients()
        self._build_lock = threading.Lock()
        self._stop = threading.Event()
        self._jenv = Environment(
            loader=FileSystemLoader(str(_templates_dir())),
            autoescape=select_autoescape(["html", "j2"]),
        )
        self._slug = self._compute_slug()
        self._server: ThreadingHTTPServer | None = None
        self._watcher_thread: threading.Thread | None = None

    def _compute_slug(self) -> str:
        try:
            front, _ = frontmatter.parse_file(self.cfg.manuscript)
            title = front.get("title") or self.cfg.manuscript.stem
        except Exception:
            title = self.cfg.manuscript.stem
        return _slug(title)

    def initial_build(self) -> None:
        with self._build_lock:
            run_build(self.cfg)
        self._slug = self._compute_slug()

    def _do_build(self) -> bool:
        with self._build_lock:
            try:
                run_build(self.cfg)
                self._slug = self._compute_slug()
                return True
            except Exception:
                traceback.print_exc()
                return False

    def _watched_files(self) -> list[Path]:
        paths = [self.cfg.manuscript]
        if self.cfg.cover and self.cfg.cover.exists():
            paths.append(self.cfg.cover)
        yaml_path = self.cfg.project_dir / "heinlein.yaml"
        if yaml_path.exists():
            paths.append(yaml_path)
        return paths

    def _watch_loop(self) -> None:
        last_mtimes: dict[Path, float] = {p: _safe_mtime(p) for p in self._watched_files()}
        pending_since: float | None = None
        while not self._stop.is_set():
            time.sleep(WATCH_INTERVAL)
            paths = self._watched_files()
            current = {p: _safe_mtime(p) for p in paths}
            changed = any(current.get(p, 0.0) != last_mtimes.get(p, 0.0) for p in paths)
            if changed:
                last_mtimes = current
                pending_since = time.monotonic()
                continue
            if pending_since is not None and (time.monotonic() - pending_since) >= DEBOUNCE:
                pending_since = None
                print(f"[heinlein] change detected — rebuilding {self.cfg.manuscript.name}", file=sys.stderr)
                if self._do_build():
                    self.clients.broadcast("reload")

    def start(self) -> None:
        handler_cls = _make_handler(self)
        self._server = ThreadingHTTPServer((self.host, self.port), handler_cls)
        self._watcher_thread = threading.Thread(target=self._watch_loop, daemon=True)
        self._watcher_thread.start()
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def serve_forever(self) -> None:
        handler_cls = _make_handler(self)
        self._server = ThreadingHTTPServer((self.host, self.port), handler_cls)
        self._watcher_thread = threading.Thread(target=self._watch_loop, daemon=True)
        self._watcher_thread.start()
        try:
            self._server.serve_forever()
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        self._stop.set()
        if self._server is not None:
            try:
                self._server.shutdown()
            except Exception:
                pass
            self._server.server_close()
            self._server = None

    @property
    def address(self) -> tuple[str, int]:
        if self._server is None:
            return (self.host, self.port)
        return self._server.server_address[:2]

    # ---- request rendering ----------------------------------------------

    def render_gallery(self) -> bytes:
        current = self._current_entry()
        archived = self._archive_entries()
        title = current.title if current else "heinlein"
        tpl = self._jenv.get_template("gallery.html.j2")
        out = tpl.render(
            page_title=title,
            current=current,
            current_files=current.url_files("/download") if current else {},
            archived=[(e, e.url_files(f"/archive/{e.dir.name}")) for e in archived],
            archive_root=str(self.cfg.archive) if self.cfg.archive else None,
        )
        return out.encode("utf-8")

    def render_preview_shell(self) -> bytes:
        tpl = self._jenv.get_template("preview_shell.html.j2")
        out = tpl.render(title=self._current_title())
        return out.encode("utf-8")

    def _current_title(self) -> str:
        try:
            front, _ = frontmatter.parse_file(self.cfg.manuscript)
            return str(front.get("title") or self.cfg.manuscript.stem)
        except Exception:
            return self.cfg.manuscript.stem

    def _current_entry(self) -> ProjectEntry | None:
        try:
            front, _ = frontmatter.parse_file(self.cfg.manuscript)
        except Exception:
            front = {}
        title = str(front.get("title") or self.cfg.manuscript.stem)
        author = str(front.get("author") or self.cfg.metadata.get("author") or "")
        subtitle = str(front.get("subtitle") or "")
        files_map: dict[str, Path] = {}
        for ext in ARCHIVE_EXTS:
            p = self.cfg.output / f"{self._slug}{ext}"
            if p.exists():
                files_map[ext.lstrip(".")] = p
        return ProjectEntry(
            title=title,
            author=author,
            subtitle=subtitle,
            dir=self.cfg.output,
            files=files_map,
        )

    def _archive_entries(self) -> list[ProjectEntry]:
        if self.cfg.archive is None or not self.cfg.archive.is_dir():
            return []
        out: list[ProjectEntry] = []
        for sub in sorted(self.cfg.archive.iterdir()):
            if not sub.is_dir():
                continue
            if sub.resolve() == self.cfg.output.resolve():
                continue  # don't double-list the active project's own dist
            entry = _read_archived_dir(sub)
            if entry is not None:
                out.append(entry)
        out.sort(key=lambda e: max((p.stat().st_mtime for p in e.files.values()), default=0.0), reverse=True)
        return out

    # ---- file serving ---------------------------------------------------

    def resolve_download(self, fmt: str) -> Path | None:
        ext = FORMAT_EXT.get(fmt)
        if ext is None:
            return None
        p = self.cfg.output / f"{self._slug}{ext}"
        return p if p.exists() else None

    def resolve_archive_file(self, project: str, filename: str) -> Path | None:
        if self.cfg.archive is None:
            return None
        root = self.cfg.archive.resolve()
        candidate = (root / project / filename).resolve()
        # Path-traversal check.
        try:
            candidate.relative_to(root)
        except ValueError:
            return None
        if not candidate.is_file():
            return None
        if candidate.suffix.lower() not in ARCHIVE_EXTS:
            return None
        return candidate

    def resolve_preview_html(self) -> Path | None:
        p = self.cfg.output / f"{self._slug}.html"
        return p if p.exists() else None


def _safe_mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except FileNotFoundError:
        return 0.0


def _read_archived_dir(d: Path) -> ProjectEntry | None:
    """Discover artifacts under an archived project dir.

    Looks for a heinlein.yaml (uses its title/author/output) — falls back to
    scanning the directory and a `dist/` subdirectory for known formats.
    """
    title = d.name
    author = ""
    subtitle = ""
    yaml_path = d / "heinlein.yaml"
    output_dir = d
    manuscript_path: Path | None = None
    if yaml_path.is_file():
        try:
            raw = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
        except Exception:
            raw = {}
        meta = raw.get("metadata") or {}
        if "manuscript" in raw:
            manuscript_path = (d / raw["manuscript"]).resolve()
        if "output" in raw:
            output_dir = (d / raw["output"]).resolve()
        author = str(meta.get("author") or "")
    if manuscript_path and manuscript_path.is_file():
        try:
            front, _ = frontmatter.parse_file(manuscript_path)
            title = str(front.get("title") or title)
            author = author or str(front.get("author") or "")
            subtitle = str(front.get("subtitle") or "")
        except Exception:
            pass

    files_map: dict[str, Path] = {}
    search_dirs = [output_dir, d]
    seen_names: set[str] = set()
    for sd in search_dirs:
        if not sd.is_dir():
            continue
        for f in sd.iterdir():
            if not f.is_file():
                continue
            if f.suffix.lower() not in ARCHIVE_EXTS:
                continue
            if f.name in seen_names:
                continue
            seen_names.add(f.name)
            ext_key = f.suffix.lower().lstrip(".")
            # Prefer first-seen (output dir wins over the project root).
            files_map.setdefault(ext_key, f)

    if not files_map:
        return None
    return ProjectEntry(title=title, author=author, subtitle=subtitle, dir=d, files=files_map)


def _make_handler(server: Server) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401
            sys.stderr.write(f"[heinlein] {self.address_string()} - {fmt % args}\n")

        # ---- helpers ----
        def _send_bytes(self, status: int, body: bytes, content_type: str, *, extra_headers: dict[str, str] | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _send_file(self, status: int, path: Path, *, attachment_name: str | None = None) -> None:
            ctype, _ = mimetypes.guess_type(path.name)
            if ctype is None:
                ctype = "application/octet-stream"
            try:
                data = path.read_bytes()
            except OSError:
                self._send_bytes(404, b"not found", "text/plain")
                return
            extra: dict[str, str] = {}
            if attachment_name:
                extra["Content-Disposition"] = f'attachment; filename="{attachment_name}"'
            self._send_bytes(status, data, ctype, extra_headers=extra)

        def _redirect(self, location: str) -> None:
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        # ---- routing ----
        def do_GET(self) -> None:  # noqa: N802
            parts = urlsplit(self.path)
            route = unquote(parts.path)

            if route == "/":
                self._send_bytes(200, server.render_gallery(), "text/html; charset=utf-8")
                return
            if route == "/preview" or route == "/preview/":
                self._send_bytes(200, server.render_preview_shell(), "text/html; charset=utf-8")
                return
            if route == "/preview/raw":
                p = server.resolve_preview_html()
                if p is None:
                    self._send_bytes(503, b"preview not built yet", "text/plain")
                    return
                self._send_file(200, p)
                return
            if route == "/events":
                self._serve_sse()
                return
            if route == "/static/tokens.css":
                tokens = _templates_dir() / "tokens.css"
                self._send_file(200, tokens)
                return
            if route.startswith("/download/"):
                fmt = route[len("/download/"):]
                p = server.resolve_download(fmt)
                if p is None:
                    self._send_bytes(404, b"not found", "text/plain")
                    return
                self._send_file(200, p, attachment_name=p.name)
                return
            if route.startswith("/archive/"):
                rest = route[len("/archive/"):]
                segs = rest.split("/", 1)
                if len(segs) != 2 or not segs[0] or not segs[1]:
                    self._send_bytes(404, b"not found", "text/plain")
                    return
                project, filename = segs
                p = server.resolve_archive_file(project, filename)
                if p is None:
                    self._send_bytes(404, b"not found", "text/plain")
                    return
                self._send_file(200, p, attachment_name=p.name)
                return
            self._send_bytes(404, b"not found", "text/plain")

        def _serve_sse(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q = server.clients.register()
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while not server._stop.is_set():
                    try:
                        evt = q.get(timeout=15.0)
                    except queue.Empty:
                        try:
                            self.wfile.write(b": keep-alive\n\n")
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            return
                        continue
                    payload = f"data: {json.dumps({'event': evt})}\n\n".encode("utf-8")
                    try:
                        self.wfile.write(payload)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return
            finally:
                server.clients.unregister(q)

    return Handler


def escape(s: str) -> str:
    return html.escape(s or "")
