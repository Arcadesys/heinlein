// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createUpdatePanel} from './updatePanel';
import type {UpdateStatus} from './updatePanel';
import type {LocalCore} from './localCore';
beforeEach(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open')};});
afterEach(()=>document.body.replaceChildren());
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(){const request=vi.fn(async():Promise<UpdateStatus>=>({state:'available',commit:'a'.repeat(40),availableCommit:'b'.repeat(40)}));const quit=vi.fn(async()=>{});const panel=createUpdatePanel({updateRequest:request}as unknown as LocalCore,{quit});document.body.append(panel.element,panel.notice);const click=async(name:string)=>{[...panel.element.querySelectorAll('button')].find(b=>b.textContent===name)!.click();await tick()};return{request,quit,panel,click};}
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

it('a refused quit keeps the app open and gives the saved-connection retry action',async()=>{
 const f=fixture();f.request.mockResolvedValueOnce({state:'scheduled'} as any);await f.panel.open();f.quit.mockRejectedValueOnce(new Error('private native detail'));await f.click('Save and quit when ready');
 expect(f.panel.element.hasAttribute('open')).toBe(true);expect(f.panel.element.textContent).toContain('Retry saved GitHub connection');expect(f.panel.element.textContent).not.toContain('private native detail');expect(f.request.mock.calls).toEqual([['status']]);
});

it('background release checks show a notice without opening a dialog or moving focus',async()=>{
 const f=fixture();const writer=document.createElement('textarea');document.body.append(writer);writer.focus();
 f.request.mockResolvedValueOnce({state:'release-not-checked',channel:'release',currentVersion:'1.7.0'}).mockResolvedValueOnce({state:'release-available',channel:'release',currentVersion:'1.7.0',availableVersion:'1.8.0'});
 await f.panel.poll();expect(f.request.mock.calls).toEqual([['status'],['check']]);expect(f.panel.notice.hidden).toBe(false);expect(document.activeElement).toBe(writer);expect(f.panel.element.open).toBe(false);
 f.request.mockResolvedValue({state:'release-available',channel:'release',currentVersion:'1.7.0',availableVersion:'1.8.0'});
 f.panel.notice.querySelector('button')!.click();await tick();expect(f.panel.element.textContent).toContain('Installed 1.7.0');expect(f.panel.element.textContent).toContain('Latest published 1.8.0');
 expect([...f.panel.element.querySelectorAll('button')].find(b=>b.textContent==='Update on next launch')!.hidden).toBe(true);
 await f.click('Open release download page');expect(f.request).toHaveBeenLastCalledWith('openRelease');expect(f.quit).not.toHaveBeenCalled();f.panel.destroy();
});
it('background checks make failures visible and preserve scheduled updates',async()=>{
 const f=fixture();f.request.mockResolvedValueOnce({state:'scheduled'});await f.panel.poll();expect(f.request.mock.calls).toEqual([['status']]);expect(f.panel.notice.textContent).toContain('Update scheduled');await f.panel.poll();expect(f.request).toHaveBeenCalledTimes(1);f.panel.destroy();
 const failed=fixture();failed.request.mockRejectedValue(new Error('private failure'));await failed.panel.poll();expect(failed.panel.notice.hidden).toBe(false);expect(failed.panel.notice.textContent).toContain('needs attention');expect(failed.panel.element.open).toBe(false);failed.panel.destroy();
});
it('automatic checks start once and stop when the studio is destroyed',async()=>{
 vi.useFakeTimers();try{
 const f=fixture();f.panel.startChecking();f.panel.startChecking();await vi.advanceTimersByTimeAsync(5000);expect(f.request.mock.calls).toEqual([['status'],['check']]);f.panel.destroy();await vi.advanceTimersByTimeAsync(60*60*1000);expect(f.request).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers();}
});
