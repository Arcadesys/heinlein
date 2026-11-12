"""Collect installed dependency notices without inventing missing permissions.

Run after npm ci and the Cargo build. This is a best-effort inventory, not legal
clearance or proof that every resolved build dependency is linked into the app.
"""
from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote


_LEGAL = re.compile(r"^(licen[cs]e|copying|copyright|notice|authors)(?:[._-].*)?$", re.I)
_SKIP = {"node_modules", ".git", "target"}


def _texts(root: Path, review: list[str], label: str, declared: str | None = None, *, missing=True):
    """Return complete UTF-8 upstream texts; report omissions explicitly."""
    if not root.is_dir():
        review.append(f"{label}: installed package directory unavailable; upstream texts missing.")
        return []
    candidates = set()
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in _SKIP and not (Path(directory) / d).is_symlink())
        for name in files:
            if _LEGAL.match(name):
                candidates.add(Path(directory) / name)
    if declared:
        path = root / declared
        if path.resolve().is_relative_to(root.resolve()):
            candidates.add(path)
        else:
            review.append(f"{label}: declared license file is outside the package; review required.")
    result = []
    for path in sorted(candidates, key=lambda p: p.relative_to(root).as_posix()):
        name = path.relative_to(root).as_posix()
        try:
            if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                raise ValueError("symlink or external path")
            data = path.read_bytes()
            if len(data) > 2_000_000:
                raise ValueError("text exceeds inventory limit")
            text = data.decode("utf-8")
            if not text.strip() or "\x00" in text:
                raise ValueError("empty or non-text file")
            result.append((name, text))
        except (OSError, UnicodeError, ValueError):
            review.append(f"{label}: upstream text {name} could not be included; review required.")
    if not result and missing:
        review.append(f"{label}: no readable upstream license/copyright/NOTICE text found.")
    return result


def _supplement(studio: Path, package: dict, review: list[str], label: str):
    """Use bundled originals only for byte/version/commit-matched crate releases."""
    directory = studio / "macos/upstream_notices"
    try:
        manifest = json.loads((directory / "manifest.json").read_text())
        record = next(r for r in manifest["packages"]
                      if (r["name"], r["version"]) == (package["name"], package["version"]))
    except (OSError, ValueError, KeyError, StopIteration):
        return [], False
    try:
        root = Path(package["manifest_path"]).parent
        vcs = json.loads((root / ".cargo_vcs_info.json").read_text())
        if (package.get("license") != record["license"]
                or package.get("repository", "").rstrip("/") != record["repository"]
                or vcs["git"]["sha1"] != record["commit"] or vcs["path_in_vcs"] != record["path"]
                or hashlib.sha256((root / "Cargo.toml.orig").read_bytes()).hexdigest() != record["manifest_sha256"]):
            raise ValueError("crate provenance mismatch")
        evidence = record.get("license_evidence")
        if evidence:
            path = root / evidence["package_file"]
            if (not path.resolve().is_relative_to(root.resolve())
                    or hashlib.sha256(path.read_bytes()).hexdigest() != evidence["sha256"]):
                raise ValueError("license declaration mismatch")
        texts = []
        for original in record["texts"]:
            path = directory / original["file"]
            if not path.resolve().is_relative_to(directory.resolve()) or path.is_symlink():
                raise ValueError("supplement path mismatch")
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != original["sha256"]:
                raise ValueError("supplement content mismatch")
            texts.append((f"Supplemental original: {original['url']} (SHA256 {original['sha256']})", data.decode("utf-8")))
        texts.insert(0, ("Supplement provenance", f"Exact upstream crate manifest: {record['cargo_toml_url']}\n"
                        f"Original manifest SHA256: {record['manifest_sha256']}\n"
                        f"Crate release VCS commit: {record['commit']}\n"))
        if evidence:
            texts.append((f"Release license declaration: {evidence['url']}", evidence["header"]))
        return texts, record["complete_terms"]
    except (OSError, ValueError, KeyError, TypeError):
        review.append(f"{label}: supplemental provenance/content did not match this crate release; review required.")
        return [], False


def _npm(studio: Path, review: list[str]):
    try:
        lock = json.loads((studio / "package-lock.json").read_text())
        packages = lock["packages"]
    except (OSError, ValueError, KeyError):
        review.append("npm: package-lock packages inventory unavailable; production notices incomplete.")
        return []
    result = []
    for relative, item in sorted(packages.items()):
        if not relative or item.get("dev"):
            continue
        # Reject unexpected lock paths before reading any local package files.
        path = studio / relative
        if not relative.startswith("node_modules/") or not path.resolve().is_relative_to((studio / "node_modules").resolve()):
            review.append("npm: unsupported package location omitted; inventory needs review.")
            continue
        name = item.get("name") or relative.rsplit("node_modules/", 1)[-1]
        version = item.get("version", "unknown")
        label = f"npm {name}@{version}"
        installed = {}
        try:
            installed = json.loads((path / "package.json").read_text())
        except (OSError, ValueError):
            review.append(f"{label}: installed package metadata unavailable.")
        if installed.get("version") and installed["version"] != version:
            review.append(f"{label}: installed version differs from lockfile; texts require review.")
        license_value = installed.get("license") or item.get("license") or "UNIDENTIFIED"
        if not isinstance(license_value, str):
            license_value = json.dumps(license_value, sort_keys=True)
        if license_value == "UNIDENTIFIED":
            review.append(f"{label}: license identifier missing; no permission inferred.")
        links = [f"https://www.npmjs.com/package/{quote(name, safe='@/')}/v/{quote(version, safe='')}"]
        if str(item.get("resolved", "")).startswith("https://registry.npmjs.org/"):
            links.append(f"https://registry.npmjs.org/{quote(name, safe='@/')}/-/{quote(name.rsplit('/', 1)[-1] + '-' + version, safe='')}.tgz")
        else:
            review.append(f"{label}: registry archive provenance unconfirmed; exact source access needs review.")
        result.append((label, license_value, links, _texts(path, review, label)))
    return result


