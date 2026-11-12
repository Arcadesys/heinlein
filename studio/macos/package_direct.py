#!/usr/bin/env python3
"""Build a direct-download Apple Silicon DMG from the committed Studio source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit

import bundled_pandoc
import pandoc_dependency_sources
from third_party_notices import write_notices

ROOT = Path(__file__).resolve().parents[2]
NAME = "Heinlein Studio"
BUNDLE_ID = "me.thearcades.heinlein.studio"


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def public_page(url):
    parts = urlsplit(url)
    if (not url.isascii() or any(ord(char) <= 32 or ord(char) == 127 for char in url)
            or parts.scheme != "https" or not parts.hostname or parts.username is not None
            or any(char in url for char in "?#\\") or len(url) > 2000):
        raise ValueError("Use a public HTTPS downloads page without credentials, query or fragment.")
    _ = parts.port  # Reject malformed port numbers before starting the build.
    return url


def build_app(work, commit):
    source = work / "source"
    source.mkdir()
    archive = work / "source.tar"
    run("git", "-C", ROOT, "archive", "--format=tar", "-o", archive, commit)
    with tarfile.open(archive) as tracked:
        tracked.extractall(source, filter="data")
    studio = source / "studio"
    target = work / "target"
    env = {**os.environ, "CARGO_TARGET_DIR": str(target), "PYTHONDONTWRITEBYTECODE": "1",
           "OPENSSL_STATIC": "1", "MACOSX_DEPLOYMENT_TARGET": "15.0", "VITE_HEINLEIN_DIRECT_MAC": "1"}
    # Keep Tauri's intermediate build ad-hoc. Only the final staged bundle goes to Apple.
    for key in list(env):
        if key.startswith("APPLE_") or key == "TAURI_SIGNING_PRIVATE_KEY":
            del env[key]
    run("npm", "ci", cwd=studio, env=env)
    run("npm", "run", "tauri", "build", "--", "--config", "src-tauri/tauri.release.conf.json",
        "--config", '{"bundle":{"macOS":{"minimumSystemVersion":"15.0"}}}',
        "--bundles", "app", "--ci", "--", "--locked", cwd=studio, env=env)
    return target / "release/bundle/macos" / f"{NAME}.app"


def inspect_app(app):
    contents = app / "Contents"
    info = plistlib.loads((contents / "Info.plist").read_bytes())
    version = info["CFBundleShortVersionString"]
    if info["CFBundleIdentifier"] != BUNDLE_ID or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Unexpected app identity or version.")
    binary = contents / "MacOS" / info["CFBundleExecutable"]
    if info.get("LSMinimumSystemVersion") != "15.0":
        raise ValueError("The paid app must declare macOS 15.0 as its minimum version.")
    inspect_binary(binary)
    return version


def inspect_binary(binary):
    if output("lipo", "-archs", binary) != "arm64":
        raise ValueError(f"Expected an Apple Silicon executable: {binary.name}")
    for line in output("otool", "-L", binary).splitlines()[1:]:
        library = line.strip().partition(" (compatibility version")[0]
        if library.startswith("/") and not library.startswith(("/System/Library/", "/usr/lib/")):
            raise ValueError(f"The app links to a library on the build machine: {library}")
    load_commands = output("xcrun", "vtool", "-show-build", binary)
    minimum = re.search(r"^\s*minos (\d+)\.(\d+)", load_commands, re.MULTILINE)
    if not minimum or tuple(map(int, minimum.groups())) > (15, 0):
        raise ValueError(f"{binary.name} cannot run on the advertised macOS 15.0 minimum.")


def check_converter(app):
    helper = app / "Contents/Helpers/pandoc"
    inspect_binary(helper)
    if output(helper, "--version").splitlines()[0] != f"pandoc {bundled_pandoc.VERSION}":
        raise ValueError("Unexpected document converter version.")


def verify_image(dmg, work, page, version, commercial):
    run("hdiutil", "verify", dmg)
    if commercial:
        run("xcrun", "stapler", "validate", dmg)
        run("spctl", "--assess", "--type", "open", "--context", "context:primary-signature", dmg)
    mount = work / "mounted"
    mount.mkdir()
    run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg)
    try:
        app = mount / f"{NAME}.app"
        if inspect_app(app) != version or os.readlink(mount / "Applications") != "/Applications":
            raise ValueError("The mounted image does not match the expected installer.")
        marker = app / "Contents/Resources/direct-download.json"
        if json.loads(marker.read_bytes()) != {"url": page}:
            raise ValueError("The mounted app has the wrong purchased-downloads page.")
        check_converter(app)
        bundled_pandoc.check_hash(mount / "Converter source" / bundled_pandoc.SOURCE_FILENAME,
                                  bundled_pandoc.SOURCE_SHA256)
        run("codesign", "--verify", "--deep", "--strict", app)
        if commercial:
            run("spctl", "--assess", "--type", "execute", app)
    finally:
        run("hdiutil", "detach", mount)


def package(args):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("Build this Apple Silicon installer on an Apple Silicon Mac.")
    identity = args.identity
    if not args.rehearsal:
        if not identity or not identity.startswith("Developer ID Application: ") or not args.notary_profile:
            raise ValueError("Provide --identity and --notary-profile, or explicitly select --rehearsal.")
        if f'"{identity}"' not in output("security", "find-identity", "-v", "-p", "codesigning"):
            raise ValueError("The specified Developer ID Application identity is unavailable in Keychain.")
    elif identity or args.notary_profile:
        raise ValueError("A rehearsal uses ad-hoc signing and takes no signing or notary credentials.")
    dest = args.output.absolute()
    if dest.exists():
        raise ValueError("Choose a new output directory.")
    if not dest.parent.is_dir():
        raise ValueError("The output parent directory must already exist.")
    commit = output("git", "-C", ROOT, "rev-parse", "HEAD")
    if subprocess.run(["git", "-C", ROOT, "diff", "--quiet", commit, "--", "studio", "heinlein"]).returncode:
        raise ValueError("Commit the selected Studio and publishing changes before packaging.")
    print(f"Building committed source {commit}", flush=True)
    with tempfile.TemporaryDirectory(prefix=".heinlein-package-", dir=dest.parent) as tmp:
        work = Path(tmp)
        app = build_app(work, commit)
        version = inspect_app(app)
        stage = work / "image"
        stage.mkdir()
        app = app.rename(stage / app.name)
        (stage / "Applications").symlink_to("/Applications")
        resources = app / "Contents/Resources"
        notices = write_notices(work / "source/studio", resources / "Third-party notices.txt")
        (resources / "direct-download.json").write_text(json.dumps({"url": args.downloads_page}) + "\n")
        signer = identity or "-"
        stamp = "--timestamp" if identity else "--timestamp=none"
        helper = bundled_pandoc.stage_converter(work, stage, app)
        run("codesign", "--force", "--options", "runtime", stamp, "--sign", signer, helper)
        check_converter(app)
        run("codesign", "--force", "--options", "runtime", stamp, "--sign", signer, app)
        run("codesign", "--verify", "--deep", "--strict", app)
        ready = work / "artifacts"
        ready.mkdir()
        companion = ready / "pandoc-3.14-dependency-sources.tar.gz"
        companion_info = pandoc_dependency_sources.prepare_companion(companion, cache=args.pandoc_source_cache)
        suffix = "-rehearsal" if args.rehearsal else ""
        dmg = ready / f"Heinlein-Studio-{version}-macos-arm64{suffix}.dmg"
        run("hdiutil", "create", "-volname", NAME, "-srcfolder", stage, "-fs", "HFS+",
            "-format", "UDZO", dmg)
        receipt = {"commit": commit, "version": version, "architecture": "arm64",
                   "downloadsPage": args.downloads_page, "mode": "rehearsal" if args.rehearsal else "Developer ID"}
        receipt["minimumMacOS"] = "15.0"
        receipt["documentConverter"] = {"name": "Pandoc", "version": bundled_pandoc.VERSION,
                                        "upstreamArchiveSha256": bundled_pandoc.RELEASE_SHA256,
                                        "upstreamSourceSha256": bundled_pandoc.SOURCE_SHA256,
                                        "dependencySources": companion_info}
        receipt["thirdPartyNotices"] = {
            "npmPackages": notices["npm_packages"], "cargoPackages": notices["cargo_packages"],
            "review": notices["review_items"],
        }
        if notices["review_items"]:
            print(f"Third-party notices include {len(notices['review_items'])} items to review in build.json.", flush=True)
        if not args.rehearsal:
            run("codesign", "--sign", signer, "--timestamp", "--identifier", BUNDLE_ID + ".dmg", dmg)
            ticket = json.loads(output("xcrun", "notarytool", "submit", dmg, "--wait", "--keychain-profile",
                                       args.notary_profile, "--output-format", "json"))
            if ticket.get("status") != "Accepted":
                raise ValueError(f"Apple notarization status {ticket.get('status')} (submission {ticket.get('id')}).")
            receipt["notarySubmission"] = ticket["id"]
            run("xcrun", "stapler", "staple", dmg)
        verify_image(dmg, work, args.downloads_page, version, commercial=not args.rehearsal)
        with dmg.open("rb") as image:
            receipt["sha256"] = hashlib.file_digest(image, "sha256").hexdigest()
        (ready / "SHA256SUMS").write_text(f"{receipt['sha256']}  {dmg.name}\n"
                                         f"{companion_info['sha256']}  {companion.name}\n")
        (ready / "build.json").write_text(json.dumps(receipt, indent=2) + "\n")
        # Same filesystem. A concurrent successful build leaves a nonempty destination
        # that rename cannot replace; buyers never see a partially assembled directory.
        ready.rename(dest)
        print(dest / dmg.name, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--downloads-page", type=public_page, required=True,
                        help="Public, shareable HTTPS page where customers can retrieve purchases")
    parser.add_argument("--output", type=Path, required=True, help="New directory for verified artifacts")
    parser.add_argument("--pandoc-source-cache", type=Path,
                        help="Optional previously built Pandoc dependency source archive, verified against its pinned digest")
    parser.add_argument("--identity", help="Exact Developer ID Application name in Keychain")
    parser.add_argument("--notary-profile", help="Name of an existing notarytool Keychain profile")
    parser.add_argument("--rehearsal", action="store_true", help="Build a local, ad-hoc test DMG without notarization")
    try:
        package(parser.parse_args())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Packaging stopped: {error}\n")


if __name__ == "__main__":
    main()
