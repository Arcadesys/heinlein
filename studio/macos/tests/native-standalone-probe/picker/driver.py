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


APPLE_OK_CONTRACT = 'https://developer.apple.com/documentation/appkit/nssavepanel/ok(_:)'

def require_supported_automation(phase, record):
    # Every advertised picker scenario depends on programmatic NSSavePanel OK.
    record.update(passed=False, acceptance=False, classification='unsupported_automation',
                  unsupportedAPI='NSSavePanel.ok:', appleContract=APPLE_OK_CONTRACT)
    raise RuntimeError('Unsupported automated Save panel OK on macOS10.15+; acceptance=false; '+APPLE_OK_CONTRACT)


def child_environment(root, phase, diagnostic_backtrace=False, parent_environment=None):
    if diagnostic_backtrace and phase != 'picker-preview-only':
        raise ValueError('Backtrace diagnostics require the single Picker-only phase')
    parent = os.environ if parent_environment is None else parent_environment
    allowed = {'HOME','PATH','LANG','LC_ALL','LC_CTYPE','USER','LOGNAME','SHELL','__CF_USER_TEXT_ENCODING'}
    environment = {key:value for key,value in parent.items() if key in allowed}
    environment['TMPDIR'] = str(root)
    if diagnostic_backtrace:
        environment['RUST_BACKTRACE'] = '1'
    assert environment.get('HOME') == parent.get('HOME')
    return environment


class BoundedDiagnostics:
    """Retain the first bounded evidence while continuing to consume both pipes."""
    def __init__(self, home_prefix, byte_limit=131072, line_limit=600, partial_limit=32768):
        self.home_prefix = home_prefix if home_prefix and len(home_prefix)>1 else None
        self.byte_limit, self.line_limit, self.partial_limit = byte_limit, line_limit, partial_limit
        self.lines, self.pending, self.dropping = [], {}, set()
        self.stats = {'bytesRead':0,'retainedBytes':0,'suppressedLines':0,'overflow':False,
                      'truncated':False,'byteLimitPerStream':byte_limit,'lineLimitPerStream':line_limit,
                      'maximumRetainedBytes':2*byte_limit,'maximumRetainedLines':2*line_limit,
                      'streams':{name:{'retainedBytes':0,'retainedLines':0} for name in ('stdout','stderr')},
                      'partialLineLimit':partial_limit,'streamsDrainedToEOF':[]}

    @property
    def failed(self):
        return self.stats['overflow'] or self.stats['truncated']

    def _line(self, raw, stream, truncated=False, unterminated=False):
        stream_stats=self.stats['streams'][stream]
        if stream_stats['retainedLines']>=self.line_limit or stream_stats['retainedBytes']+len(raw)>self.byte_limit:
            self.stats['overflow']=True; self.stats['suppressedLines']+=1
            return []
        self.stats['retainedBytes']+=len(raw)
        stream_stats['retainedBytes']+=len(raw); stream_stats['retainedLines']+=1
        value=raw.decode('utf8',errors='replace')
        if self.home_prefix: value=value.replace(self.home_prefix,'<user-home>')
        try:
            decoded=json.loads(value)
            if not isinstance(decoded,dict): raise ValueError('Not a diagnostic object')
        except ValueError:
            decoded={'kind':'native-stderr','stream':stream,'message':value}
        if truncated: decoded['truncated']=True; self.stats['truncated']=True
        if unterminated: decoded['unterminated']=True
        self.lines.append(decoded)
        return [decoded]

    def feed(self, stream, data):
        self.stats['bytesRead']+=len(data)
        if stream in self.dropping:
            split=data.find(b'\n')
            if split<0: return []
            data=data[split+1:]; self.dropping.remove(stream)
        buffer=self.pending.pop(stream,b'')+data
        emitted=[]
        while b'\n' in buffer:
            raw,buffer=buffer.split(b'\n',1)
            if len(raw)>self.partial_limit:
                self.stats['truncated']=True
                emitted+=self._line(raw[:self.partial_limit],stream,truncated=True)
            else: emitted+=self._line(raw,stream)
        if len(buffer)>self.partial_limit:
            self.stats['truncated']=True
            emitted+=self._line(buffer[:self.partial_limit],stream,truncated=True)
            self.dropping.add(stream)
        else: self.pending[stream]=buffer
        return emitted

    def finish(self, stream):
        tail=self.pending.pop(stream,b'')
        emitted=self._line(tail,stream,unterminated=True) if tail else []
        self.dropping.discard(stream)
        self.stats['streamsDrainedToEOF'].append(stream)
        return emitted


