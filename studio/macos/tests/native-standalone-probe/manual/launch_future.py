"""FUTURE ONLY. Run this pinned script file in an explicitly user-owned Terminal.
Never use a heredoc, redirected stdin, background service or automatic UI action.
"""
import argparse
import json
import sys
import os
sys.dont_write_bytecode=True
from future_support import validate_preflight,make_plan,execute_future,load_reviewed,expected_binding,sanitized_environment

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preflight',required=True)
    parser.add_argument('--preflight-sha256',required=True)
    parser.add_argument('--authorize-native-launch',action='store_true')
    parser.add_argument('--operator-owned-terminal',action='store_true')
    args=parser.parse_args()
    p=validate_preflight(args.preflight,args.preflight_sha256,True)
    plan=make_plan(p,args.authorize_native_launch,args.operator_owned_terminal,sys.stdin.buffer)
    safe=sanitized_environment(plan['root'],os.environ);os.environ.clear();os.environ.update(safe)
    def dispatch(*values):
        reviewed=load_reviewed(p)
        return reviewed.collect_owned(*values)
    execute_future(plan,sys.stdin.buffer,dispatch)
    # Only the official guarded reader can establish final receipt authority.
    reviewed=load_reviewed(p)
    receipt=reviewed.read_final_receipt(p['control']['path'],expected_binding(p),p['control']['identity'])
    print(json.dumps({'verifiedReceipt':receipt is not None,'acceptance':bool(receipt and receipt.get('acceptance'))}))
    return 0 if receipt and receipt.get('acceptance') is True else 73

if __name__=='__main__':raise SystemExit(main())
