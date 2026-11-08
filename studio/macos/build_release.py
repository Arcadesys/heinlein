"""Build an explicitly selected public release in a disposable private directory.

Invoked by the native app with a sanitized environment. Never installs or launches.
Only the resulting app is retained; subprocess output goes to a private log.
"""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile


def run(args, cwd, log, timeout=1800):
    process = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL,
                               stdout=log, stderr=log, start_new_session=True)
    try:
        if process.wait(timeout=timeout):
            raise RuntimeError("Build command failed")
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise RuntimeError("Build timed out") from None


def build(version):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Invalid release version")
    work = Path(tempfile.mkdtemp(prefix="heinlein-release-build-"))
    try:
        source = work / "source"
        with (work / "build.log").open("wb") as log:
            run(["git", "-c", "credential.helper=", "clone", "--depth", "1",
                 "--branch", "v" + version, "--",
                 "https://github.com/Arcadesys/heinlein.git", str(source)], work, log, 120)
            studio = source / "studio"
            if json.loads((studio / "package.json").read_text())["version"] != version:
                raise ValueError("Release source version mismatch")
            run(["npm", "ci"], studio, log)
            run(["npm", "run", "tauri", "build", "--", "--config",
                 "src-tauri/tauri.release.conf.json", "--bundles", "app", "--ci"], studio, log)
            app = studio / "target/release/bundle/macos/Heinlein Studio.app"
            run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], work, log, 60)
            output = work / "Heinlein Studio.app"
            shutil.move(str(app), output)
        shutil.rmtree(source)
        return output
    except BaseException:
        shutil.rmtree(work)
        raise


if __name__ == "__main__":
    try:
        print(build(sys.argv[1]))
    except Exception:
        print("Release build failed; check Python, Git, Node/npm, Rust and Apple build tools.", file=sys.stderr)
        sys.exit(1)
