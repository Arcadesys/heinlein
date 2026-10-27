// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import {syntheticProjects} from '../tests/projectBridge';
const apps:ReturnType<typeof mountStudio>[]=[];
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setTimeout(r,0));};
beforeEach(()=>{Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();HTMLElement.prototype.scrollIntoView=vi.fn();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'));};document.body.replaceChildren(document.createElement('div'));});
afterEach(()=>{apps.splice(0).forEach(a=>a.destroy());vi.useRealTimers();});
function start(f=syntheticProjects()){const root=document.body.firstElementChild as HTMLElement;const app=mountStudio(root,f.core);apps.push(app);return{f,root,app};}
function button(text:string,scope:ParentNode=document){const b=[...scope.querySelectorAll('button')].find(b=>b.textContent===text);if(!b)throw Error(`Missing ${text}`);return b;}
async function library(){document.querySelector<HTMLButtonElement>('.project-switcher')!.click();await tick();}
async function open(name:string){await library();button(`Open ${name}`,document.querySelector('.project-library')!).click();await tick();}
function view(){return EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;}
const items=()=>[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const item=(text:string)=>items().find(node=>node.textContent?.startsWith(text))!;
async function begin(){const f=syntheticProjects();f.seedMovement();const {app}=start(f);await tick();await open('Novel A');await app.showDocument('ms/meeting.md');await tick();return {f,app};}
it('opens on the Binder and shows the chapter between project and scene',async()=>{
 await begin();
 expect(document.querySelector('#navigation-tab-manuscript')!.getAttribute('aria-selected')).toBe('true');
 expect(document.querySelector('.pill-chapter')!.textContent).toBe('Opening');
 expect(document.querySelector('.pill-scene')!.textContent).toBe('Meeting');
});
it('the Binder tree marks the current scene in text and opens another scene',async()=>{
 await begin();
 const here=document.querySelector<HTMLButtonElement>('.binder-scene[aria-current="true"]')!;
 expect(here.textContent).toContain('Meeting');expect(here.textContent).toContain('You are here');
 document.querySelector<HTMLButtonElement>('.binder-scene:not([aria-current])')!.click();await tick();
 expect(document.querySelector('.pill-scene')!.textContent).toBe('Arrival');
});
it('the Scene menu lists the chapter, moves between scenes and keeps the buffer',async()=>{
 await begin();
 document.querySelector<HTMLButtonElement>('.pill-scene')!.click();
 expect(items().map(node=>node.textContent?.replace(/You are here/,'').trim()).slice(0,2)).toEqual(['Arrival','Meeting']);
 expect(item('Meeting').getAttribute('aria-current')).toBe('true');
 item('Next scene').click();await tick();
 expect(document.querySelector('.pill-scene')!.textContent).toBe('Bridge');expect(document.querySelector('.pill-chapter')!.textContent).toBe('Middle');
});
it('the Chapter menu opens the first scene of the chosen chapter and disables empty ones',async()=>{
 await begin();
 document.querySelector<HTMLButtonElement>('.pill-chapter')!.click();
 expect((item('Empty chapter') as HTMLButtonElement).disabled).toBe(true);
 item('Ending').click();await tick();
 expect(document.querySelector('.pill-scene')!.textContent).toBe('Finale');
});
it('previous and next stop at the ends of the manuscript with a plain message',async()=>{
 const {app}=await begin();await app.showDocument('ms/prelude.md');await tick();
 document.querySelector<HTMLButtonElement>('.pill-scene')!.click();
 expect((item('Previous scene') as HTMLButtonElement).disabled).toBe(true);
});