def _command(args, studio: Path):
    return subprocess.run(args, cwd=studio, check=True, capture_output=True, text=True, timeout=120).stdout


def _cargo(studio: Path, review: list[str]):
    target = "aarch64-apple-darwin"
    try:
        host = next(line.split(": ", 1)[1] for line in _command(["rustc", "-vV"], studio).splitlines() if line.startswith("host: "))
        if host in {"aarch64-apple-darwin", "x86_64-apple-darwin"}:
            target = host
        else:
            review.append("Cargo: non-macOS host; inventory uses aarch64-apple-darwin, review intended release target.")
    except (OSError, subprocess.SubprocessError, StopIteration):
        review.append("Cargo: host target unavailable; inventory uses aarch64-apple-darwin, review intended release target.")
    try:
        metadata = json.loads(_command(["cargo", "metadata", "--locked", "--offline", "--format-version", "1", "--filter-platform", target], studio))
        packages = {p["id"]: p for p in metadata["packages"]}
        nodes = {n["id"]: n for n in metadata["resolve"]["nodes"]}
        root = next(p["id"] for p in metadata["packages"] if p["name"] == "heinlein-studio")
        seen, pending = set(), [root]
        while pending:
            key = pending.pop()
            if key in seen:
                continue
            seen.add(key)
            for dep in nodes[key]["deps"]:
                if any(kind["kind"] != "dev" for kind in dep["dep_kinds"]):
                    pending.append(dep["pkg"])
    except (OSError, ValueError, KeyError, TypeError, StopIteration, subprocess.SubprocessError):
        review.append("Cargo: locked offline dependency metadata unavailable; Cargo notices incomplete.")
        return [], target
    result = []
    for package in sorted((packages[key] for key in seen), key=lambda p: (p["name"], p["version"])):
        source = package.get("source")
        if not source:  # Workspace code is not an upstream third-party package.
            continue
        name, version = package["name"], package["version"]
        label = f"Cargo {name}@{version}"
        license_value = package.get("license") or "UNIDENTIFIED"
        if license_value == "UNIDENTIFIED":
            review.append(f"{label}: license identifier missing; inspect declared license text, no permission inferred.")
        links = []
        if source in {"registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/"}:
            links = [f"https://crates.io/api/v1/crates/{quote(name, safe='')}/{quote(version, safe='')}/download",
                     f"https://docs.rs/crate/{quote(name, safe='')}/{quote(version, safe='')}/source/"]
        else:
            review.append(f"{label}: non-crates.io source; exact source access needs review.")
        if "MPL" in license_value:
            review.append(f"{label}: MPL covered-source availability/recipient notice obligations need review; exact crate source links included.")
        texts = _texts(Path(package["manifest_path"]).parent, review, label, package.get("license_file"), missing=False)
        if not texts:
            texts, complete = _supplement(studio, package, review, label)
            if not complete:
                suffix = " Verified upstream licensing explanation is included." if texts else ""
                review.append(f"{label}: full upstream license/copyright/NOTICE text missing or unverified.{suffix}")
        result.append((label, license_value, links, texts))
    return result, target


def write_notices(studio: Path, destination: Path) -> dict:
    """Write a deterministic UTF-8 Resources notice file and return review counts.

    Missing dependency metadata/text becomes visible review material. An unwritable
    destination still raises OSError, so callers cannot mistake a missing file for
    a successful package. No network downloads or legal grants are synthesized.
    """
    studio, destination = Path(studio), Path(destination)
    review: list[str] = []
    npm = _npm(studio, review)
    cargo, target = _cargo(studio, review)
    review = sorted(set(review))
    lines = ["Heinlein Studio — third-party dependency notices", "",
             "Best-effort installed/locked dependency inventory; not legal clearance.",
             "npm production lock entries; Cargo normal/build closure from heinlein-studio,",
             f"default resolved features, target {target}. Build/proc-macro dependencies may",
             "not be shipped. Optional feature, platform and bundled-tool coverage needs review.",
             "Source archive links identify exact package versions, including MPL covered source.",
             "Upstream texts below are reproduced without added permission grants.", "",
             "REVIEW ITEMS (not a development-build gate)"]
    lines.extend(f"- {entry}" for entry in review)
    if not review:
        lines.append("- No missing metadata/text detected; distribution obligations still need review.")
    for label, license_value, links, texts in npm + cargo:
        lines.extend(["", "=" * 72, label, f"Declared license: {license_value}"])
        lines.extend(f"Exact package source: {link}" for link in links)
        if not texts:
            lines.append("UPSTREAM TEXT MISSING — review required; no license grant inferred.")
        for name, text in texts:
            lines.extend(["", f"--- Upstream file: {name} ---", text])
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"npm_packages": len(npm), "cargo_packages": len(cargo), "cargo_target": target, "review_items": review}
