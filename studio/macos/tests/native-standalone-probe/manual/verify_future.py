"""FUTURE official final reader; candidate JSON alone is never authority."""
import argparse
import sys
sys.dont_write_bytecode=True
import json
from future_support import validate_preflight,expected_binding,load_reviewed

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preflight',required=True);parser.add_argument('--preflight-sha256',required=True)
    args=parser.parse_args();p=validate_preflight(args.preflight,args.preflight_sha256,False)
    result=load_reviewed(p).read_final_receipt(p['control']['path'],expected_binding(p),p['control']['identity'])
    print(json.dumps({'verifiedReceipt':result is not None,'acceptance':bool(result and result.get('acceptance')),'receipt':result},indent=2))
    return 0 if result and result.get('acceptance') is True else 73

if __name__=='__main__':raise SystemExit(main())
