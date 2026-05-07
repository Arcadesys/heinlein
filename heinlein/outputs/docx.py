"""Build DOCX via pandoc."""
from __future__ import annotations

from pathlib import Path

from heinlein import pandoc


def build(*, body_md: str, output: Path) -> Path:
    pandoc.run(
        ["-f", "markdown", "-t", "docx", "-o", str(output)],
        input_bytes=body_md.encode("utf-8"),
    )
    return output
