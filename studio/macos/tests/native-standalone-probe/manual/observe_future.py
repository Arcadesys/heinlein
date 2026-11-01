"""FUTURE independent observer. Inspect only the two PIDs in this run's startup.json.
Never use before separate native-launch authorization and an independent context.
"""
import argparse
import sys
sys.dont_write_bytecode=True
import ctypes
import json
import os
from pathlib import Path
import subprocess
import time
from future_support import validate_preflight,expected_binding,read_json,load_reviewed,sanitized_environment

def process_path(pid):
    lib=ctypes.CDLL('/usr/lib/libproc.dylib');fn=lib.proc_pidpath
    fn.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32];fn.restype=ctypes.c_int
    buffer=ctypes.create_string_buffer(4096)
    if fn(pid,buffer,len(buffer))<=0:raise ValueError('Owned process identity unavailable')
    return str(Path(os.fsdecode(buffer.value)).resolve())

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preflight',required=True);parser.add_argument('--preflight-sha256',required=True)
    parser.add_argument('--independent-context-confirmed',action='store_true')
    args=parser.parse_args()
    if not args.independent_context_confirmed:raise ValueError('Independent observation after launch-context handoff must be explicit')
    p=validate_preflight(args.preflight,args.preflight_sha256,False);binding=expected_binding(p)
    claim=read_json(Path(p['control']['path'])/'launch.attempt',4096)
    if claim.get('binding')!=binding or claim.get('preflightSha256')!=args.preflight_sha256 or claim.get('operatorOwner')!='explicit-user-owned-terminal':raise ValueError('One-shot operator/run claim mismatch')
    startup=read_json(Path(p['control']['path'])/'startup.json')
    if any(startup.get(k)!=v for k,v in binding.items()):raise ValueError('Startup binding changed')
    if startup.get('collectorPID')!=claim.get('collectorPID'):raise ValueError('Collector does not match one-shot launch owner')
    if startup.get('phase')!='picker-manual-preview' or startup.get('acceptance') is not False:raise ValueError('Unknown startup state')
    for pid_key,start_key,executable in [('pid','childStart',p['binary']),('collectorPID','collectorStart',p['python']['path'])]:
        pid=startup[pid_key]
        if type(pid) is not int or pid<=0 or pid==os.getpid():raise ValueError('Distinct current owned PID required')
        current=subprocess.check_output(['/bin/ps','-p',str(pid),'-o','lstart='],text=True,env=sanitized_environment(p['root']['path'],os.environ)).strip()
        if current!=startup[start_key] or process_path(pid)!=str(Path(executable).resolve()):raise ValueError('PID/start/executable changed; do not widen or retry')
    proof={k:startup[k] for k in ('pid','collectorPID','childStart','collectorStart','startupNonce','signedSha256','root')}
    proof.update(observerPID=os.getpid(),observerConfirmedLive=True,observedAt=time.time())
    reviewed=load_reviewed(p);reviewed.atomic_receipt(Path(p['control']['path'])/'startup-observed.json',proof)
    print(json.dumps({'startupObserved':True,'acceptance':False,'humanStepsMayBeginOnlyUnderCurrentAuthorization':True}))

if __name__=='__main__':main()
