// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {createDocumentTabs} from './documentTabs';
describe('document navigation metadata',()=>{
 it('deduplicates mounts, keeps failed activation uncommitted, and retains metadata identities without eviction',async()=>{
  const open=vi.fn(async()=>{});const tabs=createDocumentTabs({open,close:async()=>{},read:()=>{}});
  tabs.mount({path:'a.md',kind:'source',sceneId:'a'});tabs.mount({path:'a.md',kind:'source',sceneId:'a'});
  tabs.mount({path:'b.md',kind:'source'});expect(tabs.items()).toHaveLength(2);
  await tabs.activate(tabs.items()[0]);expect(open).toHaveBeenCalled();expect(tabs.active()?.path).toBe('b.md');
  for(let n=2;n<12;n++)tabs.mount({path:`${n}.md`,kind:'source'});
  tabs.mount({path:'overflow.md',kind:'source'});expect(tabs.items()).toHaveLength(13);expect(tabs.items()[0].path).toBe('a.md');
 });
 it('arrows explore without activation; Enter activates; close controls are separate',()=>{
  const open=vi.fn(async()=>{});const close=vi.fn(async()=>{});const tabs=createDocumentTabs({open,close,read:()=>{}});document.body.replaceChildren(tabs.element);
  tabs.mount({path:'a.md',kind:'source'});tabs.mount({path:'b.md',kind:'source'});
  const controls=tabs.element.querySelectorAll<HTMLButtonElement>('[role=tab]');controls[1].focus();controls[1].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));expect(document.activeElement).toBe(controls[0]);expect(open).not.toHaveBeenCalled();controls[0].click();expect(open).toHaveBeenCalledOnce();
  expect(tabs.element.querySelector('[aria-label="Close document a.md"]')).not.toBeNull();
 });
 it('retains focus on the same Read beside control across a metadata rerender',()=>{
  const tabs=createDocumentTabs({open:async()=>{},close:async()=>{},read:()=>{}});document.body.replaceChildren(tabs.element);tabs.mount({path:'a.md',kind:'source',sceneId:'a'});const read=tabs.element.querySelector<HTMLButtonElement>('[aria-label="Read beside active document: a.md"]')!;read.focus();tabs.reconcile([{id:'a',path:'a.md'}]);expect(document.activeElement?.getAttribute('aria-label')).toBe('Read beside active document: a.md');
 });
 it('arrow focus skips unavailable tabs and blocked identities cannot activate',()=>{
  const open=vi.fn(async()=>{});const tabs=createDocumentTabs({open,close:async()=>{},read:()=>{}});document.body.replaceChildren(tabs.element);tabs.mount({path:'removed.md',kind:'source',sceneId:'gone'});tabs.mount({path:'kept.md',kind:'source',sceneId:'kept'});tabs.reconcile([{id:'kept',path:'kept.md'}]);const current=tabs.element.querySelector<HTMLButtonElement>('[aria-selected=true]')!;current.focus();current.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));expect(document.activeElement).toBe(current);tabs.setBlocked(true);void tabs.activate(tabs.items()[1]);expect(open).not.toHaveBeenCalled();
 });
 it('reconciles by verified scene ID without treating split as rename and retains removed identity visibly',()=>{
  const tabs=createDocumentTabs({open:async()=>{},close:async()=>{},read:()=>{}});tabs.mount({path:'old.md',kind:'source',sceneId:'original'});
  tabs.reconcile([{id:'original',path:'old.md'},{id:'suffix',path:'new.md'}]);expect(tabs.active()?.path).toBe('old.md');
  tabs.reconcile([{id:'original',path:'moved.md'}]);expect(tabs.active()?.path).toBe('moved.md');tabs.reconcile([]);expect(tabs.active()?.unavailable).toBe(true);
  tabs.clear();expect(tabs.items()).toHaveLength(0);expect(tabs.active()).toBeUndefined();
 });
});
