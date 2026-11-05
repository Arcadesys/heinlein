// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {Transaction} from '@codemirror/state';
import {mountStudio} from './studio';
import {wordCount} from './writingFeedback';
import {groupDeletionModel} from '../tests/groupDeletionModel';
import {sheetDeletionModel} from '../tests/sheetDeletionModel';
let app:ReturnType<typeof mountStudio>|undefined;
const view=()=>EditorView.findFromDOM(document.querySelector('.active-document-pane .cm-editor') as HTMLElement)!;
const button=(label:string,scope:ParentNode=document)=>[...scope.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!;
const dialog=()=>document.querySelector<HTMLDialogElement>('dialog[aria-label="Word counts"]')!;
const manuscript=()=>dialog().querySelectorAll('dd')[1].textContent;
async function start(){const model=groupDeletionModel();app=mountStudio(document.body,model.core);await app.selectRepository(async()=>model.session);await app.showDocument('ms/first.md');return model;}
const open=()=>button('Word counts').click();const close=()=>dialog().querySelector<HTMLButtonElement>('[aria-label="Close word counts"]')!.click();
beforeEach(()=>{const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key),clear:()=>data.clear()});document.body.replaceChildren();Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();});
afterEach(()=>{app?.destroy();app=undefined;vi.unstubAllGlobals();});
it('updates source and nested manuscript counts without touching the editor, saving, or asking a provider',async()=>{
 const model=await start(),editor=view();const original=editor.state.doc.toString();editor.dispatch({changes:{from:editor.state.doc.length,insert:' extra words'},selection:{anchor:4},annotations:Transaction.userEvent.of('input.type')});editor.focus();
 open();const expected=wordCount(original+' extra words')+wordCount(model.files.get('ms/second.md')!);await vi.waitFor(()=>expect(manuscript()).toBe(`${expected} words`));expect(dialog().querySelector('select')!.value).toBe('target');expect(dialog().querySelectorAll('li:not([hidden])')).toHaveLength(2);expect(dialog().textContent).not.toContain('Synthetic reference notes');
 expect(view()).toBe(editor);expect(model.calls.save).toBe(0);expect(editor.state.selection.main.head).toBe(4);close();expect(editor.hasFocus).toBe(true);expect(editor.state.doc.toString()).toBe(original+' extra words');
 await app!.saveCurrent();await app!.showDocument('ms/second.md');open();expect(manuscript()).toBe(`${expected} words`);expect(dialog().querySelector('select')!.value).toBe('nested');expect(dialog().querySelectorAll('li:not([hidden])')).toHaveLength(1);
});
it('counts unsaved multi-scene chapter edits once and retains exact saved counts after navigation',async()=>{
 const model=await start();await app!.showDocument('__chapter__/target.md',false,()=>true,{number:1,title:'Draft group',path:'',source:'__chapter__/target.md',scenes:[{path:'ms/first.md'},{path:'ms/second.md'}]});const editor=view();
 const from=editor.state.doc.toString().indexOf('Second');editor.dispatch({changes:[{from:0,insert:'new '},{from,insert:'more '}]});
 const expected=wordCount(model.files.get('ms/first.md')!)+wordCount(model.files.get('ms/second.md')!)+2;
 open();await vi.waitFor(()=>expect(manuscript()).toBe(`${expected} words`));expect(dialog().querySelector('select')!.value).toBe('target');expect(dialog().textContent).toContain('Group editor open');close();await app!.saveCurrent();await app!.showDocument('ms/second.md');open();expect(manuscript()).toBe(`${expected} words`);
});
it('updates group membership after deletion and undo while preserving unsaved scene text',async()=>{
 const model=await start();const editor=view();editor.dispatch({changes:{from:0,insert:'unsaved '}});const expected=wordCount(editor.state.doc.toString())+wordCount(model.files.get('ms/second.md')!);
 const menu=document.querySelector('summary[aria-label="Actions for Draft group"]')!.parentElement as HTMLDetailsElement;menu.open=true;menu.dispatchEvent(new Event('toggle'));button('Delete group…',document.querySelector('.row-menu-items[aria-label="Actions for Draft group"]')!).click();await vi.waitFor(()=>expect(document.querySelector('dialog[aria-label="Delete group?"]')).not.toBeNull());button('Delete group',document.querySelector('dialog[aria-label="Delete group?"]')!).click();await vi.waitFor(()=>expect(model.groupCalls.apply).toBe(1));await vi.waitFor(()=>expect(document.querySelector('summary[aria-label="Actions for Draft group"]')).toBeNull());
 open();await vi.waitFor(()=>expect(manuscript()).toBe(`${expected} words`));expect([...dialog().querySelectorAll('option')].some(o=>o.value==='target')).toBe(false);expect(model.calls.save).toBe(0);close();
 const project=document.querySelector('details.project-menu') as HTMLDetailsElement;project.open=true;project.dispatchEvent(new Event('toggle'));button('Undo last change',document.querySelector('.row-menu-items[aria-label="Project actions"]')!).click();await vi.waitFor(()=>expect(document.querySelector('dialog[aria-label="Review manuscript change"]')).not.toBeNull());button('Apply change',document.querySelector('dialog[aria-label="Review manuscript change"]')!).click();await vi.waitFor(()=>expect(document.querySelector('summary[aria-label="Actions for Draft group"]')).not.toBeNull());open();await vi.waitFor(()=>expect(manuscript()).toBe(`${expected} words`));expect(dialog().querySelector('select')!.value).toBe('target');expect(view()).toBe(editor);
});

it('removes a deleted scene from manuscript counts and restores it on Undo',async()=>{
 const model=sheetDeletionModel();app=mountStudio(document.body,model.core);await app.selectRepository(async()=>model.session);await app.showDocument('ms/first.md');
 const menu=document.querySelector('summary[aria-label="Actions for Second sheet"]')!.parentElement as HTMLDetailsElement;menu.open=true;menu.dispatchEvent(new Event('toggle'));button('Delete sheet…',document.querySelector('.row-menu-items[aria-label="Actions for Second sheet"]')!).click();await vi.waitFor(()=>expect(document.querySelector('dialog[aria-label="Delete sheet?"]')).not.toBeNull());button('Delete sheet',document.querySelector('dialog[aria-label="Delete sheet?"]')!).click();await vi.waitFor(()=>expect(model.calls.apply).toBe(1));await vi.waitFor(()=>expect(document.querySelector('summary[aria-label="Actions for Second sheet"]')).toBeNull());open();await vi.waitFor(()=>expect(manuscript()).toBe('5 words'));expect(dialog().querySelectorAll('li')).toHaveLength(1);close();
 const project=document.querySelector('details.project-menu') as HTMLDetailsElement;project.open=true;project.dispatchEvent(new Event('toggle'));button('Undo last change',document.querySelector('.row-menu-items[aria-label="Project actions"]')!).click();await vi.waitFor(()=>expect(document.querySelector('dialog[aria-label="Review manuscript change"]')).not.toBeNull());button('Apply change',document.querySelector('dialog[aria-label="Review manuscript change"]')!).click();await vi.waitFor(()=>expect(model.calls.undo).toBe(1));await vi.waitFor(()=>expect(document.querySelector('summary[aria-label="Actions for Second sheet"]')).not.toBeNull());open();await vi.waitFor(()=>expect(manuscript()).toBe('9 words'));expect(dialog().querySelectorAll('li')).toHaveLength(2);expect(model.calls.save).toBe(0);
});
