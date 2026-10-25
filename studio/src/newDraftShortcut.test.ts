// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import {syntheticDraftBridge} from '../tests/standaloneBridge';
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
    expect(document.querySelector('.help-sheet')?.textContent).toContain('New Markdown draft');
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
describe('new draft preserves project departure authority',()=>{
  it('cancel keeps current unsaved project text',async()=>{
    const x=await project();shortcut();await settle();pressButton('Keep editing');await settle();
    expect(view().state.doc.toString()).toBe(x.text);expect(document.querySelector('.standalone-page')).toBeNull();expect(x.save).not.toHaveBeenCalled();
  });
  it('explicit Save and continue keeps project text before blank draft',async()=>{
    const x=await project();shortcut();await settle();pressButton('Save and continue');await settle();
    expect(x.save).toHaveBeenCalledWith('project','scene.md','synthetic',x.text);expect(document.querySelector('.standalone-page')).not.toBeNull();expect(view().state.doc.toString()).toBe('');expect(document.activeElement).toBe(content());expect(x.bridge.externalCalls).toEqual([]);
  });
  it('failed project save keeps its visible writing and prevents switching',async()=>{
    const x=await project(true);shortcut();await settle();pressButton('Save and continue');await settle();
    expect(view().state.doc.toString()).toBe(x.text);expect(document.querySelector('.standalone-page')).toBeNull();expect(x.save).toHaveBeenCalledOnce();expect(x.bridge.records.size).toBe(0);
  });
});
