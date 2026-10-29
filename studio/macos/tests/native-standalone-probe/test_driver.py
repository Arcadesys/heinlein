"""Synthetic byte files only: never run a binary, signing tool or native fixture."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native47_driver', Path(__file__).with_name('driver.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class BinaryProvenanceTests(unittest.TestCase):
    def test_different_inputs_cannot_inherit_historical_source_claims(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hashes = []
            with patch.object(driver.subprocess, 'Popen', side_effect=AssertionError('No execution')), \
                 patch.object(driver.subprocess, 'run', side_effect=AssertionError('No tools')):
                for label, supplied, executed in [('a', b'fake original A', b'fake signed A'),
                                                   ('b', b'different fake B', b'different signed B')]:
                    with self.subTest(binary=label):
                        binary, executable = root / label, root / (label + '-signed')
                        binary.write_bytes(supplied)
                        executable.write_bytes(executed)
                        receipt = driver.binary_receipt(binary, executable)
                        hashes.append(receipt['binarySha256'])
                        self.assertIsNone(receipt['source'])
                        self.assertIsNone(receipt['tree'])
                        self.assertIsNone(receipt['uncommittedFixture'])
                        self.assertEqual(receipt['binarySha256'], hashlib.sha256(supplied).hexdigest())
                        self.assertEqual(receipt['executedBinarySha256'], hashlib.sha256(executed).hexdigest())
                        self.assertEqual(receipt['binary'], str(binary))
                        self.assertEqual(receipt['executedBinary'], str(executable))
            self.assertNotEqual(*hashes)


class WindowEvidenceTests(unittest.TestCase):
    def test_requires_one_owned_window_and_all_actual_focus_observations(self):
        valid = dict(label='main', visible=True, focused=True, rendererActiveElement=True,
                     editorHasFocus=True, documentHasFocus=True)
        driver.validate_window_observations([valid])
        for observations in ([], [valid, valid], [dict(valid, label='other')]):
            with self.assertRaises(RuntimeError):
                driver.validate_window_observations(observations)
        for key in ('visible', 'focused', 'rendererActiveElement', 'editorHasFocus', 'documentHasFocus'):
            for value in (False, None, 1, 'true'):
                with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                    driver.validate_window_observations([dict(valid, **{key: value})])


if __name__ == '__main__':
    unittest.main()
