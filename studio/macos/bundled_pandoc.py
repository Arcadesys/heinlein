"""Stage the direct Mac edition's pinned offline document converter."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile

VERSION = "3.14"
COMMIT = "3dde36a9ddd68b8677397d9c59c891d9b8763b89"
ARCHIVE = f"pandoc-{VERSION}-arm64-macOS.zip"
RELEASE_URL = f"https://github.com/jgm/pandoc/releases/download/{VERSION}/{ARCHIVE}"
RELEASE_SHA256 = "58d6593884fec9d4424b641b92503c316d9c36decb2891ff8d73ae74dd3b6304"
SOURCE_URL = f"https://codeload.github.com/jgm/pandoc/tar.gz/{COMMIT}"
SOURCE_FILENAME = f"pandoc-{VERSION}-source.tar.gz"
SOURCE_SHA256 = "7af064b201d137217032419806a8953afaa946dbee87db9d6f15b2ef0773ea0b"


def check_hash(path: Path, expected: str):
    with path.open("rb") as file:
        actual = hashlib.file_digest(file, "sha256").hexdigest()
    if actual != expected:
        raise ValueError(f"Upstream checksum mismatch for {path.name}.")


def download(url: str, path: Path, sha256: str):
    subprocess.run(["/usr/bin/curl", "--fail", "--silent", "--show-error", "--location",
                    "--proto", "=https", "--proto-redir", "=https", "--retry", "3",
                    "--max-time", "300", "--output", path, url], check=True)
    check_hash(path, sha256)


def stage_converter(work: Path, image: Path, app: Path) -> Path:
    archive = work / ARCHIVE
    download(RELEASE_URL, archive, RELEASE_SHA256)
    helper = app / "Contents/Helpers/pandoc"
    helper.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as zipped:
        with zipped.open(f"pandoc-{VERSION}-arm64/bin/pandoc") as source, helper.open("xb") as destination:
            shutil.copyfileobj(source, destination)
    helper.chmod(0o755)

    sources = image / "Converter source"
    sources.mkdir()
    source_archive = sources / SOURCE_FILENAME
    download(SOURCE_URL, source_archive, SOURCE_SHA256)
    notices = app / "Contents/Resources/licenses/pandoc"
    notices.mkdir(parents=True, exist_ok=True)
    with tarfile.open(source_archive, "r:gz") as source:
        for name in ["COPYING.md", "COPYRIGHT", "AUTHORS.md"]:
            member = source.getmember(f"pandoc-{COMMIT}/{name}")
            if not member.isfile() or member.size > 1024 * 1024:
                raise ValueError(f"Unexpected Pandoc source archive member {name}.")
            with source.extractfile(member) as file:
                (notices / name).write_bytes(file.read())
    (notices / "Source.txt").write_text(
        f"Heinlein Studio runs Pandoc {VERSION} as a separate executable for DOCX and EPUB.\n"
        f"The installer contains the upstream Pandoc source and build scripts in Converter source/{SOURCE_FILENAME}.\n"
        f"Get pandoc-{VERSION}-dependency-sources.tar.gz with this DMG from the same download page. "
        "It contains dependency sources, notices and build information for the bundled converter.\n"
        f"Upstream source revision: https://github.com/jgm/pandoc/tree/{COMMIT}\n"
        f"Original binary distribution: {RELEASE_URL}\n", encoding="utf-8")
    return helper
