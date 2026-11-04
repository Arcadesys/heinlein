// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {Transaction} from '@codemirror/state';
import {mountStudio} from './studio';
import {groupDeletionModel} from '../tests/groupDeletionModel';
let app:ReturnType<typeof mountStudio>|undefined;
const view=()=>EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
const dialog=()=>document.querySelector<HTMLDialogElement>('dialog[aria-label="Delete group?"]')!;
function button(label:string,scope:ParentNode=document){return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!;}
function groupDelete(title='Draft group'){const menu=document.querySelector(`summary[aria-label="Actions for ${title}"]`)!.parentElement as HTMLDetailsElement;menu.open=true;menu.dispatchEvent(new Event('toggle'));button('Delete group…',document.querySelector(`.row-menu-items[aria-label="Actions for ${title}"]`)!).click();}
function projectAction(label:string){const menu=document.querySelector('details.project-menu') as HTMLDetailsElement;menu.open=true;menu.dispatchEvent(new Event('toggle'));button(label,document.querySelector('.row-menu-items[aria-label="Project actions"]')!).click();}
async function start(){const model=groupDeletionModel();app=mountStudio(document.body,model.core);await app.selectRepository(async()=>model.session);await app.showDocument('ms/first.md');return model;}
async function preview(title?:string){groupDelete(title);await vi.waitFor(()=>expect(dialog()).not.toBeNull());}
beforeEach(()=>{localStorage.clear();document.body.replaceChildren();Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();});
afterEach(()=>{app?.destroy();app=undefined;});

it('confirms the group name, explains retained contents, focuses Cancel and restores group focus on cancel',async()=>{
 const model=await start();await preview();expect(dialog().textContent).toContain('Draft group');expect(dialog().textContent).toContain('No sheet files are deleted or moved');expect(document.activeElement?.textContent).toBe('Cancel');expect(model.groupCalls.apply).toBe(0);
 button('Cancel',dialog()).click();await vi.waitFor(()=>expect(document.activeElement?.textContent).toBe('Draft group'));expect(model.groupCalls.apply).toBe(0);
});
it('deletes the group and promotes its sheets and child group without saving or rebuilding a dirty editor; Undo restores it',async()=>{
 const model=await start();const active=view();active.dispatch({changes:{from:active.state.doc.length,insert:' Unsaved—writing.'},selection:{anchor:5},annotations:Transaction.userEvent.of('input.type')});const text=active.state.doc.toString();const files=[...model.files];
 await preview();const confirm=button('Delete group',dialog());confirm.click();confirm.click();
 await vi.waitFor(()=>expect(document.querySelector('summary[aria-label="Actions for Draft group"]')).toBeNull());await vi.waitFor(()=>expect(document.activeElement?.textContent).toBe('First sheet'));
 expect(model.groupCalls.apply).toBe(1);expect(model.calls.save).toBe(0);expect([...model.files]).toEqual(files);expect(view()).toBe(active);expect(active.state.doc.toString()).toBe(text);expect(active.state.selection.main.head).toBe(5);
 expect(document.querySelector('[data-group-id="nested"]')).not.toBeNull();expect(document.querySelector('[aria-label="Outline Reference"]')).not.toBeNull();
 projectAction('Undo last change');await vi.waitFor(()=>expect(document.querySelector('dialog[aria-label="Review manuscript change"]')).not.toBeNull());button('Apply change',document.querySelector('dialog[aria-label="Review manuscript change"]')!).click();
 await vi.waitFor(()=>expect(document.querySelector('summary[aria-label="Actions for Draft group"]')).not.toBeNull());expect(model.groupCalls.undo).toBe(1);expect(view()).toBe(active);expect(active.state.doc.toString()).toBe(text);expect(model.calls.save).toBe(0);
});
it('deletes empty groups through the same confirmation',async()=>{
 const model=await start();await preview('Empty group');button('Delete group',dialog()).click();await vi.waitFor(()=>expect(document.querySelector('[data-group-id="empty"]')).toBeNull());expect(model.files.size).toBe(3);expect(document.querySelector('[data-group-id="target"]')).not.toBeNull();
});
it('preserves the group and editor when native apply rejects a stale preview',async()=>{
 const model=await start();const active=view();model.core.applyDraftingChange=vi.fn(async()=>{throw Error('Synthetic stale group preview');});await preview();button('Delete group',dialog()).click();await vi.waitFor(()=>expect(document.body.textContent).toContain('Synthetic stale group preview'));expect(document.querySelector('[data-group-id="target"]')).not.toBeNull();expect(view()).toBe(active);expect(model.files.size).toBe(3);
});
