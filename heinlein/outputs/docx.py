"""Build DOCX via pandoc."""
from __future__ import annotations

from pathlib import Path

from heinlein import pandoc


def build(
    *,
    body_md: str,
    output: Path,
    resource_path: Path | None = None,
    toc: bool = False,
) -> Path:
    args = ["-f", "markdown", "-t", "docx", "-o", str(output)]
    if toc:
        args += ["--toc", "--toc-depth=2"]
    if resource_path is not None:
        args += [f"--resource-path={resource_path}"]
    pandoc.run(
        args,
        input_bytes=body_md.encode("utf-8"),
    )
    return output
