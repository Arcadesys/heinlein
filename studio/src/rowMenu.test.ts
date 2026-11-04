// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {rowMenu} from './rowMenu';

beforeEach(()=>{document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));document.body.replaceChildren();});
afterEach(()=>{document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));vi.restoreAllMocks();});
function setup(){
  const first=document.createElement('button');first.textContent='Export manuscript…';
  const last=document.createElement('button');last.textContent='Other action';
  const menu=rowMenu('Project actions',[first,last]);const host=document.createElement('section');host.append(menu);document.body.append(host);
  const summary=menu.querySelector('summary')!;const list=menu.querySelector<HTMLElement>('.row-menu-items')!;
  let top=50;vi.spyOn(summary,'getBoundingClientRect').mockImplementation(()=>new DOMRect(50,top,20,20));
  Object.defineProperties(list,{offsetWidth:{value:180},offsetHeight:{value:120}});
  return {menu,host,first,last,summary,list,move:(value:number)=>{top=value;},open:()=>{menu.open=true;menu.dispatchEvent(new Event('toggle'));}};
}
it('opening focus does not cause an ancestor scroll to dismiss the popup',()=>{
  const f=setup();const focus=f.first.focus.bind(f.first);
  vi.spyOn(f.first,'focus').mockImplementation(options=>{focus(options);if(!options?.preventScroll)window.dispatchEvent(new Event('scroll'));});
  f.open();expect(f.menu.open).toBe(true);expect(document.activeElement).toBe(f.first);
});
it('follows a visible anchor through delayed programmatic scrolling',()=>{
  const f=setup();f.open();f.move(90);f.host.dispatchEvent(new Event('scroll'));
  expect(f.menu.open).toBe(true);expect(f.list.style.top).toBe('114px');expect(document.activeElement).toBe(f.first);
});
it('keeps scrolling inside the popup available and dismisses deliberate outside scrolling',()=>{
  const f=setup();f.open();f.list.dispatchEvent(new Event('wheel',{bubbles:true}));expect(f.menu.open).toBe(true);
  document.body.dispatchEvent(new Event('wheel',{bubbles:true}));expect(f.menu.open).toBe(false);
});
it('dismisses when scrolling removes the anchor from view',()=>{
  const f=setup();f.open();f.move(-1000);f.host.dispatchEvent(new Event('scroll'));expect(f.menu.open).toBe(false);
});
