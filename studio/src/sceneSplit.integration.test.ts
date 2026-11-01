// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {Transaction} from '@codemirror/state';
import {mountStudio} from './studio';
import type {DraftingChange, DraftingState, LocalCore, RecoveryDraft} from './localCore';
const source = '---\r\ntitle: Exact\r\n---\r\nA 🐺 passage.\r\nLast line';
const session = {id: 'session', projectKey: 'book', name: 'Synthetic', manifests: []};
let app: ReturnType<typeof mountStudio> | undefined;
const initial = (): DraftingState => ({manifestPath: 'ms/manuscript.json', revision: 'rev1', project: 'Book', groups: [{id: 'g', title: 'Group'}], scenes: [{id: 's1', path: 'ms/scene.md', title: 'Opening', groupId: 'g'}], untrackedPaths: [], missingPaths: []});
function bridge(generic = false) {
  const sourcePath=generic?'notes/story.Markdown':'ms/scene.md';
  const state=()=>generic?{...initial(),revision:null,scenes:[],groups:[]}:initial();
  let draft: RecoveryDraft | null = null;
  const files = new Map([[sourcePath, source]]);
  let split: Extract<DraftingChange, {kind: 'splitScene'|'splitFile'}>;
  const doc = (path: string, text = files.get(path) ?? source) => ({path, text, contentHash: `hash:${text}`, sizeBytes: new TextEncoder().encode(text).length, frontmatter: null, generatedCompatibility: false});
  return {
    available: () => true, recentRepositories: vi.fn(async () => []), pickRepository: vi.fn(async () => session),
    openRecentRepository: vi.fn(async () => session), listDirectory: vi.fn(async () => []), listSystemFonts: vi.fn(async () => []),
    loadManuscript: vi.fn(async () => {throw new Error('No manuscript');}), readDocument: vi.fn(async (_id, path) => doc(path)),
    readRecovery: vi.fn(async () => draft), stageRecovery: vi.fn(async (_id, path, baseHash, text) => {draft = {id: 'draft', path, baseHash, text, updatedAt: 0}; return draft;}),
    discardRecovery: vi.fn(async () => {draft = null;}), saveDocument: vi.fn(async (_id, path, _hash, text) => {files.set(path, text); return doc(path, text);}),
    setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
    loadDrafting: vi.fn(async () => state()),
    previewDraftingChange: vi.fn(async (_id, _revision, change: DraftingChange) => {
      if (change.kind !== (generic?'splitFile':'splitScene')) throw new Error('Expected split'); split = change as typeof split;
      return {id: 'preview', summary: 'Split scene', warnings: [], changes: [{kind: generic?'splitFile':'split', source: sourcePath, destination: split.path}]};
    }),
    applyDraftingChange: vi.fn(async () => {
      const raw = new TextEncoder().encode(files.get(sourcePath)!);
      files.set(sourcePath, new TextDecoder().decode(raw.slice(0, split.byteOffset)));
      files.set(split.path, new TextDecoder().decode(raw.slice(split.byteOffset)));
      return {state: generic?state():{...initial(), revision: 'rev2', scenes: [...initial().scenes, {id: 's2', title: split.kind==='splitScene'?split.title:'', path: split.path, groupId: 'g'}]}, undoId: 'undo'};
    }),
    undoDraftingChange: vi.fn(async () => {files.set(sourcePath, source); if(generic)files.delete(split.path); return state();}),
  } satisfies LocalCore;
}
function button(label:string){const find=()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);if(!find()&&label.startsWith('Read beside active document:'))button('Read beside…').click();if(!find()&&label.startsWith('Close document '))button('Document details').click();const b=find();if(!b)throw Error(`Missing ${label}`);return b;}
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
async function start(core: LocalCore) {
  app = mountStudio(document.body, core); await app.selectRepository(async () => session); await app.showDocument('ms/scene.md');
  view().dispatch({selection: {anchor: view().state.doc.toString().indexOf('Last')}});
}
async function preview() {
  button('Split scene at cursor').click(); button('Preview split').click();
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Review manuscript change"]')).not.toBeNull());
}
function append(text = '!') {view().dispatch({changes: {from: view().state.doc.length, insert: text}, annotations: Transaction.userEvent.of('input.type')});}
beforeEach(() => {
  localStorage.clear(); document.body.replaceChildren();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {app?.destroy(); app = undefined;});
describe('Studio split scene at cursor', () => {
  it('offers splitting generic story.md without manuscript setup',async()=>{
    const core=bridge();core.loadDrafting.mockResolvedValue({...initial(),revision:null,scenes:[],groups:[]});
    app=mountStudio(document.body,core);await app.selectRepository(async()=>session);await app.showDocument('story.md');
    view().dispatch({selection:{anchor:view().state.doc.toString().indexOf('Last')}});
    expect(button('Split scene at cursor').disabled).toBe(false);
  });


  async function startGeneric(core=bridge(true)) {
    app=mountStudio(document.body,core);await app.selectRepository(async()=>session);await app.showDocument('notes/story.Markdown');
    view().dispatch({selection:{anchor:view().state.doc.toString().indexOf('Last')}});return core;
  }
  it('splits unmapped Markdown with filename only, exact bytes, path tabs, explicit saved reference and undo',async()=>{
    const core=await startGeneric();button('Split scene at cursor').click();
    const form=document.querySelector('[aria-label="Split Markdown file at cursor"]')!;
    expect(form.textContent).toContain('Cancel does not undo that save');
    expect(form.querySelectorAll('input')).toHaveLength(1);const name=form.querySelector('input')!;expect(name.value).toBe('story-continued.Markdown');name.value='second.Markdown';
    button('Preview split').click();await vi.waitFor(()=>expect(core.previewDraftingChange).toHaveBeenCalled());
    expect(core.previewDraftingChange).toHaveBeenCalledWith('session',null,{kind:'splitFile',sourcePath:'notes/story.Markdown',path:'notes/second.Markdown',expectedHash:`hash:${source}`,byteOffset:new TextEncoder().encode(source.slice(0,source.indexOf('Last'))).length});
    expect(core.applyDraftingChange).not.toHaveBeenCalled();button('Apply change').click();await vi.waitFor(()=>expect(view().state.doc.toString()).toBe('Last line'));
    expect([...document.querySelectorAll('.document-tabs [role="tab"]')].map(t=>t.getAttribute('aria-label'))).toEqual(['notes/story.Markdown','notes/second.Markdown']);
    expect(document.querySelector('.reference-source')?.textContent).toBe('');button('Read both sections').click();await vi.waitFor(()=>expect(document.querySelector('.reference-source')?.textContent).toBe(source.slice(0,source.indexOf('Last'))));
    expect(core.saveDocument).not.toHaveBeenCalled();button('Undo last split').click();await vi.waitFor(()=>expect(document.querySelector('[aria-label="Review manuscript change"]')).not.toBeNull());button('Apply change').click();
    await vi.waitFor(()=>expect(view().state.doc.toString()).toBe(source.replace(/\r\n/g,'\n')));
    expect(core.undoDraftingChange).toHaveBeenCalledWith('session','undo');expect(document.querySelector('[role=tab][aria-label="notes/second.Markdown · Unavailable"]')).not.toBeNull();
  });
  it('generic cancel, invalid sibling name and save failure never prepare a split',async()=>{
    const core=await startGeneric();button('Split scene at cursor').click();button('Cancel').click();expect(core.previewDraftingChange).not.toHaveBeenCalled();
    button('Split scene at cursor').click();const name=document.querySelector<HTMLInputElement>('[aria-label="Split Markdown file at cursor"] input')!;name.value='../outside.md';button('Preview split').click();expect(name.validationMessage).toContain('sibling filename');expect(core.previewDraftingChange).not.toHaveBeenCalled();button('Cancel').click();
    append();core.saveDocument.mockRejectedValueOnce(Error('Synthetic save denied'));button('Split scene at cursor').click();button('Preview split').click();await vi.waitFor(()=>expect(document.body.textContent).toContain('Synthetic save denied'));expect(core.previewDraftingChange).not.toHaveBeenCalled();expect(view().state.doc.toString()).toMatch(/!$/);
  });
  it('generic ordinary save precedes preview and cancel does not undo it',async()=>{
    const core=await startGeneric();append(' synthetic');await preview();expect(core.saveDocument).toHaveBeenCalledWith('session','notes/story.Markdown',`hash:${source}`,`${source} synthetic`);expect(core.previewDraftingChange.mock.calls[0][2]).toMatchObject({kind:'splitFile',expectedHash:`hash:${source} synthetic`});button('Cancel').click();expect(core.applyDraftingChange).not.toHaveBeenCalled();expect(view().state.doc.toString()).toMatch(/synthetic$/);
  });
  it('generic recovery disables split and a moved cursor refuses captured preview',async()=>{
    const core=await startGeneric();button('Split scene at cursor').click();view().dispatch({selection:{anchor:view().state.selection.main.head+1}});button('Preview split').click();await vi.waitFor(()=>expect(document.body.textContent).toContain('scene or cursor changed'));expect(core.previewDraftingChange).not.toHaveBeenCalled();app!.destroy();app=undefined;document.body.replaceChildren();
    core.loadDrafting.mockResolvedValue({...initial(),revision:null,scenes:[],groups:[],recoveryRequired:true});await startGeneric(core);expect(button('Split scene at cursor').disabled).toBe(true);
  });
  it('generic reference-origin selection cannot use the stale writer cursor after toolbar focus',async()=>{
    const core=await startGeneric();button('Read beside active document: notes/story.Markdown').click();await vi.waitFor(()=>expect(document.querySelector('.reference-source')?.textContent).toBe(source));const pre=document.querySelector<HTMLElement>('.reference-source')!;pre.focus();const range=document.createRange();range.selectNodeContents(pre);document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range);pre.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));button('Split scene at cursor').focus();button('Split scene at cursor').click();expect(document.querySelector('[aria-label="Split Markdown file at cursor"]')).toBeNull();expect(core.previewDraftingChange).not.toHaveBeenCalled();expect(document.querySelector('.status')?.textContent).toContain('Activate this document');
  });
  it.each(['document epoch','recovery','disposed session'])('generic %s change after preview makes zero apply calls',async kind=>{
    const core=await startGeneric();await preview();const apply=button('Apply change');
    if(kind==='document epoch')await app!.showDocument('other.md',true);
    else if(kind==='recovery'){core.readRecovery.mockResolvedValueOnce({id:'new-recovery',path:'notes/story.Markdown',baseHash:`hash:${source}`,text:'Pending synthetic recovery',updatedAt:0});await app!.showDocument('notes/story.Markdown',true);}
    else{app!.destroy();app=undefined;}
    apply.click();await new Promise(resolve=>setTimeout(resolve,0));expect(core.applyDraftingChange).not.toHaveBeenCalled();expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('generic committed split with unreadable suffix keeps both path tabs unavailable and no old writer',async()=>{
    const core=await startGeneric();const read=core.readDocument.getMockImplementation()!;core.readDocument.mockImplementation(async(id,path)=>{if(path.endsWith('-continued.Markdown'))throw Error('Synthetic suffix unavailable');return read(id,path);});
    await preview();button('Apply change').click();await vi.waitFor(()=>expect(document.body.textContent).toContain('view could not refresh'));
    expect(document.querySelector('.markdown-editor')).toBeNull();expect([...document.querySelectorAll('.document-tabs [role="tab"]')].map(t=>t.getAttribute('aria-label'))).toEqual(['notes/story.Markdown','notes/story-continued.Markdown · Unavailable']);expect(document.querySelector('.document-tabs [aria-selected="true"]')).toBeNull();expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('converts Unicode CRLF cursor exactly, previews, applies and baselines suffix without credit', async () => {
    const core = bridge(); await start(core); await preview();
    expect(core.previewDraftingChange).toHaveBeenCalledWith('session', 'rev1', {kind: 'splitScene', sceneId: 's1', path: 'ms/scene-continued.md', title: 'Opening continued', expectedHash: `hash:${source}`, byteOffset: new TextEncoder().encode(source.slice(0, source.indexOf('Last'))).length});
    expect(core.applyDraftingChange).not.toHaveBeenCalled(); button('Apply change').click();
    await vi.waitFor(() => expect(view().state.doc.toString()).toBe('Last line'));
    expect(document.body.textContent).toContain('0 / 1,000 daily growth credited');
    expect(core.saveDocument).not.toHaveBeenCalled(); expect(button('Undo last change').disabled).toBe(false);
    append(' fresh');
    expect(document.body.textContent).toContain('1 / 1,000 daily growth credited');
  });
  it('keeps original and suffix identities beyond12 tabs and reads both only on explicit choice',async()=>{
    const core=bridge();await start(core);const original=document.querySelector<HTMLButtonElement>('.document-tabs [role="tab"][aria-selected="true"]')!.id;
    for(let i=0;i<13;i++)await app!.showDocument(`other-${i}.md`);
    await app!.showDocument('ms/scene.md');
    button('Read beside active document: ms/scene.md').click();
    await vi.waitFor(()=>expect(document.querySelector('.reference-source')?.textContent).toBe(source));
    view().dispatch({selection:{anchor:view().state.doc.toString().indexOf('Last')}});await preview();button('Apply change').click();
    await vi.waitFor(()=>expect(document.querySelector('.document-tabs [role="tab"][aria-selected="true"]')?.getAttribute('aria-label')).toBe('ms/scene-continued.md'));
    expect(document.getElementById(original)?.getAttribute('aria-label')).toBe('ms/scene.md');
    expect(document.querySelectorAll('.document-tabs [role="tab"]')).toHaveLength(15);
    expect(document.querySelector('.reference-source')?.textContent).toBe(source);
    expect(document.querySelector('.reference-state')?.textContent).toContain('Changed');
    button('Read both sections').click();await vi.waitFor(()=>expect(document.querySelector('.reference-source')?.textContent).toBe(source.slice(0,source.indexOf('Last'))));
    expect(view().state.doc.toString()).toBe('Last line');expect(core.saveDocument).not.toHaveBeenCalled();
    button('Undo last change').click();await vi.waitFor(()=>expect(document.querySelector('[aria-label="Review manuscript change"]')).not.toBeNull());button('Apply change').click();
    await vi.waitFor(()=>expect([...document.querySelectorAll('.document-tabs [role="tab"]')].some(t=>t.getAttribute('aria-label')==='ms/scene-continued.md · Unavailable')).toBe(true));
    expect(document.getElementById(original)?.getAttribute('aria-label')).toBe('ms/scene.md');
    await new Promise(resolve=>setTimeout(resolve,0));await app!.showDocument('ms/scene.md');
    for(let i=0;i<13;i++)button(`Close document other-${i}.md`).click();
    core.readDocument.mockClear();button('Close document ms/scene.md').click();
    await vi.waitFor(()=>expect(document.querySelector('.markdown-editor')).toBeNull());expect(core.readDocument).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.document-tabs [role="tab"]')).toHaveLength(1);
  });
  it('registers both verified split identities when the saved suffix cannot initially reopen',async()=>{
    const core=bridge();const read=core.readDocument.getMockImplementation()!;core.readDocument.mockImplementation(async(id,path)=>{if(path==='ms/scene-continued.md')throw Error('Synthetic suffix read unavailable');return read(id,path);});
    await start(core);await preview();button('Apply change').click();await vi.waitFor(()=>expect(document.body.textContent).toContain('view could not refresh'));
    expect([...document.querySelectorAll('.document-tabs [role="tab"]')].map(t=>t.getAttribute('aria-label'))).toEqual(['ms/scene.md','ms/scene-continued.md']);expect(document.querySelector('.document-tabs [aria-selected="true"]')).toBeNull();expect(document.querySelector('.markdown-editor')).toBeNull();expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('adds no successful suffix tab on canceled or failed split',async()=>{
    const core=bridge();await start(core);await preview();button('Cancel').click();expect(document.querySelectorAll('.document-tabs [role="tab"]')).toHaveLength(1);
    await new Promise(resolve=>setTimeout(resolve,0));core.applyDraftingChange.mockRejectedValueOnce(Error('stale split'));await preview();button('Apply change').click();await vi.waitFor(()=>expect(document.body.textContent).toContain('stale split'));
    expect(document.querySelectorAll('.document-tabs [role="tab"]')).toHaveLength(1);expect(document.querySelector('.split-reading-offer')?.textContent).toBe('');
  });
  it('saves dirty raw text first and uses returned hash', async () => {
    const core = bridge(); await start(core); append(); await preview();
    expect(core.saveDocument).toHaveBeenCalledWith('session', 'ms/scene.md', `hash:${source}`, `${source}!`);
    expect(core.previewDraftingChange.mock.calls[0][2]).toMatchObject({expectedHash: `hash:${source}!`});
    button('Cancel').click(); expect(core.applyDraftingChange).not.toHaveBeenCalled();
  });
  it('does not preview when dirty save fails', async () => {
    const core = bridge(); core.saveDocument.mockRejectedValue(new Error('Disk full')); await start(core); append();
    button('Split scene at cursor').click(); button('Preview split').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Disk full'));
    expect(core.previewDraftingChange).not.toHaveBeenCalled(); expect(view().state.doc.toString()).toMatch(/!$/);
  });
  it.each(['selection', 'start', 'end', 'frontmatter', 'surrogate'])('rejects %s boundary', async kind => {
    const core = bridge(); await start(core); const text = view().state.doc.toString();
    const anchor = kind === 'start' ? 0 : kind === 'end' ? text.length : kind === 'frontmatter' ? 5 : kind === 'surrogate' ? text.indexOf('🐺') + 1 : text.indexOf('Last');
    view().dispatch({selection: {anchor, head: kind === 'selection' ? anchor + 2 : anchor}}); button('Split scene at cursor').click();
    expect(document.querySelector('[aria-label="Split scene at cursor"]')).toBeNull(); expect(core.previewDraftingChange).not.toHaveBeenCalled();
  });
  it('supports keyboard shortcut and cancels preview without writing', async () => {
    const core = bridge(); await start(core);
    view().contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true}));
    button('Preview split').click(); await vi.waitFor(() => expect(document.querySelector('[aria-label="Review manuscript change"]')).not.toBeNull());
    button('Cancel').click(); expect(core.applyDraftingChange).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('rejects navigation after capture', async () => {
    const core = bridge(); await start(core); button('Split scene at cursor').click(); await app!.showDocument('other.md'); button('Preview split').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('scene or cursor changed'));
    expect(core.previewDraftingChange).not.toHaveBeenCalled();
  });
  it('rejects late edits during slow dirty save', async () => {
    const core = bridge(); let release!: () => void; const original = core.saveDocument.getMockImplementation()!;
    core.saveDocument.mockImplementation(async (...args) => {await new Promise<void>(resolve => {release = resolve;}); return original(...args);});
    await start(core); append(); button('Split scene at cursor').click(); button('Preview split').click();
    await vi.waitFor(() => expect(release).toBeDefined()); append(' late'); release();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Newer edits are still unsaved'));
    expect(core.previewDraftingChange).not.toHaveBeenCalled(); expect(view().state.doc.toString()).toMatch(/! late$/);
  });
  it('refuses apply after late editor edit in preview', async () => {
    const core = bridge(); await start(core); await preview(); append(' late'); button('Apply change').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Newer text is preserved'));
    expect(core.applyDraftingChange).not.toHaveBeenCalled(); expect(view().state.doc.toString()).toMatch(/late$/);
  });
  it.each(['---\nunfinished metadata\nLast line', '---\r\n' + 'metadata: unfinished\r\n'.repeat(10000) + 'Last line', 'Text \ud800 here. Last line'])('rejects incomplete metadata or invalid Unicode', async text => {
    const core = bridge(); const read = core.readDocument.getMockImplementation()!;
    core.readDocument.mockImplementation(async (id, path) => ({...await read(id, path), text}));
    await start(core); button('Split scene at cursor').click();
    expect(document.querySelector('[aria-label="Split scene at cursor"]')).toBeNull();
    expect(core.previewDraftingChange).not.toHaveBeenCalled();
  });
  it.each(['\ufeff' + source, '---\n---\nA body\nLast line', '\ufeff---\r\n---\r\nA body\r\nLast line'])('supports BOM and empty frontmatter without dropping bytes', async text => {
    const core = bridge(); const read = core.readDocument.getMockImplementation()!;
    core.readDocument.mockImplementation(async (id, path) => ({...await read(id, path), text}));
    await start(core); await preview();
    expect(core.previewDraftingChange.mock.calls[0][2]).toMatchObject({byteOffset: new TextEncoder().encode(text.slice(0, text.indexOf('Last'))).length});
    button('Cancel').click();
  });
  it('undoes an unchanged split through explicit preview', async () => {
    const core = bridge(); await start(core); await preview(); button('Apply change').click();
    await vi.waitFor(() => expect(view().state.doc.toString()).toBe('Last line'));
    button('Undo last change').click(); await vi.waitFor(() => expect(document.querySelector('[aria-label="Review manuscript change"]')).not.toBeNull());
    expect(core.undoDraftingChange).not.toHaveBeenCalled(); button('Apply change').click();
    await vi.waitFor(() => expect(core.undoDraftingChange).toHaveBeenCalledWith('session', 'undo'));
    expect(document.body.textContent).toContain('0 / 1,000 daily growth credited');
  });
  it('undoes through explicit preview and blocks late undo edits', async () => {
    const core = bridge(); await start(core); await preview(); button('Apply change').click();
    await vi.waitFor(() => expect(view().state.doc.toString()).toBe('Last line'));
    button('Undo last change').click(); await vi.waitFor(() => expect(document.querySelector('[aria-label="Review manuscript change"]')).not.toBeNull());
    append(' late'); button('Apply change').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Newer text is preserved'));
    expect(core.undoDraftingChange).not.toHaveBeenCalled(); expect(view().state.doc.toString()).toBe('Last line late');
  });
  it('rejects cursor movement after capture', async () => {
    const core = bridge(); await start(core); button('Split scene at cursor').click();
    view().dispatch({selection: {anchor: view().state.selection.main.from + 1}}); button('Preview split').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('scene or cursor changed'));
    expect(core.previewDraftingChange).not.toHaveBeenCalled();
  });
  it('preserves late buffer edit while apply is in flight', async () => {
    const core = bridge(); let release!: () => void; const original = core.applyDraftingChange.getMockImplementation()!;
    core.applyDraftingChange.mockImplementation(async () => {await new Promise<void>(resolve => {release = resolve;}); return original();});
    await start(core); await preview(); button('Apply change').click(); await vi.waitFor(() => expect(release).toBeDefined());
    append(' late'); release(); await vi.waitFor(() => expect(document.body.textContent).toContain('Newer text is preserved'));
    expect(view().state.doc.toString()).toMatch(/late$/); expect(document.body.textContent).toContain('view could not refresh');
  });
});
