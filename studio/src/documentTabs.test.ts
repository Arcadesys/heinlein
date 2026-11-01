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
  expect(tabs.element.querySelector('[aria-label="Close current document: b.md"]')).not.toBeNull();
 });
 it('retains focus on the same Read beside control across a metadata rerender',()=>{
  const tabs=createDocumentTabs({open:async()=>{},close:async()=>{},read:()=>{}});document.body.replaceChildren(tabs.element);tabs.mount({path:'a.md',kind:'source',sceneId:'a'});const read=tabs.element.querySelector<HTMLButtonElement>('[aria-label="Read beside…"]')!;read.focus();tabs.reconcile([{id:'a',path:'a.md'}]);expect(document.activeElement?.getAttribute('aria-label')).toBe('Read beside…');
 });
 it('arrow focus skips unavailable tabs and blocked identities cannot activate',()=>{
  const open=vi.fn(async()=>{});const tabs=createDocumentTabs({open,close:async()=>{},read:()=>{}});document.body.replaceChildren(tabs.element);tabs.mount({path:'removed.md',kind:'source',sceneId:'gone'});tabs.mount({path:'kept.md',kind:'source',sceneId:'kept'});tabs.reconcile([{id:'kept',path:'kept.md'}]);const current=tabs.element.querySelector<HTMLButtonElement>('[aria-selected=true]')!;current.focus();current.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));expect(document.activeElement).toBe(current);tabs.setBlocked(true);void tabs.activate(tabs.items()[1]);expect(open).not.toHaveBeenCalled();
 });
 it('disambiguates visible labels, retains source/assembled identities and reads inactive B without activating it',()=>{
  const open=vi.fn(async()=>{}),read=vi.fn(),close=vi.fn(async()=>{});const tabs=createDocumentTabs({open,close,read});document.body.replaceChildren(tabs.element);const a=tabs.mount({path:'first/opening.md',kind:'source'});const b=tabs.mount({path:'second/opening.md',kind:'source'});const assembled=tabs.mount({path:'first/opening.md',kind:'assembled'});tabs.mount({path:'first/opening.md',kind:'source'});expect(tabs.items()).toHaveLength(3);expect(a.id).not.toBe(assembled.id);expect(tabs.element.textContent).toContain('first/opening.md · Source');expect(tabs.element.textContent).toContain('first/opening.md · Assembled');tabs.element.querySelector<HTMLButtonElement>('[aria-label="Read beside…"]')!.click();const disabled=tabs.element.querySelector<HTMLButtonElement>('[aria-label="Assembled: first/opening.md"]')!;expect(disabled.disabled).toBe(true);expect(tabs.element.textContent).toContain('Assembled documents cannot be a saved-source reference');tabs.element.querySelector<HTMLButtonElement>('[aria-label="Read beside active document: second/opening.md"]')!.click();expect(read).toHaveBeenCalledWith(b);expect(open).not.toHaveBeenCalled();expect(tabs.active()).toBe(a);expect(document.activeElement?.getAttribute('aria-label')).toBe('Read beside…');
 });
 it('invalidates obsolete split cursor positions and preserves unavailable path identity',()=>{
  const tabs=createDocumentTabs({open:async()=>{},close:async()=>{},read:()=>{}});tabs.mount({path:'story.md',kind:'source'});tabs.items()[0].position={hash:'before-split',anchor:40,head:40,scrollTop:100};tabs.invalidate('story.md');expect(tabs.items()[0].position).toBeUndefined();tabs.register({path:'suffix.md',kind:'source'});tabs.invalidate('suffix.md',true);expect(tabs.items().map(t=>({path:t.path,sceneId:t.sceneId,unavailable:t.unavailable}))).toEqual([{path:'story.md',sceneId:undefined,unavailable:undefined},{path:'suffix.md',sceneId:undefined,unavailable:true}]);
 });
 it('reconciles by verified scene ID without treating split as rename and retains removed identity visibly',()=>{
  const tabs=createDocumentTabs({open:async()=>{},close:async()=>{},read:()=>{}});tabs.mount({path:'old.md',kind:'source',sceneId:'original'});
  tabs.reconcile([{id:'original',path:'old.md'},{id:'suffix',path:'new.md'}]);expect(tabs.active()?.path).toBe('old.md');
  tabs.reconcile([{id:'original',path:'moved.md'}]);expect(tabs.active()?.path).toBe('moved.md');tabs.reconcile([]);expect(tabs.active()?.unavailable).toBe(true);
  tabs.clear();expect(tabs.items()).toHaveLength(0);expect(tabs.active()).toBeUndefined();
 });
});
