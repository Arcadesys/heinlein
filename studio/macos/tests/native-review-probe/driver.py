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


def require(condition):
    if not condition:
        raise ValueError("Native acceptance receipt is incomplete or inconsistent")


def validate_receipt(r, phase, actual=False):
    if phase == 'stale':
        require(actual and r['schema'] == 1 and r['phase'] == 'stale')
        require(r['actualOSDialogPlumbing'] is True and r['realResponse'] is True)
        require(r['staleRefused'] is True and r['receiptCount'] == 0)
        require(r['externalBytesPreserved'] is True and r['osDialogUsability'] is False)
        return
    expected = 3 if phase == 'first' else 4
    require(r['schema'] == 1 and r['phase'] == phase)
    require(r['realIPC'] is True and r['exactBytes'] is True)
    require((r['accepted'], r['rejected'], r['superseded']) == (expected, 1, 1))
    require(r['confirmations'] == (3 if phase == 'first' else 1))
    require(r['confirmation'] == ('production-parented-NSAlert-public-button' if actual else 'compile-feature-native-synthetic-author-choice'))
    if actual:
        require(r['actualOSDialogPlumbing'] is True)
        require(r['actualResponses'] == ([False, True, True, True] if phase == 'first' else [True]))
    require(r['osDialogUsability'] is False)



def run(binary, root, phase, actual=False):
    child = subprocess.Popen([str(binary), '--revision-native-acceptance', str(root), phase,
                              '--actual-native-dialog' if actual else '--synthetic-author-choice'], env=dict(os.environ, TMPDIR=str(root)),
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
    validate_receipt(receipt, phase, actual)
    return {'pid': child.pid, 'exit': code, 'diagnostics': diagnostics, 'receipt': receipt}



def allocate(binary):
    root = Path('/private/tmp') / ('heinlein-native-review-' + str(uuid.uuid4()))
    root.mkdir(mode=0o700)
    bundle_parent = binary.parent / ('native44-bundle-' + uuid.uuid4().hex)
    bundle_parent.mkdir(mode=0o700)
    bundle = bundle_parent / 'DISPOSABLE Review.app'
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
    return root, executable, identity



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--actual-dialog', action='store_true')
    parser.add_argument('--stage-only', action='store_true')
    parser.add_argument('--staged', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    meta = binary.stat()
    if not (stat.S_ISREG(meta.st_mode) and meta.st_uid == os.getuid()
            and str(binary).startswith(('/private/tmp/heinlein-revision-native-acceptance/', '/private/tmp/heinlein-review-os-confirmation/'))):
        parser.error('Only owned temporary native44 executable allowed')
    if args.staged:
        packet = json.loads(args.staged.read_text())
        if packet['rawSHA256'] != hashlib.sha256(binary.read_bytes()).hexdigest() or packet['actual'] != args.actual_dialog:
            parser.error('Staged binary or mode changed')
        entries = packet['entries']
        for entry in entries:
            root_path, exe = Path(entry['root']), Path(entry['executable'])
            meta = root_path.lstat()
            if (root_path.resolve() != root_path or meta.st_uid != os.getuid() or meta.st_mode & 0o077
                    or not stat.S_ISDIR(meta.st_mode) or any(root_path.iterdir())
                    or root_path.parent != Path('/private/tmp')
                    or not root_path.name.startswith('heinlein-native-review-')):
                parser.error('Staged root must remain canonical, owned, private and empty')
            uuid.UUID(root_path.name.removeprefix('heinlein-native-review-'))
            if (exe.resolve() != exe or binary.parent not in exe.parents
                    or not exe.parent.parent.parent.parent.name.startswith('native44-bundle-')
                    or hashlib.sha256(exe.read_bytes()).hexdigest() != entry['signedSHA256']):
                parser.error('Staged executable changed or escaped owned bundle')
            info = plistlib.loads((exe.parent.parent / 'Info.plist').read_bytes())
            expected = 'me.thearcades.heinlein.synthetic-review-' + root_path.name.removeprefix('heinlein-native-review-').replace('-', '')
            if info['CFBundleIdentifier'] != expected or entry['identifier'] != expected:
                parser.error('Staged bundle identity changed')
        if len(entries) != (2 if args.actual_dialog else 1):
            parser.error('Incorrect staged case count')
    else:
        entries = []
        for _ in range(2 if args.actual_dialog else 1):
            root_path, exe, identifier = allocate(binary)
            entries.append(dict(root=str(root_path), executable=str(exe), identifier=identifier,
                                signedSHA256=hashlib.sha256(exe.read_bytes()).hexdigest()))
        packet = dict(schema=1, rawSHA256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                      actual=args.actual_dialog, entries=entries)
    if args.stage_only:
        args.receipt.write_text(json.dumps(packet, indent=2) + '\n')
        print(json.dumps({'stagedOnly': True, 'receipt': str(args.receipt)}), flush=True)
        return
    root, executable, identity = Path(entries[0]['root']), Path(entries[0]['executable']), entries[0]['identifier']
    result = {'schema': 1, 'root': str(root), 'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'phases': [], 'passed': False, 'actualOSDialogPlumbing': args.actual_dialog,
              'signedBinarySHA256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'bundleIdentifier': identity, 'OSDialogUsability': False, 'VoiceOver': False,
              'physicalKeyboard': False, 'liveProvider': False, 'installedApp': False}
    try:
        for phase in ('first', 'reopen'):
            result['phases'].append(run(executable, root, phase, args.actual_dialog))
        if args.actual_dialog:
            stale_root, stale_binary, stale_identity = Path(entries[1]['root']), Path(entries[1]['executable']), entries[1]['identifier']
            result['staleRoot'] = str(stale_root)
            result['staleSignedBinarySHA256'] = hashlib.sha256(stale_binary.read_bytes()).hexdigest()
            result['staleBundleIdentifier'] = stale_identity
            result['phases'].append(run(stale_binary, stale_root, 'stale', True))
        result['passed'] = True
    except Exception as error:
        result['failure'] = str(error)
        raise
    finally:
        args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': True, 'receipt': str(args.receipt)}), flush=True)


if __name__ == '__main__':
    main()
