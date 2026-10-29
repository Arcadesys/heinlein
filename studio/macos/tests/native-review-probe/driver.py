#!/usr/bin/env python3
"""Own disposable native processes only. No signals, real provider or installed app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import selectors
import shutil
import stat
import subprocess
import time
import uuid


def validate_receipt(r, phase):
    expected = 3 if phase == 'first' else 4
    assert r['schema'] == 1 and r['phase'] == phase
    assert r['realIPC'] is True and r['exactBytes'] is True
    assert (r['accepted'], r['rejected'], r['superseded']) == (expected, 1, 1)
    assert r['confirmations'] == (3 if phase == 'first' else 1)
    assert r['confirmation'] == 'compile-feature-native-synthetic-author-choice'
    assert r['osDialogUsability'] is False


def run(binary, root, phase):
    child = subprocess.Popen([str(binary), '--revision-native-acceptance', str(root), phase,
                              '--synthetic-author-choice'], env=dict(os.environ, TMPDIR=str(root)),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    print(json.dumps({'pid': child.pid, 'root': str(root), 'phase': phase}), flush=True)
    selector = selectors.DefaultSelector()
    for stream in (child.stdout, child.stderr):
        selector.register(stream, selectors.EVENT_READ)
    diagnostics, buffers = [], {}
    deadline = time.monotonic() + 110
    while selector.get_map() or child.poll() is None:
        if time.monotonic() > deadline:
            raise RuntimeError(f'Uncertain live fixture pid={child.pid}, root={root}; no signal sent')
        for key, _ in selector.select(.1):
            data = os.read(key.fd, 8192)
            if not data:
                remainder = buffers.pop(key.fd, b'')
                if remainder:
                    text = remainder.decode(errors='replace')[:1000]
                    diagnostics.append(text)
                    print(text, flush=True)
                selector.unregister(key.fileobj)
                continue
            buffer = buffers.get(key.fd, b'') + data
            if len(buffer) > 32768:
                raise RuntimeError('Unexpected diagnostic volume; preserve exact child')
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                text = line.decode(errors='replace')
                diagnostics.append(text[:1000])
                print(text[:1000], flush=True)
                if len(diagnostics) > 200:
                    raise RuntimeError('Unexpected diagnostic count')
            buffers[key.fd] = buffer
    code = child.wait()
    if code != 0:
        raise RuntimeError(f'Native phase {phase} failed exit={code}; root={root}; diagnostics={diagnostics!r}')
    receipt = json.loads((root / f'{phase}-receipt.json').read_text())
    validate_receipt(receipt, phase)
    return {'pid': child.pid, 'exit': code, 'diagnostics': diagnostics, 'receipt': receipt}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    meta = binary.stat()
    if not (stat.S_ISREG(meta.st_mode) and meta.st_uid == os.getuid()
            and str(binary).startswith('/private/tmp/heinlein-revision-native-acceptance/')):
        parser.error('Only owned temporary native44 executable allowed')
    root = Path('/private/tmp') / ('heinlein-native-review-' + str(uuid.uuid4()))
    root.mkdir(mode=0o700)
    bundle = binary.parent / ('native44-bundle-' + uuid.uuid4().hex) / 'DISPOSABLE Review.app'
    executable = bundle / 'Contents/MacOS/synthetic-review'
    executable.parent.mkdir(mode=0o700, parents=True)
    shutil.copy2(binary, executable)
    identity = 'me.thearcades.heinlein.synthetic-review-' + root.name.split('review-')[1].replace('-', '')
    (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': identity, 'CFBundleExecutable': executable.name,
        'CFBundleName': 'DISPOSABLE Review Acceptance', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.0.0'}))
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', identity, str(bundle)], check=True, capture_output=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(bundle)], check=True, capture_output=True)
    result = {'schema': 1, 'root': str(root), 'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'phases': [], 'passed': False, 'OSDialogUsability': False, 'VoiceOver': False,
              'physicalKeyboard': False, 'liveProvider': False, 'installedApp': False}
    try:
        for phase in ('first', 'reopen'):
            result['phases'].append(run(executable, root, phase))
        result['passed'] = True
    except Exception as error:
        result['failure'] = str(error)
        raise
    finally:
        args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': True, 'receipt': str(args.receipt)}), flush=True)


if __name__ == '__main__':
    main()
