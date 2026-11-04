// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createDraftingPanel} from './draftingPanel';
import type {Document, DraftingState, LocalCore} from './localCore';

const state: DraftingState = {manifestPath:'ms/manuscript.json',revision:'r',project:'Book',
  groups:[{id:'g',title:'Chapter'}],scenes:[
    {id:'a',title:'First sheet',path:'ms/a.md',groupId:'g'},
    {id:'b',title:'Second sheet',path:'ms/b.md',groupId:'g'}],untrackedPaths:[],missingPaths:[]};
const doc = (text: string) => ({text} as Document);
const panels: ReturnType<typeof createDraftingPanel>[] = [];
afterEach(() => { panels.splice(0).forEach(panel => panel.destroy()); document.body.replaceChildren(); });
function setup(read = vi.fn(async (_repo: string, path: string) => doc(`# Heading\nOpening of ${path}\nSecond line\nThird line\nFourth line`))) {
  const root = document.createElement('main'); document.body.append(root);
  let repositoryId = 'repo'; const open = vi.fn();
  const core = {readDocument:read,loadDrafting:async()=>structuredClone(state),previewDraftingChange:vi.fn(),
    applyDraftingChange:vi.fn(),undoDraftingChange:vi.fn()} as unknown as LocalCore;
  const panel = createDraftingPanel(core,{root,repository:()=>({id:repositoryId,name:'Book',manifests:[]}),
    run:async run=>run(),show:()=>{},open,changed:async()=>{},report:()=>{}});
  panels.push(panel); root.append(panel.element);
  const excerpt = (path = 'ms/b.md') => root.querySelector<HTMLElement>(`.scene-excerpt[data-path="${path}"]`)!;
  const toggle = () => root.querySelector<HTMLButtonElement>('.tree-toggle')!.click();
  return {panel,read,open,excerpt,toggle,switchRepository:()=>{panel.clear();repositoryId='other';}};
}

it('loads all opening excerpts without opening a sheet and reuses them across tree renders',async()=>{
  const f=setup(); await f.panel.load();
  await vi.waitFor(()=>expect(f.excerpt().textContent).toBe('Opening of ms/b.md Second line Third line'));
  expect(f.open).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledTimes(2);
  const control=document.querySelector<HTMLButtonElement>('.scene-open[data-path="ms/b.md"]')!;
  expect(control.getAttribute('aria-describedby')).toBe(f.excerpt().id);
  expect(f.excerpt().getAttribute('aria-hidden')).toBeNull();
  f.toggle(); f.toggle(); expect(f.excerpt().textContent).toContain('Opening of ms/b.md');
  expect(f.read).toHaveBeenCalledTimes(2);
});

it('finishes preloading while a group is collapsed and paints the cached text when expanded',async()=>{
  let release!: (value: Document) => void;
  const read=vi.fn((_repo:string,path:string)=>path==='ms/b.md'?new Promise<Document>(resolve=>{release=resolve;}):Promise.resolve(doc('First opening')));
  const f=setup(read); const loading=f.panel.load();
  await vi.waitFor(()=>expect(release).toBeTypeOf('function')); f.toggle(); release(doc('Unopened — exact.'));
  await loading; f.toggle();
  expect(f.excerpt().textContent).toBe('Unopened — exact.'); expect(f.read).toHaveBeenCalledTimes(2);
});

it('keeps live text ahead of a late disk read and through refresh',async()=>{
  let release!: (value: Document) => void;
  const read=vi.fn((_repo:string,path:string)=>path==='ms/b.md'?new Promise<Document>(resolve=>{release=resolve;}):Promise.resolve(doc('First opening')));
  const f=setup(read); const loading=f.panel.load();
  await vi.waitFor(()=>expect(release).toBeTypeOf('function')); f.panel.updateBuffer('ms/b.md','Unsaved — exact.');
  release(doc('Older disk text')); await loading;
  expect(f.excerpt().textContent).toBe('Unsaved — exact.');
  await f.panel.load(); expect(f.excerpt().textContent).toBe('Unsaved — exact.');
});

it('ignores late reads from a previous project, including identical relative paths',async()=>{
  const releases: ((value: Document) => void)[]=[];
  const read=vi.fn((repo:string,_path:string)=>repo==='repo'?new Promise<Document>(resolve=>releases.push(resolve)):Promise.resolve(doc('Other project')));
  const f=setup(read); const loading=f.panel.load();
  await vi.waitFor(()=>expect(releases).toHaveLength(1)); f.switchRepository(); await f.panel.load();
  await vi.waitFor(()=>expect(f.excerpt().textContent).toBe('Other project'));
  releases.forEach(release=>release(doc('Private previous project')));
  expect(await loading).toBeNull(); f.toggle(); f.toggle();
  expect(f.excerpt().textContent).toBe('Other project');
});

it('distinguishes unreadable sheets from empty sheets and retries on disk refresh',async()=>{
  const read=vi.fn(async(_repo:string,path:string)=>{if(path==='ms/b.md')throw Error('Unavailable');return doc('');});
  const f=setup(read); await f.panel.load();
  await vi.waitFor(()=>expect(f.excerpt().textContent).toBe('Preview unavailable'));
  expect(f.excerpt('ms/a.md').textContent).toBe('No text yet');
  read.mockImplementation(async()=>doc('Fresh disk opening')); await f.panel.load();
  await vi.waitFor(()=>expect(f.excerpt().textContent).toBe('Fresh disk opening'));
});

it('serializes preview reads and finishes them before the library load resolves',async()=>{
  let busy=false;
  const read=vi.fn(async(_repo:string,_path:string)=>{
    expect(busy).toBe(false); busy=true;
    await new Promise(resolve=>setTimeout(resolve,5));busy=false;return doc('Cached opening');
  });
  const f=setup(read); await f.panel.load();
  expect(read).toHaveBeenCalledTimes(2);expect(busy).toBe(false);
  expect(f.excerpt().textContent).toBe('Cached opening');
});
