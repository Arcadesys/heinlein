// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {Transaction} from '@codemirror/state';
import {mountStudio} from './studio';
import {sheetDeletionModel} from '../tests/sheetDeletionModel';
let app:ReturnType<typeof mountStudio>|undefined;
const view=()=>EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
function button(label:string,scope:ParentNode=document){return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!;}
function rowDelete(title:string){const menu=document.querySelector(`summary[aria-label="Actions for ${title}"]`)!.parentElement as HTMLDetailsElement;menu.open=true;menu.dispatchEvent(new Event('toggle'));button('Delete sheet…',document.querySelector(`.row-menu-items[aria-label="Actions for ${title}"]`)!).click();}
function projectAction(label:string){const menu=document.querySelector('details.project-menu') as HTMLDetailsElement;menu.open=true;menu.dispatchEvent(new Event('toggle'));button(label,document.querySelector('.row-menu-items[aria-label="Project actions"]')!).click();}
async function start(){const model=sheetDeletionModel();app=mountStudio(document.body,model.core);await app.selectRepository(async()=>model.session);await app.showDocument('ms/first.md');return model;}
async function preview(title='First sheet'){rowDelete(title);await vi.waitFor(()=>expect(document.querySelector('dialog[aria-label="Delete sheet?"]')).not.toBeNull());}
beforeEach(()=>{localStorage.clear();document.body.replaceChildren();Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();});
afterEach(()=>{app?.destroy();app=undefined;});

it('requires explicit deletion, focuses Cancel, and restores the sheet row on cancellation',async()=>{
 const model=await start();const original=model.files.get('ms/first.md');await preview();
 expect(document.activeElement?.textContent).toBe('Cancel');expect(document.querySelector('dialog[aria-label="Delete sheet?"]')?.textContent).toContain('ms/first.md');expect(model.calls.apply).toBe(0);
 button('Cancel',document.querySelector('dialog[aria-label="Delete sheet?"]')!).click();await vi.waitFor(()=>expect(document.activeElement?.textContent).toBe('First sheet'));
 expect(model.files.get('ms/first.md')).toBe(original);expect(model.calls.apply).toBe(0);
});
it('saves dirty writing before preview, clears a deleted active writer, and restores exact text through Undo',async()=>{
 const model=await start();view().dispatch({changes:{from:view().state.doc.length,insert:' New—writing.'},annotations:Transaction.userEvent.of('input.type')});
 await preview();expect(model.calls.save).toBe(1);const saved=model.files.get('ms/first.md');
 const apply=button('Delete sheet',document.querySelector('dialog[aria-label="Delete sheet?"]')!);apply.click();apply.click();
 await vi.waitFor(()=>expect(document.querySelector('.cm-editor')).toBeNull());expect(model.calls.apply).toBe(1);expect(model.files.has('ms/first.md')).toBe(false);
 expect(document.querySelector('[data-path="ms/first.md"].scene-open')).toBeNull();expect(document.activeElement?.textContent).toBe('Second sheet');
 projectAction('Undo last change');await vi.waitFor(()=>expect(document.querySelector('dialog[aria-label="Review manuscript change"]')).not.toBeNull());button('Apply change',document.querySelector('dialog[aria-label="Review manuscript change"]')!).click();
 await vi.waitFor(()=>expect(model.files.get('ms/first.md')).toBe(saved));expect(model.calls.undo).toBe(1);
 await app!.showDocument('ms/first.md');expect(view().state.doc.toString()).toBe(saved!.replace(/\r\n/g,'\n'));
});
it('deleting another sheet preserves the active editor instance, text and cursor',async()=>{
 const model=await start();const active=view();active.dispatch({selection:{anchor:5}});const text=active.state.doc.toString();
 await preview('Second sheet');button('Delete sheet',document.querySelector('dialog[aria-label="Delete sheet?"]')!).click();
 await vi.waitFor(()=>expect(model.calls.apply).toBe(1));await vi.waitFor(()=>expect(document.activeElement?.textContent).toBe('First sheet'));
 expect(view()).toBe(active);expect(active.state.doc.toString()).toBe(text);expect(active.state.selection.main.head).toBe(5);expect(model.files.has('ms/second.md')).toBe(false);
});
it('deletes discovered reference sheets through the same guarded confirmation',async()=>{
 const model=await start();await preview('Outline');button('Delete sheet',document.querySelector('dialog[aria-label="Delete sheet?"]')!).click();
 await vi.waitFor(()=>expect(model.files.has('ms/reference/outline.md')).toBe(false));expect(model.files.size).toBe(2);expect(view().state.doc.toString()).toContain('Exact first sheet.');
});
it('a save failure preserves the active writer and file',async()=>{
 const model=await start();const active=view();active.dispatch({changes:{from:active.state.doc.length,insert:' Unsaved'},annotations:Transaction.userEvent.of('input.type')});
 vi.spyOn(model.core,'saveDocument').mockRejectedValueOnce(Error('Synthetic disk full'));rowDelete('First sheet');
 await vi.waitFor(()=>expect(document.body.textContent).toContain('Synthetic disk full'));expect(model.calls.preview).toBe(0);expect(view()).toBe(active);expect(active.state.doc.toString()).toContain('Unsaved');
});
it('a failed apply leaves the sheet available and never clears its writer',async()=>{
 const model=await start();const active=view();model.core.applyDraftingChange=vi.fn(async()=>{throw Error('Synthetic stale preview');});await preview();button('Delete sheet',document.querySelector('dialog[aria-label="Delete sheet?"]')!).click();
 await vi.waitFor(()=>expect(document.body.textContent).toContain('Synthetic stale preview'));expect(view()).toBe(active);expect(model.files.has('ms/first.md')).toBe(true);expect(document.activeElement?.textContent).toBe('First sheet');
});