def diagnostic_outcome(code, result, lines):
    """D1 never establishes acceptance, including an instrumented normal run."""
    markers=[v for v in lines if v.get('kind')=='native47-d1']
    terminal={71:'rust_panic',72:'hook_reentry',81:'objc_exception',82:'objc_other',83:'invalid_dispatch'}
    if code in terminal:
        category=terminal[code]
        matched=any(v.get('category')==category for v in markers)
        return {'classification':'terminal_failure','acceptance':False,
                'terminalCategory':category,'terminalMarkerPresent':matched}
    if code==79:
        return {'classification':'marker_failure','acceptance':False,'terminalMarkerPresent':False}
    if code==0 and result and result.get('diagnosticOnly') is True and result.get('scenarioCompleted') is True and result.get('acceptance') is False and result.get('passed') is False and markers:
        return {'classification':'non_reproduction','acceptance':False}
    return {'classification':'incomplete_failure','acceptance':False}


def run_phase(binary, root, phase, record, diagnostic_backtrace=False, diagnostic_boundary=False):
    require_supported_automation(phase, record)
    if diagnostic_boundary and (phase != 'picker-preview-only' or diagnostic_backtrace):
        raise ValueError('D1 requires picker-only without backtrace mode')
    environment=child_environment(root,phase,diagnostic_backtrace)
    capture=BoundedDiagnostics(os.environ.get('HOME'))
    record.update(diagnosticBacktrace=diagnostic_backtrace,
                  diagnosticEnvironment={'RUST_BACKTRACE':'1'} if diagnostic_backtrace else {},
                  diagnosticTimingLimit='Backtrace environment may affect timing; symbols/frames best-effort; no cause inference',
                  capture=capture.stats, orderedDiagnostics=capture.lines)
    child = subprocess.Popen([str(binary), '--standalone-native-acceptance', str(root), 'picker-d1' if diagnostic_boundary else phase],
                             env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
    selector=selectors.DefaultSelector()
    selector.register(child.stdout,selectors.EVENT_READ,'stdout')
    selector.register(child.stderr,selectors.EVENT_READ,'stderr')
    result=None
    record.update(pid=child.pid,processGroup=os.getpgid(child.pid),parentProcessGroup=os.getpgrp(),phase=phase,
                  lifecycle=[{'stage':'child-spawned','pid':child.pid}])
    if record['processGroup']==record['parentProcessGroup']:
        raise RuntimeError('Fixture child did not acquire its isolated session')
    deadline,abort_deadline=time.monotonic()+65,None
    while selector.get_map() or child.poll() is None:
        if (time.monotonic()>deadline or capture.failed) and abort_deadline is None:
            record['cooperativeAbortReason']='diagnostic-overflow-or-truncation' if capture.failed else 'stage-timeout'
            record['lifecycle'].append({'stage':'cooperative-abort-request','reason':record['cooperativeAbortReason']})
            try:
                child.stdin.write(b'abort\n'); child.stdin.flush()
            except BrokenPipeError:
                record['abortPipeAlreadyClosed']=True
            abort_deadline=time.monotonic()+10
        if abort_deadline and time.monotonic()>abort_deadline:
            raise RuntimeError(f'Uncertain live fixture child pid={child.pid} root={root}; bounded diagnostics retained')
        for key,_ in selector.select(.1):
            data=os.read(key.fileobj.fileno(),8192)
            if data: emitted=capture.feed(key.data,data)
            else:
                selector.unregister(key.fileobj)
                emitted=capture.finish(key.data)
            # Never forward synchronously to a controller sink while the child is live.
            for decoded in emitted:
                if decoded.get('kind')=='result': result=decoded
    code=child.wait()
    record.update(exit=code,result=result)
    if diagnostic_boundary:
        record.update(diagnosticOnly=True, diagnosticOutcome=diagnostic_outcome(code,result,capture.lines),acceptance=False)
    record['lifecycle'].append({'stage':'child-reaped','exit':code})
    if abort_deadline or capture.failed or code!=0 or not result or (record.get('diagnosticOutcome',{}).get('classification')!='non_reproduction' if diagnostic_boundary else result.get('passed') is not True):
        raise RuntimeError(f'Native phase failed exit={code} phase={phase} root={root}; preserve diagnostics')
    validate_phase(phase,result,capture.lines)
    return record


def validate_phase(phase,result,lines):
    stages=[line.get('stage') for line in lines if line.get('kind')=='progress']
    required=['feature-explicit-invocation-private-root-sentinel-validated',
              'all-tauri-app-paths-confined-before-webview-or-store',
              'immutable-fixture-private-home-resolver-validated-no-env-override',
              'native-dialog-plugin-after-confinement-no-JS-dialog-ACL',
              'own-webkit-isPersistent-false-before-fixture-navigation','callback-gate-passed',
              'with-webview-call-returned','worker-not-main-navigation-gates-complete',
              'worker-navigation-enqueued','first-renderer-IPC','production-editor-ready',
              'production-editor-focused','owned-native-window-visible-focused']
    required+=['picker-cancel-real-null','picker-preview-real-token'] if phase=='picker-preview-only' else ['picker-cancel-real-null','picker-preview-real-token','picker-place-cancel-real-null',
               'picker-copy-real-receipt','picker-replay-denied'] if phase=='picker' else ['picker-reopened-both']
    required+=['picker-all-evidence-ready','request-close-from-production',
               'production-request-close-command-received','production-exit-guards-approved-Some0']
    positions=[stages.index(stage) for stage in required]
    if positions!=sorted(positions):raise RuntimeError('Native picker stages out of order')
    observations=[v for v in lines if v.get('kind')=='owned-window-observation']
    if len(observations)!=1 or any(observations[0].get(k) is not True for k in ('visible','focused','rendererActiveElement','editorHasFocus','documentHasFocus')):
        raise RuntimeError('Own native window/editor focus not proven')
    actions=[v for v in lines if v.get('kind')=='native-picker' and v.get('stage') in ('public-panel-action-dispatched-real-completion-required','public-alert-button-action-dispatched-real-completion-required')]
    expected_actions=[1,2] if phase=='picker-preview-only' else [1,2,3,4,5] if phase=='picker' else []
    if [v.get('phase') for v in actions]!=expected_actions:raise RuntimeError('Actual public dialog actions missing/duplicated')
    for action in actions:
        observed='actual-NSSavePanel-owned-parent-dir-name-verified' if action['phase'] in (1,2,4) else 'actual-parented-alert-exact-synthetic-content-controls-verified'
        witness=next((v for v in lines if v.get('kind')=='native-picker' and v.get('stage')==observed and v.get('phase')==action['phase']),None)
        if not witness or lines.index(witness)>=lines.index(action):raise RuntimeError('Public action lacks preceding owned-sheet witness')
    if phase in ('picker-preview-only','picker'):
        for action in (value for value in actions if value['phase'] in (1,2,4)):
            phase_number=action['phase']
            before=next((v for v in lines if v.get('kind')=='native-picker' and v.get('phase')==phase_number and v.get('stage')=='owned-panel-before-synthetic-name-input'),None)
            after=next((v for v in lines if v.get('kind')=='native-picker' and v.get('phase')==phase_number and v.get('stage')=='synthetic-filename-reread-verified'),None)
            observations=[v for v in lines if v.get('kind')=='native-picker-diagnostic' and v.get('phase')==phase_number]
            if not before or not after or not lines.index(before)<lines.index(after)<lines.index(action) or len(observations)!=2:
                raise RuntimeError('Synthetic filename input lacks bounded identity/reread evidence')
            for index,observation in enumerate(observations):
                fields=observation.get('fields',{})
                required_fields=('messageMatches','directoryMatches') if index==0 else ('messageMatches','nameMatches','directoryMatches')
                if observation.get('savePanelTypeMatches') is not True or observation.get('visible') is not True or any(fields.get(key) is not True for key in required_fields):
                    raise RuntimeError('Synthetic filename input identity/directory mismatch')
            if observations[1].get('afterSyntheticNameInput') is not True:
                raise RuntimeError('Actual filename reread missing')
    readbacks=[v['value'] for v in lines if v.get('kind')=='native-picker-readback']
    expected=[('picker-cancel-real-null',1,False),('picker-preview-real-token',2,False)] if phase=='picker-preview-only' else [('picker-cancel-real-null',1,False),('picker-preview-real-token',2,False),('picker-place-cancel-real-null',3,False),('picker-preview-real-token',4,False),('picker-copy-real-receipt',5,True),('picker-replay-denied',5,True)] if phase=='picker' else [('picker-reopened-both',0,True)]
    if len(readbacks)!=len(expected):raise RuntimeError('Native file/source readback missing')
    for value,(stage,count,placed) in zip(readbacks,expected):
        if value.get('stage')!=stage or value.get('nativeActions')!=count or value.get('originalExact') is not True or value.get('copyExact') is not placed or value.get('publicationAbsent') is not (not placed) or value.get('bytes')!=94 or value.get('hash')!='115d534fa5575cf7820a1c44c84824eb41871d514293561082f487cfcbe5a276' or value.get('placements')!=(1 if placed else 0) or value.get('pendingIntents')!=0:
            raise RuntimeError('Native original/copy/cancellation byte binding mismatch')
    expected_summary={'armed':2,'completedPublicActions':2,'failure':0,'readbackMask':6,'alertCalls':0,'pickerOnly':True,'placementConfirmation':False,'syntheticNameInputMask':6,'defaultSuggestedFilenameInitialization':False} if phase=='picker-preview-only' else {'armed':5,'completedPublicActions':5,'failure':0,'readbackMask':126,'syntheticNameInputMask':22,'alertCalls':2,'defaultSuggestedFilenameInitialization':False} if phase=='picker' else {'armed':0,'completedPublicActions':0,'failure':0,'readbackMask':128}
    if any(result.get('picker',{}).get(k)!=v for k,v in expected_summary.items()):raise RuntimeError('Native one-shot dialog evidence incomplete')
    if result.get('nativeTerminateCounters')!=[1,1,1,0] or result.get('approvedProgrammaticExits')!=1 or result.get('forbiddenServiceAttempts')!=0 or result.get('managedRuntimeAcquire') is not False or result.get('osStoreProviderConstructorsReachable') is not False:
        raise RuntimeError('Native close/isolation result mismatch')


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
    parser.add_argument('--preview-only', action='store_true')
    parser.add_argument('--diagnostic-backtrace', action='store_true')
    parser.add_argument('--diagnostic-ok-boundary', action='store_true')
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    unsupported={}
    try:
        require_supported_automation('picker-preview-only' if args.preview_only else 'picker',unsupported)
    except RuntimeError as error:
        parser.exit(2,json.dumps(unsupported)+'\n'+str(error)+'\n')
    if args.diagnostic_backtrace and not args.preview_only:
        parser.error("Backtrace diagnostics require --preview-only")
    if args.diagnostic_ok_boundary and (not args.preview_only or args.diagnostic_backtrace):
        parser.error('D1 requires --preview-only without --diagnostic-backtrace')
    binary = args.binary.resolve(strict=True)
    metadata = binary.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or not str(binary).startswith('/private/tmp/heinlein-native47-'):
        parser.error('Only this worker owned temporary fixture executable is allowed')
    root = Path('/private/tmp') / f'heinlein-native-standalone-{uuid.uuid4()}'
    root.mkdir(mode=0o700)
    bundle_parent = binary.parent / 'native47-picker-runs' / root.name
    bundle_parent.mkdir(mode=0o700, parents=True)
    bundle_metadata=bundle_parent.stat()
    if bundle_parent.resolve()!=bundle_parent or bundle_metadata.st_uid!=os.getuid() or bundle_metadata.st_mode&0o077:
        raise RuntimeError('Unsafe fresh synthetic bundle root')
    app = bundle_parent / 'DISPOSABLE Standalone Picker Acceptance.app'
    executable = app / 'Contents' / 'MacOS' / 'synthetic-standalone'
    executable.parent.mkdir(mode=0o700, parents=True)
    shutil.copy2(binary, executable)
    identifier = 'me.thearcades.heinlein.synthetic-standalone-' + root.name.removeprefix('heinlein-native-standalone-').replace('-', '')
    (app / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': identifier, 'CFBundleExecutable': executable.name,
        'CFBundleName': 'DISPOSABLE Standalone Picker Acceptance', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.0.0'}))
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', identifier, str(app)], check=True, capture_output=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(app)], check=True, capture_output=True)
    receipt = {**binary_receipt(binary, executable),
               'bundle': str(app), 'identifier': identifier, 'signature': 'ad-hoc; strict verified',
               'root': str(root), 'physicalKeyboard': False, 'VoiceOver': False, 'installedApp': False, 'phases': [],'pickerOnly':args.preview_only,'placementConfirmation':not args.preview_only,'diagnosticBacktrace':args.diagnostic_backtrace,'diagnosticOnly':args.diagnostic_ok_boundary,'acceptance':False}
    # Write progress after each clean child exit; failure keeps exact diagnostic root.
    try:
        for phase in (('picker-preview-only',) if args.preview_only else ('picker', 'picker-reopen')):
            record={}
            receipt['phases'].append(record)
            record.update(run_phase(executable, root, phase, record, args.diagnostic_backtrace,args.diagnostic_ok_boundary))
        if not args.preview_only:
            first=[v['value'] for v in receipt['phases'][0]['orderedDiagnostics'] if v.get('kind')=='native-picker-readback'][-1]
            reopened=[v['value'] for v in receipt['phases'][1]['orderedDiagnostics'] if v.get('kind')=='native-picker-readback'][-1]
            if any(first.get(k)!=reopened.get(k) for k in ('draftId','revision','hash','bytes','placements')):
                raise RuntimeError('Fresh process changed original/copy/receipt binding')
        receipt['passed'] = not args.diagnostic_ok_boundary
        receipt['acceptance'] = not args.diagnostic_ok_boundary
        if args.diagnostic_ok_boundary: receipt['classification']='non_reproduction'
    except Exception as error:
        receipt['passed'] = False
        receipt['failure'] = str(error)
        raise
    finally:
        args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'kind': 'complete', 'receipt': str(args.receipt), 'rootRetained': str(root)}), flush=True)


if __name__ == '__main__':
    main()
