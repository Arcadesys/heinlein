"""Subprocess wrappers for pandoc."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def pandoc_path() -> str:
    p = shutil.which("pandoc")
    if not p:
        raise RuntimeError(
            "pandoc not found on PATH. Install via `brew install pandoc`."
        )
    return p


def md_to_html(body_md: str) -> str:
    """Convert markdown to HTML5 fragment (no document wrapper)."""
    res = subprocess.run(
        [pandoc_path(), "-f", "markdown", "-t", "html5", "--no-highlight"],
        input=body_md.encode("utf-8"),
        capture_output=True,
        check=True,
    )
    return res.stdout.decode("utf-8")


def run(args: list[str], *, input_bytes: bytes | None = None) -> None:
    cmd = [pandoc_path(), *args]
    subprocess.run(cmd, input=input_bytes, check=True)


def md_file_to(
    src: Path,
    out: Path,
    *,
    extra_args: list[str] | None = None,
    input_bytes: bytes | None = None,
) -> None:
    """Run pandoc converting `src` (or stdin if input_bytes given) → `out`."""
    args: list[str] = []
    if input_bytes is None:
        args.append(str(src))
    else:
        args += ["-f", "markdown"]
    args += ["-o", str(out)]
    if extra_args:
        args += extra_args
    run(args, input_bytes=input_bytes)
