// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import {syntheticDraftBridge} from '../tests/standaloneBridge';
import {syntheticProjects} from '../tests/projectBridge';
let app:ReturnType<typeof mountStudio>|undefined;
beforeEach(()=>{localStorage.clear();document.body.replaceChildren();Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();});
afterEach(()=>{app?.destroy();app=undefined;document.body.replaceChildren();});
async function settle(){for(let i=0;i<50;i++)await Promise.resolve();}
async function setup(){const bridge=syntheticDraftBridge();const root=document.createElement('div');document.body.append(root);app=mountStudio(root,bridge.core);await settle();return bridge;}
const content=()=>document.querySelector<HTMLElement>('.cm-content')!;
const view=()=>EditorView.findFromDOM(content())!;
function type(text:string){view().dispatch({changes:{from:view().state.doc.length,insert:text}});}
function shortcut(options:KeyboardEventInit={metaKey:true}){const event=new KeyboardEvent('keydown',{key:'n',bubbles:true,cancelable:true,...options});content().dispatchEvent(event);return event;}
describe('new Markdown draft shortcut',()=>{
  it.each(['metaKey','ctrlKey'] as const)('%s+N keeps current text then focuses a blank draft without a destination',async modifier=>{
    const bridge=await setup();type('Keep — café 🦊\n');
    const event=shortcut({[modifier]:true});await settle();
    expect(event.defaultPrevented).toBe(true);expect([...bridge.records.values()][0].text).toBe('Keep — café 🦊\n');
    expect(view().state.doc.toString()).toBe('');expect(document.activeElement).toBe(content());expect(bridge.externalCalls).toEqual([]);
  });
  it('keeps visible writing after a save failure and permits retry',async()=>{
    const bridge=await setup();type('Never lose this');bridge.failNextSave();shortcut();await settle();
    expect(view().state.doc.toString()).toBe('Never lose this');expect(document.body.textContent).toContain('Not kept yet');
    shortcut();await settle();expect(view().state.doc.toString()).toBe('');expect([...bridge.records.values()][0].text).toBe('Never lose this');
  });
  it('waits for a pending save acknowledgment before replacing the editor',async()=>{
    const bridge=await setup();const action=document.querySelector<HTMLButtonElement>('button[aria-keyshortcuts*="Meta+N"]')!;const clicks=vi.fn();action.addEventListener('click',clicks);type('Pending draft');let resume!:()=>void;bridge.holdNextSave(r=>resume=r);shortcut();await settle();
    expect(view().state.doc.toString()).toBe('Pending draft');expect(action.disabled).toBe(true);shortcut();await settle();expect(clicks).toHaveBeenCalledOnce();resume();await settle();expect(view().state.doc.toString()).toBe('');expect(action.disabled).toBe(false);
  });
  it('does not start a draft for modified, repeated, composing or modal key events',async()=>{
    const bridge=await setup();type('Unchanged');
    for(const options of [{metaKey:false},{metaKey:true,shiftKey:true},{metaKey:true,altKey:true},{metaKey:true,repeat:true},{metaKey:true,isComposing:true}])shortcut(options);
    const dialog=document.createElement('dialog');dialog.setAttribute('open','');document.body.append(dialog);shortcut();await settle();
    expect(view().state.doc.toString()).toBe('Unchanged');expect(bridge.calls.filter(c=>c.kind==='create')).toHaveLength(0);
  });
  it('exposes the shortcut on its button and in the keyboard sheet',async()=>{
    await setup();const button=document.querySelector('button[aria-keyshortcuts*="Meta+N"]')!;
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Meta+N Control+N');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'/',metaKey:true,bubbles:true}));
    expect(document.querySelector('.help-sheet')?.textContent).toContain('New scene in project / new standalone draft');
  });
});

async function project(fail=false){
  const bridge=await setup();
  bridge.core.stageRecovery=async(_id,path,baseHash,text)=>({id:'recovery',path,baseHash,text,updatedAt:1});
  bridge.core.discardRecovery=async()=>{};
  const save=vi.fn(async(_id:string,path:string,_hash:string,text:string)=>{if(fail)throw Error('Synthetic save failed');return {path,text,contentHash:'saved',sizeBytes:text.length,frontmatter:null,generatedCompatibility:false};});
  bridge.core.saveDocument=save;
  await app!.selectRepository(async()=>({id:'project',name:'Synthetic project',manifests:[]}));
  await app!.showDocument('scene.md');await settle();type(' — latest');
  return {bridge,save,text:view().state.doc.toString()};
}
function pressButton(label:string){[...document.querySelectorAll('button')].find(b=>b.textContent===label)!.click();}
describe('explicit New draft preserves project departure authority',()=>{
  it('cancel keeps current unsaved project text',async()=>{
    const x=await project();pressButton('New draft');await settle();pressButton('Keep editing');await settle();
    expect(view().state.doc.toString()).toBe(x.text);expect(document.querySelector('.standalone-page')).toBeNull();expect(x.save).not.toHaveBeenCalled();
  });
  it('explicit Save and continue keeps project text before blank draft',async()=>{
    const x=await project();pressButton('New draft');await settle();pressButton('Save and continue');await settle();
    expect(x.save).toHaveBeenCalledWith('project','scene.md','synthetic',x.text);expect(document.querySelector('.standalone-page')).not.toBeNull();expect(view().state.doc.toString()).toBe('');expect(document.activeElement).toBe(content());expect(x.bridge.externalCalls).toEqual([]);
  });
  it('failed project save keeps its visible writing and prevents switching',async()=>{
    const x=await project(true);pressButton('New draft');await settle();pressButton('Save and continue');await settle();
    expect(view().state.doc.toString()).toBe(x.text);expect(document.querySelector('.standalone-page')).toBeNull();expect(x.save).toHaveBeenCalledOnce();expect(x.bridge.records.size).toBe(0);
  });
});

