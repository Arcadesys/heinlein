"""Pure policy tests; no signing identity or Keychain access."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'studio/macos/signing_policy.py'
spec = importlib.util.spec_from_file_location('signing_policy', path)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class SigningPolicyTests(unittest.TestCase):
    def test_exact_certificate_and_identifier_are_bound(self):
        fingerprint = 'A' * 40
        identifier = 'me.thearcades.heinlein.studio.native'
        sign = policy.signing_arguments(fingerprint, identifier)
        verify = policy.verification_arguments(fingerprint, identifier)
        self.assertEqual(sign[2], fingerprint)
        self.assertIn('certificate leaf = H"' + fingerprint + '"', sign[-1])
        self.assertIn('identifier "' + identifier + '"', verify[-1])
        self.assertIn('--strict', verify)
        self.assertNotIn('-', sign)

    def test_rejects_missing_or_unsafe_configuration(self):
        for fingerprint in (None, '', '-', 'A' * 39, 'G' * 40, 'a' * 40):
            with self.subTest(fingerprint=fingerprint):
                with self.assertRaises(ValueError):
                    policy.signing_arguments(fingerprint, 'me.thearcades.heinlein.studio')
        for identifier in ('', 'x" or true', 'x\n', '../x'):
            with self.subTest(identifier=identifier):
                with self.assertRaises(ValueError):
                    policy.verification_arguments('A' * 40, identifier)


if __name__ == '__main__':
    unittest.main()
