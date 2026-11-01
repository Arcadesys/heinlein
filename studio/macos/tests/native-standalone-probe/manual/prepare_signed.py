"""Prepare a disposable signed manual fixture; never launch it or runtime helpers.

macOS only. Uses an existing offline toolchain/dependency cache, not installers.
All build products are outside the repository. Future launch needs separate consent.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid

MANUAL = Path('studio/macos/tests/native-standalone-probe/manual')
FEATURES = 'standalone-native-acceptance,tauri/custom-protocol'
RUNTIME_PARENT = Path('/private/tmp')
HELPERS = ('future_support.py', 'launch_future.py', 'observe_future.py', 'verify_future.py')
BUILD_KEYS = {'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
              '__CF_USER_TEXT_ENCODING', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN',
              'SDKROOT', 'DEVELOPER_DIR', 'MACOSX_DEPLOYMENT_TARGET'}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        while data := f.read(65536):
            h.update(data)
    return h.hexdigest()


def private_json(path, value):
    # Every output is fresh. Failure leaves an incomplete package, never a prepared pin.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, indent=2)
        f.write('\n')


def identity(path):
    m = path.lstat()
    if path.resolve() != path or not stat.S_ISDIR(m.st_mode) or m.st_uid != os.getuid() or stat.S_IMODE(m.st_mode) != 0o700:
        raise ValueError('Expected canonical owned 0700 directory')
    return {'path': str(path), 'identity': [m.st_dev, m.st_ino], 'uid': m.st_uid, 'mode': '0o700'}


def build_environment(work, parent):
    env = {key: value for key, value in parent.items() if key in BUILD_KEYS}
    env.update(TMPDIR=str(work / 'tool-tmp'), CARGO_TARGET_DIR=str(work / 'target'), CARGO_NET_OFFLINE='true')
    if not parent.get('HOME') or env.get('HOME') != parent['HOME']:
        raise ValueError('HOME must remain unchanged')
    return env


def release_command(cargo):
    return [cargo, 'build', '--manifest-path', 'Cargo.toml', '--release', '--offline', '--locked',
            '--no-default-features', '--target', 'aarch64-apple-darwin', '-p', 'heinlein-studio',
            '--features', FEATURES]


class Runner:
    def __init__(self, work, cwd, env):
        self.work, self.cwd, self.env = work, cwd, env
        self.counter = 0

    def __call__(self, args, label):
        self.counter += 1
        result = subprocess.run(args, cwd=self.cwd, env=self.env, capture_output=True, check=True)
        (self.work / f'{self.counter:02d}-{label}.log').write_bytes(result.stdout + result.stderr)
        return (result.stdout + result.stderr).decode('utf-8', errors='strict')


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def archive_source(repo, commit, work):
    commit = git(repo, 'rev-parse', '--verify', commit + '^{commit}').decode().strip()
    tree = git(repo, 'rev-parse', commit + '^{tree}').decode().strip()
    if not all(re.fullmatch('[0-9a-f]{40}', value) for value in (commit, tree)):
        raise ValueError('Expected full Git object identities')
    data = git(repo, 'archive', '--format=tar', commit)
    archive = work / 'source.tar'
    archive.write_bytes(data)
    source = work / 'source'
    source.mkdir(mode=0o700)
    # Reject traversal and symlinks: a clean snapshot may not write outside this directory.
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member in tar.getmembers():
            rel = Path(member.name)
            if rel.is_absolute() or '..' in rel.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsupported archive member (including symlink/submodule)')
        tar.extractall(source, filter='data')
    entries = []
    for row in git(repo, 'ls-tree', '-rz', commit).split(b'\0'):
        if not row:
            continue
        meta, name = row.split(b'\t', 1)
        mode, kind, blob = meta.decode().split()
        rel = os.fsdecode(name)
        path = source / rel
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise ValueError('Only regular source files supported')
        raw = path.read_bytes()
        if hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() != blob:
            raise ValueError('Archive Git blob mismatch')
        entries.append({'path': rel, 'gitMode': mode, 'sha256': sha(path)})
    inventory = {'commit': commit, 'tree': tree, 'files': entries}
    verify_source(source, inventory)
    private_json(work / 'source-before.json', inventory)
    return source, inventory, sha(archive)


def verify_source(source, inventory):
    for entry in inventory['files']:
        path = source / entry['path']
        m = path.lstat()
        expected = int(entry['gitMode'][-3:], 8)
        if not stat.S_ISREG(m.st_mode) or stat.S_IMODE(m.st_mode) != expected or sha(path) != entry['sha256']:
            raise ValueError('Original source bytes/modes changed: ' + entry['path'])


def source_guards(source):
    main = (source / 'studio/src-tauri/src/main.rs').read_text()
    manifest = (source / 'studio/src-tauri/Cargo.toml').read_text()
    standalone = (source / 'studio/src-tauri/src/standalone_native_acceptance.rs').read_text()
    config = json.loads((source / MANUAL / 'tauri.conf.json').read_text())
    # Source witnesses, never executable rejection probes. Fail closed on source drift.
    if 'default = []' not in manifest or 'standalone-native-acceptance' not in manifest:
        raise ValueError('Feature/default contract changed')
    if ('std::process::exit(64)' not in main or 'standalone-native-acceptance' not in main
            or 'production startup disabled' not in main):
        raise ValueError('Acceptance startup rejection source witness changed')
    if ('.incognito(true)' not in standalone
            or 'Some(AppDirectoriesOverride::Root(app_root.clone()))' not in standalone
            or 'uuid.simple()' not in standalone):
        raise ValueError('Private namespace source witnesses changed')
    if config['app']['windows'] != []:
        raise ValueError('Manual configuration must not create a second window')
    return config


def link_cache(cache, studio):
    cache = cache.resolve(strict=True)
    if not cache.is_dir():
        raise ValueError('Existing node_modules cache required; no installation')
    dest = studio / 'node_modules'
    dest.mkdir(mode=0o700)
    for child in cache.iterdir():
        if child.name not in ('.vite', '.vite-temp', '.cache'):
            (dest / child.name).symlink_to(child, target_is_directory=child.is_dir())


def host_pins(binary, run):
    items, seen, queue = [], set(), [binary]
    while queue:
        owner = queue.pop()
        output = run(['/usr/bin/otool', '-L', str(owner)], 'dylibs')
        for line in output.splitlines()[1:]:
            name = line.strip().split(' (', 1)[0]
            if not name or name in seen:
                continue
            seen.add(name)
            item = {'loadPath': name, 'loadedBy': str(owner)}
            if name.startswith(('/System/', '/usr/lib/')):
                item.update(backing='system/dyld-cache; OS-version pin, not loaded-image observation', sha256=None)
            else:
                path = Path(name)
                if not path.is_absolute():
                    raise ValueError('Unpinned relative host dependency: ' + name)
                resolved = path.resolve(strict=True)
                item.update(resolved=str(resolved), sha256=sha(resolved), backing='host-file')
                queue.append(resolved)
            items.append(item)
    return items


def prepare(repo, revision, output_parent, work_parent, node_cache):
    if sys.platform != 'darwin':
        raise ValueError('Preparation requires macOS; tests must mock subprocesses')
    run_id = str(uuid.uuid4())
    # No existing output is reused. Failures preserve working evidence, never clean old items.
    control = Path(tempfile.mkdtemp(prefix='manual47-', dir=output_parent)).resolve()
    work = Path(tempfile.mkdtemp(prefix='manual47-build-', dir=work_parent)).resolve()
    root = RUNTIME_PARENT / ('heinlein-native-standalone-' + run_id)
    root.mkdir(mode=0o700)
    control.chmod(0o700)
    work.chmod(0o700)
    (work / 'tool-tmp').mkdir(mode=0o700)
    print('Private preparation working directory: ' + str(work), flush=True)
    source, inventory, archive_hash = archive_source(repo, revision, work)
    config = source_guards(source)
    studio = source / 'studio'
    link_cache(node_cache, studio)
    env = build_environment(work, os.environ)
    run = Runner(work, studio, env)
    tools = {}
    for tool, version_args in [('rustc', ['--version', '--verbose']), ('cargo', ['--version']), ('node', ['--version'])]:
        path = Path(shutil.which(tool, path=env['PATH'])).resolve(strict=True)
        tools[tool] = {'path': str(path), 'sha256': sha(path), 'version': run([str(path), *version_args], tool)}
    tools.update(HOMEUnchanged=True, buildEnvironmentKeys=sorted(env))
    private_json(control / 'toolchain.json', tools)
    for label, relative in [('base', 'vite.config.ts'), ('picker', 'picker/vite.config.ts'), ('manual', 'manual/vite.config.ts')]:
        run([str(studio / 'node_modules/.bin/vite'), 'build', '--config', 'macos/tests/native-standalone-probe/' + relative], label + '-assets')
    run(['npm', 'run', 'build'], 'default-assets')
    dist = source / MANUAL / 'dist'
    if not (dist / 'index.html').is_file():
        raise ValueError('Actual private manual assets missing')
    identifier = 'dev.heinlein.standalone.manual-' + run_id
    overlay = {'identifier': identifier, 'build': {'frontendDist': str(dist)}, 'app': {'windows': []}}
    private_json(control / 'tauri-overlay.json', overlay)
    env['TAURI_CONFIG'] = json.dumps(overlay, separators=(',', ':'))
    command = release_command(tools['cargo']['path'])
    run(command, 'release-overlay')
    raw = work / 'target/aarch64-apple-darwin/release/heinlein-studio'
    raw_hash = sha(raw)
    verify_source(source, inventory)
    private_json(work / 'source-after.json', inventory)
    if sha(work / 'source-before.json') != sha(work / 'source-after.json'):
        raise ValueError('Source inventory changed')
    private_json(control / 'source-inventory.json', inventory)
    assets = {str(p.relative_to(dist)): {'sha256': sha(p), 'bytes': p.stat().st_size,
              'mode': oct(stat.S_IMODE(p.stat().st_mode))} for p in dist.rglob('*') if p.is_file()}
    private_json(control / 'embedded-assets.json', {'embeddedDist': str(dist), 'assets': assets,
                 'overlaySha256': sha(control / 'tauri-overlay.json')})
    app = control / 'DISPOSABLE Manual Save Preview.app'
    binary = app / 'Contents/MacOS/synthetic-standalone'
    resources = app / 'Contents/Resources'
    binary.parent.mkdir(parents=True, mode=0o700)
    resources.mkdir(mode=0o700)
    for folder in (app, app / 'Contents', binary.parent):
        folder.chmod(0o700)
    shutil.copyfile(raw, binary)
    binary.chmod(0o700)
    plist = {'CFBundleIdentifier': identifier, 'CFBundleExecutable': binary.name,
             'CFBundleName': 'DISPOSABLE Manual Save Preview', 'CFBundlePackageType': 'APPL',
             'CFBundleVersion': '1', 'CFBundleShortVersionString': config['version'], 'NSHighResolutionCapable': True}
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(plist))
    (app / 'Contents/Info.plist').chmod(0o600)
    evidence = {'commit': inventory['commit'], 'tree': inventory['tree'], 'sourceArchiveSha256': archive_hash,
                'originalSourceInventorySha256': sha(control / 'source-inventory.json'),
                'originalBytesModesIdentical': True, 'rawBeforeStageSigningSha256': raw_hash,
                'embeddedAssetManifestSha256': sha(control / 'embedded-assets.json'),
                'overlaySha256': sha(control / 'tauri-overlay.json'), 'features': FEATURES.split(','),
                'nativeExecuted': False, 'acceptance': False}
    private_json(resources / 'build-evidence.json', evidence)
    for target in (binary, app):
        run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', identifier, str(target)], 'sign')
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app)], 'verify')
    signature = run(['/usr/bin/codesign', '--display', '--verbose=4', str(app)], 'signature')
    if 'Signature=adhoc' not in signature or 'Identifier=' + identifier not in signature:
        raise ValueError('Unexpected signature')
    architecture = run(['/usr/bin/file', str(binary)], 'architecture')
    if 'arm64' not in architecture or 'Mach-O 64-bit executable' not in architecture or 'x86_64' in architecture:
        raise ValueError('Expected native ARM64 executable')
    symbols = run(['/usr/bin/nm', str(binary)], 'symbols')
    if any(name in symbols for name in ('native47_d1_action', 'production_main')):
        raise ValueError('Excluded production/diagnostic symbol present')
    dylibs = host_pins(binary, run)
    for name in HELPERS:
        shutil.copyfile(source / MANUAL / name, control / name)
        (control / name).chmod(0o600)
    shutil.copyfile(source / MANUAL / 'driver.py', control / 'collector_reviewed.py')
    (control / 'collector_reviewed.py').chmod(0o600)
    if any(root.iterdir()):
        raise ValueError('Runtime root must remain empty')
    files = {str(p.relative_to(control)): sha(p) for p in control.rglob('*') if p.is_file()}
    python = Path(sys.executable).resolve(strict=True)
    os_version = Path('/System/Library/CoreServices/SystemVersion.plist').resolve(strict=True)
    preflight = {'schema': 'manual47-signed-prepared-v1', 'phase': 'picker-manual-preview',
                 **evidence, 'runId': run_id, 'control': identity(control), 'root': identity(root),
                 'binary': str(binary), 'rawSha256': raw_hash, 'files': files, 'hostDylibs': dylibs,
                 'systemVersionPin': {'path': str(os_version), 'sha256': sha(os_version)},
                 'python': {'path': str(python), 'sha256': sha(python)}, 'buildCommand': command,
                 'signedPrepared': True, 'launchAuthorized': False, 'launchReady': False,
                 'nativeExecuted': False, 'acceptance': False, 'startupSurvivalObserved': False,
                 'profile': {'path': str(root / 'app-data'), 'reservedOnly': True, 'exists': False},
                 'bundle': {'identifier': identifier, 'path': str(app), 'nativeDirect': True},
                 'sourceBytesModesBeforeAfterIdentical': True,
                 'manualConfigSha256': sha(source / MANUAL / 'tauri.conf.json')}
    preflight['binding'] = {'runId': run_id, 'receiptNonce': str(uuid.uuid4()), 'binary': str(binary),
                            'signedSha256': files[str(binary.relative_to(control))], 'root': str(root)}
    private_json(control / 'preflight.json', preflight)
    pin = sha(control / 'preflight.json')
    handoff = f'''# Signed disposable fixture — prepared, not launched

Source commit `{inventory['commit']}`, tree `{inventory['tree']}`. #47 remains open.

**No launch is authorized.** signedPrepared=true; launchAuthorized, launchReady,
nativeExecuted and acceptance=false. No native binary, collector, launcher,
observer or rejected-flag probe was executed by preparation.

- App: `{app}`
- Empty 0700 synthetic root: `{root}`; app-data is reserved, not created.
- Private control: `{control}`
- Build working material: `{work}`
- Independent preflight SHA-256: `{pin}`
- Raw before signing: `{raw_hash}`
- Final signed after outer sealing: `{preflight['binding']['signedSha256']}`

All original source bytes and modes matched before/after. Actual private embedded
assets and overlay are hash-pinned; strict deep ad-hoc signature, ARM64 and symbol
exclusions were checked statically. Host dylib/OS/Python pins are in preflight.
These checks prove no runtime namespace, startup survival or native acceptance.

Future helpers require separate explicit launch authorization. Keep this preflight
pin independently; never take expected binding from a candidate receipt. Use a
user-owned Terminal and the pinned script file, never a heredoc, redirected stdin,
background service or automatically opened Terminal. launch_future.py requires
--authorize-native-launch and --operator-owned-terminal and a retained live FD.
Its synced one-shot claim precedes any spawn; failure/double invocation cannot retry.
An independent observe_future.py context must confirm this exact owned startup
BEFORE human Open/Cancel/Save/Finish steps. Type its exact ready STARTUP_NONCE
command once in the retained launch Terminal. Wait for native readiness; Open stays
disabled until the mutex-protected native latch. A unique matching nonce ACK must
precede picker readbacks in final evidence. No automated UI/human-step deadline.
Only verify_future.py via the reviewed official guarded read_final_receipt can
establish final receipt authority; JSON acceptance:true alone never does.

Source-only stages are not this signed package. System pins are not loaded-image
observations. Nothing is installed/released/uploaded; HOME is unchanged, no old
profile/credentials are copied. Preserve failed attempts for diagnosis, do not retry
or reuse this run. See the source README for future helper arguments and limits.
'''
    fd = os.open(control / 'HANDOFF.md', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(handoff)
    return {'control': str(control), 'work': str(work), 'preflightSha256': pin,
            'handoffSha256': sha(control / 'HANDOFF.md'), 'nativeExecuted': False, 'acceptance': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--commit', required=True, help='Exact reviewed commit to archive, including these reusable helpers')
    parser.add_argument('--output-parent', type=Path, required=True, help='Existing private artifact parent')
    parser.add_argument('--work-parent', type=Path, required=True, help='Existing private temporary build parent')
    parser.add_argument('--node-cache', type=Path, required=True, help='Existing node_modules, never installs dependencies')
    args = parser.parse_args()
    for parent in (args.output_parent, args.work_parent):
        identity(parent.resolve(strict=True))
    print(json.dumps(prepare(args.repo.resolve(strict=True), args.commit, args.output_parent,
                             args.work_parent, args.node_cache), indent=2))


if __name__ == '__main__':
    main()
