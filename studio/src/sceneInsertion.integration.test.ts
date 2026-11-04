// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import {syntheticProjects} from '../tests/projectBridge';

let app:ReturnType<typeof mountStudio>|null=null;
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setTimeout(r,0));};
beforeEach(()=>{
 Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();
 HTMLElement.prototype.scrollIntoView=vi.fn();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'));};
 document.body.replaceChildren(document.createElement('main'));
});
afterEach(()=>{app?.destroy();app=null;});
function button(text:string,root:ParentNode=document){const result=[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text);if(!result)throw Error(`Missing ${text}`);return result;}
async function openProject(name:string){document.querySelector<HTMLButtonElement>('.project-switcher')!.click();await tick();button(`Open ${name}`,document.querySelector('.project-library')!).click();await tick();}
function showTree(){const toggle=document.querySelector<HTMLButtonElement>('.navigation-toggle')!;if(toggle.getAttribute('aria-expanded')!=='true')toggle.click();document.querySelector<HTMLButtonElement>('.files.nav-view:not([hidden]) .nav-back')?.click();}
function action(title:string,label:string){const menu=document.querySelector<HTMLElement>(`summary[aria-label="Actions for ${title}"]`)!.parentElement as HTMLDetailsElement;menu.open=true;menu.dispatchEvent(new Event('toggle'));const b=button(label,document.querySelector(`.row-menu-items[aria-label="Actions for ${title}"]`)!);b.focus();b.click();}
async function setup(legacy=false){
 const f=syntheticProjects();f.seedMovement();const m=f.manuscripts['local-a'];
 if(legacy)delete m.library;
 else {
  m.libraryLegacy=false;m.groups.push({id:'nested',title:'Nested folder'});
  m.scenes.push({id:'nested-scene',title:'Nested source',path:'ms/nested.md',groupId:'nested'});f.documents['local-a']['ms/nested.md']='Nested — source.\r\n';
  const at=m.library!.findIndex(e=>e.id==='scene-arrival');m.library!.splice(at+1,0,{id:'nested',kind:'group',parentId:'group-opening'});
  m.library!.push({id:'nested-scene',kind:'scene',parentId:'nested'});
 }
 app=mountStudio(document.body.firstElementChild as HTMLElement,f.core);await tick();await openProject('Novel A');await app.showDocument('ms/afterword.md');showTree();await tick();return f;
}
it.each([
 {title:'Prelude',after:false,legacy:true},{title:'Afterword',after:true,legacy:true},
 {title:'Arrival',after:false,legacy:false},{title:'Arrival',after:true,legacy:false},
 {title:'Meeting',after:true,legacy:false},{title:'Bridge',after:false,legacy:false},
])('adds a scene relative to $title, after=$after, legacy=$legacy',async({title,after,legacy})=>{
 const f=await setup(legacy);const originals=structuredClone(f.documents['local-a']);const anchor=f.manuscripts['local-a'].scenes.find(s=>s.title===title)!;
 action(title,after?'Add scene below':'Add scene above');
 const input=document.querySelector<HTMLInputElement>('dialog[aria-label="New scene"] input')!;expect(document.activeElement).toBe(input);input.value='Inserted scene';button('Create scene').click();
 await vi.waitFor(()=>expect(f.manuscripts['local-a'].scenes.some(s=>s.title==='Inserted scene')).toBe(true));
 const m=f.manuscripts['local-a'],created=m.scenes.find(s=>s.title==='Inserted scene')!;
 expect(created.groupId).toBe(anchor.groupId);expect(created.reference).toBe(false);expect(f.documents['local-a'][created.path]).toBe('');
 expect(Object.fromEntries(Object.entries(f.documents['local-a']).filter(([path])=>path!==created.path))).toEqual(originals);
 expect(m.scenes.indexOf(created)).toBe(m.scenes.findIndex(s=>s.id===anchor.id)+(after?1:-1));
 if(m.library){const siblings=m.library.filter(e=>e.parentId===anchor.groupId);expect(siblings.findIndex(e=>e.id===created.id)).toBe(siblings.findIndex(e=>e.id===anchor.id)+(after?1:-1));}
 await vi.waitFor(()=>expect(EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!.state.doc.toString()).toBe(''));
 showTree();await tick();const titles=[...document.querySelectorAll('.scene-open')].map(e=>e.textContent);expect(titles.indexOf('Inserted scene')).toBe(titles.indexOf(title)+(after?1:-1));
 expect(f.draftingCalls).toEqual(['preview','apply']);expect(f.externalCalls).toEqual([]);
});
it.each(['Add scene above','Add scene below'])('cancel %s keeps exact data and restores scene focus',async label=>{
 const f=await setup();const before=JSON.stringify(f.state());action('Arrival',label);button('Cancel').click();
 expect(document.querySelector('dialog[aria-label="New scene"]')).toBeNull();expect(document.activeElement?.textContent).toBe('Arrival');
 expect(JSON.stringify(f.state())).toBe(before);expect(f.draftingCalls).toEqual([]);expect(f.externalCalls).toEqual([]);
});
it('refuses a stale manuscript revision without creating a file',async()=>{
 const f=await setup();const before=structuredClone(f.documents);action('Arrival','Add scene below');f.manuscripts['local-a'].revision='external-change';button('Create scene').click();
 await vi.waitFor(()=>expect(f.draftingCalls).toEqual(['preview']));await tick();expect(f.documents).toEqual(before);expect(f.manuscripts['local-a'].scenes.some(s=>s.title==='Untitled scene')).toBe(false);
});
it('a queued submit from a previous project cannot create a scene in either project',async()=>{
 const f=await setup();action('Arrival','Add scene above');const submit=button('Create scene');await openProject('Novel B');const before=structuredClone(f.documents);submit.click();await tick();
 expect(f.documents).toEqual(before);expect(f.draftingCalls).toEqual([]);expect(f.externalCalls).toEqual([]);
});
