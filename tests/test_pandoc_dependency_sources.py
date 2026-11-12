"""Focused source-supply integrity checks; no upstream downloads."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import io

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pandoc_dependency_sources", ROOT / "studio/macos/pandoc_dependency_sources.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def _test_lock(data):
    return {"schema": 1, "filename": "pandoc-3.14-dependency-sources.tar.gz",
            "archive_sha256": hashlib.sha256(data).hexdigest(), "archive_bytes": len(data),
            "provenance": {"test": "synthetic"}, "review_items": []}


def test_cached_companion_digest_and_exclusive_destination(tmp_path, monkeypatch):
    data = b"Synthetic exact source companion"
    cache = tmp_path / "cache.tar.gz"
    cache.write_bytes(data)
    monkeypatch.setattr(module, "_lock", lambda: _test_lock(data))
    destination = tmp_path / "new.tar.gz"
    result = module.prepare_companion(destination, cache=cache)
    assert result["sha256"] == hashlib.sha256(data).hexdigest()
    assert destination.read_bytes() == data
    cache.write_bytes(b"Altered")
    with pytest.raises(ValueError, match="digest mismatch"):
        module.prepare_companion(tmp_path / "rejected.tar.gz", cache=cache)
    assert not (tmp_path / "rejected.tar.gz").exists()
    with pytest.raises(ValueError, match="new dependency companion destination"):
        module.prepare_companion(destination, cache=cache)
    assert destination.read_bytes() == data


def test_fetch_rejects_corrupt_upstream_source(tmp_path, monkeypatch):
    class Response(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *args): self.close()
    monkeypatch.setattr(module.urllib.request, "urlopen", lambda *a, **k: Response(b"Wrong bytes"))
    item = {"filename": "hackage/synthetic-1.tar.gz", "sha256": "0" * 64, "url": "https://example.invalid/source"}
    with pytest.raises(ValueError, match="digest mismatch"):
        module._fetch(item, tmp_path)
    assert not list(tmp_path.rglob("*.partial"))
    assert not (tmp_path / item["filename"]).exists()


def test_lock_sources_match_hackage_security_targets_and_frozen_cabal():
    lock = json.loads((ROOT / "studio/macos/pandoc_dependency_data/lock.json").read_text())
    assert len(lock["packages"]) == 264
    assert lock["ghc_boot_packages"] == [{"name": "rts", "version": "1.0.2"}]
    for item in lock["packages"]:
        targets = json.loads(item["index_target_record"])["signed"]["targets"]
        target = targets["<repo>/package/" + Path(item["filename"]).name]
        assert item["sha256"] == target["hashes"]["sha256"]
        assert item["bytes"] == target["length"]
        assert hashlib.sha256(item["cabal_text"].encode()).hexdigest() == item["cabal_sha256"]
    assert lock["provenance"]["pandoc_commit"] == "3dde36a9ddd68b8677397d9c59c891d9b8763b89"
