"""Heinlein CLI."""
from __future__ import annotations

import argparse
import sys
import webbrowser
from importlib.metadata import version
from pathlib import Path

from heinlein import config as cfg_mod
from heinlein.build import build as run_build


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="heinlein",
        description="FREE PLAY Publishing pipeline — manuscript → PDF/EPUB/DOCX/HTML/text.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {version('heinlein')}")
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
    p_build.add_argument(
        "--source-format", choices=("markdown", "twine1"), default=None,
        help="Input format (default: markdown, or source_format in heinlein.yaml).",
    )
    p_build.add_argument("--author", default=None, help="Override the edition byline.")
    p_build.add_argument("--twine-start", default=None, help="Twine 1 start passage.")
    p_build.add_argument(
        "--twine-exclude", action="append", default=None,
        help="Twine 1 passage to exclude; may be repeated.",
    )
    p_build.add_argument(
        "--restart-label", default=None,
        help="Label for the Twine gamebook restart link.",
    )
    p_build.add_argument(
        "--back-label", default=None,
        help="Label for the Twine gamebook back link.",
    )

    p_serve = sub.add_parser(
        "serve",
        help="Run the local preview + gallery server.",
    )
    p_serve.add_argument(
        "manuscript", nargs="?", type=Path,
        help="Path to a markdown manuscript. Omit to use heinlein.yaml in cwd.",
    )
    p_serve.add_argument("--config", type=Path, default=None, help="Explicit heinlein.yaml path.")
    p_serve.add_argument("--output", "-o", type=Path, default=None, help="Build output directory.")
    p_serve.add_argument(
        "--archive", type=Path, default=None,
        help="Directory containing other built projects to list in the gallery.",
    )
    p_serve.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1).")
    p_serve.add_argument("--port", type=int, default=8765, help="Bind port (default: 8765).")
    p_serve.add_argument("--no-open", action="store_true", help="Don't open the gallery in a browser.")
    p_serve.add_argument("--no-build", action="store_true", help="Skip the initial build on startup.")

    p_web = sub.add_parser(
        "web",
        help="Run the upload/build web app — drop a markdown manuscript and images, get built outputs.",
    )
    p_web.add_argument(
        "--workspace", type=Path, default=None,
        help="Directory where uploaded projects live (default: ~/heinlein-projects).",
    )
    p_web.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1).")
    p_web.add_argument("--port", type=int, default=8770, help="Bind port (default: 8770).")
    p_web.add_argument("--no-open", action="store_true", help="Don't open the app in a browser.")

    args = parser.parse_args(argv)

    if args.cmd is None:
        parser.print_help()
        return 0

    if args.cmd == "build":
        return _cmd_build(args)
    if args.cmd == "serve":
        return _cmd_serve(args)
    if args.cmd == "web":
        return _cmd_web(args)

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
        source_format_override=args.source_format,
        twine_start_override=args.twine_start,
        twine_exclude_override=tuple(args.twine_exclude) if args.twine_exclude else None,
        twine_restart_label_override=args.restart_label,
        twine_back_label_override=args.back_label,
        author_override=args.author,
    )

    if not cfg.manuscript.exists():
        print(f"error: manuscript not found: {cfg.manuscript}", file=sys.stderr)
        return 2

    debug_dir = cfg.output if args.debug_html else None
    results = run_build(cfg, debug_dir=debug_dir)
    for fmt, path in results.items():
        print(f"  {fmt:5s} → {path}")
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    from heinlein.serve import Server

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
        archive_override=args.archive,
    )

    if not cfg.manuscript.exists():
        print(f"error: manuscript not found: {cfg.manuscript}", file=sys.stderr)
        return 2

    if args.host != "127.0.0.1" and args.host != "localhost":
        print(
            f"warning: binding to {args.host} exposes your filesystem on the network.",
            file=sys.stderr,
        )

    server = Server(cfg, host=args.host, port=args.port)
    if not args.no_build:
        print(f"[heinlein] initial build → {cfg.output}", file=sys.stderr)
        try:
            server.initial_build()
        except Exception as e:
            print(f"warning: initial build failed: {e}", file=sys.stderr)

    url = f"http://{args.host}:{args.port}/"
    print(f"[heinlein] serving on {url}  (Ctrl-C to stop)", file=sys.stderr)
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[heinlein] stopping.", file=sys.stderr)
        server.shutdown()
    return 0


def _cmd_web(args: argparse.Namespace) -> int:
    from heinlein.web import run

    workspace = args.workspace.resolve() if args.workspace else Path.home() / "heinlein-projects"
    workspace.mkdir(parents=True, exist_ok=True)

    if args.host != "127.0.0.1" and args.host != "localhost":
        print(
            f"warning: binding to {args.host} exposes your filesystem on the network.",
            file=sys.stderr,
        )

    url = f"http://{args.host}:{args.port}/"
    print(f"[heinlein] web app on {url}", file=sys.stderr)
    print(f"[heinlein] workspace: {workspace}", file=sys.stderr)
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        run(workspace=workspace, host=args.host, port=args.port)
    except KeyboardInterrupt:
        print("\n[heinlein] stopping.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
