"""Focused artifact checks; no network, installed app or author data."""
import importlib.util
import json
import hashlib
from pathlib import Path
import subprocess
from unittest.mock import patch


_SOURCE = Path(__file__).resolve().parents[1] / "studio/macos/third_party_notices.py"
_SPEC = importlib.util.spec_from_file_location("third_party_notices", _SOURCE)
notices = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(notices)


def npm(studio, entries):
    (studio / "package-lock.json").write_text(json.dumps({"packages": {"": {}, **entries}}))


def installed(studio, relative, *, name="sample", version="1.0.0", license="MIT", text="Copyright Example\nExact license text.\n"):
    root = studio / relative
    root.mkdir(parents=True)
    (root / "package.json").write_text(json.dumps({"name": name, "version": version, "license": license}))
    if text is not None:
        (root / "LICENSE").write_text(text)
    return root


def cargo(studio, definitions=()):
    packages = [{"id": "app", "name": "heinlein-studio", "version": "1.0.0", "source": None}]
    deps, nodes = [], []
    for name, kind, license in definitions:
        root = studio / "cache" / name
        root.mkdir(parents=True)
        (root / "LICENSE").write_text(f"Exact upstream {name} text\n")
        packages.append({"id": name, "name": name, "version": "2.0.0", "license": license,
                         "source": "registry+https://github.com/rust-lang/crates.io-index",
                         "manifest_path": str(root / "Cargo.toml")})
        deps.append({"pkg": name, "dep_kinds": [{"kind": kind}]})
        nodes.append({"id": name, "deps": []})
    return {"packages": packages, "resolve": {"nodes": [{"id": "app", "deps": deps}, *nodes]}}


def command_for(metadata):
    def command(args, studio):
        if args[0] == "rustc":
            return "host: aarch64-apple-darwin\n"
        assert args == ["cargo", "metadata", "--locked", "--offline", "--format-version", "1", "--filter-platform", "aarch64-apple-darwin"]
        return json.dumps(metadata)
    return command


def test_exact_font_text_and_production_sources_are_retained_deterministically(tmp_path):
    npm(tmp_path, {"node_modules/@fontsource/opendyslexic": {"version": "5.3.0", "license": "OFL-1.1", "resolved": "https://registry.npmjs.org/whatever"},
                   "node_modules/dev-only": {"version": "1.0.0", "dev": True}})
    exact = "Copyright Example\r\nReserved Font Name OpenDyslexic.\r\nExact OFL terms.\r\n"
    root = installed(tmp_path, "node_modules/@fontsource/opendyslexic", name="@fontsource/opendyslexic", version="5.3.0", license="OFL-1.1")
    (root / "LICENSE").write_bytes(exact.encode())
    destination = tmp_path / "app/Contents/Resources/THIRD-PARTY-NOTICES.txt"
    with patch.object(notices, "_command", side_effect=command_for(cargo(tmp_path))):
        result = notices.write_notices(tmp_path, destination)
        first = destination.read_bytes()
        notices.write_notices(tmp_path, destination)
    assert destination.read_bytes() == first
    assert exact.encode() in first
    text = first.decode()
    assert "OFL-1.1" in text and "opendyslexic-5.3.0.tgz" in text
    assert "dev-only" not in text and str(tmp_path) not in text
    assert result["npm_packages"] == 1 and result["review_items"] == []


def test_cargo_includes_normal_and_build_mpl_source_but_excludes_dev(tmp_path):
    npm(tmp_path, {})
    metadata = cargo(tmp_path, [("cssparser", None, "MPL-2.0"), ("builder", "build", "Apache-2.0 AND ISC"), ("dev-helper", "dev", "MIT")])
    destination = tmp_path / "notices.txt"
    with patch.object(notices, "_command", side_effect=command_for(metadata)):
        result = notices.write_notices(tmp_path, destination)
    text = destination.read_text()
    assert result["cargo_packages"] == 2
    assert "https://crates.io/api/v1/crates/cssparser/2.0.0/download" in text
    assert "https://docs.rs/crate/cssparser/2.0.0/source/" in text
    assert "MPL covered-source availability/recipient notice obligations" in text
    assert "Apache-2.0 AND ISC" in text and "Exact upstream builder text" in text
    assert "dev-helper" not in text


def test_missing_metadata_and_text_become_review_items_without_blocking(tmp_path):
    npm(tmp_path, {"node_modules/missing": {"version": "1.0.0"}})
    destination = tmp_path / "Resources/notices.txt"
    with patch.object(notices, "_command", side_effect=subprocess.CalledProcessError(1, ["cargo"])):
        result = notices.write_notices(tmp_path, destination)
    text = destination.read_text()
    assert result["npm_packages"] == 1 and result["cargo_packages"] == 0
    assert "UPSTREAM TEXT MISSING" in text and "UNIDENTIFIED" in text
    assert "Cargo notices incomplete" in text and "no permission inferred" in text
    assert "metadata unavailable" in text


