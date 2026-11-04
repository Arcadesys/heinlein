// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createConversationRail} from './conversationRail';
let rail:ReturnType<typeof createConversationRail>|undefined;
beforeEach(()=>{document.body.replaceChildren();document.documentElement.style.fontSize='16px';vi.stubGlobal('innerWidth',2048);});
afterEach(()=>{rail?.destroy();rail=undefined;vi.unstubAllGlobals();});
it('opens the initial wide dock when late writer/font layout finally leaves room',()=>{
 const writer=document.createElement('div');let bounds=new DOMRect(0,0,2048,700);writer.getBoundingClientRect=()=>bounds;
 rail=createConversationRail(document.createElement('div'),()=>writer);document.body.append(rail.element);rail.refresh();
 const dock=rail.element.querySelector<HTMLElement>('.conversation-rail-dock')!;expect(dock.hidden).toBe(true);
 bounds=new DOMRect(200,0,900,700);window.dispatchEvent(new Event('resize'));expect(dock.hidden).toBe(false);
 expect(rail.element.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
});
it('preserves an explicit closed choice across later font and viewport measurements',()=>{
 const writer=document.createElement('div');writer.getBoundingClientRect=()=>new DOMRect(200,0,900,700);
 rail=createConversationRail(document.createElement('div'),()=>writer);document.body.append(rail.element);rail.refresh();
 const dock=rail.element.querySelector<HTMLElement>('.conversation-rail-dock')!;expect(dock.hidden).toBe(false);
 [...rail.element.querySelectorAll('button')].find(b=>b.textContent==='Close chats')!.click();
 window.dispatchEvent(new Event('resize'));rail.refresh();expect(dock.hidden).toBe(true);
 rail.element.querySelector<HTMLButtonElement>('.conversation-rail-toggle')!.click();expect(dock.hidden).toBe(false);
});
