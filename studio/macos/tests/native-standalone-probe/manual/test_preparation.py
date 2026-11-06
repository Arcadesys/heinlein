"""Local mock/static tests only. No native build, launcher main or collector spawn."""
import ast
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import shutil
import sys
import plistlib
import unittest
from unittest import mock

import future_support as support
import prepare_signed as prep
import observe_future as observer
import verify_future as verifier
import driver
from test_driver import evidence

HERE = Path(__file__).resolve().parent


class FakeTTY:
    def __init__(self, fd, tty=True):
        self.fd, self.tty = fd, tty

    def isatty(self):
        return self.tty

    def fileno(self):
        return self.fd


class Controls(unittest.TestCase):
    def prepared(self, control):
        m = control.stat()
        binary = str(control / 'app/Contents/MacOS/synthetic')
        binding = dict(runId='SIMULATED', receiptNonce='SIMULATED-nonce', binary=binary,
                       signedSha256='a' * 64, root='/private/tmp/heinlein-native-standalone-SIMULATED')
        return dict(control={'path': str(control), 'identity': [m.st_dev, m.st_ino]},
                    root={'path': binding['root']}, runId=binding['runId'], binary=binary,
                    binding=binding, files={'app/Contents/MacOS/synthetic': 'a' * 64},
                    _preflightHash='b' * 64)

    def test_denial_and_redirected_control(self):
        with tempfile.TemporaryDirectory() as folder:
            p = self.prepared(Path(folder).resolve())
            for authorized, owned, tty in [(False, True, True), (True, False, True), (True, True, False)]:
                with self.assertRaises(ValueError):
                    support.make_plan(p, authorized, owned, FakeTTY(-1, tty))

    def test_one_shot_and_retained_fd_lifetime(self):
        with tempfile.TemporaryDirectory() as folder:
            control = Path(folder).resolve()
            p = self.prepared(control)
            read_fd, write_fd = os.pipe()
            with os.fdopen(read_fd, 'rb', buffering=0) as original, os.fdopen(write_fd, 'wb', buffering=0):
                operator = FakeTTY(original.fileno())
                plan = support.make_plan(p, True, True, operator)
                seen = []

                def dispatch(binary, root, owned, binding, retained):
                    self.assertTrue((control / 'launch.attempt').is_file())
                    self.assertNotEqual(retained.fileno(), original.fileno())
                    self.assertEqual(os.fstat(retained.fileno()).st_ino, os.fstat(original.fileno()).st_ino)
                    self.assertTrue(binding['launchAuthorized'])
                    seen.append(retained)
                    return 'SIMULATED'

                with mock.patch.object(support.os, 'isatty', return_value=True), mock.patch.object(support.os, 'kill') as kill:
                    target = mock.Mock(side_effect=dispatch)
                    self.assertEqual(support.execute_future(plan, operator, target), 'SIMULATED')
                    with self.assertRaises(FileExistsError):
                        support.execute_future(plan, operator, target)
                    target.assert_called_once()
                    kill.assert_not_called()
                self.assertTrue(seen[0].closed)
                self.assertFalse(original.closed)
                self.assertEqual(json.loads((control / 'launch.attempt').read_text())['binding'], p['binding'])

    def test_each_claim_sync_failure_is_fail_closed(self):
        for fail_call in (1, 2):
            with tempfile.TemporaryDirectory() as folder:
                p = self.prepared(Path(folder).resolve())
                plan = support.make_plan(p, True, True, FakeTTY(-1))
                target = mock.Mock()
                calls = []

                def sync(fd):
                    calls.append(fd)
                    if len(calls) == fail_call:
                        raise OSError('SIMULATED sync failure')

                with mock.patch.object(support.os, 'fsync', side_effect=sync):
                    with self.assertRaises(OSError):
                        support.execute_future(plan, FakeTTY(-1), target)
                target.assert_not_called()
                with self.assertRaises(FileExistsError):
                    support.execute_future(plan, FakeTTY(-1), target)

    def test_lost_terminal_never_dispatches(self):
        with tempfile.TemporaryDirectory() as folder:
            p = self.prepared(Path(folder).resolve())
            read_fd, write_fd = os.pipe()
            with os.fdopen(read_fd, 'rb') as original, os.fdopen(write_fd, 'wb'):
                operator = FakeTTY(original.fileno())
                plan = support.make_plan(p, True, True, operator)
                target = mock.Mock()
                with mock.patch.object(support.os, 'isatty', return_value=False):
                    with self.assertRaises(ValueError):
                        support.execute_future(plan, operator, target)
                target.assert_not_called()
                self.assertFalse(original.closed)

    def test_binding_is_from_prepared_pin_not_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            p = self.prepared(Path(folder).resolve())
            self.assertEqual(support.expected_binding(p), p['binding'])
            for key in ('runId', 'root', 'binary', 'signedSha256'):
                changed = {**p, 'binding': {**p['binding'], key: 'tampered'}}
                with self.assertRaises(ValueError):
                    support.expected_binding(changed)

    def test_preflight_pin_and_private_file_tamper(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder).resolve() / 'preflight.json'
            path.write_text('{}')
            path.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                support.validate_preflight(path, 'a' * 64, True)
            with self.assertRaisesRegex(ValueError, 'source/phase'):
                support.validate_preflight(path, support.digest(path), True)
            link = path.parent / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                support.digest(link)
            path.chmod(0o666)
            with self.assertRaises(ValueError):
                support.digest(path)

    def test_observer_explicit_gate_before_any_read_or_process(self):
        with mock.patch('sys.argv', ['observe', '--preflight', 'SIMULATED', '--preflight-sha256', 'a' * 64]), \
                mock.patch.object(observer, 'validate_preflight') as validate, \
                mock.patch.object(observer.subprocess, 'check_output') as process:
            with self.assertRaisesRegex(ValueError, 'Independent observation'):
                observer.main()
            validate.assert_not_called()
            process.assert_not_called()

    def test_observer_claim_mismatch_never_queries_process(self):
        with tempfile.TemporaryDirectory() as folder:
            p = self.prepared(Path(folder).resolve())
            with mock.patch('sys.argv', ['observe', '--preflight', 'SIMULATED', '--preflight-sha256', 'a' * 64,
                                         '--independent-context-confirmed']), \
                    mock.patch.object(observer, 'validate_preflight', return_value=p), \
                    mock.patch.object(observer, 'read_json', return_value={'binding': {}}), \
                    mock.patch.object(observer.subprocess, 'check_output') as process:
                with self.assertRaisesRegex(ValueError, 'claim mismatch'):
                    observer.main()
                process.assert_not_called()

    def test_verifier_uses_official_reader_independent_binding(self):
        with tempfile.TemporaryDirectory() as folder:
            p = self.prepared(Path(folder).resolve())
            for receipt, code in [(None, 73), ({'acceptance': False}, 73), ({'acceptance': True}, 0)]:
                reviewed = mock.Mock()
                reviewed.read_final_receipt.return_value = receipt
                with mock.patch('sys.argv', ['verify', '--preflight', 'SIMULATED', '--preflight-sha256', 'a' * 64]), \
                        mock.patch.object(verifier, 'validate_preflight', return_value=p), \
                        mock.patch.object(verifier, 'load_reviewed', return_value=reviewed), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(verifier.main(), code)
                reviewed.read_final_receipt.assert_called_once_with(p['control']['path'], p['binding'], p['control']['identity'])

    def test_late_observation_after_picker_results_cannot_accept(self):
        # SIMULATED genuine-shaped native evidence, both picker callbacks already complete.
        # A later observer must not turn this sequence into acceptance without a prior native gate.
        with tempfile.TemporaryDirectory() as folder:
            control = Path(folder).resolve()
            p = self.prepared(control)
            record = {**p['binding'], 'pid': 123456, 'collectorPID': 123457,
                      'childStart': 'SIMULATED-child-start', 'collectorStart': 'SIMULATED-collector-start',
                      'startupNonce': 'SIMULATED-startup', 'startedAt': 10,
                      'diagnostics': [v for v in evidence() if v.get('kind')=='native-picker-readback'][:2]}
            proof = {key: record[key] for key in ('pid', 'collectorPID', 'childStart', 'collectorStart',
                                                  'startupNonce', 'signedSha256', 'root')}
            proof.update(observerPID=123458, observerConfirmedLive=True, observedAt=20)
            path = control / 'startup-observed.json'
            path.write_text(json.dumps(proof))
            path.chmod(0o600)
            with mock.patch.object(driver.time, 'time', return_value=30):
                record['startupIdentityVerified'] = driver.startup_proof(path, record)
            capture = driver.Capture()
            capture.feed('stdout', b''.join(json.dumps(value).encode() + b'\n' for value in evidence() if value.get('kind')!='native-observation-ready'))
            capture.finish('stdout')
            capture.finish('stderr')
            result = driver.finalize(control / 'receipt.json', record, capture, 0, True,
                                     expected_binding=p['binding'])
            self.assertFalse(result['acceptance'], 'Late observation accepted completed picker steps without prior native gate')

    def test_sanitized_environments_home_unchanged(self):
        parent = {'HOME': '/unchanged', 'PATH': '/usr/bin', 'OPENAI_API_KEY': 'not-copied',
                  'TAURI_CONFIG': 'not-inherited', 'TMPDIR': '/old'}
        self.assertEqual(support.sanitized_environment('/synthetic', parent),
                         {'HOME': '/unchanged', 'PATH': '/usr/bin', 'TMPDIR': '/synthetic'})
        env = prep.build_environment(Path('/synthetic'), parent)
        self.assertEqual(env['HOME'], parent['HOME'])
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertNotIn('TAURI_CONFIG', env)
        self.assertEqual(env['CARGO_NET_OFFLINE'], 'true')


