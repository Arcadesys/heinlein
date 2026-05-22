"""FastAPI app for uploading a manuscript + images and building outputs.

`heinlein web` boots this. Each upload creates a fresh project directory under
the workspace, runs the build pipeline, and lands you on a per-project page
with download links for every format.
"""
from __future__ import annotations

import mimetypes
import re
import shutil
import sys
import time
import traceback
from importlib.resources import files
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from jinja2 import Environment, FileSystemLoader, select_autoescape

from heinlein import frontmatter
from heinlein.build import build as run_build
from heinlein.config import HeinleinConfig, PageConfig

ARTIFACT_EXTS = {".pdf", ".epub", ".docx", ".html", ".txt"}
FORMAT_LABEL = {"pdf": "PDF", "epub": "EPUB", "docx": "DOCX", "html": "HTML", "txt": "Text"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".tiff", ".bmp", ".svg"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB per file


def _templates_dir() -> Path:
    return Path(str(files("heinlein").joinpath("templates")))


def _slug(s: str) -> str:
    s = (s or "").lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "manuscript"


def _safe_subdir(workspace: Path, name: str) -> Path | None:
    """Resolve workspace/name and ensure it stays inside workspace."""
    root = workspace.resolve()
    candidate = (root / name).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    if not candidate.is_dir():
        return None
    return candidate


def _safe_file(project_dir: Path, filename: str) -> Path | None:
    base = project_dir.resolve()
    candidate = (base / filename).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    return candidate


def _project_summary(project_dir: Path) -> dict[str, Any]:
    """Describe a project dir for listing in the index."""
    yaml_path = project_dir / "heinlein.yaml"
    manuscript_path = project_dir / "manuscript.md"
    title = project_dir.name
    author = ""
    subtitle = ""
    if yaml_path.is_file():
        try:
            raw = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
        except Exception:
            raw = {}
        meta = raw.get("metadata") or {}
        author = str(meta.get("author") or "")
    if manuscript_path.is_file():
        try:
            front, _ = frontmatter.parse_file(manuscript_path)
            title = str(front.get("title") or title)
            author = author or str(front.get("author") or "")
            subtitle = str(front.get("subtitle") or "")
        except Exception:
            pass

    dist = project_dir / "dist"
    artifacts: dict[str, str] = {}
    if dist.is_dir():
        for f in dist.iterdir():
            if f.is_file() and f.suffix.lower() in ARTIFACT_EXTS:
                ext = f.suffix.lower().lstrip(".")
                artifacts[ext] = f.name

    try:
        mtime = max((f.stat().st_mtime for f in dist.glob("*")), default=project_dir.stat().st_mtime)
    except OSError:
        mtime = 0.0

    return {
        "name": project_dir.name,
        "title": title,
        "author": author,
        "subtitle": subtitle,
        "artifacts": artifacts,
        "mtime": mtime,
    }


def _list_projects(workspace: Path) -> list[dict[str, Any]]:
    if not workspace.is_dir():
        return []
    entries = []
    for sub in workspace.iterdir():
        if not sub.is_dir():
            continue
        entries.append(_project_summary(sub))
    entries.sort(key=lambda e: e["mtime"], reverse=True)
    return entries


def _validate_filename(name: str) -> str:
    """Strip any path components and reject empties / dotfiles."""
    base = Path(name).name
    if not base or base.startswith("."):
        raise HTTPException(status_code=400, detail=f"invalid filename: {name!r}")
    return base


def _read_upload(upload: UploadFile) -> bytes:
    data = upload.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"{upload.filename}: file exceeds 50 MB limit")
    return data


