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

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--authorized-synthetic-keychain-test',action='store_true',required=True)
    parser.add_argument('--probe-a',type=Path,required=True);parser.add_argument('--probe-b',type=Path,required=True)
    parser.add_argument('--cleanup-after-success',action='store_true')
    args=parser.parse_args()
    if sys.platform!='darwin':raise SystemExit('macOS required')
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
        env=u.environment(Path.home())
        if nonce:env.update(HEINLEIN_READY_NONCE=nonce,HEINLEIN_PROBE_ACK_DIR=str(paths.cache))
        child=subprocess.Popen([str(paths.app/'Contents/MacOS/heinlein-native'),mode,service,str(profile)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,pass_fds=(lease.file.fileno(),) if lease else ())
        # Do not time out/kill an OS permission prompt. Operator handles it in UI.
        output,_=child.communicate(seed if mode!='cleanup' else None)
        if len(output)>4096:raise SystemExit('Invalid probe receipt')
        return child.returncode,json.loads(output)
    package(args.probe_a,paths.app,'a',1)
    code,written=probe('write')
    if code or not written.get('allEqual'):raise SystemExit('Synthetic write not approved; no update attempted. Exact synthetic service: '+service)
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
            print(json.dumps({'allEqual':False,'accessState':read.get('error','probe-failed'),'credentialDeleted':False}),flush=True)
            if input('Handle OS access, then Return to retry B, or q to stop: ').lower()=='q':
                raise SystemExit('Synthetic items retained; exact service: '+service)
        cleanup=False
        if args.cleanup_after_success:cleanup=probe('cleanup')[0]==0
    print(json.dumps({'allEqual':True,'confirmedAndUnconfirmed':read.get('confirmedAndUnconfirmed') is True,
        'code':signatures,'differentCodeHashes':True,'signing':'ad-hoc; explicit stable IDs; OS approval may be required',
        'cleanup':cleanup,'syntheticService':service,'fixtureRoot':str(root)}))
if __name__=='__main__':main()
