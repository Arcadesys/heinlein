"""Build plain text via pandoc."""
from __future__ import annotations

from pathlib import Path

from heinlein import pandoc


def build(*, body_md: str, output: Path) -> Path:
    pandoc.run(
        ["-f", "markdown", "-t", "plain", "--wrap=preserve", "-o", str(output)],
        input_bytes=body_md.encode("utf-8"),
    )
    return output
