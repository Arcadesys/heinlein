// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createDraftingPanel} from './draftingPanel';
import {withReferenceSheets} from './sheetManagement';
import type {DraftingChange, DraftingState, LocalCore} from './localCore';
afterEach(() => document.body.replaceChildren());

it('shows discovered chapter references and changes classification without touching a dirty editor', async () => {
  const state: DraftingState = {manifestPath:'ms/manuscript.json',revision:'revision',project:'Book',
    groups:[{id:'g',title:'Chapter'}],scenes:[{id:'a',title:'Scene',path:'ms/chapter/scene.md',groupId:'g'}],
    referenceSheets:[{id:'r',title:'Outline',path:'ms/chapter/reference/outline.md',groupId:'g',reference:true}],
    library:[{id:'g',kind:'group',parentId:null},{id:'a',kind:'scene',parentId:'g'}],untrackedPaths:[],missingPaths:[]};
  const root = document.createElement('main'); document.body.append(root);
  let change: DraftingChange | undefined;
  const verify = vi.fn(), changed = vi.fn(), save = vi.fn(), open = vi.fn();
  const runOrganization = vi.fn(async (run: () => Promise<void>) => run());
  const core = {loadDrafting:async()=>structuredClone(state), saveDocument:save,
    previewDraftingChange:vi.fn(async (_id, _revision, next: DraftingChange) => {change=next; return {id:'p',summary:'Classification',changes:[{kind:'index',source:null,destination:state.manifestPath}],warnings:[]};}),
    applyDraftingChange:async()=>({state:{...state,scenes:state.scenes.map(scene=>({...scene,reference:true}))},undoId:'u'}),
    undoDraftingChange:async()=>state} as unknown as LocalCore;
  const panel = createDraftingPanel(core, {root,repository:()=>({id:'repo',name:'Book',manifests:[]}),
    run:async run=>run(),runOrganization,verify,show:()=>{},open,changed,report:()=>{}});
  root.append(panel.element); await panel.load(); panel.updateBuffer('ms/chapter/scene.md','Unsaved author text — exact.');
  const reference = root.querySelector<HTMLButtonElement>('[aria-label="Outline Reference"]')!;
  expect(reference.closest('ul')!.parentElement!.textContent).toContain('Chapter');
  reference.click(); expect(open).toHaveBeenCalledWith('ms/chapter/reference/outline.md');
  const menu = root.querySelector<HTMLDetailsElement>('summary[aria-label="Actions for Scene"]')!.parentElement as HTMLDetailsElement;
  menu.open=true; menu.dispatchEvent(new Event('toggle'));
  [...document.querySelectorAll<HTMLButtonElement>('.row-menu-items button')].find(button=>button.textContent==='Make reference sheet')!.click();
  await vi.waitFor(()=>expect(changed).toHaveBeenCalled());
  expect(change).toEqual({kind:'setSheetReference',path:'ms/chapter/scene.md',reference:true});
  expect(verify).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(runOrganization).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0][4]).toBe(true);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Scene Reference');
  expect(root.querySelector('[aria-current="true"]')?.getAttribute('data-path')).toBe('ms/chapter/scene.md');
});

it('merges discovered references once and retains explicit regular sheets in reference folders', () => {
  const state: DraftingState = {manifestPath:'ms/manuscript.json',revision:'r',project:'Book',groups:[],
    scenes:[{id:'a',title:'Regular',path:'ms/reference/a.md',groupId:null,reference:false}],
    referenceSheets:[{id:'b',title:'Duplicate',path:'ms/reference/a.md',groupId:null,reference:true}],untrackedPaths:[],missingPaths:[]};
  expect(withReferenceSheets(state)).toBe(state);
});