// Deliberately separate close() from delivery of the native queued close event.
// This controls the race instead of relying on browser scheduling luck.
describe('deferred Appearance close focus ownership',()=>{
  let originalShow:PropertyDescriptor|undefined, originalClose:PropertyDescriptor|undefined;
  beforeEach(()=>{
    originalShow=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal');originalClose=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close');
    Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}});
    Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');}});
  });
  afterEach(()=>{
    for(const [name,descriptor] of [['showModal',originalShow],['close',originalClose]] as const){if(descriptor)Object.defineProperty(HTMLDialogElement.prototype,name,descriptor);else Reflect.deleteProperty(HTMLDialogElement.prototype,name);}
  });
  async function open(){document.querySelector<HTMLButtonElement>('button.appearance')!.click();await settle();return document.querySelector<HTMLDialogElement>('dialog.appearance-dialog')!;}
  const deliver=(dialog:HTMLDialogElement)=>dialog.dispatchEvent(new Event('close'));
  it.each(['','Already kept — café 🦊'])('does not steal a newly mounted blank editor after %j',async text=>{
    const bridge=await setup();
    if(text){type(text);pressButton('Keep on this Mac');await settle();}
    const dialog=await open();dialog.close();shortcut();await settle();
    expect(view().state.doc.toString()).toBe('');expect(document.activeElement).toBe(content());
    deliver(dialog);expect(document.activeElement).toBe(content());
    expect([...bridge.records.values()].map(d=>d.text)).toEqual(text?[text]:[]);
  });
  it('preserves editor focus and text while departure waits for a real save result',async()=>{
    const bridge=await setup();type('Save pending — 🦊');let resume!:()=>void;bridge.holdNextSave(r=>resume=r);
    const dialog=await open();dialog.close();content().focus();shortcut();await settle();
    deliver(dialog);expect(view().state.doc.toString()).toBe('Save pending — 🦊');expect(document.activeElement).toBe(content());
    resume();await settle();expect(view().state.doc.toString()).toBe('');expect(document.activeElement).toBe(content());expect([...bridge.records.values()][0].text).toBe('Save pending — 🦊');
  });
  it('ignores an old close after Appearance is reopened',async()=>{
    await setup();const dialog=await open();dialog.close();await open();const focused=document.activeElement;
    deliver(dialog);expect(dialog.open).toBe(true);expect(document.activeElement).toBe(focused);
    dialog.close();deliver(dialog);expect(document.activeElement).toBe(document.querySelector('button.appearance'));
  });
  it('restores ordinary close focus but never overrides a purposeful outside control',async()=>{
    await setup();const dialog=await open();dialog.close();deliver(dialog);expect(document.activeElement).toBe(document.querySelector('button.appearance'));
    await open();dialog.close();const outside=document.createElement('input');document.body.append(outside);outside.focus();deliver(dialog);expect(document.activeElement).toBe(outside);
  });
});


describe('contextual project New refuses stale asynchronous work', () => {
  async function initializedProject() {
    const fixture = syntheticProjects(); fixture.seedMovement();
    const root = document.createElement('div'); document.body.append(root);
    app = mountStudio(root, fixture.core); await settle();
    await app.selectRepository(() => fixture.core.pickRepository());
    await app.showDocument('ms/arrival.md'); await settle(); content().focus();
    return fixture;
  }
  it('does not open Add scene from old state after a failed manuscript reload', async () => {
    const fixture = await initializedProject();
    fixture.core.loadDrafting = vi.fn(async () => { throw Error('Synthetic reload refused'); });
    shortcut(); await settle();
    expect(document.querySelector('.drafting-dialog')).toBeNull();
    expect(view().state.doc.toString()).toContain('Arrival');
    expect(document.body.textContent).toContain('Synthetic reload refused');
    expect(fixture.draftingCalls).toEqual([]); expect(fixture.draft.calls.filter(c => c.kind === 'create')).toEqual([]);
  });
  it('coalesces repeated requests and drops a delayed response after document navigation', async () => {
    const fixture = await initializedProject(); const load = fixture.core.loadDrafting!;
    let finish!: () => void;
    fixture.core.loadDrafting = vi.fn(id => new Promise<Awaited<ReturnType<typeof load>>>(resolve => { void load(id).then(state => { finish = () => resolve(state); }); }));
    shortcut(); shortcut(); await settle();
    expect(fixture.core.loadDrafting).toHaveBeenCalledOnce();
    await app!.showDocument('ms/meeting.md'); await settle(); content().focus();
    finish(); await settle();
    expect(document.querySelector('.drafting-dialog')).toBeNull();
    expect(view().state.doc.toString()).toContain('Meeting'); expect(document.activeElement).toBe(content());
    expect(fixture.draftingCalls).toEqual([]); expect(fixture.draft.calls.filter(c => c.kind === 'create')).toEqual([]);
  });
});
