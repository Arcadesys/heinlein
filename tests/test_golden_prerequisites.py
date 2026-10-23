"""Required validation cannot silently skip or rewrite the publishing goldens."""
import pytest

from tests import test_golden as golden


@pytest.mark.parametrize("installed", [None, "wrong-version"])
@pytest.mark.parametrize("required_by", ["CI", "HEINLEIN_REQUIRE_GOLDENS"])
def test_required_goldens_fail_on_missing_or_wrong_pandoc(monkeypatch, installed, required_by):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("HEINLEIN_REQUIRE_GOLDENS", raising=False)
    monkeypatch.setenv(required_by, "true" if required_by == "CI" else "1")
    monkeypatch.setattr(golden, "PANDOC", installed)
    monkeypatch.setattr(golden, "UPDATE", False)
    with pytest.raises(pytest.fail.Exception, match="goldens require pandoc"):
        golden._skip_if_version_drift()


@pytest.mark.parametrize("installed", [None, "wrong-version"])
def test_local_version_mismatch_has_an_explicit_skip(monkeypatch, installed):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("HEINLEIN_REQUIRE_GOLDENS", raising=False)
    monkeypatch.setattr(golden, "PANDOC", installed)
    monkeypatch.setattr(golden, "UPDATE", False)
    with pytest.raises(pytest.skip.Exception, match="goldens require pandoc"):
        golden._skip_if_version_drift()


def test_required_goldens_never_regenerate_fixtures(monkeypatch):
    monkeypatch.setenv("HEINLEIN_REQUIRE_GOLDENS", "1")
    monkeypatch.setattr(golden, "PANDOC", golden.PINNED)
    monkeypatch.setattr(golden, "UPDATE", True)
    with pytest.raises(pytest.fail.Exception, match="updates are forbidden"):
        golden._skip_if_version_drift()


def test_required_supported_pandoc_runs_goldens(monkeypatch):
    monkeypatch.setenv("HEINLEIN_REQUIRE_GOLDENS", "1")
    monkeypatch.setattr(golden, "PANDOC", golden.PINNED)
    monkeypatch.setattr(golden, "UPDATE", False)
    golden._skip_if_version_drift()
