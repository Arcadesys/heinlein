#!/usr/bin/env python3
"""Exercise a built Studio binary's headless MCP entry using synthetic data only.

Usage: python3 studio/macos/tests/mcp-project-probe.py /absolute/path/to/target/release/heinlein-studio
Does not launch the GUI, use a real profile, configure Codex, or access Keychain.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import tempfile
import time
import uuid


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary',type=Path)
    binary=parser.parse_args().binary.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='heinlein-mcp-project-') as temporary:
        base=Path(temporary).resolve();root=base/'synthetic project';root.mkdir()
        source=root/'scene.md';original='Exact — e\u0301 🦊\r\n'.encode();source.write_bytes(original)
        selection=base/'selection';selection.mkdir(mode=0o700)
        process=subprocess.Popen([str(binary),'--heinlein-mcp',str(selection)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
        pending=b'';serial=0
        def request(method,params,expected_error=None):
            nonlocal serial,pending
            serial+=1;identifier=serial
            payload={'jsonrpc':'2.0','id':identifier,'method':method,'params':params}
            process.stdin.write((json.dumps(payload)+'\n').encode());process.stdin.flush()
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                while b'\n' in pending:
                    line,pending=pending.split(b'\n',1)
                    message=json.loads(line)
                    if message.get('id')==identifier:
                        if 'error' in message: raise AssertionError('Unexpected MCP protocol error')
                        return message['result']
                if not select.select([process.stdout],[],[],max(0,deadline-time.monotonic()))[0]:break
                chunk=os.read(process.stdout.fileno(),65536)
                if not chunk:raise AssertionError('Headless MCP exited before responding')
                pending+=chunk
                if len(pending)>1024*1024:raise AssertionError('Unexpected oversized fixture response')
            raise AssertionError('Headless MCP fixture response timed out')
        def tool(name,args):
            return request('tools/call',{'name':name,'arguments':args})['structuredContent']
        def author_selection(shared):
            metadata=root.stat()
            value={'schemaVersion':2 if shared else 1,'generation':str(uuid.uuid4()),'selection':({'repository':str(root),'scenes':[],'projectWide':True,'proposalStore':str(base/'proposals'),'device':metadata.st_dev,'inode':metadata.st_ino} if shared else None)}
            stage=selection/f'{uuid.uuid4()}.tmp'
            with os.fdopen(os.open(stage,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as handle:
                json.dump(value,handle);handle.flush();os.fsync(handle.fileno())
            stage.replace(selection/'selection-v1.json')
        try:
            request('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'synthetic headless probe','version':'1'}})
            process.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n');process.stdin.flush()
            assert tool('list_projects',{})['projects']==[]
            author_selection(True)
            project=tool('list_projects',{})['projects'][0]['projectId']
            scenes=tool('list_scenes',{'projectId':project})['scenes'];assert [s['path'] for s in scenes]==['scene.md']
            scene=scenes[0]['sceneId'];read=tool('read_scene',{'projectId':project,'sceneId':scene});assert read['text'].encode()==original
            (root/'reference.md').write_text('New saved reference —\n')
            assert len(tool('list_scenes',{'projectId':project})['scenes'])==2
            proposal={'projectId':project,'sceneId':scene,'snapshotId':read['snapshotId'],'baseHash':read['baseHash'],'replacementText':'Suggested only —\r\n'}
            assert tool('propose_scene',proposal)['error']['code']=='readRequired'
            read=tool('read_scene',{'projectId':project,'sceneId':scene});proposal.update(snapshotId=read['snapshotId'],baseHash=read['baseHash'])
            assert tool('propose_scene',proposal)['requiresAuthorReview'] is True
            assert request('tools/call',{'name':'apply_patch','arguments':{}},expected_error=-32601)['errorCode']==-32601
            assert source.read_bytes()==original
            author_selection(False)
            assert tool('list_projects',{})['projects']==[]
            assert tool('read_scene',{'projectId':project,'sceneId':scene})['error']['code']=='noSelection'
            assert source.read_bytes()==original
            process.stdin.close();assert process.wait(timeout=5)==0
        finally:
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGKILL);process.wait()
    print('Headless Studio MCP project probe passed: grant, future sources, stale pins, advisory proposals, denied writes, revoke, exact bytes.')

if __name__=='__main__':main()
