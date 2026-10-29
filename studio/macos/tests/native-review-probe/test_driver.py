import unittest
from driver import validate_receipt


class ReceiptTests(unittest.TestCase):
    def receipt(self, phase):
        return dict(schema=1, phase=phase, realIPC=True, exactBytes=True,
                    accepted=3 if phase == 'first' else 4, rejected=1, superseded=1,
                    confirmations=3 if phase == 'first' else 1,
                    confirmation='compile-feature-native-synthetic-author-choice',
                    osDialogUsability=False)

    def test_both_distinct_process_phases(self):
        for phase in ('first', 'reopen'):
            validate_receipt(self.receipt(phase), phase)

    def test_missing_or_incorrect_evidence_is_not_pass(self):
        for key in self.receipt('first'):
            receipt = self.receipt('first')
            receipt[key] = None
            with self.subTest(key=key), self.assertRaises(AssertionError):
                validate_receipt(receipt, 'first')


if __name__ == '__main__':
    unittest.main()
