"""Updater file/process boundaries; no installed app, profile, token or Keychain.

Fake signing/process fixtures prove transaction logic only. The Darwin-specific
signing test uses synthetic code in a temporary bundle, never secret storage.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('studio_update',ROOT/'studio/macos/update.py')
u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
A='a'*40;B='b'*40;TREE='c'*40
class Crash(BaseException):pass

def bundle(path,commit,generation=1):
    (path/'Contents/MacOS').mkdir(parents=True,mode=0o700)
    (path/'Contents/Resources').mkdir()
    (path/'Contents/MacOS/heinlein-native').write_text('native-'+commit)
    u.atomic_json(path/u.MANIFEST,{'commit':commit,'tree':TREE,'origin':u.ORIGIN,'channel':'main','updaterVersion':1,'generation':generation})
    return path

class FakeMac:
    def __init__(self,paths):self.p=paths;self.fail=None;self.children=[];self.calls=[];self.ready=True;self.alive=True
    def validate(self,path,legacy=False):
        self.calls.append(('validate',path))
        if (path/'Contents/MacOS/heinlein-native').read_text().startswith('tampered'):raise u.Failure('signature-failed')
        return u.read_json(path/u.MANIFEST)
    def exchange(self,a,b):
        self.calls.append(('swap',a,b))
        if self.fail=='swap':raise u.Failure('swap-failed')
        # This is a portable fixture primitive, not proof of native atomic exchange.
        temp=a.with_name('fixture-swap');a.rename(temp);b.rename(a);temp.rename(b)
        u.sync_dir(a.parent);u.sync_dir(b.parent)
    def source(self,installed):
        if self.fail=='fetch':raise u.Failure('fetch-failed')
        return {'commit':B,'tree':TREE,'origin':u.ORIGIN,'channel':'main'},self.p.cache
    def checkout(self,*_):return self.p.cache
    def build(self,root,stage,source,generation):
        if self.fail in ('build','sign'):raise u.Failure(self.fail+'-failed')
        bundle(stage,source['commit'],generation)
    def run(self,*args,**kwargs):self.calls.append(('activate',))
    def spawn(self,app,lease,nonce):
        owner=self
        class Child:
            pid=42
            def poll(self):return None if owner.alive else 1
        child=Child();self.children.append(os.dup(lease.file.fileno()))
        if not self.alive:os.close(self.children.pop())
        if self.ready:
            source=self.validate(app)
            u.atomic_json(self.p.cache/('ready-'+nonce+'.json'),{'nonce':nonce,'pid':42,'commit':source['commit'],'tree':source['tree']})
        return child
    def close(self):
        for fd in self.children:os.close(fd)
        self.children=[]

class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.p=u.Paths(home=Path(self.temp.name)/'home');self.p.home.mkdir(mode=0o700);self.p.ensure();bundle(self.p.app,A)
        self.mac=FakeMac(self.p);self.engine=u.Engine(self.p,self.mac)
    def tearDown(self):self.mac.close();self.temp.cleanup()
    def candidate(self):return bundle(self.p.staged(),B,2)
    def record(self,stage=None):return self.engine.install(stage or self.candidate(),{'commit':B,'tree':TREE,'generation':2},self.mac.validate(self.p.app))
    def test_complete_update_keeps_full_bundle_backup_and_public_receipt(self):
        result=self.engine.launch(ready_timeout=.1)
        self.assertEqual(result,{'state':'launched','commit':B});self.assertFalse(self.p.journal.exists())
        backups=list(self.p.stages.glob('*/Heinlein Studio.app'))
        self.assertEqual(len(backups),1);self.assertEqual(self.mac.validate(backups[0])['commit'],A)
        self.assertEqual(u.read_json(self.p.status)['generation'],2)
    def test_every_journal_and_swap_crash_recovers_known_old_or_acknowledged_new(self):
        for point in ['prepared','swap','swapped','starting','uncertain','ready']:
            with self.subTest(point=point):
                self.mac.close()
                if self.p.journal.exists():self.engine.recover()
                shutil.rmtree(self.p.app);bundle(self.p.app,A)
                self.engine.fault=lambda step: (_ for _ in ()).throw(Crash()) if step==point else None
                self.mac.ready=point!='uncertain';self.mac.alive=True
                with self.assertRaises(Crash):self.engine.launch(ready_timeout=0 if point=='uncertain' else .1)
                record=u.read_json(self.p.journal);self.mac.close();self.engine.fault=lambda _:None
                self.engine.recover();self.assertFalse(self.p.journal.exists())
                self.assertEqual(self.mac.validate(self.p.app)['commit'],B if point in ('ready','starting') else A)
    def test_late_ready_ack_finalizes_but_timeout_never_replaces_running_payload(self):
        self.mac.ready=False
        self.assertEqual(self.engine.launch(ready_timeout=0)['state'],'startup-uncertain')
        before=u.bundle_hash(self.p.app);record=u.read_json(self.p.journal)
        self.engine.recover();self.assertEqual(u.bundle_hash(self.p.app),before);self.assertTrue(self.p.journal.exists())
        self.assertEqual(self.engine.launch(ready_timeout=0)['state'],'running')
        u.atomic_json(self.p.cache/('ready-'+record['nonce']+'.json'),{'nonce':record['nonce'],'commit':B,'tree':TREE,'pid':42})
        self.engine.recover();self.assertFalse(self.p.journal.exists())
    def test_fetch_build_sign_or_swap_failure_launches_valid_previous_app(self):
        for failure in ['fetch','build','sign','swap']:
            with self.subTest(failure=failure):
                self.mac.close();self.mac.fail=failure
                self.assertEqual(self.engine.launch(ready_timeout=.1)['commit'],A)
                self.assertEqual(self.mac.validate(self.p.app)['commit'],A)
                self.assertFalse(self.p.journal.exists())
    def test_external_app_edit_after_preparation_stops_before_swap(self):
        stage=self.candidate()
        self.engine.fault=lambda point:(self.p.app/'Contents/MacOS/heinlein-native').write_text('author external install') if point=='prepared' else None
        with self.assertRaises(u.Failure):self.record(stage)
        self.assertFalse(any(c[0]=='swap' for c in self.mac.calls))
    def test_unknown_bundle_or_failed_rollback_stops_without_launch(self):
        self.record();self.mac.fail='swap'
        with self.assertRaises(u.Failure):self.engine.recover()
        self.assertTrue(self.p.journal.exists())
        self.mac.fail=None;self.engine.recover();self.assertEqual(self.mac.validate(self.p.app)['commit'],A)
    def test_disk_failure_before_journal_durability_never_swaps_live_app(self):
        before=u.bundle_hash(self.p.app)
        with patch.object(u.os,'fsync',side_effect=OSError('synthetic disk full')):
            with self.assertRaises(u.Failure):self.record()
        self.assertEqual(u.bundle_hash(self.p.app),before);self.assertFalse(any(c[0]=='swap' for c in self.mac.calls))
    def test_tampered_backup_refuses_rollback_and_retains_journal(self):
        record=self.record();backup=self.p.stage_path(record['stage'])
        (backup/'Contents/MacOS/heinlein-native').write_text('tampered fixture')
        with self.assertRaises(u.Failure):self.engine.recover()
        self.assertTrue(self.p.journal.exists());self.assertEqual(self.mac.validate(self.p.app)['commit'],B)
    def test_crash_after_rollback_exchange_recovers_without_second_swap(self):
        self.record();self.engine.fault=lambda step: (_ for _ in ()).throw(Crash()) if step=='rollback-swap' else None
        with self.assertRaises(Crash):self.engine.recover()
        swaps=len([c for c in self.mac.calls if c[0]=='swap']);self.engine.fault=lambda _:None;self.engine.recover()
        self.assertFalse(self.p.journal.exists());self.assertEqual(self.mac.validate(self.p.app)['commit'],A)
        self.assertEqual(len([c for c in self.mac.calls if c[0]=='swap']),swaps)
    def test_symlinks_invalid_journal_and_nonprivate_paths_fail_closed(self):
        (self.p.cache/'transaction-v1.json').symlink_to(self.p.home/'no-read')
        with self.assertRaises(u.Failure):self.engine.recover()
        self.p.journal.unlink();u.atomic_json(self.p.journal,{'stage':'../../outside','phase':'swapped','commit':B,'previousCommit':A})
        with self.assertRaises(u.Failure):self.engine.recover()
        self.p.cache.chmod(0o777)
        with self.assertRaises(u.Failure):self.p.ensure()
    def test_hardlinked_lock_is_rejected_without_changing_the_other_file(self):
        other=self.p.home/'unrelated-file';other.write_bytes(b'fixture');other.chmod(0o644)
        os.link(other,self.p.cache/'update.lock')
        with self.assertRaises(u.Failure):u.Lease(self.p.cache/'update.lock')
        self.assertEqual(other.read_bytes(),b'fixture');self.assertEqual(other.stat().st_mode&0o777,0o644)
    def test_update_and_lifetime_locks_block_another_launch(self):
        with u.Lease(self.p.cache/'update.lock'):
            with self.assertRaises(u.Failure):u.Lease(self.p.cache/'update.lock')
        with u.Lease(self.p.cache/'lifetime.lock'):
            self.assertEqual(self.engine.launch(ready_timeout=0)['state'],'running')
        self.assertFalse(any(c[0]=='swap' for c in self.mac.calls))
    def test_schedule_is_explicit_and_never_changes_running_bundle(self):
        before=u.bundle_hash(self.p.app)
        with self.assertRaises(u.Failure):self.engine.schedule()
        self.engine.check();self.assertFalse(self.p.scheduled.exists());self.engine.schedule()
        self.assertEqual(u.read_json(self.p.scheduled),{'commit':B,'tree':TREE});self.assertEqual(u.bundle_hash(self.p.app),before)
    def test_only_fixed_main_source_and_forward_history_are_accepted(self):
        class Source(u.Mac):
            target=B;forward=True
            def git(inner,args,output=True):
                if 'init' in args:
                    Path(args[-1]).mkdir(mode=0o700);(Path(args[-1])/'config').write_text('[core]\n bare = true\n repositoryformatversion = 0\n')
                if 'fetch' in args:self.assertIn(u.ORIGIN,args);self.assertIn('refs/heads/main:refs/heinlein/main',args)
                if 'merge-base' in args and not inner.forward:raise u.Failure('not-forward')
                if 'rev-parse' in args:return TREE if args[-1].endswith('^{tree}') else inner.target
                return ''
        source=Source(self.p)
        self.assertEqual(source.source({'commit':A})[0]['commit'],B)
        source.target=A;self.assertEqual(source.source({'commit':A})[0]['commit'],A)
        source.target='d'*40;source.forward=False
        with self.assertRaises(u.Failure):source.source({'commit':B})
    def test_tool_metadata_streams_do_not_mix_architecture_with_warning_output(self):
        command=[sys.executable,'-c','import sys;print("arm64");print("fixture warning",file=sys.stderr)']
        self.assertEqual(u.Mac(self.p).run(command,'fixture',output=True),'arm64')
        self.assertEqual(u.Mac(self.p).run(command,'fixture',output='stderr'),'fixture warning')
        self.assertIn('fixture warning',u.Mac(self.p).run(command,'fixture',output='combined'))
    def test_errors_and_environment_never_log_inherited_secrets(self):
        old=os.environ.get('GITHUB_TOKEN');os.environ['GITHUB_TOKEN']='DO_NOT_EXPORT'
        try:self.assertNotIn('GITHUB_TOKEN',u.environment(self.p.home))
        finally:
            if old is None:os.environ.pop('GITHUB_TOKEN',None)
            else:os.environ['GITHUB_TOKEN']=old
        self.assertEqual(str(u.Failure('build-failed')),'build-failed')

    def test_legacy_installation_refuses_automatic_update_and_retains_lock_inode(self):
        legacy=u.read_json(self.p.app/u.MANIFEST);legacy.pop('updaterVersion');u.atomic_json(self.p.app/u.MANIFEST,legacy)
        before=u.bundle_hash(self.p.app)
        with self.assertRaisesRegex(u.Failure,'legacy-bootstrap-required'):self.engine.launch(ready_timeout=0)
        self.assertEqual(u.bundle_hash(self.p.app),before);self.assertFalse(any(c[0]=='swap' for c in self.mac.calls))
        lock=self.p.cache/'update.lock';lock.write_bytes(b'');lock.chmod(0o644);inode=lock.stat().st_ino
        with u.Lease(lock):self.assertEqual(lock.stat().st_ino,inode)
        self.assertEqual(lock.stat().st_mode&0o777,0o600)
        self.p.cache.chmod(0o755);self.p.ensure();self.assertEqual(self.p.cache.stat().st_mode&0o777,0o700)
    def test_stage_only_prepares_verified_candidate_and_complete_rollback_for_legacy(self):
        legacy=u.read_json(self.p.app/u.MANIFEST);legacy.pop('updaterVersion');u.atomic_json(self.p.app/u.MANIFEST,legacy)
        before=u.bundle_hash(self.p.app)
        spec=importlib.util.spec_from_file_location('stage_install',ROOT/'studio/macos/install.py');installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
        receipt=installer.stage_update(self.p,self.mac)
        self.assertTrue(receipt['legacyBootstrapRequired']);self.assertEqual(u.bundle_hash(self.p.app),before)
        self.assertEqual(u.bundle_hash(self.p.stages/receipt['rollback']/self.p.app.name),before)
        self.assertEqual(self.mac.validate(self.p.stages/receipt['stage']/self.p.app.name)['commit'],B)
        self.assertFalse(any(c[0]=='swap' for c in self.mac.calls))
    def test_wrong_source_or_generation_does_not_replace_old_payload(self):
        stage=self.candidate()
        for source in [{'commit':A,'tree':TREE,'generation':2},{'commit':B,'tree':TREE,'generation':1}]:
            with self.assertRaises(u.Failure):self.engine.install(stage,source,self.mac.validate(self.p.app))
        self.assertEqual(self.mac.validate(self.p.app)['commit'],A)
    def test_inherited_lifetime_lease_survives_launcher_exit_until_native_exit(self):
        lease=u.Lease(self.p.cache/'lifetime.lock')
        child=subprocess.Popen([sys.executable,'-c','import sys; print("ready",flush=True); sys.stdin.buffer.read(1)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,pass_fds=(lease.file.fileno(),))
        try:
            self.assertEqual(child.stdout.readline(),b'ready\n');lease.close()
            with self.assertRaises(u.Failure):u.Lease(self.p.cache/'lifetime.lock')
            child.communicate(b'x');child.wait()
            with u.Lease(self.p.cache/'lifetime.lock'):pass
        finally:
            if child.poll() is None:child.communicate(b'x')
    @unittest.skipUnless(sys.platform=='darwin','native atomic exchange is macOS-only')
    def test_real_native_exchange_only_swaps_synthetic_full_bundles(self):
        stage=self.candidate();before=u.bundle_hash(self.p.app);candidate=u.bundle_hash(stage)
        u.Mac(self.p).exchange(self.p.app,stage)
        self.assertEqual(u.bundle_hash(self.p.app),candidate);self.assertEqual(u.bundle_hash(stage),before)
    @unittest.skipUnless(sys.platform=='darwin','native signing/architecture are macOS-only')
    def test_real_synthetic_bundle_signature_identity_architecture_and_tamper(self):
        source=self.p.cache/'fixture-source';(source/'studio/target/release').mkdir(parents=True)
        (source/'studio/macos').mkdir();(source/'studio/package.json').write_text('{"version":"1.5.0-rc.1"}')
        for name in ['update.py','install.py','Launcher.swift']:shutil.copy2(ROOT/'studio/macos'/name,source/'studio/macos'/name)
        program=source/'probe.c';program.write_text('int main(void){return 0;}')
        subprocess.run(['/usr/bin/xcrun','clang',str(program),'-o',str(source/'studio/target/release/heinlein-studio')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        spec=importlib.util.spec_from_file_location('bundle_install',ROOT/'studio/macos/install.py');builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
        destination=self.p.staged();platform=u.Mac(self.p)
        builder.stage_bundle(source,destination,{'commit':B,'tree':TREE},2,platform)
        self.assertEqual(platform.validate(destination)['commit'],B)
        (destination/'Contents/Resources/update.py').write_text('tampered')
        with self.assertRaises(u.Failure):platform.validate(destination)

if __name__=='__main__':unittest.main()
