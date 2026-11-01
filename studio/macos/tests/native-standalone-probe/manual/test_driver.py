"""Synthetic/pure tests only. Never launch a native child or operate UI."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('manual_driver',Path(__file__).with_name('driver.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
BINDING=dict(runId='SIMULATED-run',receiptNonce='SIMULATED-nonce',binary='/owned/SIMULATED',signedSha256='a'*64,root='/private/tmp/SIMULATED')

def evidence():
    values=[]
    for name,actions in [('picker-cancel-real-null',1),('picker-preview-real-token',2),('manual-final-exact-no-copy',2)]:
        values.append({'kind':'native-picker-readback','value':dict(stage=name,nativeActions=actions,originalExact=True,publicationAbsent=True,copyExact=False,placements=0,pendingIntents=0,revision=1,bytes=94,hash='115d534fa5575cf7820a1c44c84824eb41871d514293561082f487cfcbe5a276',draftId='SIMULATED-ID')})
    values += [dict(kind='progress',stage=s) for s in ['manual-finish-exact-no-copy','production-exit-guards-approved-Some0']]
    values.append(dict(kind='result',phase=d.MODE,passed=True,scenarioCompleted=True,acceptance=True,approvedProgrammaticExits=1,nativeTerminateCounters=[1,1,1,0],forbiddenServiceAttempts=0,osStoreProviderConstructorsReachable=False,managedRuntimeAcquire=False,picker=dict(manual=True,completedManualResults=2,activePhase=None,failure=False,tokenRetained=True,finishRequested=True,automatedActions=0,alertCalls=0,readbackMask=14,defaultSuggestedFilenameInitialization=False)))
    return values

class Contract(unittest.TestCase):
    def capture(self):
        c=d.Capture();c.feed('stdout',b''.join(json.dumps(v).encode()+b'\n' for v in evidence()));c.finish('stdout');c.finish('stderr');return c
    def test_simulated_protocol(self):self.assertTrue(d.protocol(evidence()))
    def test_order_duplicate_null_no_place_and_alerts_fail(self):
        for change in ['order','duplicate','missing','null','place','actions','alert','token','finish']:
            v=copy.deepcopy(evidence())
            if change=='order':v[0],v[1]=v[1],v[0]
            elif change=='duplicate':v.append(copy.deepcopy(v[-1]))
            elif change=='missing':v.pop(1)
            elif change=='null':v[1]['value']['originalExact']=False
            elif change=='place':v.insert(0,dict(kind='progress',stage='picker-copy-real-receipt'))
            else:v[-1]['picker'][{'actions':'automatedActions','alert':'alertCalls','token':'tokenRetained','finish':'finishRequested'}[change]]=1 if change in ['actions','alert'] else False
            self.assertFalse(d.protocol(v),change)
    def test_exact_lexical_paths_only(self):
        root='/private/tmp/owned';self.assertTrue(d.lexical(root+'/copy-targets/draft.md',root))
        for path in ['/outside/draft.md',root+'/copy-targets/./draft.md',root+'/copy-targets/../copy-targets/draft.md','file://'+root+'/copy-targets/draft.md',None]:self.assertFalse(d.lexical(path,root))
    def test_environment_home_unchanged_and_provider_vars_excluded(self):
        env=d.environment('/private/tmp/owned',{'HOME':'/unchanged','PATH':'/usr/bin','OPENAI_API_KEY':'private','TAURI_CONFIG':'other','TMPDIR':'/old'})
        self.assertEqual(env,{'HOME':'/unchanged','PATH':'/usr/bin','TMPDIR':'/private/tmp/owned'})
    def test_overflow_keeps_draining_bounded(self):
        c=d.Capture(byte_limit=100,line_limit=3,partial_limit=16)
        for _ in range(1000):c.feed('stdout',b'{}\n'*50);c.feed('stderr',b'x'*8192)
        c.finish('stdout');c.finish('stderr');self.assertTrue(c.overflow);self.assertTrue(c.truncated);self.assertLessEqual(len(c.records),3);self.assertLessEqual(sum(map(len,c.pending.values())),32);self.assertEqual(c.eof,{'stdout','stderr'})
    def test_unterminated_and_duplicate_eof_are_incomplete(self):
        c=d.Capture();c.feed('stdout',b'{}');c.finish('stdout');self.assertTrue(c.truncated)
        c=d.Capture();c.finish('stdout');c.finish('stdout');self.assertTrue(c.truncated)
    def test_eof_reap_stop_overflow_startup_and_exit_gate(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root).resolve()/'receipt.json'
            for bad in ['none','eof','reap','stop','overflow','truncated','startup','exit']:
                control=Path(root).resolve()/bad;control.mkdir(mode=0o700);path=control/'receipt.json'
                c=self.capture();record={**BINDING,'startupIdentityVerified':bad!='startup'}
                if bad=='eof':c.eof.remove('stderr')
                if bad=='overflow':c.overflow=True
                if bad=='truncated':c.truncated=True
                result=d.finalize(path,record,c,73 if bad=='exit' else 0,bad!='reap',bad=='stop',expected_binding=BINDING)
                self.assertEqual(result['acceptance'],bad=='none',bad)
    def test_atomic_readback_and_failure_never_memory_pass(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root).resolve()/'receipt.json';self.assertEqual(d.atomic_receipt(path,{'acceptance':False}),{'acceptance':False});self.assertEqual(path.stat().st_mode&0o777,0o600)
            record={**BINDING,'startupIdentityVerified':True}
            with mock.patch.object(d.os,'fsync',side_effect=OSError('synthetic disk failure')):
                with self.assertRaises(OSError):d.finalize(path,record,self.capture(),0,True,expected_binding=BINDING)
            self.assertFalse(record['acceptance']);self.assertIsNone(d.read_final_receipt(path.parent,BINDING,d.private(path.parent)))
    def test_receipt_limit(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):d.atomic_receipt(Path(root).resolve()/'receipt.json',{'data':'x'*d.MAX_RECEIPT})
    def test_startup_proof_exact_binding_and_separate_observer(self):
        with tempfile.TemporaryDirectory() as root:
            r=dict(pid=101,collectorPID=102,childStart='child',collectorStart='collector',startupNonce='nonce',signedSha256='hash',root='/private/tmp/owned',startedAt=1)
            v={**r,'observerConfirmedLive':True,'observerPID':103,'observedAt':2};p=Path(root).resolve()/'startup-observed.json';d.atomic_receipt(p,v);self.assertTrue(d.startup_proof(p,r))
            for k,value in [('pid',9),('startupNonce','old'),('observerPID',102),('observerConfirmedLive',False),('observedAt',0)]:
                d.atomic_receipt(p,{**v,k:value});self.assertFalse(d.startup_proof(p,r),k)
    def test_mocked_single_child_drains_both_streams_and_reaps_without_forwarding(self):
        for issue in ['none','storage','disconnect','overflow','readerror']:
            with self.subTest(issue=issue):
                with tempfile.TemporaryDirectory() as folder:
                    root=Path(folder).resolve();binary=root/'synthetic-only';binary.write_bytes(b'not executable; mocked only')
                    rd,wr=os.pipe();out=os.fdopen(rd,'rb',buffering=0);os.write(wr,(b'x'*100+b'\n' if issue=='overflow' else b'')+b''.join(json.dumps(v).encode()+b'\n' for v in evidence()));os.close(wr)
                    rd,wr=os.pipe();err=os.fdopen(rd,'rb',buffering=0);os.close(wr)
                    rd,wr=os.pipe();childin=os.fdopen(wr,'wb',buffering=0);spare=os.fdopen(rd,'rb',buffering=0)
                    rd,wr=os.pipe();operator=os.fdopen(rd,'rb',buffering=0);operator_write=os.fdopen(wr,'wb',buffering=0)
                    if issue=='disconnect':operator_write.close()
                    child=mock.Mock(pid=123456,stdin=childin,stdout=out,stderr=err);child.poll.return_value=0;child.wait.return_value=0
                    binding=dict(runId='SIMULATED-run',receiptNonce='SIMULATED-nonce',launchAuthorized=True,root=str(root),binary=str(binary),signedSha256=d.hashlib.sha256(binary.read_bytes()).hexdigest())
                    original=d.atomic_receipt;calls=[0]
                    def write(path,value):
                        calls[0]+=1
                        if issue=='storage' and calls[0]==2:raise OSError('SIMULATED storage failure while child live')
                        return original(path,value)
                    actual_read=d.os.read;out_fd=out.fileno();read_count=[0]
                    def read(fd,size):
                        if fd==out_fd:
                            read_count[0]+=1
                            if issue=='readerror' and read_count[0]==2:raise OSError('SIMULATED read failure')
                        return actual_read(fd,size)
                    capture_factory=d.Capture
                    def capture():return capture_factory(partial_limit=64) if issue=='overflow' else capture_factory()
                    try:
                        with mock.patch.object(d.os,'read',side_effect=read),mock.patch.object(d,'atomic_receipt',side_effect=write),mock.patch.object(d,'Capture',side_effect=capture),mock.patch.object(d.subprocess,'Popen',return_value=child) as popen,mock.patch.object(d.subprocess,'check_output',return_value='SIMULATED-start'),mock.patch.object(d.os,'getpgid',return_value=123456),mock.patch.object(d,'startup_proof',return_value=True),mock.patch('sys.stdout',new_callable=io.StringIO) as stdout:
                            result=d.collect_owned(binary,root,root,binding,operator)
                            self.assertEqual(result['acceptance'],issue=='none');self.assertEqual(result['streamsEOF'],['stderr'] if issue=='readerror' else ['stderr','stdout']);child.wait.assert_called_once();
                            if issue=='readerror':
                                self.assertEqual(result['readErrors'],['stdout']);self.assertEqual(result['missingEOFStreams'],['stdout']);self.assertEqual(result['diagnostics'][0],evidence()[0]);self.assertFalse(result['acceptance'])
                            self.assertEqual(stdout.getvalue(),'');self.assertTrue(popen.call_args.kwargs['start_new_session']);self.assertEqual(len(popen.call_args.args[0]),4)
                    finally:operator.close();operator_write.close();spare.close()

    def test_actual_collector_postexit_held_delayed_continuous_and_unbounded_alive(self):
        for scenario in ['held','delayed','continuous','alive']:
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as folder:
                root=Path(folder).resolve();binary=root/'SIMULATED';binary.write_bytes(b'mocked child only')
                rd,out_write=os.pipe();out=os.fdopen(rd,'rb',buffering=0)
                prefix={'kind':'prefix','value':'SIMULATED retained prefix'}
                os.write(out_write,b''.join(json.dumps(v).encode()+b'\n' for v in [prefix,*evidence()]))
                if scenario=='held':os.write(out_write,b'SIMULATED partial prefix')
                rd,wr=os.pipe();err=os.fdopen(rd,'rb',buffering=0);os.close(wr)
                rd,wr=os.pipe();childin=os.fdopen(wr,'wb',buffering=0);spare=os.fdopen(rd,'rb',buffering=0)
                rd,wr=os.pipe();operator=os.fdopen(rd,'rb',buffering=0);operator_write=os.fdopen(wr,'wb',buffering=0)
                clock=[0.0];loops=[0];polls=[0];closed=[False]
                def close_writer():
                    if not closed[0]:os.close(out_write);closed[0]=True
                def poll():
                    polls[0]+=1
                    if scenario=='alive' and polls[0]<21:return None
                    if scenario=='alive':close_writer()
                    return 0
                actual_selector=d.selectors.DefaultSelector
                class Selector:
                    def __init__(self):self.inner=actual_selector()
                    def register(self,*args):return self.inner.register(*args)
                    def unregister(self,*args):return self.inner.unregister(*args)
                    def get_map(self):return self.inner.get_map()
                    def close(self):self.inner.close()
                    def select(self,timeout):
                        loops[0]+=1;clock[0]+=1.0 if scenario=='alive' else .25
                        if loops[0]>40:raise AssertionError('RED watchdog: exited child with held pipe never finalized')
                        if scenario=='delayed' and clock[0]>=1.5:close_writer()
                        if scenario=='continuous' and not closed[0]:os.write(out_write,b'{"kind":"tail"}\n')
                        return self.inner.select(0)
                child=mock.Mock(pid=123456,stdin=childin,stdout=out,stderr=err);child.poll.side_effect=poll;child.wait.return_value=0
                binding=dict(runId='SIMULATED-run',receiptNonce='SIMULATED-nonce',launchAuthorized=True,root=str(root),binary=str(binary),signedSha256=d.hashlib.sha256(binary.read_bytes()).hexdigest())
                try:
                    with mock.patch.object(d.subprocess,'Popen',return_value=child),mock.patch.object(d.subprocess,'check_output',return_value='SIMULATED-start'),mock.patch.object(d.os,'getpgid',return_value=123456),mock.patch.object(d,'startup_proof',return_value=True),mock.patch.object(d.selectors,'DefaultSelector',Selector),mock.patch.object(d.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(d.os,'kill') as kill,mock.patch.object(d.os,'killpg') as killpg:
                        result=d.collect_owned(binary,root,root,binding,operator)
                        self.assertEqual(result['acceptance'],scenario in ['delayed','alive']);self.assertTrue(result['reaped']);self.assertEqual(result['exit'],0);child.wait.assert_called_once();self.assertIn(prefix,result['diagnostics']);self.assertEqual(result,json.loads((root/'receipt.json').read_text()))
                        self.assertGreater(polls[0],1);kill.assert_not_called();killpg.assert_not_called();child.terminate.assert_not_called();child.kill.assert_not_called()
                        if scenario in ['held','continuous']:
                            self.assertEqual(result['missingEOFStreams'],['stdout']);self.assertEqual(result['streamsEOF'],['stderr']);self.assertTrue(result['postExitDrainExpired']);self.assertLessEqual(clock[0],2.5)
                            if scenario=='held':self.assertEqual(result['partialPrefixes']['stdout'],'SIMULATED partial prefix')
                        else:self.assertEqual(result['streamsEOF'],['stderr','stdout']);self.assertFalse(result['postExitDrainExpired'])
                        if scenario=='alive':self.assertGreaterEqual(clock[0],20)
                finally:close_writer();operator.close();operator_write.close();spare.close()

    def test_spawn_setup_failures_always_protect_owned_handles_and_record_actual_state(self):
        for seam in ['selector','register-stdout','register-stderr','register-operator','set-blocking','thread-create','thread-start']:
            with self.subTest(seam=seam),tempfile.TemporaryDirectory() as folder:
                root=Path(folder).resolve();binary=root/'SIMULATED';binary.write_bytes(b'mocked child only')
                handles=[];writers=[]
                for _ in range(4):
                    rd,wr=os.pipe();handles.append(os.fdopen(rd,'rb',buffering=0));writers.append(os.fdopen(wr,'wb',buffering=0))
                out,err,spare,operator=handles;childin=writers[2]
                child=mock.Mock(pid=123456,stdin=childin,stdout=out,stderr=err);child.poll.return_value=None
                binding=dict(runId='SIMULATED-run',receiptNonce='SIMULATED-nonce',launchAuthorized=True,root=str(root),binary=str(binary),signedSha256=d.hashlib.sha256(binary.read_bytes()).hexdigest())
                actual_selector=d.selectors.DefaultSelector
                class Selector:
                    def __init__(self):
                        if seam=='selector':raise OSError('SIMULATED selector setup failure')
                        self.inner=actual_selector()
                    def register(self,fileobj,events,data):
                        if seam=='register-'+data:raise OSError('SIMULATED registration failure')
                        return self.inner.register(fileobj,events,data)
                    def close(self):self.inner.close()
                fake_thread=mock.Mock();fake_thread.start.side_effect=OSError('SIMULATED thread start failure')
                thread_factory=mock.Mock(side_effect=OSError('SIMULATED thread create failure')) if seam=='thread-create' else mock.Mock(return_value=fake_thread)
                actual_blocking=d.os.set_blocking
                def blocking(fd,value):
                    if seam=='set-blocking':raise OSError('SIMULATED blocking setup failure')
                    return actual_blocking(fd,value)
                try:
                    with mock.patch.object(d.subprocess,'Popen',return_value=child) as popen,mock.patch.object(d.selectors,'DefaultSelector',Selector),mock.patch.object(d.threading,'Thread',thread_factory),mock.patch.object(d.os,'set_blocking',side_effect=blocking),mock.patch.object(d.os,'kill') as kill,mock.patch.object(d.os,'killpg') as killpg:
                        result=d.collect_owned(binary,root,root,binding,operator)
                        self.assertFalse(result['acceptance']);self.assertFalse(result['reaped']);self.assertIsNone(result['exit']);self.assertEqual(result['pid'],123456);self.assertEqual(result['signedSha256'],binding['signedSha256']);self.assertEqual(result['streamsEOF'],[]);self.assertEqual(result['missingEOFStreams'],['stderr','stdout']);self.assertIn('setupFailure',result);self.assertEqual(result,json.loads((root/'receipt.json').read_text()));popen.assert_called_once();child.wait.assert_not_called();child.terminate.assert_not_called();child.kill.assert_not_called();kill.assert_not_called();killpg.assert_not_called();self.assertTrue(out.closed and err.closed and childin.closed);self.assertFalse(operator.closed)
                finally:
                    for handle in handles+writers:handle.close()

    def complete(self, control):
        return d.finalize(control/'receipt.json',{**BINDING,'startupIdentityVerified':True},self.capture(),0,True,expected_binding=BINDING)

    def test_postreplace_sync_or_readback_failure_surviving_candidate_is_not_authority(self):
        for seam in ['directory-sync','readback']:
            with self.subTest(seam=seam),tempfile.TemporaryDirectory() as folder:
                root=Path(folder).resolve();path=root/'receipt.json';actual_sync=d.os.fsync;actual_read=d._read_owned
                def sync(fd):
                    if seam=='directory-sync' and d.stat.S_ISDIR(os.fstat(fd).st_mode) and path.exists() and json.loads(path.read_text()).get('acceptance') is True:raise OSError('SIMULATED post-replace directory sync failure')
                    return actual_sync(fd)
                def read(fd,name,limit):
                    if seam=='readback' and name=='receipt.json':raise OSError('SIMULATED candidate readback failure')
                    return actual_read(fd,name,limit)
                record={**BINDING,'startupIdentityVerified':True}
                with mock.patch.object(d.os,'fsync',side_effect=sync),mock.patch.object(d,'_read_owned',side_effect=read),mock.patch.object(Path,'unlink',side_effect=OSError('SIMULATED invalidation unavailable')) as unlink:
                    with self.assertRaises(OSError):d.finalize(path,record,self.capture(),0,True,expected_binding=BINDING)
                    unlink.assert_not_called()
                self.assertTrue(json.loads(path.read_text())['acceptance']);self.assertTrue((root/'receipt.pending').exists());self.assertFalse(record['acceptance']);self.assertIsNone(d.read_final_receipt(root,BINDING,d.private(root)))

    def test_guard_unlink_failure_is_incomplete_and_success_has_no_fallible_postcommit_work(self):
        for fail in [True,False]:
            with self.subTest(fail=fail),tempfile.TemporaryDirectory() as folder:
                root=Path(folder).resolve();actual_unlink=d.os.unlink;actual_sync=d.os.fsync;committed=[False]
                def unlink(name,*args,**kwargs):
                    if name=='receipt.pending':
                        if fail:raise OSError('SIMULATED guard commit failure')
                        value=actual_unlink(name,*args,**kwargs);committed[0]=True;return value
                    return actual_unlink(name,*args,**kwargs)
                def sync(fd):
                    if committed[0]:raise AssertionError('Fallible postcommit sync attempted')
                    return actual_sync(fd)
                with mock.patch.object(d.os,'unlink',side_effect=unlink),mock.patch.object(d.os,'fsync',side_effect=sync):
                    if fail:
                        with self.assertRaises(OSError):self.complete(root)
                    else:self.assertTrue(self.complete(root)['acceptance'])
                value=d.read_final_receipt(root,BINDING,d.private(root));self.assertEqual(value is not None,not fail)

    def test_restart_matching_commit_accepts_wrong_bindings_and_pending_reject(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();value=self.complete(root);identity=d.private(root)
            self.assertEqual(d.read_final_receipt(root,dict(BINDING),identity),value)
            for key in ['runId','receiptNonce','binary','signedSha256','root']:
                self.assertIsNone(d.read_final_receipt(root,{**BINDING,key:'STALE-'+BINDING[key]},identity),key)
            (root/'receipt.pending').write_text('malformed guard');(root/'receipt.pending').chmod(0o600)
            self.assertIsNone(d.read_final_receipt(root,BINDING,identity))
            (root/'receipt.pending').unlink()
            with mock.patch.object(d,'_guard_absent',side_effect=PermissionError('SIMULATED lookup error')):self.assertIsNone(d.read_final_receipt(root,BINDING,identity))
            with self.assertRaises(FileExistsError):self.complete(root)
            self.assertEqual(d.read_final_receipt(root,BINDING,identity),value)
            bad={**value,'finalState':'unknown'};d.atomic_receipt(root/'receipt.json',bad);self.assertIsNone(d.read_final_receipt(root,BINDING,identity))

    def test_reader_rejects_guard_directory_or_receipt_replacement_during_read(self):
        for change in ['guard','directory','receipt']:
            with self.subTest(change=change),tempfile.TemporaryDirectory() as folder:
                base=Path(folder).resolve();root=base/'control';root.mkdir(mode=0o700);self.complete(root);identity=d.private(root);actual_read=d._read_owned;changed=[False]
                def read(fd,name,limit):
                    result=actual_read(fd,name,limit)
                    if name=='receipt.json' and not changed[0]:
                        changed[0]=True
                        if change=='guard':
                            (root/'receipt.pending').write_text('introduced during read');(root/'receipt.pending').chmod(0o600)
                        elif change=='receipt':
                            data=(root/'receipt.json').read_bytes();(root/'receipt.json').rename(root/'old.json');(root/'receipt.json').write_bytes(data);(root/'receipt.json').chmod(0o600)
                        else:
                            root.rename(base/'old-control');root.mkdir(mode=0o700)
                    return result
                with mock.patch.object(d,'_read_owned',side_effect=read):self.assertIsNone(d.read_final_receipt(root,BINDING,identity))

    def test_one_attempt_crash_and_validation_boundaries_cannot_accept(self):
        for seam in ['pending-synced','validation']:
            with self.subTest(seam=seam),tempfile.TemporaryDirectory() as folder:
                root=Path(folder).resolve();marker=d._create_marker
                def create(fd,name,state,expected):
                    marker(fd,name,state,expected)
                    if seam=='pending-synced' and name=='receipt.pending':raise OSError('SIMULATED crash after guard sync')
                with mock.patch.object(d,'_create_marker',side_effect=create),mock.patch.object(d,'_candidate_valid',return_value=False):
                    with self.assertRaises((OSError,ValueError)):self.complete(root)
                self.assertIsNone(d.read_final_receipt(root,BINDING,d.private(root)))
                with self.assertRaises(FileExistsError):self.complete(root)

    def test_official_reader_rejects_malformed_type_permissions_and_wrong_directory_identity(self):
        for issue in ['json','symlink','permissions','directory-identity']:
            with self.subTest(issue=issue),tempfile.TemporaryDirectory() as folder:
                root=Path(folder).resolve();self.complete(root);identity=d.private(root);path=root/'receipt.json'
                if issue=='json':path.write_text('{')
                elif issue=='permissions':path.chmod(0o644)
                elif issue=='directory-identity':identity=(identity[0],identity[1]+1)
                else:path.rename(root/'other.json');path.symlink_to(root/'other.json')
                self.assertIsNone(d.read_final_receipt(root,BINDING,identity))

    def test_no_launch_without_later_gate(self):
        with tempfile.TemporaryDirectory() as root:
            with mock.patch.object(d.subprocess,'Popen') as popen:
                with self.assertRaises(ValueError):d.collect_owned(Path(root).resolve()/'missing',Path(root).resolve(),Path(root).resolve(),{},None)
                popen.assert_not_called()

if __name__=='__main__':unittest.main()
