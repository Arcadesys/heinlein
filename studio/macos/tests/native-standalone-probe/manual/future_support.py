"""Reusable manual47 preparation controls. No import-time actions or native launch."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import re

MODE='picker-manual-preview'
BIND_KEYS=('runId','receiptNonce','binary','signedSha256','root')


def digest(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        m=os.fstat(f.fileno())
        if not stat.S_ISREG(m.st_mode) or m.st_uid!=os.getuid() or m.st_nlink!=1 or m.st_mode&0o022:
            raise ValueError('Unsafe pinned file')
        h=hashlib.sha256()
        while data:=f.read(65536):h.update(data)
        return h.hexdigest()


def host_digest(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        m=os.fstat(f.fileno())
        if not stat.S_ISREG(m.st_mode) or m.st_uid not in (0,os.getuid()) or m.st_mode&0o022:raise ValueError('Unsafe host pin')
        h=hashlib.sha256()
        while data:=f.read(65536):h.update(data)
        return h.hexdigest()


def sanitized_environment(root, parent):
    allowed={'HOME','PATH','LANG','LC_ALL','LC_CTYPE','USER','LOGNAME','SHELL','__CF_USER_TEXT_ENCODING'}
    env={key:value for key,value in parent.items() if key in allowed};env['TMPDIR']=str(root)
    if env.get('HOME')!=parent.get('HOME'):raise ValueError('HOME must remain unchanged')
    return env


def private_identity(path, expected):
    path=Path(path);m=path.lstat()
    if path.resolve()!=path or not stat.S_ISDIR(m.st_mode) or m.st_uid!=os.getuid() or stat.S_IMODE(m.st_mode)!=0o700 or [m.st_dev,m.st_ino]!=expected:
        raise ValueError('Private directory changed')


def read_json(path, limit=2097152):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        m=os.fstat(f.fileno())
        if not stat.S_ISREG(m.st_mode) or m.st_uid!=os.getuid() or m.st_nlink!=1 or m.st_mode&0o077 or m.st_size>limit:
            raise ValueError('Unsafe bounded private JSON')
        data=f.read(limit+1)
        if len(data)>limit:raise ValueError('JSON bound exceeded')
        return json.loads(data)


def validate_preflight(path, expected_hash, before_launch):
    path=Path(path)
    if path.name!='preflight.json' or digest(path)!=expected_hash:
        raise ValueError('Independent preflight hash mismatch')
    p=read_json(path)
    if p.get('schema')!='manual47-signed-prepared-v1' or not re.fullmatch(r'[0-9a-f]{40}',str(p.get('commit',''))) or not re.fullmatch(r'[0-9a-f]{40}',str(p.get('tree',''))) or p.get('phase')!=MODE:
        raise ValueError('Unexpected prepared source/phase')
    if p.get('signedPrepared') is not True or any(p.get(k) is not False for k in ('launchAuthorized','nativeExecuted','acceptance')):
        raise ValueError('Preparation is not runtime authorization or acceptance')
    control=Path(p['control']['path']);root=Path(p['root']['path'])
    if path.parent!=control or Path(__file__).resolve().parent!=control:
        raise ValueError('Only this pinned control package may be used')
    private_identity(control,p['control']['identity']);private_identity(root,p['root']['identity'])
    if root.parent!=Path('/private/tmp') or root.name!='heinlein-native-standalone-'+p['runId']:
        raise ValueError('Exact synthetic root required')
    for name,expected in p['files'].items():
        rel=Path(name)
        if rel.is_absolute() or '..' in rel.parts or digest(control/rel)!=expected:
            raise ValueError('Pinned preparation file changed')
    for item in p['hostDylibs']:
        if item.get('sha256') and (str(Path(item['loadPath']).resolve())!=item['resolved'] or host_digest(Path(item['resolved']))!=item['sha256']):
            raise ValueError('Host dylib pin changed')
    if host_digest(Path(p['systemVersionPin']['path']))!=p['systemVersionPin']['sha256']:raise ValueError('Host OS pin changed')
    if host_digest(Path(p['python']['path']))!=p['python']['sha256']:
        raise ValueError('Pinned Python changed')
    if before_launch and (any(root.iterdir()) or any((control/name).exists() for name in ('receipt.json','receipt.pending','receipt.attempt'))):
        raise ValueError('Fresh empty root and no previous collector receipt required')
    p['_preflightHash']=expected_hash
    return p


def expected_binding(p):
    b={key:p['binding'][key] for key in BIND_KEYS}
    if b['runId']!=p['runId'] or b['root']!=p['root']['path'] or b['binary']!=p['binary'] or b['signedSha256']!=p['files'][str(Path(p['binary']).relative_to(p['control']['path']))]:
        raise ValueError('Independent prepared binding mismatch')
    return b


def make_plan(p, authorized, terminal_owned, operator):
    if authorized is not True or terminal_owned is not True:
        raise ValueError('Later explicit native launch and operator-owned Terminal authorization required')
    if operator is None or not operator.isatty():
        raise ValueError('Retained user-owned Terminal input required; heredoc/redirected/EOF input is forbidden')
    return {'control':p['control']['path'],'root':p['root']['path'],'binary':p['binary'],
            'controlIdentity':p['control']['identity'],'binding':expected_binding(p),
            'preflightHash':p['_preflightHash']}


def claim_attempt(plan):
    control=Path(plan['control']);private_identity(control,plan['controlIdentity'])
    parent=os.open(control,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        opened=os.fstat(parent)
        if [opened.st_dev,opened.st_ino]!=plan['controlIdentity']:
            raise ValueError('Control directory replaced before claim')
        payload=json.dumps({'state':'attempted','binding':plan['binding'],'preflightSha256':plan['preflightHash'],'collectorPID':os.getpid(),'collectorParentPID':os.getppid(),'operatorOwner':'explicit-user-owned-terminal'}).encode()
        fd=os.open('launch.attempt',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
        with os.fdopen(fd,'wb') as f:f.write(payload);f.flush();os.fsync(f.fileno())
        os.fsync(parent)  # Must succeed before any collector/native spawn. Never remove/retry.
    finally:os.close(parent)


def load_reviewed(p):
    path=Path(p['control']['path'])/'collector_reviewed.py'
    if digest(path)!=p['files']['collector_reviewed.py']:raise ValueError('Reviewed collector hash changed')
    spec=importlib.util.spec_from_file_location('manual47_reviewed_collector',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def execute_future(plan, operator, dispatch):
    # No process query or subprocess occurs before the durable one-shot claim.
    claim_attempt(plan)
    retained_fd=os.dup(operator.fileno())
    with os.fdopen(retained_fd,'rb',buffering=0) as retained:
        if not os.isatty(retained.fileno()):raise ValueError('Operator channel ceased to be a live Terminal')
        return dispatch(plan['binary'],plan['root'],plan['control'],
                        {**plan['binding'],'launchAuthorized':True},retained)
