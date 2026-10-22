// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createUpdatePanel} from './updatePanel';
import type {LocalCore} from './localCore';
beforeEach(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open')};});
afterEach(()=>document.body.replaceChildren());
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(){const request=vi.fn(async()=>({state:'available',commit:'a'.repeat(40),availableCommit:'b'.repeat(40)}));const quit=vi.fn(async()=>{});const panel=createUpdatePanel({updateRequest:request}as unknown as LocalCore,{quit});document.body.append(panel.element);const click=async(name:string)=>{[...panel.element.querySelectorAll('button')].find(b=>b.textContent===name)!.click();await tick()};return{request,quit,panel,click};}
it('check and schedule are explicit; only author-selected guarded quit leaves writing',async()=>{
 const f=fixture();await f.panel.open();expect(f.request).toHaveBeenCalledWith('status');expect(f.quit).not.toHaveBeenCalled();await f.click('Check for updates');expect(f.request).toHaveBeenLastCalledWith('check');
 f.request.mockResolvedValueOnce({state:'scheduled',commit:'a'.repeat(40),availableCommit:'b'.repeat(40)});await f.click('Update on next launch');expect(f.request).toHaveBeenLastCalledWith('schedule');expect(f.quit).not.toHaveBeenCalled();
 await f.click('Save and quit when ready');expect(f.quit).toHaveBeenCalledOnce();
});
it('closing and reopening during a delayed check rejects stale results and restores focus',async()=>{
 const opener=document.createElement('button');document.body.append(opener);opener.focus();const f=fixture();await f.panel.open();let resolve!:(v:any)=>void;f.request.mockImplementationOnce(()=>new Promise(r=>resolve=r));await f.click('Check for updates');f.panel.element.dispatchEvent(new Event('cancel',{cancelable:true}));expect(document.activeElement).toBe(opener);
 const reopened=f.panel.open();resolve({state:'scheduled'});await reopened;expect(f.panel.element.textContent).toContain('newer main-source');expect([...f.panel.element.querySelectorAll('button')].find(b=>b.textContent==='Save and quit when ready')!.hidden).toBe(true);expect(f.quit).not.toHaveBeenCalled();
});
it('unavailable and failed checks never trigger scheduling or quit',async()=>{
 const f=fixture();f.request.mockResolvedValueOnce({state:'unavailable'} as any);await f.panel.open();expect([...f.panel.element.querySelectorAll('button')].find(b=>b.textContent==='Check for updates')!.disabled).toBe(true);
 f.request.mockRejectedValueOnce(new Error('synthetic private provider output'));await f.panel.open();expect(f.panel.element.textContent).not.toContain('synthetic private');expect(f.quit).not.toHaveBeenCalled();
});
