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


def run_phase(binary, root, record):
    environment = dict(os.environ, TMPDIR=str(root))
    child = subprocess.Popen([str(binary), '--update-native-acceptance', str(root)],
                             env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
    print(json.dumps({'kind': 'child', 'pid': child.pid, 'binary': str(binary), 'root': str(root), 'phase': 'updates'}), flush=True)
    selector = selectors.DefaultSelector()
    for stream in (child.stdout, child.stderr):
        selector.register(stream, selectors.EVENT_READ)
    lines, buffers, result = [], {}, None
    record.update(pid=child.pid, processGroup=os.getpgid(child.pid), parentProcessGroup=os.getpgrp(), phase='updates',orderedDiagnostics=lines)
    if record["processGroup"] == record["parentProcessGroup"]:
        raise RuntimeError("Fixture child did not acquire its isolated session")
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
        raise RuntimeError(f'Native phase failed exit={code} phase=updates root={root}; preserve diagnostics')
    stages = [line.get('stage') for line in lines if line.get('kind') == 'progress']
    validate_result(result, lines)
    return record


def validate_result(result, lines):
    required = ['feature-explicit-invocation-private-root-sentinel-validated',
                'all-tauri-app-paths-confined-before-webview-or-store',
                'own-webkit-isPersistent-false-before-fixture-navigation', 'callback-gate-passed',
                'with-webview-call-returned', 'worker-not-main-navigation-gates-complete',
                'worker-navigation-enqueued', 'first-renderer-IPC', 'fixture-editor-focused',
                'updates-initial-status', 'check-busy-duplicate-suppressed', 'quit-refused-during-check',
                'check-failed-visible', 'explicit-retry-available', 'deferred-writing-retained',
                'late-response-ignored', 'in-memory-scheduled', 'stale-save-failure-preserved',
                'save-quit-held-for-genuine-ack', 'genuine-save-ack-released',
                'production-request-close', 'production-exit-guards-approved-Some0']
    stages = [v.get('stage') for v in lines if v.get('kind') == 'progress']
    positions = [stages.index(stage) for stage in required]
    if positions != sorted(positions): raise RuntimeError('Native scenario phases out of order')
    observations = [v for v in lines if v.get('kind') == 'owned-window-observation']
    if len(observations) != 1 or any(observations[0].get(k) is not True for k in ('visible','focused','editorHasFocus','activeElement')):
        raise RuntimeError('Actual owned window/editor focus not proven')
    if result.get('backend', {}).get('calls') != ['status','check','check','status','check','status','schedule']:
        raise RuntimeError('Unexpected native backend actions or implicit retry/schedule')
    for key,value in {'approvedProgrammaticExits':1,'closeCommands':2,'forbiddenServiceAttempts':0,
                      'managedRuntimeAcquire':False,'osStoreProviderConstructorsReachable':False}.items():
        if result.get(key) != value: raise RuntimeError(f'Invalid native result {key}')
    if result.get('nativeTerminateCounters') != [1,1,1,0] or result['backend'].get('realUpdaterExecutions') != 0:
        raise RuntimeError('Unexpected native termination/backend boundary')



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
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or not str(binary).startswith('/private/tmp/heinlein-native42-'):
        parser.error('Only this worker owned temporary fixture executable is allowed')
    root = Path('/private/tmp') / f'heinlein-native-updates-{uuid.uuid4()}'
    root.mkdir(mode=0o700)
    bundle_parent = binary.parent / 'native42-runs' / root.name
    bundle_parent.mkdir(mode=0o700, parents=True)
    bundle_metadata=bundle_parent.stat()
    if bundle_parent.resolve()!=bundle_parent or bundle_metadata.st_uid!=os.getuid() or bundle_metadata.st_mode&0o077:
        raise RuntimeError('Unsafe fresh synthetic bundle root')
    app = bundle_parent / 'DISPOSABLE Updates Acceptance.app'
    executable = app / 'Contents' / 'MacOS' / 'synthetic-updates'
    executable.parent.mkdir(mode=0o700, parents=True)
    shutil.copy2(binary, executable)
    identifier = 'me.thearcades.heinlein.synthetic-updates-' + root.name.removeprefix('heinlein-native-updates-').replace('-', '')
    (app / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': identifier, 'CFBundleExecutable': executable.name,
        'CFBundleName': 'DISPOSABLE Updates Acceptance', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.0.0'}))
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', identifier, str(app)], check=True, capture_output=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(app)], check=True, capture_output=True)
    receipt = {**binary_receipt(binary, executable),
               'bundle': str(app), 'identifier': identifier, 'signature': 'ad-hoc; strict verified',
               'root': str(root), 'physicalKeyboard': False, 'VoiceOver': False, 'installedApp': False, 'phases': []}
    # Write progress after each clean child exit; failure keeps exact diagnostic root.
    try:
        record={}
        receipt['phases'].append(record)
        run_phase(executable, root, record)
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
