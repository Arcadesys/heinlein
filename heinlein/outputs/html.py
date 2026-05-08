"""Build standalone HTML via pandoc with the html-preview template."""
from __future__ import annotations

from pathlib import Path

from heinlein import pandoc


def build(*, body_md: str, template: Path, output: Path, resource_path: Path | None = None) -> Path:
    args = [
        "-f", "markdown",
        "-t", "html5",
        "--standalone",
        "--embed-resources",
        f"--template={template}",
        "-o", str(output),
    ]
    if resource_path is not None:
        args += [f"--resource-path={resource_path}"]
    pandoc.run(
        args,
        input_bytes=body_md.encode("utf-8"),
    )
    return output
