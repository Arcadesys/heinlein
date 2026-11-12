"""Exercise commercial release failure paths without Developer ID credentials."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

MACOS = Path(__file__).resolve().parents[1] / "studio/macos"
with patch.object(sys, "path", [str(MACOS), *sys.path]):
    spec = importlib.util.spec_from_file_location("direct_package", MACOS / "package_direct.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)


class DirectPackageTests(unittest.TestCase):
    def test_portal_uses_a_public_https_address(self):
        self.assertEqual(builder.public_page("https://example.org/purchases"), "https://example.org/purchases")
        for url in ("http://example.org", "https:///path", "https://@example.org/download",
                    "https://account:secret@example.org", "https://example.org/download?token=value",
                    "https://example.org/#fragment", "https://example.org:bad", "https://example.org/\nlink"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                builder.public_page(url)

    @patch.object(builder.platform, "system", return_value="Darwin")
    @patch.object(builder.platform, "machine", return_value="arm64")
    def test_paid_build_needs_an_available_identity_before_building(self, *_):
        args = SimpleNamespace(identity="Developer ID Application: Test", notary_profile="test", rehearsal=False)
        with patch.object(builder, "output", return_value="0 valid identities found"), \
                patch.object(builder, "build_app") as build, self.assertRaisesRegex(ValueError, "unavailable"):
            builder.package(args)
        build.assert_not_called()

    @patch.object(builder.platform, "system", return_value="Darwin")
    @patch.object(builder.platform, "machine", return_value="arm64")
    def test_apple_rejection_keeps_output_unpublished(self, *_):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "deliver"
            identity = "Developer ID Application: Test"
            args = SimpleNamespace(identity=identity, notary_profile="test", rehearsal=False,
                                   downloads_page="https://example.org/purchases", output=destination, pandoc_source_cache=None)

            def intermediate_app(work, _commit):
                bundle = work / "Heinlein Studio.app"
                (bundle / "Contents/Resources").mkdir(parents=True)
                return bundle

            responses = [f'"{identity}"', "a" * 40, '{"status":"Invalid","id":"test-case"}']
            with patch.object(builder, "output", side_effect=responses), \
                    patch.object(builder, "build_app", side_effect=intermediate_app), \
                    patch.object(builder, "inspect_app", return_value="1.2.3"), \
                    patch.object(builder.pandoc_dependency_sources, "prepare_companion"), \
                    patch.object(builder.bundled_pandoc, "stage_converter"), patch.object(builder, "check_converter"), \
                    patch.object(builder, "write_notices"), patch.object(builder, "run") as command, \
                    patch.object(builder.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                    self.assertRaisesRegex(ValueError, "Invalid.*test-case"):
                builder.package(args)
            self.assertFalse(destination.exists())
            self.assertEqual(list(Path(tmp).iterdir()), [])
            self.assertFalse(any("staple" in call.args for call in command.call_args_list))
