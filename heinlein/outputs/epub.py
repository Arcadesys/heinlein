"""Build EPUB via pandoc."""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import yaml

from heinlein import pandoc


def _meta_yaml(front: dict[str, Any], cfg_meta: dict[str, Any]) -> str:
    """Build the pandoc EPUB metadata YAML from frontmatter + project metadata."""
    title = front.get("title", "Untitled")
    subtitle = front.get("subtitle")
    author = front.get("author", "")
    genre = front.get("genre", "")

    rights = cfg_meta.get("rights") or f"© {author}. All rights reserved."
    publisher = cfg_meta.get("publisher", "")
    language = cfg_meta.get("language", "en-US")
    description = front.get("description") or cfg_meta.get("description", "")
    subjects = cfg_meta.get("subjects") or [s.strip() for s in genre.split("/") if s.strip()]
    date = cfg_meta.get("date") or ""

    meta: dict[str, Any] = {
        "title": title,
        "creator": [{"role": "author", "text": author}] if author else [],
        "publisher": publisher,
        "rights": rights,
        "language": language,
    }
    if subtitle:
        meta["subtitle"] = subtitle
    if date:
        meta["date"] = date
    if description:
        meta["description"] = description
    if subjects:
        meta["subject"] = subjects

    return "---\n" + yaml.safe_dump(meta, sort_keys=False, allow_unicode=True) + "---\n"


def build(
    *,
    body_md: str,
    front: dict[str, Any],
    cfg_meta: dict[str, Any],
    cover: Path | None,
    css: Path,
    output: Path,
) -> Path:
    """Run pandoc to produce an EPUB."""
    args = [
        "-f", "markdown",
        "-t", "epub",
        "-o", str(output),
        "--css", str(css),
    ]
    if cover and cover.exists():
        args += ["--epub-cover-image", str(cover)]

    meta_text = _meta_yaml(front, cfg_meta)
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".yaml", delete=False, encoding="utf-8"
    ) as tmp:
        tmp.write(meta_text)
        meta_path = Path(tmp.name)
    args += ["--metadata-file", str(meta_path)]

    try:
        pandoc.run(args, input_bytes=body_md.encode("utf-8"))
    finally:
        meta_path.unlink(missing_ok=True)
    return output
