"""Studio Publish: build the designed book from the live Studio manuscript.

Studio hands this module the assembled manuscript text (Library reading order,
current editor text) and the author's metadata. It runs the same
``heinlein.build.build`` pipeline as ``heinlein build``, so the PDF, EPUB and
DOCX carry the full book design, without a separate publishing-copy folder.

If the Studio project has its own ``heinlein.yaml``, Studio passes it with
``--config`` so the project's page size, accents, styles and cover apply. The
manuscript always comes from Studio; the YAML's ``manuscript:`` is ignored.
The source project is only read, never written.
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

from heinlein import config as cfg_mod
from heinlein.build import build

PUBLISH_FORMATS = ("pdf", "epub", "docx", "html", "text")


def _frontmatter(title: str, author: str, rights: str) -> str:
    # JSON is a YAML subset, so every value is safely quoted.
    front = {"title": title, "author": author}
    if rights:
        front["rights"] = rights
    return "---\n" + json.dumps(front, ensure_ascii=False) + "\n---\n"


def publish(
    *,
    manuscript: Path,
    output_dir: Path,
    formats: list[str],
    title: str,
    author: str = "",
    rights: str = "",
    language: str = "",
    project_config: Path | None = None,
) -> dict[str, Path]:
    """Build each requested format into ``output_dir``. Returns {format: path}."""
    if not formats or any(f not in PUBLISH_FORMATS for f in formats) or len(set(formats)) != len(formats):
        raise ValueError("Choose one or more of: " + ", ".join(PUBLISH_FORMATS))
    if not title.strip():
        raise ValueError("A book title is required to publish.")
    body = manuscript.read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="heinlein-publish-") as work:
        staged = Path(work) / "manuscript.md"
        staged.write_text(_frontmatter(title, author, rights) + body, encoding="utf-8")
        if project_config is not None:
            cfg = cfg_mod.load(
                manuscript=staged,
                project_yaml=project_config,
                output_override=output_dir,
                formats_override=list(formats),
            )
        else:
            cfg = cfg_mod.load(manuscript=staged, output_override=output_dir, formats_override=list(formats))
        # Studio's metadata wins: the author just reviewed it in the Publish dialog.
        cfg.metadata["title"] = title
        cfg.metadata["author"] = author
        if rights:
            cfg.metadata["rights"] = rights
        if language:
            cfg.metadata["language"] = language
        return build(cfg)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="heinlein.studio_publish")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--formats", required=True, help="Comma-separated: " + ",".join(PUBLISH_FORMATS))
    parser.add_argument("--title", required=True)
    parser.add_argument("--author", default="")
    parser.add_argument("--rights", default="")
    parser.add_argument("--language", default="")
    parser.add_argument("--config", type=Path, default=None, help="Optional project heinlein.yaml")
    args = parser.parse_args(argv)
    results = publish(
        manuscript=args.input,
        output_dir=args.output_dir,
        formats=[f.strip() for f in args.formats.split(",") if f.strip()],
        title=args.title,
        author=args.author,
        rights=args.rights,
        language=args.language,
        project_config=args.config,
    )
    # One line per artifact so the host can verify what was built.
    for fmt, path in results.items():
        print(f"{fmt}\t{path.name}")


if __name__ == "__main__":
    main()
