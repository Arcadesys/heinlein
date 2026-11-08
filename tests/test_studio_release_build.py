import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("build_release", Path(__file__).parents[1] / "studio/macos/build_release.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ReleaseBuildTests(unittest.TestCase):
    def test_rejects_non_release_input_before_downloading(self):
        for version in ["main", "1.9.0;touch x", "../1.9.0", "1.9.0-beta"]:
            with self.assertRaises(ValueError), patch.object(builder, "run") as run:
                builder.build(version)
            run.assert_not_called()

    def test_pins_release_and_retains_only_built_app_and_log(self):
        with tempfile.TemporaryDirectory() as parent:
            work = Path(parent) / "build"
            work.mkdir()
            commands = []

            def run(args, cwd, log, timeout=1800):
                commands.append(args)
                if args[0] == "git":
                    studio = work / "source/studio"
                    studio.mkdir(parents=True)
                    (studio / "package.json").write_text('{"version":"1.9.0"}')
                if "tauri" in args:
                    app = work / "source/studio/target/release/bundle/macos/Heinlein Studio.app"
                    app.mkdir(parents=True)
                    (app / "payload").write_text("built")

            with patch.object(builder.tempfile, "mkdtemp", return_value=str(work)), patch.object(builder, "run", side_effect=run):
                app = builder.build("1.9.0")
            self.assertEqual((app / "payload").read_text(), "built")
            self.assertFalse((work / "source").exists())
            self.assertTrue((work / "build.log").is_file())
            self.assertIn("v1.9.0", commands[0])
            self.assertIn("https://github.com/Arcadesys/heinlein.git", commands[0])
            self.assertEqual(commands[-1][:4], ["/usr/bin/codesign", "--verify", "--deep", "--strict"])

    def test_failed_build_cleans_private_tree(self):
        with tempfile.TemporaryDirectory() as parent:
            work = Path(parent) / "failed"
            work.mkdir()
            with patch.object(builder.tempfile, "mkdtemp", return_value=str(work)), patch.object(builder, "run", side_effect=RuntimeError("failed")):
                with self.assertRaises(RuntimeError):
                    builder.build("1.9.0")
            self.assertFalse(work.exists())

    def test_timeout_stops_only_owned_build_group(self):
        process = Mock(pid=4321)
        process.wait.side_effect = [subprocess.TimeoutExpired("build", 1), 0]
        with patch.object(builder.subprocess, "Popen", return_value=process), patch.object(builder.os, "killpg") as kill:
            with self.assertRaises(RuntimeError):
                builder.run(["npm", "ci"], "/tmp", Mock(), timeout=1)
            kill.assert_called_once_with(4321, builder.signal.SIGKILL)
