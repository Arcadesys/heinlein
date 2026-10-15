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
function bridge() {
  let draft: RecoveryDraft | null = null;
  const files = new Map([['ms/scene.md', source]]);
  let split: Extract<DraftingChange, {kind: 'splitScene'}>;
  const doc = (path: string, text = files.get(path) ?? source) => ({path, text, contentHash: `hash:${text}`, sizeBytes: new TextEncoder().encode(text).length, frontmatter: null, generatedCompatibility: false});
  return {
    available: () => true, recentRepositories: vi.fn(async () => []), pickRepository: vi.fn(async () => session),
    openRecentRepository: vi.fn(async () => session), listDirectory: vi.fn(async () => []), listSystemFonts: vi.fn(async () => []),
    loadManuscript: vi.fn(async () => {throw new Error('No manuscript');}), readDocument: vi.fn(async (_id, path) => doc(path)),
    readRecovery: vi.fn(async () => draft), stageRecovery: vi.fn(async (_id, path, baseHash, text) => {draft = {id: 'draft', path, baseHash, text, updatedAt: 0}; return draft;}),
    discardRecovery: vi.fn(async () => {draft = null;}), saveDocument: vi.fn(async (_id, path, _hash, text) => {files.set(path, text); return doc(path, text);}),
    setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
    loadDrafting: vi.fn(async () => initial()),
    previewDraftingChange: vi.fn(async (_id, _revision, change: DraftingChange) => {
      if (change.kind !== 'splitScene') throw new Error('Expected split'); split = change;
      return {id: 'preview', summary: 'Split scene', warnings: [], changes: [{kind: 'split', source: 'ms/scene.md', destination: split.path}]};
    }),
    applyDraftingChange: vi.fn(async () => {
      const raw = new TextEncoder().encode(files.get('ms/scene.md')!);
      files.set('ms/scene.md', new TextDecoder().decode(raw.slice(0, split.byteOffset)));
      files.set(split.path, new TextDecoder().decode(raw.slice(split.byteOffset)));
      return {state: {...initial(), revision: 'rev2', scenes: [...initial().scenes, {id: 's2', title: split.title, path: split.path, groupId: 'g'}]}, undoId: 'undo'};
    }),
    undoDraftingChange: vi.fn(async () => {files.set('ms/scene.md', source); return initial();}),
  } satisfies LocalCore;
}
function button(label: string) {const node = [...document.querySelectorAll('button')].find(node => node.textContent === label); if (!node) throw new Error(`Missing ${label}`); return node;}
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
