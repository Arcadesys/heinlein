#!/usr/bin/env python3
"""Fixed main-source updater. No credentials, manuscripts, raw subprocess logs or feed.

The update gate covers recovery/check/build/swap/launch/readiness; a separately
inherited lifetime lease covers the complete native process lifetime. File tests
inject platform primitives; production has no unsigned/test bypass.
"""
from __future__ import annotations
import argparse
import contextlib
import configparser
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

IDENTIFIER = 'me.thearcades.heinlein.studio'
ORIGIN = 'https://github.com/Arcadesys/heinlein.git'
CHANNEL = 'main'
SAFE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
MANIFEST = 'Contents/Resources/source-update.json'
PHASES = {'prepared', 'swapped', 'starting', 'uncertain', 'ready', 'rollback'}

class Failure(Exception):
    def __init__(self, code, step='update'):
        self.code, self.step = code, step
        super().__init__(code)  # Never include paths/process output/provider bodies.

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try: os.fsync(fd)
    finally: os.close(fd)

def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, sort_keys=True)
            out.flush(); os.fsync(out.fileno())
        os.replace(temporary, path); sync_dir(path.parent)
    except OSError: raise Failure('storage-unavailable') from None
    finally:
        if temporary.exists(): temporary.unlink()

def read_json(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 65536:
                raise Failure('unsafe-state')
            return json.load(source)
    except FileNotFoundError: return None
    except (OSError, ValueError, TypeError): raise Failure('invalid-state') from None

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()

def files(path):
    result = {}
    for root, directories, names in os.walk(path, followlinks=False):
        for name in directories + names:
            entry = Path(root) / name
            info = entry.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise Failure('unsafe-bundle')
            if name in names:
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise Failure('unsafe-bundle')
                result[entry.relative_to(path).as_posix()] = digest(entry)
        if len(result) > 10000: raise Failure('bundle-limit')
    return result

def bundle_hash(path):
    return hashlib.sha256(json.dumps(files(path), sort_keys=True).encode()).hexdigest()

def revision(value):
    return isinstance(value, str) and len(value) == 40 and all(c in '0123456789abcdef' for c in value)

class Paths:
    def __init__(self, home=None, app=None):
        self.home = Path(home or Path.home()).resolve()
        self.app = Path(app or self.home / 'Applications/Heinlein Studio.app')
        self.cache = self.home / 'Library/Application Support/Heinlein Studio/updater'
        self.stages = self.home / 'Applications/.heinlein-updates'
        self.journal = self.cache / 'transaction-v1.json'
        self.status = self.cache / 'status-v1.json'
        self.scheduled = self.cache / 'next-launch-v1.json'
    def ensure(self):
        if self.app != self.home / 'Applications/Heinlein Studio.app': raise Failure('unsupported-install')
        for target in (self.cache, self.stages, self.app.parent):
            current = target
            while current != self.home:
                if current.is_symlink() or (current / '.git').exists(): raise Failure('unsafe-path')
                if current.exists():
                    info = current.stat()
                    if info.st_uid != os.getuid() or info.st_mode & 0o022: raise Failure('unsafe-path')
                current = current.parent
            target.mkdir(parents=True, mode=0o700, exist_ok=True)
        for private in (self.cache, self.stages):
            if private.stat().st_mode & 0o077: private.chmod(0o700)  # Tighten owned updater-only legacy directories.
        if self.app.is_symlink(): raise Failure('unsafe-path')
    def staged(self):
        path = self.stages / uuid.uuid4().hex
        path.mkdir(mode=0o700)
        return path / self.app.name
    def stage_path(self, name):
        if not isinstance(name, str) or len(name) != 32 or any(c not in '0123456789abcdef' for c in name):
            raise Failure('invalid-journal')
        path = self.stages / name / self.app.name
        if path.parent.is_symlink() or path.is_symlink(): raise Failure('unsafe-path')
        return path

class Lease:
    def __init__(self, path, blocking=False):
        self.file = os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'r+b')
        info = os.fstat(self.file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022 or info.st_nlink != 1:
            self.file.close(); raise Failure('unsafe-lock')
        if info.st_mode & 0o077: os.fchmod(self.file.fileno(),0o600)  # Keep the existing inode/lock.
        try: fcntl.flock(self.file, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            self.file.close(); raise Failure('busy') from None
    def close(self): self.file.close()  # Do not LOCK_UN: child shares this description.
    def __enter__(self): return self
    def __exit__(self, *_): self.close()

def environment(home):
    cargo=Path(home)/'.cargo/bin'
    tool_path=SAFE_PATH
    if cargo.is_dir() and not cargo.is_symlink() and cargo.stat().st_uid==os.getuid() and not cargo.stat().st_mode&0o022:
        tool_path=str(cargo)+':'+tool_path
    return {'PATH': tool_path, 'HOME': str(home), 'LANG': 'en_US.UTF-8',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_CONFIG_COUNT': '0', 'GIT_TERMINAL_PROMPT': '0',
            'PYTHONNOUSERSITE': '1', 'CARGO_TERM_COLOR': 'never', 'NO_COLOR': '1'}

class Mac:
    def __init__(self, paths): self.paths = paths
    def tool(self, name):
        choices = {'git':['/usr/bin/git'], 'swift':['/usr/bin/xcrun'],
                   'npm':['/opt/homebrew/bin/npm','/usr/local/bin/npm'],
                   'cargo':[str(self.paths.home / '.cargo/bin/cargo'),'/opt/homebrew/bin/cargo']}[name]
        for choice in choices:
            p = Path(choice)
            if p.is_file() and os.access(p, os.X_OK):
                resolved = p.resolve()
                if resolved.stat().st_mode & 0o022 or resolved.stat().st_uid not in (0,os.getuid()): continue
                return str(p)
        raise Failure('toolchain-unavailable', name)
    def run(self, command, step, cwd=None, output=False, timeout=1800):
        try:
            p = subprocess.run(command, cwd=cwd, env=environment(self.paths.home),
                stdout=subprocess.PIPE if output else subprocess.DEVNULL,
                stderr=subprocess.PIPE if output else subprocess.DEVNULL, timeout=timeout, check=False)
            if p.returncode: raise Failure(step + '-failed', step)
            captured = (p.stdout + p.stderr) if output else b''
            value = p.stdout+b'\n'+p.stderr if output=='combined' else p.stderr if output=='stderr' else p.stdout if output else b''
            if len(captured) > 65536: raise Failure('output-limit', step)
            return value.decode('utf-8', errors='strict').strip()
        except (OSError, UnicodeError, subprocess.TimeoutExpired): raise Failure(step + '-failed', step) from None
    def git(self, args, output=True):
        return self.run([self.tool('git'), '-c','core.hooksPath=/dev/null','-c','credential.helper=',
            '-c','protocol.file.allow=never', *args], 'fetch', output=output, timeout=120)
    def source(self, installed):
        bare = self.paths.cache / 'source'
        if bare.is_symlink(): raise Failure('unsafe-path')
        # Do not reuse a legacy working tree: it may contain untracked build inputs.
        if bare.exists() and (bare / '.git').exists(): bare = self.paths.cache / 'source-main-v1.git'
        if not bare.exists(): self.git(['init','--bare',str(bare)])
        if bare.resolve() != bare or (bare / 'hooks').is_symlink(): raise Failure('unsafe-path')
        self.validate_git_cache(bare)
        self.git(['--git-dir',str(bare),'fetch','--no-tags',ORIGIN,'refs/heads/main:refs/heinlein/main'])
        commit = self.git(['--git-dir',str(bare),'rev-parse','refs/heinlein/main'])
        tree = self.git(['--git-dir',str(bare),'rev-parse',commit+'^{tree}'])
        if not revision(commit) or not revision(tree): raise Failure('invalid-source')
        if installed and installed['commit'] != commit:
            self.git(['--git-dir',str(bare),'merge-base','--is-ancestor',installed['commit'],commit])
        return {'commit':commit,'tree':tree,'origin':ORIGIN,'channel':CHANNEL}, bare
    def validate_git_cache(self, bare):
        for root,dirs,names in os.walk(bare,followlinks=False):
            if any((Path(root)/name).is_symlink() for name in dirs+names):raise Failure('unsafe-source-cache')
        if (bare/'objects/info/alternates').exists():raise Failure('unsafe-source-cache')
        config=bare/'config'
        if not config.is_file() or config.stat().st_size>65536:raise Failure('unsafe-source-cache')
        parsed=configparser.RawConfigParser()
        try:parsed.read_string(config.read_text())
        except (ValueError,configparser.Error):raise Failure('unsafe-source-cache') from None
        allowed={'repositoryformatversion','filemode','bare','ignorecase','precomposeunicode','logallrefupdates'}
        if parsed.sections()!=['core'] or not set(parsed['core']).issubset(allowed) or parsed['core'].get('bare')!='true':raise Failure('unsafe-source-cache')
    def checkout(self, source, bare):
        root = self.paths.cache / ('build-' + uuid.uuid4().hex)
        root.mkdir(mode=0o700)
        # Git archive cannot execute hooks/filters; validate every member before extraction.
        archive = root / 'source.tar'
        with archive.open('xb') as out:
            p = subprocess.run([self.tool('git'),'--git-dir',str(bare),'archive',source['commit']],
                env=environment(self.paths.home),stdout=out,stderr=subprocess.DEVNULL,timeout=120)
        if p.returncode or archive.stat().st_size > 256*1024*1024: raise Failure('source-archive')
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            if len(members)>20000 or any(not (m.isfile() or m.isdir()) or Path(m.name).is_absolute()
                or '..' in Path(m.name).parts for m in members): raise Failure('unsafe-source')
            for member in members:
                target=root/member.name
                if member.isdir(): target.mkdir(parents=True,exist_ok=True)
                else:
                    target.parent.mkdir(parents=True,exist_ok=True)
                    with target.open('xb') as out: shutil.copyfileobj(tar.extractfile(member),out)
                    target.chmod(0o755 if member.mode & 0o111 else 0o644)
        archive.unlink()
        return root
    def build(self, root, destination, source, generation):
        self.run([self.tool('npm'),'ci','--cache',str(self.paths.cache/'npm')], 'build', cwd=root/'studio')
        self.run([self.tool('npm'),'run','tauri','build','--','--no-bundle','--runner',self.tool('cargo'),'--','--locked'], 'build',cwd=root/'studio')
        spec=importlib.util.spec_from_file_location('heinlein_bundle_builder',Path(__file__).with_name('install.py'))
        module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        module.stage_bundle(root,destination,source,generation,self)
    def sign(self, app):
        for relative, identifier in [('Contents/MacOS/heinlein-native',IDENTIFIER+'.native'),
                                      ('Contents/MacOS/heinlein-launcher',IDENTIFIER),('',IDENTIFIER)]:
            self.run(['/usr/bin/codesign','--force','--sign','-','--timestamp=none','--identifier',identifier,str(app/relative)],'sign')
    def validate(self, app, legacy=False):
        inventory=files(app)
        try: info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
        except (OSError,ValueError): raise Failure('invalid-bundle') from None
        if info.get('CFBundleIdentifier')!=IDENTIFIER or info.get('CFBundleExecutable')!='heinlein-launcher':
            raise Failure('identity-mismatch')
        source=read_json(app/MANIFEST)
        if not source or source.get('origin')!=ORIGIN or not revision(source.get('commit')): raise Failure('source-mismatch')
        modern=source.get('updaterVersion')==1
        if not modern and not legacy: raise Failure('unsupported-bundle')
        if modern:
            if source.get('channel')!=CHANNEL or not revision(source.get('tree')) or not isinstance(source.get('generation'),int) or source['generation']<1:
                raise Failure('source-mismatch')
            expected={k:v for k,v in inventory.items() if k not in (MANIFEST,'Contents/MacOS/heinlein-launcher') and not k.startswith('Contents/_CodeSignature/')}
            if source.get('files')!=expected: raise Failure('tampered-bundle')
        self.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],'signature')
        for relative, suffix in [('heinlein-native','.native'),('heinlein-launcher','')]:
            binary=app/'Contents/MacOS'/relative
            arch=self.run(['/usr/bin/lipo','-archs',str(binary)],'architecture',output=True)
            expected_arch='arm64' if os.uname().machine=='arm64' else 'x86_64'
            if arch!=expected_arch: raise Failure('architecture-mismatch')
            if modern:
                details=self.run(['/usr/bin/codesign','-dvv',str(binary)],'signature',output='stderr')
                if ('Identifier='+IDENTIFIER+suffix) not in details.splitlines(): raise Failure('signing-identity-mismatch')
        return source
    def exchange(self, a, b):
        if sys.platform!='darwin': raise Failure('unsupported-platform')
        libc=ctypes.CDLL(None,use_errno=True)
        if libc.renamex_np(os.fsencode(a),os.fsencode(b),2): raise Failure('swap-failed')
        sync_dir(a.parent); sync_dir(b.parent)
    def spawn(self, app, lease, nonce):
        env=environment(self.paths.home)
        env.update(HEINLEIN_LIFETIME_FD=str(lease.file.fileno()),HEINLEIN_READY_NONCE=nonce)
        return subprocess.Popen([str(app/'Contents/MacOS/heinlein-native')],env=env,
            pass_fds=(lease.file.fileno(),),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

class Engine:
    def __init__(self, paths, platform, fault=lambda _:None):
        self.p,self.mac,self.fault=paths,platform,fault
        paths.ensure()
    def status(self, code, **values):
        allowed={k:v for k,v in values.items() if k in ('commit','tree','availableCommit','availableTree','generation')}
        value={'state':code,**allowed}
        try:atomic_json(self.p.status,value)
        except Failure:pass  # Advisory status is not an install/readiness journal.
        return value
    def journal(self, value, phase):
        value['phase']=phase; atomic_json(self.p.journal,value); self.fault(phase)
    def active(self):
        try: return Lease(self.p.cache/'lifetime.lock')
        except Failure as error:
            if error.code=='busy': return None
            raise
    def recover(self, held=None):
        record=read_json(self.p.journal)
        if record is None: return
        if record.get('phase') not in PHASES or not revision(record.get('commit')) or not revision(record.get('previousCommit')):
            raise Failure('invalid-journal')
        backup=self.p.stage_path(record.get('stage'))
        lease=held or self.active()
        try:
            ready=read_json(self.p.cache/('ready-'+record['nonce']+'.json')) if valid_nonce(record.get('nonce')) else None
            if not valid_nonce(record.get('nonce')): raise Failure('invalid-journal')
            live=bundle_hash(self.p.app)
            if live==record['candidateHash'] and ready and ready.get('nonce')==record['nonce'] and ready.get('commit')==record['commit'] and ready.get('tree')==record['tree']:
                self.mac.validate(self.p.app); self.finish(record)
            elif lease is None:
                self.status('startup-uncertain'); return  # Never kill/replace a possibly running native.
            elif live==record['previousHash']:
                self.mac.validate(self.p.app,legacy=True); self.p.journal.unlink();sync_dir(self.p.cache)
                self.status('rolled-back',commit=record['previousCommit'])
            elif live==record['candidateHash']:
                self.mac.validate(backup,legacy=True)
                if bundle_hash(backup)!=record['previousHash']: raise Failure('backup-mismatch')
                self.journal(record,'rollback');self.mac.exchange(self.p.app,backup);self.fault('rollback-swap')
                self.mac.validate(self.p.app,legacy=True)
                self.p.journal.unlink();sync_dir(self.p.cache);self.status('rolled-back',commit=record['previousCommit'])
            else: raise Failure('recovery-required')
        finally:
            if held is None and lease is not None: lease.close()
    def finish(self, record):
        self.journal(record,'ready')
        self.p.journal.unlink();sync_dir(self.p.cache)
        if self.p.scheduled.exists(): self.p.scheduled.unlink();sync_dir(self.p.cache)
        self.status('current',commit=record['commit'],tree=record['tree'],generation=record['generation'])
    def install(self, candidate, source, previous, expected_previous_hash=None):
        if previous.get('updaterVersion')!=1:raise Failure('legacy-bootstrap-required')
        actual_previous=self.mac.validate(self.p.app,legacy=True)
        if actual_previous!=previous or (expected_previous_hash and bundle_hash(self.p.app)!=expected_previous_hash):raise Failure('bundle-changed')
        metadata=self.mac.validate(candidate)
        if metadata['commit']!=source['commit'] or metadata['tree']!=source['tree'] or metadata.get('generation')!=source['generation'] or source['generation']<=previous.get('generation',0):
            raise Failure('source-mismatch')
        record={'phase':'prepared','stage':candidate.parent.name,'commit':source['commit'],'tree':source['tree'],
            'previousCommit':previous['commit'],'candidateHash':bundle_hash(candidate),'previousHash':bundle_hash(self.p.app),
            'generation':source['generation'],'nonce':secrets.token_hex(16)}
        self.journal(record,'prepared')
        self.p.ensure()
        if bundle_hash(self.p.app)!=record['previousHash'] or bundle_hash(candidate)!=record['candidateHash']:
            raise Failure('bundle-changed')
        self.mac.exchange(self.p.app,candidate);self.fault('swap')
        self.journal(record,'swapped');return record
    def check(self):
        self.recover()
        if self.p.journal.exists(): raise Failure('startup-uncertain')
        installed=self.mac.validate(self.p.app,legacy=True)
        source,_=self.mac.source(installed)
        return self.status('current' if installed['commit']==source['commit'] else 'available',
            commit=installed['commit'],tree=installed.get('tree'),availableCommit=source['commit'],availableTree=source['tree'],generation=installed.get('generation',0))
    def schedule(self):
        status=read_json(self.p.status)
        if not status or status.get('state')!='available' or not revision(status.get('availableCommit')) or not revision(status.get('availableTree')):
            raise Failure('check-first')
        if self.mac.validate(self.p.app,legacy=True)['commit']!=status.get('commit'): raise Failure('check-first')
        atomic_json(self.p.scheduled,{'commit':status['availableCommit'],'tree':status['availableTree']})
        return self.status('scheduled',**{k:v for k,v in status.items() if k!='state'})
    def launch(self, ready_timeout=15, rebuild=False):
        self.recover()
        lease=self.active()
        if lease is None:
            atomic_json(self.p.cache/'activate-v1.json',{'nonce':uuid.uuid4().hex})
            self.mac.run([str(self.p.app/'Contents/MacOS/heinlein-launcher'),'--activate-existing'],'activate',timeout=10)
            return self.status('running')
        with lease:
            if self.p.journal.exists(): raise Failure('recovery-required')
            previous=self.mac.validate(self.p.app,legacy=True);previous_hash=bundle_hash(self.p.app);record=None
            if previous.get('updaterVersion')!=1:raise Failure('legacy-bootstrap-required')
            try:
                source,bare=self.mac.source(previous)
                scheduled=read_json(self.p.scheduled)
                if scheduled:
                    if not revision(scheduled.get('commit')) or not revision(scheduled.get('tree')): raise Failure('invalid-state')
                    for old,new in [(previous['commit'],scheduled['commit']),(scheduled['commit'],source['commit'])]:
                        self.mac.git(['--git-dir',str(bare),'merge-base','--is-ancestor',old,new])
                    if self.mac.git(['--git-dir',str(bare),'rev-parse',scheduled['commit']+'^{tree}'])!=scheduled['tree']: raise Failure('source-mismatch')
                    source={**source,**scheduled}
                if rebuild or source['commit']!=previous['commit']:
                    source['generation']=previous.get('generation',0)+1
                    stage=self.p.staged();root=self.mac.checkout(source,bare)
                    self.mac.build(root,stage,source,source['generation'])
                    record=self.install(stage,source,previous,previous_hash)
            except Exception as error:
                if self.p.journal.exists(): self.recover(held=lease)
                record=None  # Recovery restored the previous app; never acknowledge a discarded candidate.
                self.status(error.code if isinstance(error,Failure) else 'build-failed',commit=previous['commit'])
            # Never launch invalid code even on offline/build/sign/rollback failure.
            source=self.mac.validate(self.p.app,legacy=True)
            nonce=record['nonce'] if record else secrets.token_hex(16)
            child=self.mac.spawn(self.p.app,lease,nonce)
            if record: self.journal(record,'starting')
            deadline=time.monotonic()+ready_timeout
            while time.monotonic()<deadline:
                ack=read_json(self.p.cache/('ready-'+nonce+'.json'))
                if ack and ack.get('nonce')==nonce and ack.get('pid')==child.pid and ack.get('commit')==source['commit'] and ack.get('tree')==source.get('tree'):
                    if record:self.finish(record)
                    return {'state':'launched','commit':source['commit']}
                if child.poll() is not None: break
                time.sleep(.05)
            if child.poll() is None:
                if record:self.journal(record,'uncertain')
                return self.status('startup-uncertain',commit=source['commit'])
        # Lease is released only after a known child exit, enabling safe rollback.
        if record:
            self.recover()
            return self.launch_previous(ready_timeout)
        return self.status('startup-exited',commit=source['commit'])
    def launch_previous(self, timeout):
        lease=self.active()
        if lease is None:return self.status('startup-uncertain')
        with lease:
            source=self.mac.validate(self.p.app,legacy=True)
            nonce=secrets.token_hex(16);child=self.mac.spawn(self.p.app,lease,nonce)
            deadline=time.monotonic()+timeout
            while time.monotonic()<deadline:
                ack=read_json(self.p.cache/('ready-'+nonce+'.json'))
                if ack and ack.get('nonce')==nonce and ack.get('pid')==child.pid and ack.get('commit')==source['commit'] and ack.get('tree')==source.get('tree'):
                    return self.status('rolled-back-launched',commit=source['commit'])
                if child.poll() is not None:return self.status('startup-exited',commit=source['commit'])
                time.sleep(.05)
            return self.status('startup-uncertain',commit=source['commit'])

def valid_nonce(value):
    return isinstance(value,str) and len(value)==32 and all(c in '0123456789abcdef' for c in value)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--app',required=True)
    parser.add_argument('action',choices=['status','check','schedule','launch'])
    args=parser.parse_args();p=Paths(app=args.app)
    try:
        if sys.platform!='darwin':raise Failure('unsupported-platform')
        p.ensure()
        with Lease(p.cache/'update.lock'):
            engine=Engine(p,Mac(p))
            if args.action=='status': result=read_json(p.status) or {'state':'not-checked'}
            else: result=getattr(engine,args.action)()
        print(json.dumps(result))
    except Failure as error:
        print(json.dumps({'state':error.code,'step':error.step}))
        return 1
    except Exception:
        print(json.dumps({'state':'update-unavailable','step':'update'}));return 1
    return 0
if __name__=='__main__':sys.exit(main())
