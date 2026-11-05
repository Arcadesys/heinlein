// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createWordCountDialog} from './wordCountDialog';
import type {WordCountSnapshot} from './manuscriptWordCounts';
let panel: ReturnType<typeof createWordCountDialog> | undefined;
afterEach(()=>{panel?.destroy();panel=undefined;document.body.replaceChildren();});
const snapshot=():WordCountSnapshot=>({index:{title:'Book',groups:[{id:'g',title:'Group',label:'Part / Group',paths:['one.md','two.md']}],scenes:[{path:'one.md',title:'Untitled scene',groupIds:['g']},{path:'two.md',title:'Untitled scene',groupIds:['g']}]},counts:new Map([['one.md',2],['two.md',3]]),pending:new Set(),current:{path:'one.md',title:'Untitled scene',words:2,included:true},activeGroupId:'g'});
it('shows all three scopes, distinguishes duplicate titles, and labels the current scene',()=>{
 const value=snapshot();panel=createWordCountDialog(()=>value,async()=>{});document.body.append(panel.element);panel.open();
 expect(panel.element.textContent).toContain('unsaved text');expect(panel.element.textContent).toContain('Whole manuscript: Book');expect(panel.element.textContent).toContain('Group: Part / Group · 5 words');
 expect(panel.element.querySelector('select')!.value).toBe('g');expect(panel.element.querySelectorAll('.word-count-path')).toHaveLength(2);expect(panel.element.querySelector('[aria-current=true]')?.textContent).toContain('Current scene');
 expect(panel.element.querySelector('[aria-live], [role=status]')).toBeNull();
});
it('updates count text without replacing focused controls or rows and restores focus on close/cancel',()=>{
 const opener=document.createElement('button');document.body.append(opener);opener.focus();const value=snapshot();panel=createWordCountDialog(()=>value,async()=>{});document.body.append(panel.element);panel.open();
 const select=panel.element.querySelector('select')!;select.focus();const row=panel.element.querySelector('li')!;value.counts=new Map([['one.md',20],['two.md',3]]);panel.update();expect(panel.element.querySelector('li')).toBe(row);expect(document.activeElement).toBe(select);expect(panel.element.textContent).toContain('23 words');
 panel.element.dispatchEvent(new Event('cancel',{cancelable:true}));expect(panel.element.open).toBe(false);expect(document.activeElement).toBe(opener);
 panel.open();panel.element.querySelector<HTMLButtonElement>('[aria-label="Close word counts"]')!.click();expect(document.activeElement).toBe(opener);
});
it('allows a read-only recount and preserves the selected group',async()=>{
 let done!:()=>void;const refresh=vi.fn(()=>new Promise<void>(resolve=>{done=resolve;}));let value=snapshot();panel=createWordCountDialog(()=>value,refresh);document.body.append(panel.element);panel.open();const button=[...panel.element.querySelectorAll('button')].find(b=>b.textContent==='Recount saved scenes')!;button.click();expect(refresh).toHaveBeenCalledOnce();expect(button.disabled).toBe(true);value={...value,index:structuredClone(value.index)};done();await Promise.resolve();await Promise.resolve();expect(button.disabled).toBe(false);expect(panel.element.querySelector('select')!.value).toBe('g');
});

it('ignores a queued close event after reopening the same dialog',()=>{
 const opener=document.createElement('button');document.body.append(opener);opener.focus();panel=createWordCountDialog(snapshot,async()=>{});document.body.append(panel.element);panel.open();panel.element.querySelector<HTMLButtonElement>('[aria-label="Close word counts"]')!.click();panel.open();const heading=panel.element.querySelector('h2');expect(document.activeElement).toBe(heading);panel.element.dispatchEvent(new Event('close'));expect(panel.element.open).toBe(true);expect(document.activeElement).toBe(heading);
});
