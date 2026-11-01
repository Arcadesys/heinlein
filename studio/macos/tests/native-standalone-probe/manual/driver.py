#!/usr/bin/env python3
"""Manual-only source staging and bounded single-child collection. Never operates a UI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import stat
import subprocess
import time
import threading
import uuid

MODE = 'picker-manual-preview'
MAX_STREAM = 131072
MAX_LINE = 32768
MAX_LINES = 600
MAX_RECEIPT = 2 * 1024 * 1024


def binary_hash(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        m=os.fstat(f.fileno())
        if not stat.S_ISREG(m.st_mode) or m.st_uid!=os.getuid() or m.st_nlink!=1 or m.st_mode&0o022 or m.st_size>256*1024*1024:
            raise ValueError('Unsafe owned binary')
        digest=hashlib.sha256()
        while chunk:=f.read(65536):digest.update(chunk)
    return digest.hexdigest()


def private(path):
    path = Path(path)
    m = path.lstat()
    if (not stat.S_ISDIR(m.st_mode) or m.st_uid != os.getuid() or
            stat.S_IMODE(m.st_mode) != 0o700 or str(path.resolve()) != str(path)):
        raise ValueError('Canonical owned 0700 directory required')
    return m.st_dev, m.st_ino


def lexical(candidate, root):
    return isinstance(candidate, str) and candidate == str(root) + '/copy-targets/draft.md'


def environment(root, parent=None):
    parent = os.environ if parent is None else parent
    allowed = {'HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', '__CF_USER_TEXT_ENCODING'}
    env = {k: v for k, v in parent.items() if k in allowed}
    env['TMPDIR'] = str(root)
    assert env.get('HOME') == parent.get('HOME')
    return env


def atomic_receipt(path, value):
    """Bounded, atomic and directory-synced. A failed write never returns a receipt."""
    path = Path(path)
    private(path.parent)
    data = (json.dumps(value, ensure_ascii=True, separators=(',', ':')) + '\n').encode()
    if len(data) > MAX_RECEIPT:
        raise ValueError('Receipt limit exceeded')
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    tmp = '.receipt-' + str(uuid.uuid4())
    try:
        try:
            m = path.lstat()
        except FileNotFoundError:
            m = None
        if m is not None:
            if not stat.S_ISREG(m.st_mode) or m.st_uid != os.getuid() or m.st_nlink != 1 or m.st_mode & 0o077:
                raise ValueError('Unsafe receipt destination')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path.name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try:
                os.unlink(tmp, dir_fd=parent)
            except FileNotFoundError:
                pass
    finally:
        os.close(parent)
    # Read back the committed bytes; do not classify memory-only state as durable.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        actual = f.read(MAX_RECEIPT + 1)
    if actual != data:
        raise OSError('Durable receipt readback mismatch')
    return json.loads(actual)


class Capture:
    def __init__(self, byte_limit=MAX_STREAM, line_limit=MAX_LINES, partial_limit=MAX_LINE):
        self.byte_limit, self.line_limit, self.partial_limit = byte_limit, line_limit, partial_limit
        self.pending = {'stdout': b'', 'stderr': b''}
        self.retained = dict.fromkeys(self.pending, 0)
        self.counts = dict.fromkeys(self.pending, 0)
        self.dropping = set()
        self.records = []
        self.eof = set()
        self.overflow = self.truncated = False
        self.bytes_read = 0

    def line(self, stream, raw):
        if self.counts[stream] >= self.line_limit or self.retained[stream] + len(raw) > self.byte_limit:
            self.overflow = True
            return
        self.counts[stream] += 1
        self.retained[stream] += len(raw)
        try:
            value = json.loads(raw.decode('utf8', errors='strict'))
        except (ValueError, UnicodeError, RecursionError):
            value = {'kind': 'unparsed', 'stream': stream, 'bytes': len(raw), 'prefix':raw.decode('utf8',errors='replace')}
        if stream == 'stdout' and isinstance(value, dict):
            self.records.append(value)
        elif stream == 'stdout':
            self.truncated = True
        elif stream == 'stderr':
            self.records.append({'kind':'stderr-prefix','prefix':raw.decode('utf8',errors='replace')})
        # Prefixes share the strict per-stream byte/line caps; no live forwarding.

    def feed(self, stream, data):
        self.bytes_read += len(data)
        if stream in self.eof:
            self.truncated = True
            return
        if stream in self.dropping:
            end = data.find(b'\n')
            if end < 0:
                return
            data = data[end + 1:]
            self.dropping.remove(stream)
        buf = self.pending[stream] + data
        while b'\n' in buf:
            raw, buf = buf.split(b'\n', 1)
            if len(raw) > self.partial_limit:
                self.truncated = True
            else:
                self.line(stream, raw)
        if len(buf) > self.partial_limit:
            self.truncated = True
            self.dropping.add(stream)
            buf = b''
        self.pending[stream] = buf

    def finish(self, stream):
        if self.pending[stream] or stream in self.dropping or stream in self.eof:
            self.truncated = True
        self.pending[stream] = b''
        self.eof.add(stream)


def protocol(records, startup_nonce=None):
    """Only native stdout results/readbacks count; renderer text alone proves nothing."""
    records=[v for v in records if v.get('kind')!='stderr-prefix']
    acks = [v for v in records if v.get('kind') == 'native-observation-ready']
    if (not isinstance(startup_nonce, str) or len(acks) != 1 or
            acks[0].get('startupNonce') != startup_nonce or
            any(v.get('kind') == 'native-picker-readback' for v in records[:records.index(acks[0])])):
        return False
    results = [v for v in records if v.get('kind') == 'result']
    readbacks = [v.get('value', {}) for v in records if v.get('kind') == 'native-picker-readback']
    stages = [v.get('stage', '') for v in records if v.get('kind') == 'progress']
    expected = ['picker-cancel-real-null', 'picker-preview-real-token', 'manual-final-exact-no-copy']
    if len(results) != 1 or not records or records[-1] is not results[0] or [v.get('stage') for v in readbacks] != expected:
        return False
    r, picker = results[0], results[0].get('picker', {})
    if (r.get('phase') != MODE or any(r.get(k) is not True for k in ('passed', 'scenarioCompleted', 'acceptance')) or
            r.get('approvedProgrammaticExits') != 1 or r.get('nativeTerminateCounters') != [1,1,1,0] or r.get('forbiddenServiceAttempts') != 0 or
            r.get('osStoreProviderConstructorsReachable') is not False or r.get('managedRuntimeAcquire') is not False or
            picker.get('manual') is not True or picker.get('completedManualResults') != 2 or
            picker.get('activePhase') is not None or picker.get('failure') is not False or
            picker.get('tokenRetained') is not True or picker.get('finishRequested') is not True or
            picker.get('automatedActions') != 0 or picker.get('alertCalls') != 0 or picker.get('readbackMask') != 14 or
            picker.get('defaultSuggestedFilenameInitialization') is not False):
        return False
    if any(('place' in stage or 'copy-real-receipt' in stage or 'timer-installed' in stage or 'ABORT' in stage or 'failed' in stage or 'incomplete' in stage) for stage in stages):
        return False
    if ('manual-finish-exact-no-copy' not in stages or 'production-exit-guards-approved-Some0' not in stages or
            stages.index('manual-finish-exact-no-copy') >= stages.index('production-exit-guards-approved-Some0')):
        return False
    first = readbacks[0]
    for v, actions in zip(readbacks, [1, 2, 2]):
        if (v.get('nativeActions') != actions or v.get('originalExact') is not True or v.get('publicationAbsent') is not True or
                v.get('copyExact') is not False or v.get('placements') != 0 or v.get('pendingIntents') != 0 or
                v.get('revision') != 1 or v.get('bytes') != 94 or
                v.get('hash') != '115d534fa5575cf7820a1c44c84824eb41871d514293561082f487cfcbe5a276' or
                not isinstance(v.get('draftId'), str) or not v['draftId'] or v['draftId'] != first.get('draftId')):
            return False
    return True


BINDING_KEYS=('runId','receiptNonce','binary','signedSha256','root')


def _expected_binding(expected):
    if set(expected)!=set(BINDING_KEYS) or any(not isinstance(expected[k],str) or not expected[k] for k in BINDING_KEYS):
        raise ValueError('Independent exact run/nonce/binary/root binding required')
    return dict(expected)


def _version(m):
    return (m.st_dev,m.st_ino,m.st_size,m.st_mtime_ns,m.st_ctime_ns,m.st_uid,m.st_mode,m.st_nlink)


def _directory_fd(control, identity):
    fd=os.open(control,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        m=os.fstat(fd)
        if not stat.S_ISDIR(m.st_mode) or m.st_uid!=os.getuid() or stat.S_IMODE(m.st_mode)!=0o700 or (m.st_dev,m.st_ino)!=tuple(identity):
            raise ValueError('Owned control directory identity changed')
        _directory_matches(control,identity)
        return fd
    except Exception:
        os.close(fd);raise


def _directory_matches(control, identity):
    m=os.stat(control,follow_symlinks=False)
    if not stat.S_ISDIR(m.st_mode) or m.st_uid!=os.getuid() or stat.S_IMODE(m.st_mode)!=0o700 or (m.st_dev,m.st_ino)!=tuple(identity):
        raise ValueError('Control directory replaced')


def _guard_absent(fd):
    try:os.stat('receipt.pending',dir_fd=fd,follow_symlinks=False)
    except FileNotFoundError:return True
    return False  # Any entry, even malformed, remains an incomplete finalization.


def _read_owned(fd, name, limit):
    handle=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
    with os.fdopen(handle,'rb') as f:
        before=os.fstat(f.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or before.st_nlink!=1 or before.st_mode&0o077 or before.st_size>limit:
            raise ValueError('Unsafe bounded receipt/marker')
        data=f.read(limit+1)
        after=os.fstat(f.fileno())
        named=os.stat(name,dir_fd=fd,follow_symlinks=False)
        if len(data)>limit or _version(before)!=_version(after) or _version(before)!=_version(named):
            raise ValueError('Receipt/marker replaced or changed during read')
    return data,_version(before)


def _create_marker(fd,name,state,expected):
    data=json.dumps({'schema':1,'state':state,'binding':expected},sort_keys=True).encode()
    handle=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    with os.fdopen(handle,'wb') as f:
        f.write(data);f.flush();os.fsync(f.fileno())
    os.fsync(fd)


def _candidate_valid(value, expected):
    if not isinstance(value,dict) or value.get('receiptSchema')!=1 or value.get('receiptBinding')!=expected:
        return False
    if any(value.get(k)!=expected[k] for k in BINDING_KEYS):return False
    if type(value.get('reaped')) is not bool or type(value.get('acceptance')) is not bool or type(value.get('passed')) is not bool:return False
    eof=value.get('streamsEOF')
    if not isinstance(eof,list) or len(set(eof))!=len(eof) or any(v not in ('stdout','stderr') for v in eof):return False
    if value.get('finalState')=='incomplete':
        return value['acceptance'] is False and value['passed'] is False and value.get('classification')=='incomplete'
    if value.get('finalState')!='complete':return False
    return (value['acceptance'] is True and value['passed'] is True and value.get('classification')=='pass' and
            type(value.get('exit')) is int and value['exit']==0 and value.get('nativeExecuted') is True and value['reaped'] is True and set(eof)=={'stdout','stderr'} and
            value.get('startupIdentityVerified') is True and value.get('stopped') is False and
            value.get('overflow') is False and value.get('truncated') is False and
            not value.get('storageFailure') and not value.get('setupFailure') and not value.get('readErrors') and
            not value.get('postExitDrainExpired') and not value.get('missingEOFStreams') and
            value.get('observationReadySent') is True and isinstance(value.get('diagnostics'),list) and protocol(value['diagnostics'],value.get('startupNonce')))


def read_final_receipt(control, expected, control_identity):
    """Official later reader. expected/identity MUST come from independent run evidence.

    Candidate acceptance:true by itself is never authority. Guard lookup errors,
    pending finalization, wrong bindings, replacements and malformed states reject.
    """
    fd=None
    try:
        expected=_expected_binding(expected);control=Path(control)
        fd=_directory_fd(control,control_identity)
        if not _guard_absent(fd):return None
        attempt,attempt_version=_read_owned(fd,'receipt.attempt',4096)
        if json.loads(attempt)!={'schema':1,'state':'attempted','binding':expected}:return None
        if not _guard_absent(fd):return None
        data,receipt_version=_read_owned(fd,'receipt.json',MAX_RECEIPT)
        if not _guard_absent(fd):return None
        value=json.loads(data)
        if not _candidate_valid(value,expected):return None
        _directory_matches(control,control_identity)
        if _version(os.stat('receipt.json',dir_fd=fd,follow_symlinks=False))!=receipt_version:return None
        if _version(os.stat('receipt.attempt',dir_fd=fd,follow_symlinks=False))!=attempt_version:return None
        if not _guard_absent(fd):return None
        _directory_matches(control,control_identity)
        if _version(os.stat('receipt.json',dir_fd=fd,follow_symlinks=False))!=receipt_version:return None
        return value
    except (OSError,ValueError,TypeError,KeyError,RecursionError):
        return None
    finally:
        if fd is not None:
            try:os.close(fd)
            except OSError:pass


def commit_final_receipt(path, record, expected):
    """One attempt. Guard unlink is the commit point; no fallible work follows it."""
    path=Path(path)
    if path.name!='receipt.json':raise ValueError('Exact final receipt filename required')
    expected=_expected_binding(expected);identity=private(path.parent)
    fd=_directory_fd(path.parent,identity)
    try:
        # Persistent attempt marker prevents retry/reuse even after successful commit.
        _create_marker(fd,'receipt.attempt','attempted',expected)
        _create_marker(fd,'receipt.pending','pending',expected)
        candidate={**record,'receiptSchema':1,'receiptBinding':expected,
                   'finalState':'complete' if record.get('acceptance') is True else 'incomplete'}
        atomic_receipt(path,candidate)
        data,version=_read_owned(fd,'receipt.json',MAX_RECEIPT)
        value=json.loads(data)
        if data!=(json.dumps(candidate,ensure_ascii=True,separators=(',',':'))+'\n').encode() or not _candidate_valid(value,expected):
            raise ValueError('Candidate readback/completion/binding invalid')
        pending,pending_version=_read_owned(fd,'receipt.pending',4096)
        if json.loads(pending)!={'schema':1,'state':'pending','binding':expected}:raise ValueError('Pending run binding changed')
        _directory_matches(path.parent,identity)
        if _version(os.stat('receipt.json',dir_fd=fd,follow_symlinks=False))!=version:raise ValueError('Candidate replaced')
        if _version(os.stat('receipt.pending',dir_fd=fd,follow_symlinks=False))!=pending_version:raise ValueError('Pending guard replaced')
        os.unlink('receipt.pending',dir_fd=fd)  # COMMIT. Failure retains guard and is incomplete.
        return value  # No sync/readback/validation/cleanup failure after this point.
    finally:
        try:os.close(fd)
        except OSError:pass


def finalize(path, record, capture, code, reaped, stopped=False, *, expected_binding):
    passed = (record.get('startupIdentityVerified') is True and code == 0 and reaped and capture.eof == {'stdout', 'stderr'} and
              record.get('observationReadySent') is True and not capture.overflow and not capture.truncated and not stopped and protocol(capture.records,record.get('startupNonce')))
    record.update(passed=passed, acceptance=passed, classification='pass' if passed else 'incomplete',
                  exit=code, reaped=reaped, streamsEOF=sorted(capture.eof), stopped=stopped,
                  overflow=capture.overflow, truncated=capture.truncated, bytesRead=capture.bytes_read,
                  diagnostics=capture.records, partialPrefixes={stream:data.decode('utf8',errors='replace') for stream,data in capture.pending.items() if data}, nativeExecuted=True)
    try:
        return commit_final_receipt(path,record,expected_binding)
    except Exception:
        record.update(passed=False,acceptance=False,classification='incomplete',storageFailure=True)
        # Guard presence/lookup is authority, not best-effort candidate deletion.
        raise


def startup_proof(path, record):
    """Separate observer must bind this live child and collector after startup."""
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        m=os.fstat(f.fileno())
        if not stat.S_ISREG(m.st_mode) or m.st_uid!=os.getuid() or m.st_nlink!=1 or m.st_mode&0o077 or m.st_size>4096:
            return False
        value=json.loads(f.read(4097))
    keys=('pid','collectorPID','childStart','collectorStart','startupNonce','signedSha256','root')
    return (all(value.get(k)==record.get(k) and record.get(k) not in (None,'') for k in keys) and
            value.get('observerConfirmedLive') is True and
            isinstance(value.get('observerPID'),int) and value['observerPID'] not in (record['pid'],record['collectorPID']) and
            isinstance(value.get('observedAt'),(int,float)) and record['startedAt']<=value['observedAt']<=time.time())


def send_observation_ready(command, child, control, record, capture):
    """One explicit retained-Terminal command, never a watcher or human-step timer."""
    expected = ('ready ' + record['startupNonce'] + '\n').encode('ascii')
    if (command != expected or record.get('observationReadySent') or child.poll() is not None or
            any(v.get('kind') in ('native-observation-ready', 'native-picker-readback', 'result') for v in capture.records) or
            not startup_proof(control / 'startup-observed.json', record)):
        raise ValueError('Invalid, early, duplicate or late observation readiness')
    line = ('observation-ready ' + record['startupNonce'] + '\n').encode('ascii')
    if child.poll() is not None:
        raise ValueError('Owned child exited during observation verification')
    if len(line) >= 128 or os.write(child.stdin.fileno(), line) != len(line):
        raise ValueError('Incomplete observation control write')
    record['startupIdentityVerified'] = True
    record['observationReadySent'] = True


def collect_owned(binary, root, control, binding, operator):
    """Future authorized caller must first establish startup identity independently.

    Not reachable from this source-only stage CLI. No timeouts, signals, UI actions,
    retries or output forwarding. Keeps draining after overflow or operator Stop.
    """
    binary, root, control = Path(binary), Path(root), Path(control)
    private(root); private(control)
    if (operator is None or binding.get('launchAuthorized') is not True or binding.get('root') != str(root) or
            binding.get('binary') != str(binary) or not binary.is_relative_to(control) or
            binary.resolve() != binary or not stat.S_ISREG(binary.lstat().st_mode) or
            binary_hash(binary) != binding.get('signedSha256')):
        raise ValueError('Exact startup identity, owned binary and later launch authorization required')
    expected_binding=_expected_binding({key:binding.get(key) for key in BINDING_KEYS})
    receipt = control / 'receipt.json'
    if receipt.exists():
        raise ValueError('Fresh receipt required; never reuse an old receipt')
    record = {**expected_binding,'phase': MODE, 'root': str(root), 'collectorPID': os.getpid(),
              'acceptance': False, 'passed': False, 'classification': 'incomplete', 'nativeExecuted': False}
    atomic_receipt(receipt, record)
    capture = Capture()
    selector=None
    writer=None
    setup_complete=False
    storage_failed=[False]
    stopped=False
    reaped=False
    code=None
    drain_deadline=None
    drain_expired=False
    operator_pending=b''
    child = subprocess.Popen([str(binary), '--standalone-native-acceptance', str(root), MODE],
                             env=environment(root), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
    try:
        record.update(pid=child.pid, startupIdentityVerified=False,
                      startupNonce=str(uuid.uuid4()), startedAt=time.time(),
                      childStart='',collectorStart='',
                      signedSha256=binding['signedSha256'])
        def startup_writer():
            try:
                record['processGroup']=os.getpgid(child.pid)
                record['childStart']=subprocess.check_output(['/bin/ps','-p',str(child.pid),'-o','lstart='],text=True).strip()
                record['collectorStart']=subprocess.check_output(['/bin/ps','-p',str(os.getpid()),'-o','lstart='],text=True).strip()
                if not record['childStart'] or not record['collectorStart']:raise ValueError('Missing start identity')
                atomic_receipt(control / 'startup.json',dict(record))  # Separate incomplete snapshot; cannot overwrite final receipt.
            except Exception:
                storage_failed[0]=True
        writer=threading.Thread(target=startup_writer,daemon=True)
        selector = selectors.DefaultSelector()
        for stream in ('stdout', 'stderr'):
            selector.register(getattr(child, stream), selectors.EVENT_READ, stream)
        selector.register(operator, selectors.EVENT_READ, 'operator')
        os.set_blocking(child.stdin.fileno(), False)
        writer.start()
        setup_complete=True
        while any(k.data != 'operator' for k in selector.get_map().values()) or not reaped:
            # Always poll, even while reader handles remain registered.
            observed=child.poll()
            if observed is not None and not reaped:
                code=child.wait()
                reaped=True
                drain_deadline=time.monotonic()+2.0
            if reaped and any(k.data != 'operator' for k in selector.get_map().values()) and time.monotonic()>=drain_deadline:
                drain_expired=True
                for key in list(selector.get_map().values()):
                    if key.data!='operator':
                        selector.unregister(key.fileobj)
                        key.fileobj.close()  # Owned reader only. NOT a genuine EOF; do not finish Capture.
                break
            for key, _ in selector.select(.1):
                try:
                    data = os.read(key.fileobj.fileno(), 8192)
                except OSError:
                    capture.truncated=True
                    record.setdefault('readErrors',[]).append(key.data)
                    selector.unregister(key.fileobj)
                    if key.data!='operator':key.fileobj.close()
                    else:stopped=True
                    continue  # No bytes and no genuine EOF were observed.
                if key.data == 'operator':
                    # Human steps remain unbounded. Only this explicit command can unlock them.
                    if not data:
                        selector.unregister(key.fileobj)
                        stopped=True
                    elif not stopped:
                        operator_pending += data
                        if len(operator_pending) >= 128:
                            stopped=True
                        elif b'\n' in operator_pending:
                            try:
                                send_observation_ready(operator_pending, child, control, record, capture)
                                operator_pending=b''
                            except (OSError, ValueError, KeyError):
                                stopped=True
                    if stopped:
                        try:
                            os.write(child.stdin.fileno(), b'abort\n')
                        except (BrokenPipeError, BlockingIOError):
                            pass
                elif data:
                    capture.feed(key.data, data)
                else:
                    selector.unregister(key.fileobj)
                    capture.finish(key.data)
            # Overflow does not signal or close the UI; human Stop remains required.
        record.update(missingEOFStreams=sorted({'stdout','stderr'}-capture.eof),postExitDrainExpired=drain_expired)
        writer.join(2)  # Storage wait only AFTER both EOFs/reap; never a human/UI deadline.
        if writer.is_alive():
            storage_failed[0]=True
        try:
            record['startupIdentityVerified']=record.get('observationReadySent') is True and startup_proof(control / 'startup-observed.json',record)
        except (OSError,ValueError):
            record['startupIdentityVerified']=False
        record['storageFailure']=storage_failed[0]
        return finalize(receipt, record, capture, code, reaped, stopped or storage_failed[0] or drain_expired,expected_binding=expected_binding)
    except Exception as error:
        if setup_complete:
            raise
        record.update(pid=child.pid,signedSha256=binding['signedSha256'],startupIdentityVerified=False,
                      setupFailure=type(error).__name__,missingEOFStreams=sorted({'stdout','stderr'}-capture.eof),
                      postExitDrainExpired=False)
        try:
            observed=child.poll()
            if observed is not None:
                code=child.wait();reaped=True
        except Exception:
            record['exitObservationFailed']=True
        return finalize(receipt,record,capture,code,reaped,False,expected_binding=expected_binding)
    finally:
        try:
            if selector is not None:selector.close()
        finally:
            for stream in (child.stdin, child.stdout, child.stderr):
                try:stream.close()
                except OSError:pass



def stage_only(source):
    source = Path(source).resolve()
    if source != Path(__file__).resolve().parents[5]:
        raise ValueError('Stage only this exact source checkout')
    identity = str(uuid.uuid4())
    root = Path('/private/tmp') / ('heinlein-native-standalone-' + identity)
    control = Path('/private/tmp') / ('heinlein18-manual-control-' + identity)
    root.mkdir(mode=0o700); control.mkdir(mode=0o700)
    root_id = private(root); private(control)
    files = sorted((source / 'studio/macos/tests/native-standalone-probe/manual').glob('*'))
    files += [source / 'studio/src-tauri/src' / name for name in ('standalone.rs', 'standalone_native_acceptance.rs', 'standalone_picker_acceptance.rs','main.rs')]
    files += [source / 'studio/src-tauri/src/standalone_picker_acceptance/manual_contract.rs']
    files += sorted((source / 'studio/macos/tests/native-standalone-probe/manual/dist').rglob('*'))
    files += [source / name for name in ('studio/Cargo.lock','studio/src-tauri/Cargo.toml','studio/src-tauri/build.rs','studio/src-tauri/tauri.conf.json')]
    hashes = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}
    value = {'schema': 1, 'phase': MODE, 'runId':identity,'receiptNonce':str(uuid.uuid4()),'officialReceiptReader':'read_final_receipt(control, independent_expected_binding, independent_control_identity)',
             'source': str(source), 'sourceHEAD':subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip(),
             'sourceBaseTree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=source,text=True).strip(),
             'trackedDiffSha256':hashlib.sha256(subprocess.check_output(['git','diff','--binary','HEAD'],cwd=source)).hexdigest(), 'identity': identity,
             'identifier': 'me.thearcades.heinlein.synthetic-standalone-' + identity.replace('-', ''),
             'root': str(root), 'control': str(control), 'controlIdentity':list(private(control)), 'rootIdentity': list(root_id), 'rootEmpty': not any(root.iterdir()),
             'sourceAssetConfigHashes': hashes, 'rawSha256': None, 'signedSha256': None,
             'nativeExecuted': False, 'acceptance': False, 'launchReady': False,
             'missing': ['fresh raw/signed binary and signature receipt', 'later exact startup identity/survival gate'],
             'HOMEChanged': False, 'automatedActions': 0, 'humanDeadline': None,
             'collectorBounds': {'bytesPerStream': MAX_STREAM, 'lineBytes': MAX_LINE, 'linesPerStream': MAX_LINES, 'receiptBytes': MAX_RECEIPT}}
    return atomic_receipt(control / 'stage.json', value)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['stage-only'])
    parser.add_argument('--source', type=Path, required=True)
    args = parser.parse_args()
    value = stage_only(args.source)
    print(json.dumps({'stage': value['control'] + '/stage.json', 'launchReady': False, 'nativeExecuted': False}))
