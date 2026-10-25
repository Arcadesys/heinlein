#!/usr/bin/env python3
"""Own disposable native child only. No installed app, stores, signals or cleanup guessing."""
import argparse
import hashlib
import json
import os
import plistlib
import shutil
from pathlib import Path
import selectors
import stat
import subprocess
import time
import uuid


def run_phase(binary, root, phase, record):
    environment = dict(os.environ, TMPDIR=str(root))
    child = subprocess.Popen([str(binary), '--standalone-native-acceptance', str(root), phase],
                             env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, bufsize=0)
    print(json.dumps({'kind': 'child', 'pid': child.pid, 'binary': str(binary), 'root': str(root), 'phase': phase}), flush=True)
    selector = selectors.DefaultSelector()
    for stream in (child.stdout, child.stderr):
        selector.register(stream, selectors.EVENT_READ)
    lines, buffers, result = [], {}, None
    record.update(pid=child.pid,phase=phase,orderedDiagnostics=lines)
    deadline, abort_deadline = time.monotonic() + 65, None
    while selector.get_map() or child.poll() is None:
        if time.monotonic() > deadline and abort_deadline is None:
            child.stdin.write(b'abort\n'); child.stdin.flush()
            abort_deadline = time.monotonic() + 10
        if abort_deadline and time.monotonic() > abort_deadline:
            # No signal. Leave exact live child/root evidence for separately authorized action.
            raise RuntimeError(f'Uncertain live fixture child pid={child.pid} root={root} last={lines[-1:]!r}')
        for key, _ in selector.select(.1):
            data = os.read(key.fileobj.fileno(), 8192)
            if not data:
                selector.unregister(key.fileobj); continue
            buffer = buffers.get(key.fd, b'') + data
            if len(buffer) > 32768: raise RuntimeError('Unexpected oversized fixture diagnostic; child identity retained above')
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                value = line.decode('utf8', errors='replace')
                try:
                    decoded = json.loads(value)
                except ValueError:
                    decoded = {'kind': 'native-stderr', 'message': value[:1000]}
                lines.append(decoded)
                if len(lines) > 300: raise RuntimeError('Unexpected fixture diagnostic volume; child identity retained above')
                print(json.dumps(decoded), flush=True)
                if decoded.get('kind') == 'result': result = decoded
            buffers[key.fd] = buffer
    code = child.wait()
    record.update(exit=code,result=result)
    if abort_deadline or code != 0 or not result or result.get('passed') is not True:
        raise RuntimeError(f'Native phase failed exit={code} phase={phase} root={root}; preserve diagnostics')
    stages = [line.get('stage') for line in lines if line.get('kind') == 'progress']
    required = ['feature-explicit-invocation-private-root-sentinel-validated',
                'all-tauri-app-paths-confined-before-webview-or-store',
                'own-webkit-isPersistent-false-before-fixture-navigation', 'callback-gate-passed',
                'with-webview-call-returned','worker-not-main-navigation-gates-complete','worker-navigation-enqueued','first-renderer-IPC','production-editor-ready']
    if phase == 'first':
        required += ['editor-revision-queued', 'save-IPC-queued', 'own-native-terminate-dispatched',
                     'own-native-terminate-returned-cancel', 'native-terminate-cancel-deferred-to-production-renderer',
                     'native-close-received-before-save-ack', 'durable-save-ack-released']
    else:
        required += ['reopened-exact-bytes-same-id', 'own-native-terminate-dispatched',
                     'own-native-terminate-returned-cancel', 'native-terminate-cancel-deferred-to-production-renderer']
    required += ['request-close-from-production', 'production-request-close-command-received',
                 'production-exit-guards-approved-Some0']
    positions = [stages.index(stage) for stage in required]
    if positions != sorted(positions): raise RuntimeError('Native acceptance stages out of order')
    expected_hash = hashlib.sha256(('Synthetic café — 🦊\r\nSecond line\n第三行\rFinal original' + '\r\nLatest revision: naïve 🌈\r\n').encode()).hexdigest()
    hashes = [line['sha256'] for line in lines if line.get('kind') == 'synthetic-text-hash']
    if hashes != [expected_hash]: raise RuntimeError('Native save/reopen UTF8 hash mismatch')
    if phase == 'first' and stages.index('durable-save-IPC-returned') > stages.index('durable-save-ack-released'):
        raise RuntimeError('Acknowledgment preceded actual native Save return')
    if result['nativeTerminateCounters'] != [1, 1, 1, 0]: raise RuntimeError('Unexpected native Cancel/deferred/error counters')
    return {'pid': child.pid, 'exit': code, 'result': result, 'orderedDiagnostics': lines}


def binary_receipt(binary, executable):
    """Describe bytes without executing either input."""
    # Hashes identify bytes, not their source commit/tree or checkout dirty state.
    return {'source': None, 'tree': None, 'uncommittedFixture': None,
            'binary': str(binary), 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            'executedBinary': str(executable), 'executedBinarySha256': hashlib.sha256(executable.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--authorized-synthetic-native-test', action='store_true', required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    metadata = binary.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or not str(binary).startswith('/private/tmp/heinlein-native47-'):
        parser.error('Only this worker owned temporary fixture executable is allowed')
    root = Path('/private/tmp') / f'heinlein-native-standalone-{uuid.uuid4()}'
    root.mkdir(mode=0o700)
    bundle_parent = binary.parent / 'native47-runs' / root.name
    bundle_parent.mkdir(mode=0o700, parents=True)
    bundle_metadata=bundle_parent.stat()
    if bundle_parent.resolve()!=bundle_parent or bundle_metadata.st_uid!=os.getuid() or bundle_metadata.st_mode&0o077:
        raise RuntimeError('Unsafe fresh synthetic bundle root')
    app = bundle_parent / 'DISPOSABLE Standalone Acceptance.app'
    executable = app / 'Contents' / 'MacOS' / 'synthetic-standalone'
    executable.parent.mkdir(mode=0o700, parents=True)
    shutil.copy2(binary, executable)
    identifier = 'me.thearcades.heinlein.synthetic-standalone-' + root.name.removeprefix('heinlein-native-standalone-').replace('-', '')
    (app / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': identifier, 'CFBundleExecutable': executable.name,
        'CFBundleName': 'DISPOSABLE Standalone Acceptance', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.0.0'}))
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', identifier, str(app)], check=True, capture_output=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(app)], check=True, capture_output=True)
    receipt = {**binary_receipt(binary, executable),
               'bundle': str(app), 'identifier': identifier, 'signature': 'ad-hoc; strict verified',
               'root': str(root), 'physicalKeyboard': False, 'VoiceOver': False, 'installedApp': False, 'phases': []}
    # Write progress after each clean child exit; failure keeps exact diagnostic root.
    try:
        for phase in ('first', 'reopen'):
            record={}
            receipt['phases'].append(record)
            record.update(run_phase(executable, root, phase, record))
        receipt['passed'] = True
    except Exception as error:
        receipt['passed'] = False
        receipt['failure'] = str(error)
        raise
    finally:
        args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'kind': 'complete', 'receipt': str(args.receipt), 'rootRetained': str(root)}), flush=True)


if __name__ == '__main__':
    main()
