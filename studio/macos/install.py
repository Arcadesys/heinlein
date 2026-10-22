#!/usr/bin/env python3
"""Build/stage a complete stable bundle. Installation requires no running native.

The source CLI operates only from the updater's private pinned checkout. It never
imports a developer worktree or backs up user profiles/credentials/manuscripts.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import sys

spec=importlib.util.spec_from_file_location('heinlein_update',Path(__file__).with_name('update.py'))
update=importlib.util.module_from_spec(spec);spec.loader.exec_module(update)

def stage_bundle(root, destination, source, generation, platform):
    root,destination=Path(root),Path(destination)
    destination.mkdir(mode=0o700)
    macos=destination/'Contents/MacOS';resources=destination/'Contents/Resources'
    macos.mkdir(parents=True);resources.mkdir()
    native=root/'studio/target/release/heinlein-studio'
    if not native.is_file() or native.is_symlink(): raise update.Failure('missing-build')
    shutil.copy2(native,macos/'heinlein-native')
    for name in ['update.py','install.py']:shutil.copy2(root/'studio/macos'/name,resources/name)
    version=json.loads((root/'studio/package.json').read_text())['version']
    info={'CFBundleIdentifier':update.IDENTIFIER,'CFBundleExecutable':'heinlein-launcher',
          'CFBundleName':'Heinlein Studio','CFBundleDisplayName':'Heinlein Studio',
          'CFBundlePackageType':'APPL','CFBundleShortVersionString':version,'CFBundleVersion':str(generation),
          'LSMinimumSystemVersion':'11.0','NSHighResolutionCapable':True}
    icon=root/'studio/src-tauri/icons/icon.icns'
    if icon.is_file():shutil.copy2(icon,resources/'icon.icns');info['CFBundleIconFile']='icon.icns'
    (destination/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    platform.run([platform.tool('swift'),'swiftc',str(root/'studio/macos/Launcher.swift'),'-o',str(macos/'heinlein-launcher')],'build')
    # Explicit nested identifiers before sealing outer code. Hash the signed nested
    # binaries; the outer CodeResources seal and manifest are not self-hashed.
    for name,suffix in [('heinlein-native','.native')]:
        platform.run(['/usr/bin/codesign','--force','--sign','-','--timestamp=none','--identifier',update.IDENTIFIER+suffix,str(macos/name)],'sign')
    update.atomic_json(destination/update.MANIFEST,{**source,'origin':update.ORIGIN,'channel':update.CHANNEL,
        'updaterVersion':1,'generation':generation,'files':{k:v for k,v in update.files(destination).items() if k!='Contents/MacOS/heinlein-launcher'}})
    platform.run(['/usr/bin/codesign','--force','--sign','-','--timestamp=none','--identifier',update.IDENTIFIER,str(destination)],'sign')
    for path in destination.rglob('*'):
        if path.is_file():
            with path.open('rb') as file:update.os.fsync(file.fileno())
    for path in sorted([p for p in destination.rglob('*') if p.is_dir()],key=lambda p:len(p.parts),reverse=True):update.sync_dir(path)
    update.sync_dir(destination);update.sync_dir(destination.parent)
    platform.validate(destination)

def stage_update(paths,platform):
    previous=platform.validate(paths.app,legacy=True);baseline=update.bundle_hash(paths.app)
    source,bare=platform.source(previous);source['generation']=previous.get('generation',0)+1
    root=platform.checkout(source,bare);candidate=paths.staged();platform.build(root,candidate,source,source['generation'])
    rollback=paths.staged();shutil.copytree(paths.app,rollback,symlinks=True)
    platform.validate(rollback,legacy=True)
    if update.bundle_hash(paths.app)!=baseline or update.bundle_hash(rollback)!=baseline:raise update.Failure('bundle-changed')
    receipt={'state':'staged-only','stage':candidate.parent.name,'rollback':rollback.parent.name,
        'source':source,'candidateHash':update.bundle_hash(candidate),'baselineHash':baseline,
        'baselineCommit':previous['commit'],'legacyBootstrapRequired':previous.get('updaterVersion')!=1}
    update.atomic_json(paths.cache/'staged-candidate-v1.json',receipt)
    return receipt

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['stage','install']);parser.add_argument('--home',type=Path)
    args=parser.parse_args()
    if sys.platform!='darwin':raise update.Failure('unsupported-platform')
    # This installer intentionally uses the same fixed source and staging engine;
    # its commit comes from main, never the CLI's current source checkout.
    paths=update.Paths(home=args.home);paths.ensure();platform=update.Mac(paths)
    with update.Lease(paths.cache/'update.lock'):
        engine=update.Engine(paths,platform)
        result=stage_update(paths,platform) if args.action=='stage' else engine.launch(rebuild=True)
    print(json.dumps(result))

if __name__=='__main__':
    try:main()
    except update.Failure as error:print(json.dumps({'state':error.code,'step':error.step}));sys.exit(1)

    except Exception:print(json.dumps({'state':'installation-unavailable','step':'install'}));sys.exit(1)
