// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {createAck,createDiagnostics,validateDurable,validateRequest,seed,addition,expected,expectedHash} from './ack';
import {createEditor} from '../../../src/editor';
const saved={id:'synthetic',text:expected,textHash:expectedHash,revision:2};
const validate=(value:typeof saved)=>validateDurable(value,'synthetic',1);
describe('fixture acknowledgment authority',()=>{
  it.each(['close-first','durable-first'])('%s releases genuine result only after both gates',async order=>{
    const events:string[]=[];const a=createAck<typeof saved>(name=>{events.push(name);});const callback=vi.fn();
    if(order==='close-first'){a.close(callback);expect(a.released).toBe(false);a.durable(saved,validate);}
    else{a.durable(saved,validate);expect(a.released).toBe(false);a.close(callback);}
    expect(await a.wait()).toBe(saved);expect(callback).toHaveBeenCalledTimes(1);expect(events.filter(x=>x==='ack-release')).toHaveLength(1);
  });
  it('retains close before waiter subscription',async()=>{const a=createAck(()=>{});a.close(()=>{});a.durable(saved,validate);expect(await a.wait()).toBe(saved);});
  it('fails on genuine save rejection and never releases late success',async()=>{const a=createAck(()=>{});a.close(()=>{});a.fail('save rejected');a.durable(saved,validate);await expect(a.wait()).rejects.toThrow();expect(a.released).toBe(false);});
  it.each([{...saved,text:seed+addition},{...saved,revision:1},{...saved,textHash:'wrong'},{...saved,id:'other'}])('rejects wrong durable text/revision/hash/identity',async value=>{const a=createAck(()=>{});a.close(()=>{});a.durable(value,validate);await expect(a.wait()).rejects.toThrow();expect(a.released).toBe(false);});
  it('rejects wrong request before IPC',()=>{expect(()=>validateRequest(seed+addition,1)).toThrow();expect(()=>validateRequest(expected,0)).toThrow();expect(()=>validateRequest(expected,2)).toThrow();expect(()=>validateRequest(expected,1,'wrong')).toThrow();});
  it.each(['before','between','after'])('cancellation %s gates is terminal',async where=>{
    const a=createAck(()=>{});if(where==='before')a.fail('cancel');a.close(()=>{});if(where==='between')a.fail('cancel');a.durable(saved,validate);if(where==='after')a.fail('cancel');
    if(where==='after'){expect(await a.wait()).toBe(saved);}else await expect(a.wait()).rejects.toThrow();expect(a.released).toBe(false);
  });
  it.each(['close','durable'])('duplicate %s fails closed',async kind=>{const a=createAck(()=>{});if(kind==='close'){a.close(()=>{});a.close(()=>{});}else{a.durable(saved,validate);a.durable(saved,validate);}await expect(a.wait()).rejects.toThrow();expect(a.released).toBe(false);});
  it('late duplicate after release invalidates acceptance without another release',async()=>{const a=createAck(()=>{});a.close(()=>{});a.durable(saved,validate);expect(await a.wait()).toBe(saved);a.close(()=>{});expect(a.terminal).toBe(true);expect(a.released).toBe(false);});
  it('callback returns while production-style flush awaits held save; no cycle',async()=>{
    const a=createAck<typeof saved>(()=>{});let flushed=false;const ack=a.wait();
    a.close(()=>{void(async()=>{await ack;flushed=true;})();});expect(flushed).toBe(false);a.durable(saved,validate);await ack;expect(flushed).toBe(true);
  });
  it('unresolved diagnostic does not block coordinator; its final barrier fails',async()=>{
    const d=createDiagnostics(()=>new Promise(()=>{}),()=>{});const a=createAck(name=>d.emit(name));a.close(()=>{});a.durable(saved,validate);expect(await a.wait()).toBe(saved);await expect(d.flush(5)).rejects.toThrow('diagnostic-barrier-timeout');
  });
  it('rejected diagnostics cancel acceptance without recursive sends',async()=>{
    let calls=0;let a:ReturnType<typeof createAck<typeof saved>>;
    const d=createDiagnostics(async()=>{calls++;throw Error('denied');},()=>a.fail('diagnostic failure'));
    a=createAck(name=>d.emit(name));a.close(()=>{});a.durable(saved,validate);await Promise.resolve();await Promise.resolve();expect(a.released).toBe(false);await expect(d.flush(5)).rejects.toThrow('diagnostic-barrier-rejected');expect(calls).toBeLessThan(10);
  });
  it('real production editor transaction preserves mixed seed and uses explicit CRLF insertion oracle',()=>{
    const editor=createEditor(document.createElement('div'),seed,()=>{},()=>{});
    editor.view.dispatch({changes:{from:editor.view.state.doc.length,insert:addition}});
    expect(editor.text().slice(0,seed.length)).toBe(seed);expect(editor.text()).toBe(expected);editor.destroy();
  });
});
