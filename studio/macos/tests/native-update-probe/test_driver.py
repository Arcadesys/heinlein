"""Memory/byte-only receipt validation. Never executes a native binary."""
import importlib.util
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('update_driver',Path(__file__).with_name('driver.py'))
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)

class EvidenceTests(unittest.TestCase):
    def evidence(self):
        stages=['feature-explicit-invocation-private-root-sentinel-validated','all-tauri-app-paths-confined-before-webview-or-store','own-webkit-isPersistent-false-before-fixture-navigation','callback-gate-passed','with-webview-call-returned','worker-not-main-navigation-gates-complete','worker-navigation-enqueued','first-renderer-IPC','fixture-editor-focused','updates-initial-status','check-busy-duplicate-suppressed','quit-refused-during-check','check-failed-visible','explicit-retry-available','deferred-writing-retained','late-response-ignored','in-memory-scheduled','stale-save-failure-preserved','save-quit-held-for-genuine-ack','genuine-save-ack-released','production-request-close','production-exit-guards-approved-Some0']
        result=dict(approvedProgrammaticExits=1,closeCommands=2,forbiddenServiceAttempts=0,managedRuntimeAcquire=False,osStoreProviderConstructorsReachable=False,nativeTerminateCounters=[1,1,1,0],backend=dict(calls=['status','check','check','status','check','status','schedule'],realUpdaterExecutions=0))
        lines=[dict(kind='progress',stage=s) for s in stages]+[dict(kind='owned-window-observation',visible=True,focused=True,editorHasFocus=True,activeElement=True)]
        return result,lines
    def test_requires_all_ordered_phases(self):
        result,lines=self.evidence();driver.validate_result(result,lines)
        for index in range(len(lines)-1):
            with self.subTest(index=index),self.assertRaises((ValueError,RuntimeError)):
                driver.validate_result(result,lines[:index]+lines[index+1:])
        lines[1],lines[2]=lines[2],lines[1]
        with self.assertRaises(RuntimeError):driver.validate_result(result,lines)
    def test_refuses_missing_focus_extra_backend_or_forbidden_service(self):
        for key,value in [('closeCommands',1),('approvedProgrammaticExits',0),('forbiddenServiceAttempts',1),('managedRuntimeAcquire',True)]:
            r,lines=self.evidence();r[key]=value
            with self.subTest(key=key),self.assertRaises(RuntimeError):driver.validate_result(r,lines)
        r,lines=self.evidence();r['backend']['calls'].append('schedule')
        with self.assertRaises(RuntimeError):driver.validate_result(r,lines)
        r,lines=self.evidence();lines[-1]['focused']=False
        with self.assertRaises(RuntimeError):driver.validate_result(r,lines)
if __name__=='__main__':unittest.main()
