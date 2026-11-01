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
import unittest
from unittest import mock

import future_support as support
import prepare_signed as prep
import observe_future as observer
import verify_future as verifier

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
