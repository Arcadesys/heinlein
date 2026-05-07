"""Build standalone HTML via pandoc with the html-preview template."""
from __future__ import annotations

from pathlib import Path

from heinlein import pandoc


def build(*, body_md: str, template: Path, output: Path) -> Path:
    pandoc.run(
        [
            "-f", "markdown",
            "-t", "html5",
            "--standalone",
            f"--template={template}",
            "-o", str(output),
        ],
        input_bytes=body_md.encode("utf-8"),
    )
    return output
