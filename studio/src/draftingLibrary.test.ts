// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDraftingPanel} from './draftingPanel';
import type {DraftingState, LocalCore} from './localCore';

afterEach(() => { document.body.replaceChildren(); });
/** Open a row's ⋯ menu and return one of its buttons. */
function rowAction(row: string, action: string) {
  const menu = document.querySelector<HTMLElement>(`summary[aria-label="Actions for ${row}"]`)!.parentElement as HTMLDetailsElement;
  menu.open = true; menu.dispatchEvent(new Event('toggle'));
  return [...document.querySelectorAll<HTMLButtonElement>(`.row-menu-items[aria-label="Actions for ${row}"] button`)].find(node => node.textContent === action)!;
}
describe('library organization', () => {
  it('shows descendant sheets in library order and saves a rename without a confirmation', async () => {
    const state: DraftingState = {manifestPath:'ms/manuscript.json', revision:'revision', project:'Book',
      groups:[{id:'g', title:'Group'}, {id:'child', title:'Nested'}],
      scenes:[{id:'a',title:'First',path:'ms/a.md',groupId:'g'}, {id:'b',title:'Second',path:'ms/b.md',groupId:'child'}],
      library:[{id:'g',kind:'group',parentId:null},{id:'child',kind:'group',parentId:'g'}, {id:'b',kind:'scene',parentId:'child'}, {id:'a',kind:'scene',parentId:'g'}], untrackedPaths:[],missingPaths:[]};
    const preview = vi.fn(async (_repository: string, _revision: string | null, _change: unknown) => ({id:'preview', summary:'Organize library', changes:[], warnings:[]}));
    const core = {loadDrafting:vi.fn(async () => state), previewDraftingChange:preview,
      applyDraftingChange:vi.fn(async () => ({state,undoId:'undo'})), undoDraftingChange:vi.fn(),
      readDocument:vi.fn(async () => ({text:'Synthetic prose'}))} as unknown as LocalCore;
    const root = document.createElement('main'); document.body.append(root);
    const panel = createDraftingPanel(core, {root, repository:() => ({id:'repo',name:'Book',manifests:[]}),
      run:async action => action(), show:()=>{}, open:()=>{}, changed:async()=>{}, report:()=>{}});
    root.append(panel.element); await panel.load();
    expect([...root.querySelectorAll('.scene-open')].map(node => node.textContent)).toEqual(['Second','First']);
    expect([...root.querySelectorAll('.tree-toggle')].map(node => node.textContent)).toEqual(['Group','Nested']);
    rowAction('Group', 'Rename…').click();
    const input = root.querySelector('dialog input') as HTMLInputElement; input.value = 'New name';
    root.querySelector('dialog form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));
    await vi.waitFor(() => expect(core.applyDraftingChange).toHaveBeenCalledOnce());
    expect(preview.mock.calls[0][2]).toMatchObject({kind:'organizeLibrary', groups:expect.arrayContaining([{id:'g',title:'New name'}])});
    expect(root.querySelector('dialog')).toBeNull();
  });
});
it('moves a scene to another group from its menu', async () => {
  const state: DraftingState = {manifestPath:'ms/manuscript.json',revision:'r',project:'Book',groups:[{id:'g',title:'Group'},{id:'h',title:'Destination'}],scenes:[{id:'a',title:'A',path:'ms/a.md',groupId:'g'},{id:'b',title:'B',path:'ms/b.md',groupId:'g'},{id:'c',title:'C',path:'ms/c.md',groupId:'g'}],library:[{id:'g',kind:'group',parentId:null},{id:'h',kind:'group',parentId:null},{id:'a',kind:'scene',parentId:'g'},{id:'b',kind:'scene',parentId:'g'},{id:'c',kind:'scene',parentId:'g'}],untrackedPaths:[],missingPaths:[]};
  const preview = vi.fn(async (_repo:string,_revision:string|null,_change:unknown) => ({id:'p',summary:'Moved',changes:[],warnings:[]}));
  const core = {loadDrafting:async()=>state,previewDraftingChange:preview,applyDraftingChange:async()=>({state,undoId:'u'}),undoDraftingChange:async()=>state,readDocument:async()=>({text:'Synthetic'})} as unknown as LocalCore;
  const root=document.createElement('main'); document.body.append(root);
  const report=vi.fn();
  const panel=createDraftingPanel(core,{root,repository:()=>({id:'repo',name:'Book',manifests:[]}),run:async action=>action(),show:()=>{},open:()=>{},changed:async()=>{},report}); root.append(panel.element); await panel.load();
  rowAction('C', 'Move to…').click();
  const select=root.querySelector<HTMLSelectElement>('dialog select')!; expect(select.value).toBe('g');
  select.value='h'; root.querySelector('dialog form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await vi.waitFor(()=>expect(preview).toHaveBeenCalledOnce());
  const change=preview.mock.calls[0][2] as Extract<import('./localCore').DraftingChange,{kind:'organizeLibrary'}>;
  expect(change.entries.filter(entry=>entry.parentId==='h').map(entry=>entry.id)).toEqual(['c']);
  await vi.waitFor(()=>expect(report).toHaveBeenCalledWith(expect.stringContaining('Moved C to Destination')));
  expect((document.activeElement as HTMLElement).textContent).toBe('C');
});
it('keyboard-equivalent reorder applies immediately without a review dialog',async()=>{
 const state:DraftingState={manifestPath:'ms/manuscript.json',revision:'r',project:'Book',groups:[],scenes:[{id:'a',title:'A',path:'ms/a.md',groupId:null},{id:'b',title:'B',path:'ms/b.md',groupId:null}],library:[{id:'a',kind:'scene',parentId:null},{id:'b',kind:'scene',parentId:null}],untrackedPaths:[],missingPaths:[]};
 const preview=vi.fn(async (_id:string,_rev:string|null,_change:unknown)=>({id:'p',summary:'Reorder',changes:[],warnings:[]}));
 const core={loadDrafting:async()=>state,previewDraftingChange:preview,applyDraftingChange:vi.fn(async()=>({state,undoId:'u'})),undoDraftingChange:async()=>state,readDocument:async()=>({text:'Synthetic'})} as unknown as LocalCore;
 const root=document.createElement('main');document.body.append(root);const panel=createDraftingPanel(core,{root,repository:()=>({id:'r',name:'Book',manifests:[]}),run:async action=>action(),show:()=>{},open:()=>{},changed:async()=>{},report:()=>{}});root.append(panel.element);await panel.load();
 await panel.reorderScene('b',-1);expect(preview).toHaveBeenCalledOnce();expect(core.applyDraftingChange).toHaveBeenCalledOnce();expect(root.querySelector('dialog')).toBeNull();
 const change=preview.mock.calls[0][2] as Extract<import('./localCore').DraftingChange,{kind:'organizeLibrary'}>;expect(change.entries.map(entry=>entry.id)).toEqual(['b','a']);
});
it('splits nested sheets beside their source without exposing a path field',async()=>{
 const state:DraftingState={manifestPath:'ms/manuscript.json',revision:'r',project:'Book',groups:[],scenes:[{id:'a',title:'A',path:'ms/nested/a.md',groupId:null}],library:[{id:'a',kind:'scene',parentId:null}],untrackedPaths:[],missingPaths:[]};
 const preview=vi.fn(async (_id:string,_rev:string|null,_change:unknown)=>({id:'p',summary:'Split',changes:[],warnings:[]}));
 const core={loadDrafting:async()=>state,previewDraftingChange:preview,applyDraftingChange:async()=>({state,undoId:'u'}),undoDraftingChange:async()=>state,readDocument:async()=>({text:'Synthetic'})} as unknown as LocalCore;
 const root=document.createElement('main');document.body.append(root);const panel=createDraftingPanel(core,{root,repository:()=>({id:'r',name:'Book',manifests:[]}),run:async action=>action(),show:()=>{},open:()=>{},changed:async()=>{},report:()=>{}});root.append(panel.element);await panel.load();
 panel.splitScene('a',()=>({expectedHash:'hash',byteOffset:4}));expect(root.querySelectorAll('dialog input')).toHaveLength(1);
 [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(node=>node.textContent==='Preview split')!.click();await vi.waitFor(()=>expect(preview).toHaveBeenCalledOnce());
 const change=preview.mock.calls[0][2] as Extract<import('./localCore').DraftingChange,{kind:'splitScene'}>;expect(change.path).toMatch(/^ms\/nested\/sheet-[0-9a-f-]+\.md$/);
});