def test_nested_notices_preserved_and_external_symlinks_never_read(tmp_path):
    npm(tmp_path, {"node_modules/sample": {"version": "1.0.0", "resolved": "https://user:secret@example.invalid/archive"}})
    root = installed(tmp_path, "node_modules/sample")
    vendor = root / "vendor"
    vendor.mkdir()
    (vendor / "NOTICE.txt").write_text("Vendor attribution\n")
    secret = tmp_path / "unrelated.txt"
    secret.write_text("PRIVATE CONTENT")
    (root / "COPYRIGHT").symlink_to(secret)
    destination = tmp_path / "notices.txt"
    with patch.object(notices, "_command", side_effect=command_for(cargo(tmp_path))):
        result = notices.write_notices(tmp_path, destination)
    text = destination.read_text()
    assert "Vendor attribution" in text
    assert "PRIVATE CONTENT" not in text and "secret" not in text
    assert any("COPYRIGHT could not be included" in item for item in result["review_items"])
    assert any("archive provenance unconfirmed" in item for item in result["review_items"])


def test_installed_version_drift_and_missing_lock_are_explicit(tmp_path):
    npm(tmp_path, {"node_modules/sample": {"version": "1.0.0"}})
    installed(tmp_path, "node_modules/sample", version="9.0.0")
    destination = tmp_path / "notices.txt"
    with patch.object(notices, "_command", side_effect=command_for(cargo(tmp_path))):
        result = notices.write_notices(tmp_path, destination)
        assert any("installed version differs" in item for item in result["review_items"])
        (tmp_path / "package-lock.json").unlink()
        result = notices.write_notices(tmp_path, destination)
    assert any("production notices incomplete" in item for item in result["review_items"])


def supplemental_fixture(studio, *, complete=True):
    metadata = cargo(studio, [("covered", None, "MPL-2.0")])
    package = metadata["packages"][1]
    package["repository"] = "https://github.com/example/upstream"
    root = Path(package["manifest_path"]).parent
    (root / "LICENSE").unlink()
    (root / "Cargo.toml.orig").write_bytes(b"original upstream crate manifest\n")
    (root / ".cargo_vcs_info.json").write_text(json.dumps({"git": {"sha1": "a" * 40}, "path_in_vcs": "crate"}))
    directory = studio / "macos/upstream_notices"
    directory.mkdir(parents=True)
    data = b"Original verified upstream text\n"
    (directory / "original.txt").write_bytes(data)
    record = {"name": "covered", "version": "2.0.0", "license": "MPL-2.0", "repository": package["repository"],
              "commit": "a" * 40, "path": "crate", "manifest_sha256": hashlib.sha256((root / "Cargo.toml.orig").read_bytes()).hexdigest(),
              "cargo_toml_url": "https://example.invalid/immutable-commit/crate/Cargo.toml", "complete_terms": complete,
              "texts": [{"file": "original.txt", "url": "https://example.invalid/immutable-commit/LICENSE", "sha256": hashlib.sha256(data).hexdigest()}]}
    (directory / "manifest.json").write_text(json.dumps({"schema_version": 1, "packages": [record]}))
    return metadata, package, directory


def test_supplement_uses_supplied_studio_and_rejects_drift_or_tampering(tmp_path):
    metadata, package, directory = supplemental_fixture(tmp_path)
    review = []
    texts, complete = notices._supplement(tmp_path, package, review, "covered")
    assert complete and any("Original verified upstream text" in text for _, text in texts)
    assert notices._supplement(tmp_path / "other-export", package, [], "covered") == ([], False)
    original_manifest = Path(package["manifest_path"]).parent / "Cargo.toml.orig"
    original_manifest.write_text("different release")
    assert notices._supplement(tmp_path, package, review, "covered") == ([], False)
    original_manifest.write_bytes(b"original upstream crate manifest\n")
    (directory / "original.txt").write_text("tampered terms")
    assert notices._supplement(tmp_path, package, review, "covered") == ([], False)
    assert any("did not match" in item for item in review)


def test_upstream_explanation_does_not_clear_missing_full_terms(tmp_path):
    npm(tmp_path, {})
    metadata, _, _ = supplemental_fixture(tmp_path, complete=False)
    destination = tmp_path / "notices.txt"
    with patch.object(notices, "_command", side_effect=command_for(metadata)):
        result = notices.write_notices(tmp_path, destination)
    text = destination.read_text()
    assert "Original verified upstream text" in text
    assert any("full upstream license/copyright/NOTICE text missing or unverified" in item for item in result["review_items"])
    assert "Verified upstream licensing explanation is included" in text


def test_complete_verified_supplement_closes_missing_text_but_keeps_mpl_review(tmp_path):
    npm(tmp_path, {})
    metadata, _, _ = supplemental_fixture(tmp_path)
    with patch.object(notices, "_command", side_effect=command_for(metadata)):
        result = notices.write_notices(tmp_path, tmp_path / "notices.txt")
    assert len(result["review_items"]) == 1
    assert "MPL covered-source" in result["review_items"][0]
