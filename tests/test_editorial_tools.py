"""Offline smoke tests for the migrated advisory editorial tooling."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load_unslop():
    spec = importlib.util.spec_from_file_location("heinlein_unslop", ROOT / "tools" / "unslop.py")
    mod = importlib.util.module_from_spec(spec)
    import sys
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod

def test_protected_em_dash_is_not_slop():
    m = load_unslop()
    assert all(hit.match != "—" for hit in m.scan("She opened the door—and froze."))

def test_unslop_detects_ai_lexicon():
    m = load_unslop()
    assert any(hit.rule == "ai-lexicon" for hit in m.scan("This robust system will unlock transformative outcomes."))

def test_voice_guardian_resources_exist():
    for name in ("editorial-rubric.json", "protected-choices.json", "reference-passages.jsonl", "voice-profile.md"):
        assert (ROOT / "editorial" / "voice-guardian" / name).is_file()
