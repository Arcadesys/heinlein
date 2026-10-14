import importlib.util
import unittest
from pathlib import Path

module = Path(__file__).resolve().parents[1] / "editorial.py"
spec = importlib.util.spec_from_file_location("editorial", module)
editorial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editorial)

class EditorialTests(unittest.TestCase):
    def test_flags_template_contrast(self):
        self.assertIn("contrast", [x[1] for x in editorial.lint([(1, "It's not software, it's abundance.")])])

    def test_flags_fragment_stacks(self):
        self.assertIn("fragment-stack", [x[1] for x in editorial.lint([(2, "Three words. Two sentences. Everything changes.")])])

    def test_does_not_flag_em_dashes(self):
        self.assertEqual([], editorial.lint([(3, "I went to the shop—and then I found the reason.")]))
    
    def test_preserves_intentional_short_punch(self):
        self.assertEqual([], editorial.lint([(4, "I revised three novels last week. Revised.")]))
    
    def test_scopes_prose_only(self):
        self.assertTrue(editorial.prose("novels/zoo/chapter.md"))
        self.assertFalse(editorial.prose("tools/worker.py"))
        self.assertFalse(editorial.prose(".codex/hooks/README.md"))

if __name__ == "__main__":
    unittest.main()