class PythonIdentity(unittest.TestCase):
    def framework(self, base):
        version = base / 'Python.framework/Versions/3.14'
        launch = version / 'bin/python3.14'
        runtime = version / 'Resources/Python.app/Contents/MacOS/Python'
        info = runtime.parent.parent / 'Info.plist'
        for path, data in [(launch, b'SIMULATED launch stub'), (runtime, b'SIMULATED runtime image'),
                           (info, plistlib.dumps({'CFBundleExecutable': 'Python', 'CFBundleShortVersionString': '3.14.8'}))]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o600)
        return {'kind': 'macos-framework-v1', 'launchPath': str(launch), 'launchSha256': prep.sha(launch),
                'runtimeImagePath': str(runtime), 'runtimeImageSha256': prep.sha(runtime),
                'infoPlistPath': str(info), 'infoPlistSha256': prep.sha(info),
                'frameworkVersion': '3.14', 'bundleVersion': '3.14.8'}

    def test_distinct_prepared_runtime_image_is_observed_not_launch_stub(self):
        # All identities/process calls are simulated. No Python/framework/native probe.
        with tempfile.TemporaryDirectory() as folder:
            control = Path(folder).resolve()
            p = Controls().prepared(control)
            p['python'] = self.framework(control / 'SIMULATED-host')
            # Poisoned legacy field exposes the old same-path assumption; never a fallback.
            p['python']['path'] = p['python']['launchPath']
            startup = {**p['binding'], 'pid': 100001, 'collectorPID': 100002,
                       'childStart': 'SIMULATED-start', 'collectorStart': 'SIMULATED-start',
                       'startupNonce': 'SIMULATED-startup', 'phase': 'picker-manual-preview', 'acceptance': False}
            claim = {'binding': p['binding'], 'preflightSha256': p['_preflightHash'],
                     'operatorOwner': 'explicit-user-owned-terminal', 'collectorPID': 100002}
            reviewed = mock.Mock()
            with mock.patch('sys.argv', ['observe', '--preflight', 'SIMULATED', '--preflight-sha256', p['_preflightHash'], '--independent-context-confirmed']), \
                    mock.patch.object(observer, 'validate_preflight', side_effect=lambda *args: support.validate_python_identity(p['python']) or p), \
                    mock.patch.object(observer, 'read_json', side_effect=[claim, startup]), \
                    mock.patch.object(observer.subprocess, 'check_output', return_value='SIMULATED-start') as query, \
                    mock.patch.object(observer, 'process_path', side_effect=lambda pid: p['binary'] if pid == 100001 else p['python']['runtimeImagePath']) as process, \
                    mock.patch.object(observer, 'load_reviewed', return_value=reviewed), contextlib.redirect_stdout(io.StringIO()):
                observer.main()
            self.assertEqual([call.args[0][1:3] for call in query.call_args_list], [['-p', '100001'], ['-p', '100002']])
            self.assertEqual(process.call_args_list, [mock.call(100001), mock.call(100002)])
            reviewed.atomic_receipt.assert_called_once()
            self.assertTrue(reviewed.atomic_receipt.call_args.args[1]['observerConfirmedLive'])


    def reject_before_proof(self, p):
        with mock.patch('sys.argv', ['observe', '--preflight', 'SIMULATED', '--preflight-sha256', p['_preflightHash'], '--independent-context-confirmed']), \
                mock.patch.object(observer, 'validate_preflight', side_effect=lambda *args: support.validate_python_identity(p['python']) or p), \
                mock.patch.object(observer, 'read_json') as read, \
                mock.patch.object(observer.subprocess, 'check_output') as query, \
                mock.patch.object(observer, 'process_path') as process, \
                mock.patch.object(observer, 'load_reviewed') as load:
            with self.assertRaises((ValueError, OSError)):
                observer.main()
            read.assert_not_called();query.assert_not_called();process.assert_not_called();load.assert_not_called()

    def test_static_framework_pins_both_distinct_regular_images_and_plist(self):
        with tempfile.TemporaryDirectory() as folder:
            pins = self.framework(Path(folder).resolve())
            self.assertEqual(support.python_identity(pins['launchPath']), pins)
            self.assertNotEqual(pins['launchSha256'], pins['runtimeImageSha256'])
            self.assertNotEqual(Path(pins['launchPath']).stat().st_ino, Path(pins['runtimeImagePath']).stat().st_ino)
            support.validate_python_identity(pins)
            source = (HERE / 'future_support.py').read_text()
            self.assertIn("validate_python_identity(p['python'])", source)

    def test_wrong_prepared_runtime_hash_plist_or_relationship_rejects_before_proof(self):
        for key, bad in [('runtimeImagePath', '/SIMULATED/wrong-image'), ('runtimeImageSha256', 'wrong'),
                         ('launchSha256', 'wrong'), ('infoPlistPath', '/SIMULATED/wrong-plist'),
                         ('infoPlistSha256', 'wrong'), ('frameworkVersion', '3.15'),
                         ('bundleVersion', '3.15.8'), ('kind', 'unknown')]:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as folder:
                control = Path(folder).resolve();p = Controls().prepared(control)
                p['python'] = {**self.framework(control / 'SIMULATED-host'), key: bad}
                self.reject_before_proof(p)

    def test_host_image_or_plist_tamper_and_unsafe_metadata_reject_before_proof(self):
        for issue in ['launch', 'runtime', 'plist-hash', 'executable', 'version', 'malformed', 'shape', 'writable', 'oversize']:
            with self.subTest(issue=issue), tempfile.TemporaryDirectory() as folder:
                control = Path(folder).resolve();p = Controls().prepared(control)
                pins = self.framework(control / 'SIMULATED-host');p['python'] = pins
                info = Path(pins['infoPlistPath'])
                if issue == 'launch':Path(pins['launchPath']).write_bytes(b'CHANGED LAUNCH')
                elif issue == 'runtime':Path(pins['runtimeImagePath']).write_bytes(b'CHANGED RUNTIME')
                elif issue == 'writable':info.chmod(0o666)
                elif issue == 'oversize':info.write_bytes(b'x' * 65537)
                elif issue == 'malformed':info.write_bytes(b'NOT A PLIST')
                elif issue == 'shape':info.write_bytes(plistlib.dumps(['wrong shape']))
                else:
                    value = plistlib.loads(info.read_bytes())
                    if issue == 'executable':value['CFBundleExecutable'] = '../outside'
                    elif issue == 'version':value['CFBundleShortVersionString'] = '3.15.8'
                    else:value['Extra'] = 'CHANGED PLIST'
                    info.write_bytes(plistlib.dumps(value))
                self.reject_before_proof(p)

    def test_framework_paths_cannot_escape_by_runtime_or_plist_symlink(self):
        for key in ('runtimeImagePath', 'infoPlistPath'):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as folder:
                control = Path(folder).resolve();p = Controls().prepared(control)
                pins = self.framework(control / 'SIMULATED-host');p['python'] = pins
                other = self.framework(control / 'SIMULATED-other')
                path = Path(pins[key]);path.unlink();path.symlink_to(other[key])
                with mock.patch.object(support, 'host_digest', wraps=support.host_digest) as digest:
                    self.reject_before_proof(p)
                    digest.assert_not_called()  # No hash/read of the external image or aliased plist.

    def test_legacy_same_path_metadata_is_not_a_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            control = Path(folder).resolve();p = Controls().prepared(control)
            pins = self.framework(control / 'SIMULATED-host')
            p['python'] = {'path': pins['launchPath'], 'sha256': pins['launchSha256']}
            self.reject_before_proof(p)

    def test_nonframework_rule_is_explicit_rejection_before_any_output_or_build(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder).resolve();launch = base / 'bin/python3.14'
            launch.parent.mkdir();launch.write_bytes(b'SIMULATED nonframework')
            with self.assertRaisesRegex(ValueError, 'Unsupported non-framework'):
                support.python_identity(launch)
            with mock.patch.object(prep.sys, 'platform', 'darwin'), \
                    mock.patch.object(prep, 'python_identity', side_effect=ValueError('Unsupported non-framework Python layout')), \
                    mock.patch.object(prep.tempfile, 'mkdtemp') as output, \
                    mock.patch.object(prep.subprocess, 'run') as command:
                with self.assertRaisesRegex(ValueError, 'Unsupported non-framework'):
                    prep.prepare(base, 'SIMULATED', base, base, base)
                output.assert_not_called();command.assert_not_called()

    def test_process_path_is_exact_no_alias_normalization_or_real_probe(self):
        library = mock.Mock()
        def query(pid, buffer, size):
            buffer.value = b'/SIMULATED/alias/../Python'
            return len(buffer.value)
        library.proc_pidpath.side_effect = query
        with mock.patch.object(observer.ctypes, 'CDLL', return_value=library):
            self.assertEqual(observer.process_path(100002), '/SIMULATED/alias/../Python')
        library.proc_pidpath.assert_called_once()


