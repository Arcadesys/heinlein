#!/usr/bin/env python3
"""Serial, fail-fast local validation. Never installs dependencies or launches native probes."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
STUDIO = ROOT / "studio"
PACKAGES = (
    "repository-core", "proposal-store", "heinlein-local-mcp",
    "drafting-questions", "heinlein-chatgpt-auth", "github-workspace",
)
HARNESSES = (
    "crates/proposal-authority-test-harness/Cargo.toml",
    "crates/review-state-test-harness/Cargo.toml",
)
SUITES = {
    "quick": ("renderer", "smoke"),
    "studio": ("renderer", "boundaries", "browser", "native"),
    "full": ("renderer", "boundaries", "browser", "native", "publishing"),
    **{name: (name,) for name in (
        "renderer", "smoke", "browser", "boundaries", "native", "publishing"
    )},
}


def publishing_prerequisites():
    for tool in ("pandoc", "pdftotext", "uv"):
        if not shutil.which(tool):
            return f"Publishing requires {tool} on PATH"
    pinned = (ROOT / "tests/golden/PANDOC_VERSION").read_text().strip()
    version = subprocess.run(["pandoc", "--version"], capture_output=True, text=True, check=True)
    if version.stdout.splitlines()[0] != f"pandoc {pinned}":
        return f"Publishing requires pandoc {pinned} first on PATH"
    mac_browsers = (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    )
    if not any(Path(path).is_file() for path in mac_browsers) and not any(
        shutil.which(tool) for tool in ("google-chrome", "chromium", "chrome")
    ):
        return "Publishing requires Chrome/Chromium for PDF smoke coverage"
    return None


def commands(suite: str, system: str = sys.platform):
    """Yield (working directory, argv); no shell interpretation or implicit downloads."""
    for part in SUITES[suite]:
        if part == "renderer":
            yield STUDIO, ["npm", "test"]
            yield STUDIO, ["npm", "run", "build"]
        elif part in ("smoke", "browser"):
            kind = "smoke" if part == "smoke" else "full"
            yield STUDIO, ["npm", "run", f"test:browser:{kind}"]
        elif part == "boundaries":
            for location in ("macos/tests/native-standalone-probe", "../tests"):
                pattern = "test_studio_updater.py" if location == "../tests" else "test_driver.py"
                yield STUDIO, [sys.executable, "-m", "unittest", "discover", "-s", location, "-p", pattern]
            yield STUDIO, ["cargo", "test", "--locked", "--manifest-path", "macos/tests/keychain-probe/Cargo.toml"]
            yield STUDIO, ["cargo", "test", "--locked", *[arg for package in PACKAGES for arg in ("-p", package)]]
            yield STUDIO, ["cargo", "test", "--locked", "-p", "heinlein-studio", "--bin", "heinlein-studio"]
            for manifest in HARNESSES:
                yield STUDIO, ["cargo", "test", "--locked", "--manifest-path", manifest]
        elif part == "native":
            yield STUDIO, ["cargo", "fmt", "--all", "--", "--check"]
            yield STUDIO, ["cargo", "clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"]
            for manifest in HARNESSES:
                yield STUDIO, ["cargo", "clippy", "--locked", "--manifest-path", manifest, "--all-targets", "--", "-D", "warnings"]
            if system == "darwin":
                for fixture in ("", "manual/", "picker/"):
                    yield STUDIO, ["npm", "exec", "--no", "--", "vite", "build", "--config", f"macos/tests/native-standalone-probe/{fixture}vite.config.ts"]
                features = "standalone-native-acceptance,tauri/custom-protocol"
                yield STUDIO, ["cargo", "test", "--locked", "-p", "heinlein-studio", "--features", features, "isolation_tests"]
                yield STUDIO, ["cargo", "clippy", "--locked", "-p", "heinlein-studio", "--features", features, "--all-targets", "--", "-D", "warnings"]
            yield STUDIO, ["npm", "run", "tauri", "build", "--", "--no-bundle"]
        elif part == "publishing":
            yield ROOT, ["uv", "run", "--locked", "--extra", "dev", "pytest", "-ra"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", choices=SUITES, nargs="?", default="quick")
    parser.add_argument("--dry-run", action="store_true", help="Print commands without executing them")
    args = parser.parse_args(argv)
    env = os.environ.copy()
    # Node 26's experimental Web Storage interferes with jsdom's test storage.
    # Node 22 (the hosted version) accepts this flag too.
    env["NODE_OPTIONS"] = f"{env.get('NODE_OPTIONS', '')} --no-experimental-webstorage".strip()
    env["HEINLEIN_REQUIRE_GOLDENS"] = "1"
    # Share compiled dependencies across the workspace and isolated test harnesses.
    env.setdefault("CARGO_TARGET_DIR", str(STUDIO / "target"))
    if "publishing" in SUITES[args.suite] and env.get("UPDATE_GOLDEN") == "1":
        parser.error("UPDATE_GOLDEN=1 is forbidden during validation")
    if not args.dry_run and "publishing" in SUITES[args.suite]:
        try:
            error = publishing_prerequisites()
        except (OSError, subprocess.CalledProcessError, IndexError) as failure:
            error = str(failure)
        if error:
            print(f"{error}. See docs/testing/local-validation.md", file=sys.stderr)
            return 1
    if not args.dry_run:
        print(f"Local validation: {args.suite} ({sys.platform}); failures stop the run.", flush=True)
        subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, check=True)
        subprocess.run(["git", "status", "--short"], cwd=ROOT, check=True)
    for directory, command in commands(args.suite):
        print(f"[{directory.relative_to(ROOT) or '.'}] {shlex.join(command)}", flush=True)
        if args.dry_run:
            continue
        try:
            subprocess.run(command, cwd=directory, env=env, check=True)
        except FileNotFoundError as error:
            print(f"Missing prerequisite: {error.filename}. See docs/testing/local-validation.md", file=sys.stderr)
            return 127
        except subprocess.CalledProcessError as error:
            print(f"Validation stopped: {shlex.join(command)} (exit {error.returncode})", file=sys.stderr)
            return error.returncode if error.returncode > 0 else 1
    if not args.dry_run:
        print(f"Local validation passed: {args.suite} ({sys.platform}). Review any reported skips.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
