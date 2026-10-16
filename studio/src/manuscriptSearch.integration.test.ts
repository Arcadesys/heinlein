// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {Transaction} from '@codemirror/state';
import {mountStudio} from './studio';
import type {DraftingState, LocalCore, Manuscript} from './localCore';
const session = {id: 'session', projectKey: 'book', name: 'Synthetic', manifests: [] as string[]};
const source = '---\r\ntitle: Exact\r\n---\r\nA 🐺 passage—ours.\r\nLast line';
let app: ReturnType<typeof mountStudio> | undefined;
function bridge() {
  const files = new Map([['ms/one.md', source], ['ms/two.md', 'Second scene.\r\nA 🐺 passage—also ours.']]);
  const state: DraftingState = {manifestPath: 'ms/manuscript.json', revision: 'rev1', project: 'Book', groups: [], scenes: [...files.keys()].map((path, index) => ({id: `s${index}`, path, title: `Scene ${index + 1}`, groupId: null})), untrackedPaths: [], missingPaths: []};
  const doc = (path: string) => { const text = files.get(path) ?? 'Legacy needle.'; return {path, text, contentHash: `hash:${text}`, sizeBytes: text.length, frontmatter: null, generatedCompatibility: false}; };
  const core = {
    available: () => true, recentRepositories: vi.fn(async () => []), pickRepository: vi.fn(async () => session),
    openRecentRepository: vi.fn(async () => session), listDirectory: vi.fn(async () => []), listSystemFonts: vi.fn(async () => []),
    loadManuscript: vi.fn(async () => ({path: 'legacy.json', project: 'Legacy', schemaVersion: 1, volumes: [{number: 1, title: 'Volume', path: '', chapters: [{number: 1, title: 'Chapter', path: '', source: 'generated.md', scenes: [{path: 'legacy.md'}]}]}]} satisfies Manuscript)),
    readDocument: vi.fn(async (_id: string, path: string) => doc(path)),
    readRecovery: vi.fn(async () => null), stageRecovery: vi.fn(async (_id, path, baseHash, text) => ({id: 'draft', path, baseHash, text, updatedAt: 0})),
    discardRecovery: vi.fn(async () => {}), saveDocument: vi.fn(async (_id, path, _hash, text) => {files.set(path, text); return doc(path);}),
    setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
    loadDrafting: vi.fn(async () => state), previewDraftingChange: vi.fn(), applyDraftingChange: vi.fn(), undoDraftingChange: vi.fn(),
    questionStatus: vi.fn(async () => ({configured: false, message: 'Optional', model: null, accounts: [], models: [], activeAccountId: null, selectedModel: null, signInPending: false, generation: 0, usageLimited: false})),
    askQuestion: vi.fn(),
  } satisfies LocalCore;
  return {core, files};
}
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
const press = (key: string, extra: KeyboardEventInit = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...extra}));
const results = () => [...document.querySelectorAll<HTMLButtonElement>('.manuscript-search-result')];
async function search(query: string) {
  press('f', {ctrlKey: true, shiftKey: true});
  const input = document.querySelector<HTMLInputElement>('[aria-label="Find text in manuscript"]')!;
  input.value = query; input.dispatchEvent(new Event('input'));
  document.querySelector('.manuscript-search form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
  await vi.waitFor(() => expect(document.querySelector('.manuscript-search [role="status"]')!.textContent).toContain('Results are snapshots'));
}
async function start(core: LocalCore) { app = mountStudio(document.body, core); await app.selectRepository(async () => session); await app.showDocument('ms/one.md'); }
function append(text: string) {view().dispatch({changes: {from: view().state.doc.length, insert: text}, annotations: Transaction.userEvent.of('input.type')});}
beforeEach(() => {localStorage.clear(); document.body.replaceChildren(); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();});
afterEach(() => {app?.destroy(); app = undefined;});
describe('manuscript-wide search integration', () => {
  it('jumps to exact Unicode and CRLF matches without writes or inference', async () => {
    const {core} = bridge(); await start(core); await search('🐺 passage—');
    expect(results()).toHaveLength(2); results()[1].click();
    await vi.waitFor(() => expect(document.querySelector('.pill-scene')!.textContent).toBe('Scene 2'));
    expect(view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to)).toBe('🐺 passage—');
    expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.stageRecovery).not.toHaveBeenCalled(); expect(core.askQuestion).not.toHaveBeenCalled();
  });
  it('finds current unsaved text and keeps editor identity and undo history', async () => {
    const {core} = bridge(); await start(core); const before = view(); append(' Fresh—needle');
    await search('Fresh—needle'); expect(results()).toHaveLength(1); results()[0].click();
    expect(view()).toBe(before); expect(view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to)).toBe('Fresh—needle');
    expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.askQuestion).not.toHaveBeenCalled();
  });
  it('refuses shifted stale results instead of selecting unrelated text', async () => {
    const {core} = bridge(); await start(core); await search('passage');
    view().dispatch({changes: {from: 0, insert: 'changed '}}); results()[0].click();
    expect(document.body.textContent).toContain('This search result changed'); expect(view().state.selection.main.empty).toBe(true);
    expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('uses the normal dirty-navigation guard and honors Keep editing', async () => {
    const {core} = bridge(); await start(core); append(' unsaved'); await search('passage'); results()[1].click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull());
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Keep editing')!.click();
    await Promise.resolve(); expect(view().state.doc.toString()).toContain('unsaved'); expect(document.querySelector('.pill-scene')!.textContent).toBe('Scene 1');
    expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('searches the selected legacy manuscript, then switches back to ms drafting', async () => {
    const {core} = bridge(); await start(core); await app!.showManuscript('legacy.json'); await search('needle');
    expect(results()).toHaveLength(1); expect(results()[0].textContent).toContain('legacy.md');
    document.querySelector<HTMLButtonElement>('[aria-label="Close manuscript search"]')!.click();
    [...document.querySelectorAll('button')].find(button => button.textContent === 'ms drafting')!.click();
    await vi.waitFor(() => expect(document.querySelector('.drafting-panel')).not.toBeNull());
    await search('passage'); expect(results()).toHaveLength(2);
  });
  it('does not render an old result when the manuscript changes during its read', async () => {
    const {core} = bridge(); await start(core); await search('passage'); const original = view();
    const read = core.readDocument.getMockImplementation()!;
    let resolve!: (value: Awaited<ReturnType<typeof read>>) => void;
    core.readDocument.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
    results()[1].click(); await vi.waitFor(() => expect(resolve).toBeDefined());
    await app!.showManuscript('legacy.json'); resolve(await read('session', 'ms/two.md'));
    await new Promise(done => setTimeout(done, 0));
    expect(view()).toBe(original); expect(view().state.doc.toString()).toContain('Last line');
    expect(view().state.selection.main.empty).toBe(true);
  });
  it('lets a newer current-scene result supersede an older pending scene navigation', async () => {
    const {core} = bridge(); await start(core); await search('passage'); const original = view();
    const read = core.readDocument.getMockImplementation()!;
    let resolve!: (value: Awaited<ReturnType<typeof read>>) => void;
    core.readDocument.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
    results()[1].click(); await vi.waitFor(() => expect(resolve).toBeDefined());
    await search('Last line'); results()[0].click();
    expect(view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to)).toBe('Last line');
    resolve(await read('session', 'ms/two.md')); await new Promise(done => setTimeout(done, 0));
    expect(view()).toBe(original);
    expect(view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to)).toBe('Last line');
  });
  it('refuses a changed result after loading the target from disk', async () => {
    const {core, files} = bridge(); await start(core); await search('passage');
    files.set('ms/two.md', 'Changed passage'); results()[1].click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('This search result changed'));
    expect(view().state.doc.toString()).toBe('Changed passage'); expect(view().state.selection.main.empty).toBe(true);
    expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('closes search when switching repositories and allows reopening', async () => {
    const {core} = bridge(); await start(core); await search('passage');
    await app!.selectRepository(async () => ({...session, id: 'second'}));
    expect(document.querySelector('.manuscript-search')).toBeNull();
    await search('passage'); expect(results()).toHaveLength(2);
  });
});