def create_app(workspace: Path) -> FastAPI:
    workspace = workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)

    jenv = Environment(
        loader=FileSystemLoader(str(_templates_dir())),
        autoescape=select_autoescape(["html", "j2"]),
    )

    app = FastAPI(title="Heinlein")
    app.state.workspace = workspace

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        projects = _list_projects(workspace)
        tpl = jenv.get_template("web_index.html.j2")
        return HTMLResponse(tpl.render(projects=projects, workspace=str(workspace)))

    @app.get("/static/tokens.css")
    def tokens_css() -> FileResponse:
        return FileResponse(_templates_dir() / "tokens.css", media_type="text/css")

    @app.post("/upload")
    def upload(
        manuscript: UploadFile = File(...),
        cover: UploadFile | None = File(None),
        images: list[UploadFile] = File(default_factory=list),
    ) -> Response:
        return _do_upload(workspace, manuscript, cover, images)

    @app.get("/project/{name}", response_class=HTMLResponse)
    def project_page(name: str) -> HTMLResponse:
        pdir = _safe_subdir(workspace, name)
        if pdir is None:
            raise HTTPException(status_code=404, detail="project not found")
        summary = _project_summary(pdir)
        tpl = jenv.get_template("web_project.html.j2")
        return HTMLResponse(tpl.render(p=summary, format_label=FORMAT_LABEL))

    @app.get("/project/{name}/file/{filename}")
    def project_file(name: str, filename: str) -> FileResponse:
        pdir = _safe_subdir(workspace, name)
        if pdir is None:
            raise HTTPException(status_code=404, detail="project not found")
        filename = _validate_filename(filename)
        f = _safe_file(pdir / "dist", filename)
        if f is None or f.suffix.lower() not in ARTIFACT_EXTS:
            raise HTTPException(status_code=404, detail="artifact not found")
        ctype, _ = mimetypes.guess_type(f.name)
        return FileResponse(f, media_type=ctype or "application/octet-stream", filename=f.name)

    @app.get("/project/{name}/preview", response_class=HTMLResponse)
    def project_preview(name: str) -> HTMLResponse:
        pdir = _safe_subdir(workspace, name)
        if pdir is None:
            raise HTTPException(status_code=404, detail="project not found")
        # Inline the HTML output so the iframe doesn't need a separate route per asset.
        html_files = list((pdir / "dist").glob("*.html")) if (pdir / "dist").is_dir() else []
        if not html_files:
            raise HTTPException(status_code=404, detail="no html preview built")
        return HTMLResponse(html_files[0].read_text(encoding="utf-8"))

    return app


def _do_upload(
    workspace: Path,
    manuscript: UploadFile,
    cover: UploadFile | None,
    images: list[UploadFile],
) -> Response:
    if not manuscript.filename or not manuscript.filename.lower().endswith(".md"):
        raise HTTPException(status_code=400, detail="manuscript must be a .md file")

    md_bytes = _read_upload(manuscript)
    try:
        text = md_bytes.decode("utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(status_code=400, detail=f"manuscript not valid UTF-8: {e}") from e

    try:
        front, _body = frontmatter.parse(text)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid frontmatter: {e}") from e

    title = str(front.get("title") or Path(manuscript.filename).stem)
    subtitle = str(front.get("subtitle") or "")
    author = str(front.get("author") or "")
    cover_field = front.get("cover")

    slug = _slug(title)
    ts = time.strftime("%Y%m%d-%H%M%S")
    project_name = f"{slug}-{ts}"
    project_dir = workspace / project_name
    if project_dir.exists():
        raise HTTPException(status_code=409, detail=f"project {project_name} already exists")
    project_dir.mkdir(parents=True)

    try:
        (project_dir / "manuscript.md").write_bytes(md_bytes)

        cover_filename: str | None = None
        if cover is not None and cover.filename:
            cover_filename = _validate_filename(cover.filename)
            if Path(cover_filename).suffix.lower() not in IMAGE_EXTS:
                raise HTTPException(status_code=400, detail=f"cover must be an image (got {cover_filename})")
            (project_dir / cover_filename).write_bytes(_read_upload(cover))
        elif isinstance(cover_field, str) and cover_field:
            # Frontmatter references a cover but none uploaded — keep the name; build will warn if missing.
            cover_filename = _validate_filename(cover_field)

        for img in images or []:
            if not img.filename:
                continue
            name = _validate_filename(img.filename)
            if Path(name).suffix.lower() not in IMAGE_EXTS:
                raise HTTPException(status_code=400, detail=f"unsupported image type: {name}")
            (project_dir / name).write_bytes(_read_upload(img))

        # Write heinlein.yaml so the project is also CLI-buildable later.
        yaml_doc: dict[str, Any] = {
            "manuscript": "manuscript.md",
            "output": "dist",
            "formats": "all",
        }
        if cover_filename:
            yaml_doc["cover"] = cover_filename
        meta: dict[str, Any] = {}
        if title:
            meta["title"] = title
        if subtitle:
            meta["subtitle"] = subtitle
        if author:
            meta["author"] = author
        if meta:
            yaml_doc["metadata"] = meta
        (project_dir / "heinlein.yaml").write_text(
            yaml.safe_dump(yaml_doc, sort_keys=False),
            encoding="utf-8",
        )

        # Build.
        cover_path = (project_dir / cover_filename) if cover_filename else None
        cfg = HeinleinConfig(
            manuscript=(project_dir / "manuscript.md").resolve(),
            cover=cover_path.resolve() if cover_path and cover_path.exists() else None,
            page=PageConfig(),
            metadata=meta,
            output=(project_dir / "dist").resolve(),
        )
        try:
            run_build(cfg)
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            raise HTTPException(status_code=500, detail=f"build failed: {e}") from e
    except HTTPException:
        shutil.rmtree(project_dir, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(project_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"upload failed: {e}") from e

    return RedirectResponse(url=f"/project/{project_name}", status_code=303)


def run(workspace: Path, host: str = "127.0.0.1", port: int = 8770) -> None:
    import uvicorn

    app = create_app(workspace)
    uvicorn.run(app, host=host, port=port, log_level="info")
