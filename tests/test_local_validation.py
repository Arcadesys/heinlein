"""The local gate must preserve failures, environment safety, and platform boundaries."""
import importlib.util
from pathlib import Path
import subprocess
from unittest.mock import patch

import pytest

spec = importlib.util.spec_from_file_location("validate", Path(__file__).resolve().parents[1] / "tools/validate.py")
validate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validate)


def test_failed_check_stops_later_checks():
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        if command == ["npm", "test"]:
            raise subprocess.CalledProcessError(7, command)

    with patch.object(validate.subprocess, "run", side_effect=run):
        assert validate.main(["quick"]) == 7
    assert calls[-1][0] == ["npm", "test"]
    assert all(command != ["npm", "run", "build"] for command, _ in calls)


def test_dry_run_does_not_execute_anything():
    with patch.object(validate.subprocess, "run") as run:
        assert validate.main(["full", "--dry-run"]) == 0
        run.assert_not_called()


def test_local_publishing_cannot_silently_skip_or_update_goldens(monkeypatch):
    with patch.object(validate, "publishing_prerequisites", return_value=None), patch.object(validate.subprocess, "run") as run:
        assert validate.main(["publishing"]) == 0
    assert run.call_args.kwargs["env"]["HEINLEIN_REQUIRE_GOLDENS"] == "1"
    monkeypatch.setenv("UPDATE_GOLDEN", "1")
    with patch.object(validate.subprocess, "run") as run:
        with pytest.raises(SystemExit) as error:
            validate.main(["publishing"])
        assert error.value.code == 2
        run.assert_not_called()


def test_native_probe_tests_never_launch_probes():
    for system in ("darwin", "linux"):
        plan = list(validate.commands("studio", system))
        assert not any(command[:2] == ["cargo", "run"] for _, command in plan)
        assert not any(command[:2] == ["npm", "ci"] for _, command in plan)
        features = [command for _, command in plan if "--features" in command]
        assert bool(features) == (system == "darwin")


def test_missing_tool_fails_instead_of_reporting_success():
    def run(command, **kwargs):
        if command[0] == "npm":
            raise FileNotFoundError(2, "missing", "npm")

    with patch.object(validate.subprocess, "run", side_effect=run):
        assert validate.main(["renderer"]) == 127


def test_interrupted_command_is_a_failure():
    def run(command, **kwargs):
        if command[0] == "npm":
            raise subprocess.CalledProcessError(-15, command)

    with patch.object(validate.subprocess, "run", side_effect=run):
        assert validate.main(["renderer"]) == 1


def test_node_options_are_preserved_and_storage_is_disabled(monkeypatch):
    monkeypatch.setenv("NODE_OPTIONS", "--max-old-space-size=2048")
    with patch.object(validate.subprocess, "run") as run:
        assert validate.main(["renderer"]) == 0
    options = run.call_args.kwargs["env"]["NODE_OPTIONS"]
    assert "--max-old-space-size=2048" in options
    assert "--no-experimental-webstorage" in options


def test_missing_publishing_tools_stop_before_any_test():
    with patch.object(validate, "publishing_prerequisites", return_value="Publishing requires pandoc"), patch.object(validate.subprocess, "run") as run:
        assert validate.main(["full"]) == 1
        run.assert_not_called()


def test_wrong_pandoc_version_fails_closed():
    with patch.object(validate.shutil, "which", return_value="/synthetic/tool"), patch.object(validate.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="pandoc wrong-version\n")):
        assert "requires pandoc" in validate.publishing_prerequisites()


def test_manual_browser_fallback_and_automatic_security_tests_remain():
    import yaml

    workflows = validate.ROOT / ".github/workflows"
    browser = yaml.load((workflows / "studio-browser.yml").read_text(), Loader=yaml.BaseLoader)
    assert set(browser["on"]) == {"workflow_dispatch"}
    job = browser["jobs"]["browser-full"]
    assert job["name"] == "Full browser acceptance (${{ matrix.os }})"
    assert job["strategy"]["matrix"]["os"] == ["macos-latest"]
    assert any(step.get("run") == "npm run test:browser:full" for step in job["steps"])
    studio = yaml.load((workflows / "studio.yml").read_text(), Loader=yaml.BaseLoader)
    assert studio["jobs"]["boundaries"]["if"] == "github.event_name != 'workflow_dispatch'"
    assert studio["jobs"]["boundaries"]["steps"][-1]["run"] == "python3 tools/validate.py boundaries"
    assert studio["jobs"]["studio"]["if"] == "github.event_name == 'workflow_dispatch'"
    assert "push" not in studio["on"]
    publishing = yaml.load((workflows / "python.yml").read_text(), Loader=yaml.BaseLoader)
    assert set(publishing["on"]) == {"workflow_dispatch"}


def test_cargo_artifacts_are_shared_without_overriding_caller(monkeypatch):
    monkeypatch.delenv("CARGO_TARGET_DIR", raising=False)
    with patch.object(validate.subprocess, "run") as run:
        assert validate.main(["boundaries"]) == 0
    assert run.call_args.kwargs["env"]["CARGO_TARGET_DIR"] == str(validate.STUDIO / "target")
    monkeypatch.setenv("CARGO_TARGET_DIR", "/synthetic/caller-target")
    with patch.object(validate.subprocess, "run") as run:
        assert validate.main(["boundaries"]) == 0
    assert run.call_args.kwargs["env"]["CARGO_TARGET_DIR"] == "/synthetic/caller-target"


def test_hosted_workflows_target_only_macos():
    import yaml

    for path in (validate.ROOT / ".github/workflows").glob("*.yml"):
        workflow = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
        assert "ubuntu-latest" not in path.read_text()
        for job in workflow["jobs"].values():
            if "matrix" in job.get("strategy", {}):
                assert job["strategy"]["matrix"]["os"] == ["macos-latest"]
            else:
                assert job["runs-on"] == "macos-latest"
    studio = yaml.load((validate.ROOT / ".github/workflows/studio.yml").read_text(), Loader=yaml.BaseLoader)
    assert studio["jobs"]["boundaries"]["env"]["CARGO_TARGET_DIR"] == "${{ github.workspace }}/studio/target"
