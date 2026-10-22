#!/usr/bin/env python3
"""U4 ONLY after root GO: real synthetic Keychain A->B update, no real account.

Never call from normal tests/CI. Seed material stays in parent memory/anonymous
stdin pipes only; the probe returns booleans. No token/digest is exported.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import secrets
import shutil
import subprocess
import sys
import tempfile
import uuid

MACOS=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('update',MACOS/'update.py');u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)

ERRORS={'locked','denied','cancelled','unavailable','invalid-record','preflight-rejected','profile-storage','existing-item-mismatch','probe-failed'}
STAGES={'argument-preflight','service-preflight','profile-preflight','seed-pipe','profile-open','store-read-before-write','synthetic-authorize','store-confirm','synthetic-cleanup','store-read-result','record-equality','ready-receipt'}
def decode_receipt(output):
    try:value=json.loads(output) if len(output)<=4096 else {}
    except (ValueError,TypeError):value={}
    return value if isinstance(value,dict) else {}

def safe_failure(value):
    return {'allEqual':False,'error':value.get('error') if value.get('error') in ERRORS else 'probe-failed',
        'stage':value.get('stage') if value.get('stage') in STAGES else 'unknown',
        'osStatus':value.get('osStatus') if value.get('osStatus') in (-25308,-25293,-128) else None,
        'credentialDeleted':False}

def initial_write(probe,service,report=print,ask=input):
    while True:
        code,written=probe('write')
        if not code and written.get('allEqual'):return
        report(json.dumps({'phase':'A-write',**safe_failure(written),'syntheticService':service}),flush=True)
        try:choice=ask('No update attempted. Handle OS access if requested, then Return to retry these same synthetic items, or q to stop: ')
        except EOFError:choice='q'
        if choice.lower()=='q':raise SystemExit('Synthetic write incomplete; items unknown/retained, no update attempted. Exact synthetic service: '+service)

def probe_environment(home,root):
    env=u.environment(home)
    # Bind the native preflight to this newly created fixture temp root; do not
    # inherit an unrelated caller TMPDIR or weaken production updater isolation.
    env['TMPDIR']=str(root.parent)
    return env

def cleanup_exact(binary,service,profile):
    prefix='me.thearcades.heinlein.synthetic-update-'
    try:uuid.UUID(service.removeprefix(prefix))
    except (ValueError,AttributeError):raise SystemExit('Invalid synthetic cleanup identity') from None
    if not service.startswith(prefix) or profile is None:raise SystemExit('Invalid synthetic cleanup identity')
    profile=Path(profile);root=profile.parent
    if not profile.is_absolute() or profile.resolve()!=profile or profile.name!='profile' or not root.name.startswith('heinlein-synthetic-update-') or root.stat().st_uid!=os.getuid() or root.stat().st_mode&0o077:
        raise SystemExit('Invalid synthetic cleanup profile')
    # Exact two synthetic items only. No seed, account enumeration or store reads.
    result=subprocess.run([str(binary),'cleanup',service,str(profile)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=probe_environment(Path.home(),root))
    value=decode_receipt(result.stdout)
    if result.returncode or value.get('cleanup') is not True:return {'syntheticService':service,'cleanup':False,**safe_failure(value)}
    return {'syntheticService':service,'cleanup':True}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--authorized-synthetic-keychain-test',action='store_true',required=True)
    parser.add_argument('--probe-a',type=Path,required=True);parser.add_argument('--probe-b',type=Path)
    parser.add_argument('--cleanup-service');parser.add_argument('--cleanup-profile',type=Path)
    parser.add_argument('--cleanup-after-success',action='store_true')
    args=parser.parse_args()
    if sys.platform!='darwin':raise SystemExit('macOS required')
    if args.cleanup_service:
        receipt=cleanup_exact(args.probe_a,args.cleanup_service,args.cleanup_profile);print(json.dumps(receipt));return 0 if receipt['cleanup'] else 1
    if not args.probe_b or args.cleanup_profile:parser.error('A/B probe paths required unless exact-item cleanup is selected')
    if u.digest(args.probe_a)==u.digest(args.probe_b):raise SystemExit('A/B code must differ')
    root=Path(tempfile.mkdtemp(prefix='heinlein-synthetic-update-')).resolve()
    paths=u.Paths(home=root/'home');paths.home.mkdir(mode=0o700);paths.ensure();platform=u.Mac(paths)
    service='me.thearcades.heinlein.synthetic-update-'+str(uuid.uuid4());profile=root/'profile';profile.mkdir(mode=0o700)
    seed=secrets.token_bytes(32)
    def package(binary,destination,label,generation):
        (destination/'Contents/MacOS').mkdir(parents=True);resources=destination/'Contents/Resources';resources.mkdir()
        shutil.copy2(binary,destination/'Contents/MacOS/heinlein-native')
        # Probe CLI is launched directly; this harmless outer executable exists to
        # test real nested/outer signature sealing without executing normal UI.
        shutil.copy2(binary,destination/'Contents/MacOS/heinlein-launcher')
        info={'CFBundleIdentifier':u.IDENTIFIER,'CFBundleExecutable':'heinlein-launcher','CFBundleName':'Heinlein synthetic updater probe','CFBundlePackageType':'APPL'}
        (destination/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        platform.run(['/usr/bin/codesign','--force','--sign','-','--timestamp=none','--identifier',u.IDENTIFIER+'.native',str(destination/'Contents/MacOS/heinlein-native')],'sign')
        source={'origin':u.ORIGIN,'channel':'main','commit':label*40,'tree':'c'*40,'generation':generation,'updaterVersion':1}
        source['files']={k:v for k,v in u.files(destination).items() if k!='Contents/MacOS/heinlein-launcher'}
        u.atomic_json(destination/u.MANIFEST,source)
        platform.run(['/usr/bin/codesign','--force','--sign','-','--timestamp=none','--identifier',u.IDENTIFIER,str(destination)],'sign')
        platform.validate(destination);return source
    def probe(mode,nonce=None,lease=None):
        env=probe_environment(Path.home(),root)
        if nonce:env.update(HEINLEIN_READY_NONCE=nonce,HEINLEIN_PROBE_ACK_DIR=str(paths.cache))
        child=subprocess.Popen([str(paths.app/'Contents/MacOS/heinlein-native'),mode,service,str(profile)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,pass_fds=(lease.file.fileno(),) if lease else ())
        # Do not time out/kill an OS permission prompt. Operator handles it in UI.
        output,_=child.communicate(seed if mode!='cleanup' else None)
        return child.returncode,decode_receipt(output)
    package(args.probe_a,paths.app,'a',1)
    initial_write(probe,service)
    def signature_receipt(app):
        binary=app/'Contents/MacOS/heinlein-native'
        details=platform.run(['/usr/bin/codesign','-d','-r-','--verbose=2',str(binary)],'signature',output='combined')
        return {'sha256':u.digest(binary),'requirements':[line for line in details.splitlines() if line.startswith(('Identifier=','CDHash=','designated =>'))]}
    signatures={'a':signature_receipt(paths.app)}
    stage=paths.staged();source=package(args.probe_b,stage,'b',2);signatures['b']=signature_receipt(stage)
    engine=u.Engine(paths,platform)
    with u.Lease(paths.cache/'update.lock'),u.Lease(paths.cache/'lifetime.lock') as lease:
        while True:
            record=engine.install(stage,source,platform.validate(paths.app))
            code,read=probe('read',record['nonce'],lease)
            if not code and read.get('allEqual'):
                engine.recover(held=lease);break
            engine.recover(held=lease)  # Known probe exit; restore A, never delete items.
            print(json.dumps({'phase':'B-read',**safe_failure(read)}),flush=True)
            if input('Handle OS access, then Return to retry B, or q to stop: ').lower()=='q':
                raise SystemExit('Synthetic items retained; exact service: '+service)
        cleanup=False
        if args.cleanup_after_success:cleanup=probe('cleanup')[0]==0
    print(json.dumps({'allEqual':True,'confirmedAndUnconfirmed':read.get('confirmedAndUnconfirmed') is True,
        'code':signatures,'differentCodeHashes':True,'signing':'ad-hoc; explicit stable IDs; OS approval may be required',
        'cleanup':cleanup,'syntheticService':service,'fixtureRoot':str(root)}))
if __name__=='__main__':sys.exit(main())
