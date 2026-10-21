import importlib.util
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

module = Path(__file__).resolve().parents[1] / "editorial.py"
spec = importlib.util.spec_from_file_location("editorial", module)
editorial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editorial)

class EditorialTests(unittest.TestCase):
    def test_flags_template_contrast(self):
        self.assertIn("contrast", [x[1] for x in editorial.lint([(1, "It's not software, it's abundance.")])])

    def test_flags_fragment_stacks(self):
        self.assertIn("fragment-stack", [x[1] for x in editorial.lint([(2, "Three words. Two sentences. Everything changes.")])])

    def test_adjacent_sentence_delimiters_are_not_consumed(self):
        for text in ("One sentence! Another? Last one.", "One sentence.  Another.\tLast one."):
            with self.subTest(text=text):
                findings = editorial.lint([(7, text)])
                self.assertEqual(["fragment-stack"], [item[1] for item in findings])
                self.assertEqual(7, findings[0][0])

    def test_markup_and_quoted_lines_remain_outside_advisory_scope(self):
        for prefix in ("# ", "> ", "`", "| "):
            with self.subTest(prefix=prefix):
                self.assertEqual([], editorial.lint([(1, prefix + "One sentence. Another. Last one.")]))

    def test_does_not_flag_em_dashes(self):
        self.assertEqual([], editorial.lint([(3, "I went to the shop—and then I found the reason.")]))
    
    def test_preserves_intentional_short_punch(self):
        self.assertEqual([], editorial.lint([(4, "I revised three novels last week. Revised.")]))

    def test_protected_content_is_not_a_style_error(self):
        self.assertEqual([], editorial.lint([(4, "Queer, trans, kink, furry—fuck yes.")]))

    def test_findings_are_advice_and_never_rewrite_the_source(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "scene.md"
            original = "One sentence. Another. Last one.\r\nQueer, trans, kink, furry—fuck yes.\r\n".encode()
            source.write_bytes(original)
            with patch.object(editorial, "changed_lines", return_value={"scene.md": [(1, original.decode().splitlines()[0])]}):
                result = editorial.stop(root)
            self.assertEqual({"systemMessage"}, set(result))
            self.assertIn("advisory (no files changed)", result["systemMessage"])
            self.assertIn("Review context before editing", result["systemMessage"])
            self.assertIn("Never auto-rewrite", result["systemMessage"])
            self.assertEqual(original, source.read_bytes())
    
    def test_scopes_prose_only(self):
        self.assertTrue(editorial.prose("novels/zoo/chapter.md"))
        self.assertFalse(editorial.prose("tools/worker.py"))
        self.assertFalse(editorial.prose(".codex/hooks/README.md"))

if __name__ == "__main__":
    unittest.main()
