// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import {syntheticProjects} from '../tests/projectBridge';

const apps:ReturnType<typeof mountStudio>[]=[];
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};
beforeEach(()=>{
  Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect=()=>new DOMRect();
  HTMLElement.prototype.scrollIntoView=vi.fn();
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  document.body.replaceChildren(document.createElement('div'));
});
afterEach(()=>{apps.splice(0).forEach(app=>app.destroy());});
function start(f=syntheticProjects()){
  const app=mountStudio(document.body.firstElementChild as HTMLElement,f.core);apps.push(app);return {app,f};
}
function view(){return EditorView.findFromDOM(document.querySelector('.markdown-editor .cm-editor') as HTMLElement)!;}
async function openProject(name:string){
  document.querySelector<HTMLButtonElement>('.project-switcher')!.click();await tick();
  [...document.querySelectorAll<HTMLButtonElement>('.project-library button')].find(b=>b.textContent===`Open ${name}`)!.click();await tick();
}
function restart(x:ReturnType<typeof start>){
  const seed=x.f.state();x.app.destroy();apps.pop();document.body.replaceChildren(document.createElement('div'));
  return start(syntheticProjects(seed));
}

it.each(['Novel A','Novel B'])('native close and relaunch automatically restore %s, file, selection and focus',async name=>{
  const f=syntheticProjects();let close!:()=>void;
  f.core.onCloseRequested=async cb=>{close=cb;return()=>{};};
  const closed=vi.fn(async()=>{});f.core.requestClose=closed;
  let x=start(f);await tick();await openProject(name);await x.app.showDocument('scene.md');
  const bytes=structuredClone(f.documents);
  view().dispatch({selection:{anchor:2,head:5}});close();
  await vi.waitFor(()=>expect(closed).toHaveBeenCalledWith(true));
  x=restart(x);await tick();
  expect(document.querySelector('.pill-project')?.textContent).toBe(name);
  expect(view().state.selection.main.anchor).toBe(2);expect(view().state.selection.main.head).toBe(5);
  expect(view().hasFocus).toBe(true);expect(x.f.documents).toEqual(bytes);expect(x.f.externalCalls).toEqual([]);
  expect(x.f.requests.filter(r=>r.action==='activate')).toHaveLength(1);
});

it('restores Reading mode while preserving the source selection and source scroll',async()=>{
  let x=start();await tick();await openProject('Novel A');await x.app.showDocument('scene.md');
  view().dispatch({selection:{anchor:4}});
  const pane=document.querySelector<HTMLElement>('.active-document-pane')!;
  // jsdom has no layout, so writer scroll falls back to the CodeMirror scroller.
  view().scrollDOM.scrollTop=80;
  [...document.querySelectorAll<HTMLButtonElement>('.md-view-toggle button')].find(b=>b.textContent==='Reading')!.click();
  pane.scrollTop=150;pane.dispatchEvent(new Event('scroll'));
  await vi.waitFor(()=>expect(x.f.projects[0].resume?.readingScrollTop).toBeDefined(),{timeout:1500});
  x=restart(x);await tick();
  expect(document.querySelector('[aria-label="Reading view"]')).toBe(document.activeElement);
  expect(document.querySelector('.md-view-toggle button[aria-pressed="true"]')?.textContent).toBe('Reading');
  expect(view().state.selection.main.anchor).toBe(4);
  [...document.querySelectorAll<HTMLButtonElement>('.md-view-toggle button')].find(b=>b.textContent==='Source')!.click();
  expect(view().scrollDOM.scrollTop).toBe(80);expect(x.f.externalCalls).toEqual([]);
});

it.each(['changed','missing'])('startup opens the project overview when the saved file is %s',async kind=>{
  let x=start();await tick();await openProject('Novel A');await x.app.showDocument('scene.md');
  await openProject('Novel B');await openProject('Novel A');
  if(kind==='changed')x.f.documents['local-a']['scene.md']='External revision — 🦊';else delete x.f.documents['local-a']['scene.md'];
  x=restart(x);await tick();
  expect(document.querySelector('.pill-project')?.textContent).toBe('Novel A');
  expect(document.querySelector('.markdown-editor')).toBeNull();
  expect(document.querySelector('.status')?.textContent).toContain('last document changed');
  expect(x.f.externalCalls).toEqual([]);
});

