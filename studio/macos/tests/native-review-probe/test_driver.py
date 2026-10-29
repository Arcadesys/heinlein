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
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_receipt(receipt, 'first')

    def test_actual_responses_are_distinct_from_synthetic_choice(self):
        for phase in ('first', 'reopen'):
            receipt = self.receipt(phase)
            receipt.update(confirmation='production-parented-NSAlert-public-button',
                           actualOSDialogPlumbing=True,
                           actualResponses=[False, True, True, True] if phase == 'first' else [True])
            validate_receipt(receipt, phase, True)
            receipt['actualResponses'] = []
            with self.assertRaises(ValueError):
                validate_receipt(receipt, phase, True)

    def test_stale_case_requires_external_bytes_and_zero_receipts(self):
        receipt = dict(schema=1, phase='stale', actualOSDialogPlumbing=True,
                       realResponse=True, staleRefused=True, receiptCount=0,
                       externalBytesPreserved=True, osDialogUsability=False)
        validate_receipt(receipt, 'stale', True)
        receipt['receiptCount'] = 1
        with self.assertRaises(ValueError):
            validate_receipt(receipt, 'stale', True)


if __name__ == '__main__':
    unittest.main()
