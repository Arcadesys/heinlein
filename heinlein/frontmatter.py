"""Parse YAML frontmatter from a markdown file."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

_FM_RE = re.compile(r"^---\n(.*?)\n---\n(.*)", re.DOTALL)


def parse(text: str) -> tuple[dict[str, Any], str]:
    """Return (frontmatter_dict, body_markdown). If no frontmatter, returns ({}, text)."""
    match = _FM_RE.match(text)
    if not match:
        return {}, text
    front_raw = match.group(1)
    body = match.group(2)
    front = yaml.safe_load(front_raw) or {}
    if not isinstance(front, dict):
        raise ValueError("Frontmatter must be a YAML mapping")
    return front, body


def parse_file(path: Path) -> tuple[dict[str, Any], str]:
    return parse(path.read_text(encoding="utf-8"))


def strip_title_block(body_md: str) -> str:
    """Strip leading H1 and italic byline (matches prototype behavior)."""
    body_md = re.sub(r"\A(\s*)# .*\n", r"\1", body_md, count=1)
    body_md = re.sub(r"\A(\s*)\*by .*\*\n", r"\1", body_md, count=1)
    return body_md
