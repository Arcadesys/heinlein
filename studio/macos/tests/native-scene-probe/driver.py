#!/usr/bin/env python3
"""Runs only a freshly signed disposable fixture bundle, retaining evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    root = Path('/private/tmp') / ('heinlein-native-scene-' + str(uuid.uuid4()))
    root.mkdir(mode=0o700)
    staging = args.receipt.resolve().parent / ('scene-bundle-' + uuid.uuid4().hex)
    bundle = staging / 'DISPOSABLE Scene.app'
    executable = bundle / 'Contents/MacOS/synthetic-scene'
    executable.parent.mkdir(mode=0o700, parents=True)
    shutil.copy2(binary, executable)
    identity = 'me.thearcades.heinlein.synthetic-scene-' + uuid.uuid4().hex
    (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': identity, 'CFBundleExecutable': executable.name,
        'CFBundleName': 'DISPOSABLE Scene Acceptance', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.0.0'}))
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', identity, str(bundle)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(bundle)], check=True)
    results = []
    for phase in ['first', 'reopen']:
        child = subprocess.Popen([str(executable), '--scene-native-acceptance', str(root), phase],
                                 env=dict(os.environ, TMPDIR=str(root)), stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, start_new_session=True)
        print(json.dumps({'pid': child.pid, 'phase': phase, 'root': str(root)}), flush=True)
        # Native watchdog exits its own process on failure. A Python timeout never kills it.
        try:
            output, _ = child.communicate(timeout=80)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f'Uncertain live fixture pid={child.pid}; no signal sent; root={root}') from error
        print(output, flush=True)
        if child.returncode != 0:
            raise RuntimeError(f'Native {phase} failed exit={child.returncode}; root={root}')
        receipt = json.loads((root / f'{phase}-receipt.json').read_text())
        if receipt['phase'] != phase or not all(receipt[k] is True for k in ['realIPC', 'exactBytes', 'unlistedPreserved', 'missingPreserved', 'repeated', 'canceled']):
            raise ValueError('Incomplete native receipt')
        results.append({'pid': child.pid, 'exit': child.returncode, 'receipt': receipt})
    result = {'root': str(root), 'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'results': results}
    with args.receipt.open('x') as out:
        json.dump(result, out, indent=2)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
