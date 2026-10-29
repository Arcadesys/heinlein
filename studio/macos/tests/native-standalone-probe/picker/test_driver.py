"""Memory-only receipt rejection checks; never invoke a native executable."""
import copy
import importlib.util
from pathlib import Path
import tempfile
from unittest import mock
import os
import io
from types import SimpleNamespace
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
                {'kind':'native-picker-diagnostic','phase':phase,'savePanelTypeMatches':True,'visible':True,'fields':{'messageMatches':True,'directoryMatches':True,'nameMatches':False}},
                {'kind':'native-picker','stage':'owned-panel-before-synthetic-name-input','phase':phase},
                {'kind':'native-picker-diagnostic','phase':phase,'savePanelTypeMatches':True,'visible':True,'afterSyntheticNameInput':True,'fields':{'messageMatches':True,'directoryMatches':True,'nameMatches':True}},
                {'kind':'native-picker','stage':'synthetic-filename-reread-verified','phase':phase},
                {'kind':'native-picker','stage':'actual-NSSavePanel-owned-parent-dir-name-verified','phase':phase},
                {'kind':'native-picker','stage':'public-panel-action-dispatched-real-completion-required','phase':phase},
                {'kind':'native-picker-readback','value':{**template,'stage':stage,'nativeActions':phase,'copyExact':False,'publicationAbsent':True,'placements':0}},
            ])
        result['picker']={'armed':2,'completedPublicActions':2,'failure':0,'readbackMask':6,'alertCalls':0,'pickerOnly':True,'placementConfirmation':False,'syntheticNameInputMask':6,'defaultSuggestedFilenameInitialization':False}
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

    def test_name_input_requires_preidentity_and_actual_postinput_reread(self):
        for after,key in ((False,'directoryMatches'),(False,'messageMatches'),(True,'directoryMatches'),(True,'nameMatches')):
            result,lines=self.picker_only()
            observation=next(v for v in lines if v.get('kind')=='native-picker-diagnostic' and bool(v.get('afterSyntheticNameInput'))==after)
            observation['fields'][key]=False
            with self.assertRaises(RuntimeError):
                driver.validate_phase('picker-preview-only',result,lines)
        result,lines=self.picker_only()
        result['picker']['syntheticNameInputMask']=2
        with self.assertRaises(RuntimeError):
            driver.validate_phase('picker-preview-only',result,lines)

    def test_backtrace_environment_is_child_only_and_picker_only(self):
        parent=dict(os.environ)
        parent.update(RUST_BACKTRACE='inherited-not-trusted',HEINLEIN_PRIVATE_TEST='not-exported')
        unchanged=parent.copy()
        normal=driver.child_environment(Path('/synthetic/tmp'),'picker-preview-only',False,parent)
        diagnostic=driver.child_environment(Path('/synthetic/tmp'),'picker-preview-only',True,parent)
        self.assertNotIn('RUST_BACKTRACE',normal)
        self.assertEqual(diagnostic['RUST_BACKTRACE'],'1')
        self.assertEqual(diagnostic.get('HOME'),parent.get('HOME'))
        self.assertEqual(diagnostic['TMPDIR'],'/synthetic/tmp')
        self.assertNotIn('HEINLEIN_PRIVATE_TEST',diagnostic)
        self.assertEqual(parent,unchanged)
        for phase in ('picker','picker-reopen','first','unknown'):
            with mock.patch.object(driver.subprocess,'Popen') as spawn:
                with self.assertRaises(ValueError):
                    driver.run_phase(Path('/unused'),Path('/unused'),phase,{},True)
                spawn.assert_not_called()

    def test_capture_preserves_first_panic_frames_and_redacts_home_from_both_streams(self):
        capture=driver.BoundedDiagnostics('/synthetic-home')
        emitted=capture.feed('stderr',b'first panic /synthetic-home/source.rs:12\nframe 0: public ')
        emitted+=capture.feed('stdout',b'{"kind":"progress","stage":"before-action"}\n')
        emitted+=capture.feed('stderr',b'callback\nframe 1: /synthetic-home/adapter.rs:4')
        emitted+=capture.finish('stderr');emitted+=capture.finish('stdout')
        self.assertIn('first panic <user-home>/source.rs:12',emitted[0]['message'])
        self.assertTrue(any('frame 0: public callback'==v.get('message') for v in emitted))
        self.assertTrue(emitted[-1]['unterminated'])
        self.assertNotIn('/synthetic-home',str(emitted))
        self.assertFalse(capture.failed)
        self.assertEqual(set(capture.stats['streamsDrainedToEOF']),{'stdout','stderr'})

    def test_capture_overflow_keeps_first_evidence_and_continues_drain_to_eof(self):
        capture=driver.BoundedDiagnostics(None,byte_limit=80,line_limit=2)
        first=b'first panic\nframe one\n'
        capture.feed('stderr',first)
        extra=b'ignored frame\n'*100
        capture.feed('stderr',extra)
        capture.feed('stdout',b'later stdout\n')
        capture.finish('stderr');capture.finish('stdout')
        self.assertEqual([v['message'] for v in capture.lines if v['stream']=='stderr'],['first panic','frame one'])
        self.assertTrue(capture.stats['overflow'])
        self.assertGreater(capture.stats['suppressedLines'],0)
        self.assertEqual(capture.stats['bytesRead'],len(first)+len(extra)+len(b'later stdout\n'))
        self.assertEqual(set(capture.stats['streamsDrainedToEOF']),{'stdout','stderr'})

    def test_stdout_overflow_cannot_consume_reserved_first_panic_capacity(self):
        capture=driver.BoundedDiagnostics(None,byte_limit=80,line_limit=2)
        capture.feed('stdout',b'noise\n'*100)
        capture.feed('stderr',b'first panic\npublic frame\n')
        capture.finish('stdout');capture.finish('stderr')
        self.assertTrue(capture.stats['overflow'])
        self.assertEqual([v['message'] for v in capture.lines if v['stream']=='stderr'],['first panic','public frame'])
        self.assertLessEqual(capture.stats['retainedBytes'],160)
        self.assertLessEqual(len(capture.lines),4)

    def test_oversize_unterminated_stream_is_bounded_and_truncation_explicit(self):
        capture=driver.BoundedDiagnostics(None,partial_limit=16)
        capture.feed('stderr',b'first panic '+b'x'*100)
        self.assertTrue(capture.failed)
        self.assertTrue(capture.lines[0]['truncated'])
        self.assertLessEqual(len(capture.lines[0]['message']),16)
        capture.feed('stderr',b'x'*100)
        capture.feed('stderr',b'\nnext frame\n')
        capture.finish('stderr')
        self.assertEqual(capture.lines[-1]['message'],'next frame')
        self.assertEqual(capture.stats['bytesRead'],len(b'first panic '+b'x'*100)+100+len(b'\nnext frame\n'))
        self.assertEqual(capture.pending,{})

    def test_capture_records_genuine_result_without_inventing_success(self):
        capture=driver.BoundedDiagnostics(None)
        lines=capture.feed('stdout',b'{"kind":"result","passed":false}\n')
        capture.finish('stdout')
        self.assertEqual(lines,[{'kind':'result','passed':False}])
        self.assertFalse(capture.failed)

    def simulated_drain(self, timeout=False):
        # Memory-only streams/process. No executable, GUI or native probe is invoked.
        class Stream:
            def __init__(self,fd): self.fd=fd
            def fileno(self): return self.fd
        class Selector:
            def __init__(self): self.keys={}
            def register(self,stream,events,name): self.keys[stream.fd]=SimpleNamespace(fileobj=stream,data=name)
            def unregister(self,stream): del self.keys[stream.fd]
            def get_map(self): return self.keys
            def select(self,_): return [(key,1) for key in list(self.keys.values())]
        selector=Selector()
        child=SimpleNamespace(pid=123,stdout=Stream(11),stderr=Stream(12),stdin=io.BytesIO(),reaped=False)
        child.poll=lambda: None if selector.get_map() else (73 if timeout else 0)
        def reap(): child.reaped=True; return 73 if timeout else 0
        child.wait=reap
        output={11:[b'{"kind":"progress","stage":"owned-start"}\n{"kind":"result","passed":true}\n',b''],12:[b'first panic /synthetic/source.rs:1\n',b'']}
        record={}
        clock=[0,66,66,66,66,66,66,66,66] if timeout else [0]*20
        with mock.patch.object(driver.subprocess,'Popen',return_value=child), \
             mock.patch.object(driver.selectors,'DefaultSelector',return_value=selector), \
             mock.patch.object(driver.os,'getpgid',return_value=123), \
             mock.patch.object(driver.os,'getpgrp',return_value=122), \
             mock.patch.object(driver.os,'read',side_effect=lambda fd,_:output[fd].pop(0)), \
             mock.patch.object(driver.time,'monotonic',side_effect=clock), \
             mock.patch.object(driver,'validate_phase') as validate, \
             mock.patch('builtins.print',side_effect=AssertionError('Controller sink forbidden during drain')) as reporter:
            if timeout:
                with self.assertRaises(RuntimeError): driver.run_phase(Path('/synthetic'),Path('/synthetic-root'),'picker-preview-only',record,True)
                validate.assert_not_called()
            else:
                driver.run_phase(Path('/synthetic'),Path('/synthetic-root'),'picker-preview-only',record,True)
                validate.assert_called_once()
            reporter.assert_not_called()
        self.assertTrue(child.reaped)
        self.assertEqual(record['lifecycle'][-1]['stage'],'child-reaped')
        self.assertEqual(set(record['capture']['streamsDrainedToEOF']),{'stdout','stderr'})
        self.assertTrue(any('first panic' in v.get('message','') for v in record['orderedDiagnostics']))
        return child,record

    def test_live_drain_never_calls_a_stalled_or_forbidden_reporter(self):
        self.simulated_drain()

    def test_abort_is_sent_without_calling_reporter_then_pipes_are_drained(self):
        child,record=self.simulated_drain(timeout=True)
        self.assertEqual(child.stdin.getvalue(),b'abort\n')
        self.assertEqual(record['cooperativeAbortReason'],'stage-timeout')
        self.assertEqual(record['exit'],73)

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
