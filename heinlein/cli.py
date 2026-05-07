"""Heinlein CLI."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from heinlein import config as cfg_mod
from heinlein.build import build as run_build


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="heinlein",
        description="Insert Coin publishing pipeline — manuscript → PDF/EPUB/DOCX/HTML/text.",
    )
    sub = parser.add_subparsers(dest="cmd", required=False)

    p_build = sub.add_parser("build", help="Build outputs from a manuscript or project.")
    p_build.add_argument(
        "manuscript", nargs="?", type=Path,
        help="Path to a markdown manuscript with frontmatter. "
             "Omit to use heinlein.yaml in the current directory.",
    )
    p_build.add_argument(
        "--output", "-o", type=Path, default=None,
        help="Output directory (default: ./dist or what heinlein.yaml says).",
    )
    p_build.add_argument(
        "--formats", "-f", default=None,
        help="Comma-separated list (pdf,epub,docx,html,text) or 'all'.",
    )
    p_build.add_argument(
        "--debug-html", action="store_true",
        help="Keep the rendered print.html next to the PDF for inspection.",
    )
    p_build.add_argument(
        "--config", type=Path, default=None,
        help="Explicit path to heinlein.yaml (default: auto-discover).",
    )

    args = parser.parse_args(argv)

    if args.cmd is None:
        parser.print_help()
        return 0

    if args.cmd == "build":
        return _cmd_build(args)

    parser.error(f"Unknown command: {args.cmd}")
    return 2


def _cmd_build(args: argparse.Namespace) -> int:
    project_yaml: Path | None = args.config
    if project_yaml is None and args.manuscript is None:
        project_yaml = cfg_mod.discover_project_yaml(Path.cwd())
        if project_yaml is None:
            print(
                "error: no manuscript path given and no heinlein.yaml found in cwd or parents.",
                file=sys.stderr,
            )
            return 2

    cfg = cfg_mod.load(
        manuscript=args.manuscript,
        project_yaml=project_yaml,
        output_override=args.output,
        formats_override=args.formats,
    )

    if not cfg.manuscript.exists():
        print(f"error: manuscript not found: {cfg.manuscript}", file=sys.stderr)
        return 2

    debug_dir = cfg.output if args.debug_html else None
    results = run_build(cfg, debug_dir=debug_dir)
    for fmt, path in results.items():
        print(f"  {fmt:5s} → {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