it('an unavailable last project leaves drafts and the project chooser usable',async()=>{
  let x=start();await tick();await openProject('Novel A');x.f.projects[0].unavailable='Folder missing';
  x=restart(x);await tick();
  expect(document.querySelector('.standalone-editor')).not.toBeNull();
  expect(document.querySelector('.status')?.textContent).toContain('Could not reopen the last project');
  await openProject('Novel B');expect(document.querySelector('.pill-project')?.textContent).toBe('Novel B');
  expect(x.f.externalCalls).toEqual([]);
});

it('a delayed startup lookup cannot replace a new draft',async()=>{
  const f=syntheticProjects(),request=f.core.projectRequest!;let resolve!:(v:{id:string})=>void;
  f.core.projectRequest=async r=>r.action==='lastOpened'?await new Promise(yes=>resolve=yes):request(r);
  start(f);await tick();
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='New draft')!.click();await tick();
  const draft=EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
  draft.dispatch({changes:{from:0,insert:'Keep this new draft — 🦊'}});
  resolve({id:'local-a'});await tick();
  expect(draft.state.doc.toString()).toBe('Keep this new draft — 🦊');
  expect(f.requests.some(r=>r.action==='activate')).toBe(false);expect(f.externalCalls).toEqual([]);
});

it('an immediately requested folder open takes precedence over automatic restoration',async()=>{
  const seed=syntheticProjects().state();seed.lastOpenedProjectId='github-a';
  const x=start(syntheticProjects(seed));
  await x.app.selectRepository(()=>x.f.core.pickRepository());await tick();
  expect(document.querySelector('.pill-project')?.textContent).toBe('Novel A');
  expect(x.f.requests.some(r=>r.action==='previewOpen')).toBe(false);
  expect(document.querySelector('.standalone-editor')).toBeNull();
});

it('closing from standalone writing returns to drafts rather than an older project',async()=>{
  let x=start();await tick();
  const draft=EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
  draft.dispatch({changes:{from:0,insert:'Standalone writing — 🦊'}});
  await openProject('Novel A');await x.app.showDocument('scene.md');
  view().dispatch({selection:{anchor:4}});await openProject('Novel B');
  document.querySelector<HTMLButtonElement>('.project-switcher')!.click();await tick();
  [...document.querySelectorAll<HTMLButtonElement>('.project-library button')].find(b=>b.textContent==='Find standalone drafts')!.click();await tick();
  document.querySelector<HTMLButtonElement>('.draft-list-item button')!.click();await tick();
  x.f.draft.close!();await vi.waitFor(()=>expect(x.f.state().lastOpenedProjectId).toBeNull());
  x=restart(x);await tick();
  expect(document.querySelector('.standalone-editor')).not.toBeNull();
  expect(x.f.projects[0].resume?.anchor).toBe(4);
  expect(x.f.requests.some(r=>r.action==='activate')).toBe(false);expect(x.f.externalCalls).toEqual([]);
});

it('startup recovery remains visible in Source even when the saved view was Reading',async()=>{
  const f=syntheticProjects(),seed=f.state();
  seed.lastOpenedProjectId='local-a';seed.projects[0].resume={path:'scene.md',sourceHash:f.hash(seed.documents['local-a']['scene.md']),sceneId:null,anchor:4,head:4,scrollTop:80,readingScrollTop:150};
  const restored=syntheticProjects(seed);
  restored.core.readRecovery=async(_id,path)=>({id:'recovery',path,baseHash:seed.projects[0].resume!.sourceHash,text:'Unresolved local writing — 🦊',updatedAt:1});
  start(restored);await tick();
  expect(document.querySelector('.md-view-toggle button[aria-pressed="true"]')?.textContent).toBe('Source');
  expect(document.querySelector('.recovery-notice')).not.toBeNull();
  expect(view().state.selection.main.anchor).toBe(0);expect(view().state.readOnly).toBe(true);
  expect(restored.externalCalls).toEqual([]);
});
