"""Prepare the pinned Pandoc ARM64 linked-dependency source companion.

This inventories the upstream freeze's conservative build closure, not legal
clearance or a claim that every listed library is present in the executable.
The main Pandoc source is supplied separately by package_direct.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
import urllib.request

_DATA = Path(__file__).with_name("pandoc_dependency_data")
_LIMIT = 2_000_000_000
_LEGAL = re.compile(r"^(licen[cs]e|copying|copyright|notice|authors)(?:[._-].*)?$", re.I)


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as file:
        while block := file.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def _lock() -> dict:
    value = json.loads((_DATA / "lock.json").read_text())
    if value.get("schema") != 1 or not re.fullmatch(r"[0-9a-f]{64}", value.get("archive_sha256", "")):
        raise ValueError("Pandoc dependency companion lock is incomplete")
    return value


def _fetch(item: dict, directory: Path) -> Path:
    relative = PurePosixPath(item["filename"])
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Invalid pinned source path")
    path = directory.joinpath(*relative.parts)
    if path.is_file() and _digest(path) == item["sha256"]:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    # A fresh temporary path prevents a partial response from becoming a cache hit.
    temporary = path.with_suffix(path.suffix + ".partial")
    try:
        request = urllib.request.Request(item["url"], headers={"User-Agent": "Heinlein-source-companion/1"})
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("xb") as output:
            total = 0
            while block := response.read(1024 * 1024):
                total += len(block)
                if total > _LIMIT:
                    raise ValueError("Upstream source exceeds companion budget")
                output.write(block)
        if _digest(temporary) != item["sha256"]:
            raise ValueError(f"Upstream source digest mismatch: {item['filename']}")
        if "bytes" in item and temporary.stat().st_size != item["bytes"]:
            raise ValueError(f"Upstream source size mismatch: {item['filename']}")
        temporary.replace(path)
        return path
    finally:
        temporary.unlink(missing_ok=True)


def _member(archive: tarfile.TarFile, name: str, data: bytes):
    info = tarfile.TarInfo("pandoc-3.14-dependency-sources/" + name)
    info.size = len(data)
    info.mode = 0o644
    info.mtime = 0
    archive.addfile(info, io.BytesIO(data))


def _notices(sources: list[tuple[dict, Path]]) -> tuple[bytes, list[str]]:
    lines = ["Pandoc 3.14 ARM64 dependency original notices", "",
             "Conservative exact upstream build-freeze inventory. Some packages are build/test tools.",
             "Original sources and original texts are supplied; no new license grant or legal clearance is inferred.",
             "Embedded nested archives (including GHC's GMP/libffi) remain intact in the source archives.", ""]
    review = []
    for item, path in sources:
        lines.extend(["=" * 72, f"{item['name']} {item['version']}", f"Source: {item['url']}", f"SHA256: {item['sha256']}"])
        if item.get("cabal_text"):
            declarations = re.findall(r"^license\s*:\s*(.+)$", item["cabal_text"], re.I | re.M)
            if declarations:
                lines.append("Original Cabal license declaration (not substitute terms): " + declarations[0].strip())
        if not (path.name.endswith(".tar.gz") or path.name.endswith(".tar.xz")):
            continue  # Build-control patches/formula are reproduced as complete files.
        found = 0
        with tarfile.open(path, "r:*") as source:
            for member in source:
                if not member.isfile() or not _LEGAL.match(PurePosixPath(member.name).name):
                    continue
                if member.size > 2_000_000:
                    review.append(f"{item['name']}: oversized original notice remains inside source archive: {member.name}")
                    continue
                data = source.extractfile(member).read()
                if member.name.lower().endswith(".gz"):
                    try:
                        with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
                            data = compressed.read(2_000_001)
                        if len(data) > 2_000_000:
                            raise ValueError("oversized compressed original")
                    except (OSError, ValueError, EOFError):
                        review.append(f"{item['name']}: compressed notice remains inside source archive: {member.name}")
                        continue
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    review.append(f"{item['name']}: non-UTF-8 original notice remains inside source archive: {member.name}")
                    continue
                if not text.strip() or "\x00" in text:
                    continue
                found += 1
                lines.extend(["", "--- Original file: " + member.name + " ---", text])
        if not found:
            review.append(f"{item['name']}: no standalone notice detected; inspect complete source archive")
    return ("\n".join(lines) + "\n").encode(), sorted(set(review))


def _build(lock: dict, destination: Path, downloads: Path) -> list[str]:
    """Internal deterministic builder; download cache is not the public cache API."""
    items = lock["packages"] + lock["additional_sources"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        paths = list(pool.map(lambda item: _fetch(item, downloads), items))
    sources = list(zip(items, paths))
    if sum(p.stat().st_size for p in paths) > _LIMIT:
        raise ValueError("Dependency source companion exceeds 2GB budget")
    notices, review = _notices(sources)
    manifest = {key: value for key, value in lock.items() if key not in {"archive_sha256", "archive_bytes"}}
    with destination.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0, compresslevel=6) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
            for item, path in sources:
                info = tarfile.TarInfo("pandoc-3.14-dependency-sources/sources/" + item["filename"])
                info.size = path.stat().st_size; info.mode = 0o644; info.mtime = 0
                with path.open("rb") as file:
                    archive.addfile(info, file)
            _member(archive, "manifest.json", (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode())
            _member(archive, "Third-party notices.txt", notices)
            _member(archive, "Review items.json", (json.dumps(review, indent=2) + "\n").encode())
            for path in sorted(_DATA.iterdir()):
                if path.is_file() and path.name != "lock.json":
                    _member(archive, "build-evidence/" + path.name, path.read_bytes())
            for item in lock["packages"]:
                label = item['name'] + '-' + item['version']
                _member(archive, f"hackage-index-records/{label}/package.json", item["index_target_record"].encode())
                _member(archive, f"revised-cabal/{label}/{item['name']}.cabal", item["cabal_text"].encode())
    return review


def prepare_companion(destination: Path, *, cache: Path | None = None) -> dict:
    """Create a NEW adjacent source archive; cache is an optional PREBUILT archive.

    Every cache byte is hashed against the checked-in lock before reuse. Without
    a cache, fetch pinned upstream sources and build deterministically, verifying
    the resulting archive digest. A failed preparation leaves no destination.
    """
    destination = Path(destination)
    lock = _lock()
    if destination.exists():
        raise ValueError("Choose a new dependency companion destination")
    if not destination.parent.is_dir():
        raise ValueError("Dependency companion parent directory must exist")
    with tempfile.TemporaryDirectory(prefix="heinlein-pandoc-sources-", dir=destination.parent) as temporary:
        staged = Path(temporary) / lock["filename"]
        review = lock.get("review_items", [])
        if cache is not None:
            cache = Path(cache)
            if not cache.is_file() or _digest(cache) != lock["archive_sha256"]:
                raise ValueError("Cached Pandoc dependency source companion digest mismatch")
            shutil.copyfile(cache, staged)
        else:
            review = _build(lock, staged, Path(temporary) / "downloads")
        if staged.stat().st_size > _LIMIT or _digest(staged) != lock["archive_sha256"]:
            raise ValueError("Pandoc dependency source companion digest mismatch")
        if staged.stat().st_size != lock["archive_bytes"]:
            raise ValueError("Pandoc dependency source companion size mismatch")
        # Exclusive create preserves the no-overwrite contract, including symlinks.
        with destination.open("xb") as output, staged.open("rb") as source:
            try:
                shutil.copyfileobj(source, output, 1024 * 1024)
            except BaseException:
                destination.unlink(missing_ok=True)
                raise
    return {"sha256": lock["archive_sha256"], "bytes": lock["archive_bytes"],
            "filename": destination.name, "provenance": lock["provenance"], "review_items": review}
