"""Memory-only receipt rejection checks; never invoke a native executable."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('picker_driver', Path(__file__).with_name('driver.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class ReceiptTests(unittest.TestCase):
    def reopen(self):
        stages = [
            'feature-explicit-invocation-private-root-sentinel-validated',
            'all-tauri-app-paths-confined-before-webview-or-store',
            'immutable-fixture-private-home-resolver-validated-no-env-override',
            'native-dialog-plugin-after-confinement-no-JS-dialog-ACL',
            'own-webkit-isPersistent-false-before-fixture-navigation', 'callback-gate-passed',
            'with-webview-call-returned', 'worker-not-main-navigation-gates-complete',
            'worker-navigation-enqueued', 'first-renderer-IPC', 'production-editor-ready',
            'production-editor-focused', 'owned-native-window-visible-focused',
            'picker-reopened-both', 'picker-all-evidence-ready', 'request-close-from-production',
            'production-request-close-command-received', 'production-exit-guards-approved-Some0',
        ]
        lines = [{'kind': 'progress', 'stage': stage} for stage in stages]
        lines.append({'kind': 'owned-window-observation', **dict.fromkeys(
            ('visible', 'focused', 'rendererActiveElement', 'editorHasFocus', 'documentHasFocus'), True)})
        lines.append({'kind': 'native-picker-readback', 'value': {
            'stage': 'picker-reopened-both', 'nativeActions': 0, 'originalExact': True,
            'copyExact': True, 'publicationAbsent': False, 'bytes': 94,
            'hash': '115d534fa5575cf7820a1c44c84824eb41871d514293561082f487cfcbe5a276',
            'placements': 1, 'pendingIntents': 0}})
        result = {'picker': {'armed': 0, 'completedPublicActions': 0, 'failure': 0, 'readbackMask': 128},
                  'nativeTerminateCounters': [1, 1, 1, 0], 'approvedProgrammaticExits': 1,
                  'forbiddenServiceAttempts': 0, 'managedRuntimeAcquire': False,
                  'osStoreProviderConstructorsReachable': False}
        return result, lines

    def test_complete_reopen_receipt_accepted(self):
        driver.validate_phase('picker-reopen', *self.reopen())

    def test_missing_or_reordered_isolation_rejected(self):
        result, lines = self.reopen()
        for index in range(18):
            broken = copy.deepcopy(lines)
            del broken[index]
            with self.assertRaises((ValueError, RuntimeError)):
                driver.validate_phase('picker-reopen', result, broken)
        lines[0], lines[5] = lines[5], lines[0]
        with self.assertRaises(RuntimeError):
            driver.validate_phase('picker-reopen', result, lines)

    def test_wrong_bytes_focus_and_forbidden_attempt_rejected(self):
        for mutation in ('bytes', 'focus', 'service', 'abort'):
            result, lines = self.reopen()
            if mutation == 'bytes': lines[-1]['value']['bytes'] = 93
            if mutation == 'focus': lines[-2]['editorHasFocus'] = False
            if mutation == 'service': result['forbiddenServiceAttempts'] = 1
            if mutation == 'abort': result['approvedProgrammaticExits'] = 0
            with self.assertRaises(RuntimeError):
                driver.validate_phase('picker-reopen', result, lines)

    def picker_only(self):
        result, lines = self.reopen()
        for index, value in enumerate(lines):
            if value.get('stage') == 'picker-reopened-both':
                lines[index:index+1] = [{'kind':'progress','stage':stage} for stage in ('picker-cancel-real-null','picker-preview-real-token')]
                break
        template=lines.pop()['value']
        for phase,stage in ((1,'picker-cancel-real-null'),(2,'picker-preview-real-token')):
            lines.extend([
                {'kind':'native-picker','stage':'actual-NSSavePanel-owned-parent-dir-name-verified','phase':phase},
                {'kind':'native-picker','stage':'public-panel-action-dispatched-real-completion-required','phase':phase},
                {'kind':'native-picker-readback','value':{**template,'stage':stage,'nativeActions':phase,'copyExact':False,'publicationAbsent':True,'placements':0}},
            ])
        result['picker']={'armed':2,'completedPublicActions':2,'failure':0,'readbackMask':6,'alertCalls':0,'pickerOnly':True,'placementConfirmation':False}
        return result,lines

    def test_picker_only_requires_two_real_panel_actions_without_publication(self):
        driver.validate_phase('picker-preview-only', *self.picker_only())
        for key,value in (('alertCalls',1),('armed',3),('placementConfirmation',True)):
            result,lines=self.picker_only()
            result['picker'][key]=value
            with self.assertRaises(RuntimeError):
                driver.validate_phase('picker-preview-only',result,lines)
        result,lines=self.picker_only()
        lines[-1]['value']['placements']=1
        with self.assertRaises(RuntimeError):
            driver.validate_phase('picker-preview-only',result,lines)

    def test_picker_only_refuses_third_action_or_missing_completion(self):
        result,lines=self.picker_only()
        lines.append({'kind':'native-picker','stage':'public-alert-button-action-dispatched-real-completion-required','phase':3})
        with self.assertRaises(RuntimeError):
            driver.validate_phase('picker-preview-only',result,lines)
        result,lines=self.picker_only()
        del lines[-1]
        with self.assertRaises(RuntimeError):
            driver.validate_phase('picker-preview-only',result,lines)

    def test_arbitrary_binary_never_inherits_source_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = (Path(directory) / name for name in ('a', 'b'))
            a.write_bytes(b'fake one'); b.write_bytes(b'fake two')
            receipt = driver.binary_receipt(a, b)
            self.assertNotEqual(receipt['binarySha256'], receipt['executedBinarySha256'])
            for key in ('source', 'tree', 'uncommittedFixture'):
                self.assertIsNone(receipt[key])


if __name__ == '__main__':
    unittest.main()
