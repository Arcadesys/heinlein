import {describe,it,expect} from 'vitest';
import {ManualState,ManualVerification,nativeFailure} from './state';
describe('SIMULATED manual state only',()=>{
 it('requires two human steps before Finish',()=>{const s=new ManualState();s.start();s.open();s.result(null,()=>false);expect(s.phase).toBe('save');s.open();s.result({token:'simulated'},()=>true);s.finish();expect(s.phase).toBe('finishing');});
 it.each(['early','null','duplicate','wrong'])('fails closed for %s',kind=>{const s=new ManualState();s.start();expect(()=>{if(kind==='early')s.finish();else{s.open();if(kind==='duplicate')s.open();else{s.result(kind==='wrong'?{}:null,()=>false);s.open();s.result(null,()=>false);}}}).toThrow();expect(s.phase).toBe('incomplete');});
});

describe('SIMULATED native failure event contract',()=>{
 it('settles and cleans pending verification, ignores late success and stays terminal',async()=>{
  let failures=0;const v=new ManualVerification(()=>failures++);const pending=v.wait('cancel',()=>true);const rejected=expect(pending).rejects.toThrow(nativeFailure);expect(v.waiting).toBe(true);v.fail();await rejected;expect(v.waiting).toBe(false);expect(v.terminal).toBe(true);v.success({stage:'cancel'});v.fail();expect(failures).toBe(1);await expect(v.wait('save',()=>true)).rejects.toThrow(nativeFailure);
 });
 it('valid readback still settles normally',async()=>{const v=new ManualVerification(()=>{throw Error('Unexpected failure');});const pending=v.wait('save',x=>x.exact===true);v.success({stage:'save',exact:true});await pending;expect(v.waiting).toBe(false);expect(v.terminal).toBe(false);});
});