class Recipe(unittest.TestCase):
    def test_locked_offline_feature_only(self):
        command = prep.release_command('PINNED-CARGO')
        self.assertEqual(command[0], 'PINNED-CARGO')
        for option in ('--release', '--offline', '--locked', '--no-default-features'):
            self.assertIn(option, command)
        self.assertEqual(command[-1], 'standalone-native-acceptance,tauri/custom-protocol')
        self.assertNotIn('diagnostic', ' '.join(command))

    def test_runner_mocked_no_child(self):
        with tempfile.TemporaryDirectory() as folder:
            run = prep.Runner(Path(folder), Path(folder), {'HOME': '/unchanged'})
            result = mock.Mock(stdout=b'SIMULATED build output', stderr=b'')
            with mock.patch.object(prep.subprocess, 'run', return_value=result) as command:
                self.assertEqual(run(['MOCK-BUILD'], 'build'), 'SIMULATED build output')
                command.assert_called_once_with(['MOCK-BUILD'], cwd=Path(folder), env={'HOME': '/unchanged'},
                                                capture_output=True, check=True)

    def test_original_modes_and_bytes_are_verified(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'source'
            path.write_text('SIMULATED')
            path.chmod(0o644)
            inventory = {'files': [{'path': 'source', 'sha256': prep.sha(path), 'gitMode': '100644'}]}
            prep.verify_source(root, inventory)
            path.chmod(0o755)
            with self.assertRaises(ValueError):
                prep.verify_source(root, inventory)
            path.chmod(0o644)
            path.write_text('CHANGED')
            with self.assertRaises(ValueError):
                prep.verify_source(root, inventory)

    def test_current_source_guard_witnesses(self):
        # Read-only pinned source witnesses. Never run the feature binary.
        root = HERE.parents[4]
        self.assertEqual(prep.source_guards(root)['app']['windows'], [])

    def test_imports_are_inert_and_prepare_never_calls_future_helpers(self):
        for name in (*prep.HELPERS, 'prepare_signed.py'):
            tree = ast.parse((HERE / name).read_text())
            # Executable entrypoints are all behind __main__; import performs no subprocess call.
            for node in tree.body:
                if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                    self.fail('Unexpected top-level call: ' + name)
        source = (HERE / 'prepare_signed.py').read_text()
        for forbidden in ('collect_owned(', 'read_final_receipt(', 'execute_future(', 'process_path('):
            self.assertNotIn(forbidden, source)
        self.assertIn("'app': {'windows': []}", source)
        self.assertIn("'launchReady': False", source)
        self.assertLess(source.index("'--verify', '--deep', '--strict'"), source.index("files = {"))

    def test_complete_preparation_mocked_sign_order_and_external_pins(self):
        # Synthetic filesystem + mocked tools only: no build, signature tool or runtime child.
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder).resolve()
            cache = base / 'cache'
            cache.mkdir()
            runtime = base / 'runtime'
            runtime.mkdir()
            calls = []
            snapshots = []
            python_pins = PythonIdentity().framework(base / 'SIMULATED-host')

            def archive(repo, revision, work):
                source = work / 'source'
                manual = source / prep.MANUAL
                manual.mkdir(parents=True)
                for name in (*prep.HELPERS, 'driver.py', 'tauri.conf.json'):
                    shutil.copyfile(HERE / name, manual / name)
                    (manual / name).chmod(0o644)
                inventory = {'commit': 'a' * 40, 'tree': 'b' * 40,
                             'files': [{'path': str(path.relative_to(source)), 'gitMode': '100644',
                                        'sha256': prep.sha(path)} for path in manual.iterdir()]}
                prep.private_json(work / 'source-before.json', inventory)
                snapshots.append(source)
                return source, inventory, 'c' * 64

            def command(args, **kwargs):
                args = [str(a) for a in args]
                calls.append(args)
                env = kwargs['env']
                self.assertEqual(env['HOME'], os.environ['HOME'])
                self.assertNotIn('OPENAI_API_KEY', env)
                if 'build' in args and '--config' in args:
                    if args[-1].endswith('manual/vite.config.ts'):
                        dist = snapshots[0] / prep.MANUAL / 'dist'
                        dist.mkdir()
                        (dist / 'index.html').write_text('SIMULATED ASSET')
                if '--release' in args:
                    overlay = json.loads(env['TAURI_CONFIG'])
                    self.assertEqual(overlay['app']['windows'], [])
                    self.assertEqual(overlay['build']['frontendDist'], str(snapshots[0] / prep.MANUAL / 'dist'))
                    raw = Path(env['CARGO_TARGET_DIR']) / 'aarch64-apple-darwin/release/heinlein-studio'
                    raw.parent.mkdir(parents=True)
                    raw.write_bytes(b'SIMULATED RAW NEVER EXECUTED')
                output = 'SIMULATED tool version'
                if args[0] == '/usr/bin/codesign' and '--sign' in args:
                    target = Path(args[-1])
                    if target.suffix == '.app':
                        native = target / 'Contents/MacOS/synthetic-standalone'
                        native.write_bytes(b'SIMULATED FINAL AFTER OUTER SEAL')
                        seal = target / 'Contents/_CodeSignature'
                        seal.mkdir()
                        (seal / 'CodeResources').write_text('SIMULATED SEAL')
                if '--display' in args:
                    plist = prep.plistlib.loads((Path(args[-1]) / 'Contents/Info.plist').read_bytes())
                    output = 'Signature=adhoc\nIdentifier=' + plist['CFBundleIdentifier']
                if args[0] == '/usr/bin/file':
                    output = 'Mach-O 64-bit executable arm64'
                if args[0] == '/usr/bin/nm':
                    output = 'SIMULATED acceptance-only symbols'
                if args[0] == '/usr/bin/otool':
                    output = args[-1] + ':\n /usr/lib/libSystem.B.dylib (compatibility version 1)'
                return mock.Mock(stdout=output.encode(), stderr=b'')

            with mock.patch.object(prep.sys, 'platform', 'darwin'), \
                    mock.patch.object(prep, 'python_identity', return_value=python_pins) as interpreter, \
                    mock.patch.object(prep, 'RUNTIME_PARENT', runtime), \
                    mock.patch.object(prep, 'archive_source', side_effect=archive), \
                    mock.patch.object(prep, 'source_guards', return_value={'version': '0.0.0'}), \
                    mock.patch.object(prep.shutil, 'which', return_value=sys.executable), \
                    mock.patch.object(prep.subprocess, 'run', side_effect=command), \
                    contextlib.redirect_stdout(io.StringIO()):
                result = prep.prepare(base, 'SIMULATED', base, base, cache)
            control = Path(result['control'])
            pf = json.loads((control / 'preflight.json').read_text())
            self.assertTrue(pf['signedPrepared'])
            self.assertEqual(pf['python'], python_pins)
            interpreter.assert_called_once_with(sys.executable)
            self.assertIn(python_pins['launchPath'], (control / 'HANDOFF.md').read_text())
            self.assertIn(python_pins['runtimeImagePath'], (control / 'HANDOFF.md').read_text())
            for flag in ('launchAuthorized', 'launchReady', 'nativeExecuted', 'acceptance'):
                self.assertIs(pf[flag], False)
            self.assertNotEqual(pf['rawSha256'], pf['binding']['signedSha256'])
            self.assertEqual(pf['binding']['signedSha256'], prep.sha(Path(pf['binary'])))
            self.assertEqual(result['preflightSha256'], prep.sha(control / 'preflight.json'))
            for rel, digest in pf['files'].items():
                self.assertEqual(prep.sha(control / rel), digest)
            self.assertFalse(any(Path(pf['root']['path']).iterdir()))
            self.assertFalse((control / 'launch.attempt').exists())
            self.assertTrue(all(Path(call[0]) != Path(pf['binary']) for call in calls))
            self.assertFalse(any('future.py' in ' '.join(call) or 'collector_reviewed.py' in call for call in calls))
            self.assertEqual((control / 'collector_reviewed.py').read_bytes(), (HERE / 'driver.py').read_bytes())
            self.assertIn(result['preflightSha256'], (control / 'HANDOFF.md').read_text())

    def test_no_frozen_run_or_private_user_material(self):
        for name in (*prep.HELPERS, 'prepare_signed.py'):
            source = (HERE / name).read_text()
            self.assertNotIn('/Users/', source)
            self.assertNotIn('df2b6390', source)
            self.assertNotIn('heinlein18-', source)
            self.assertNotRegex(source, r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
            self.assertNotRegex(source, r"['\"][0-9a-f]{40,64}['\"]")


if __name__ == '__main__':
    unittest.main()
