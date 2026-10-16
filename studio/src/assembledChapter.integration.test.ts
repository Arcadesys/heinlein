// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import type {LocalCore, Manuscript} from './localCore';
const session = {id: 'session', projectKey: 'synthetic', name: 'Synthetic', manifests: ['scene-manifest.json']};
const manuscript: Manuscript = {path: 'scene-manifest.json', project: 'Synthetic', schemaVersion: 1, volumes: [{number: 1, title: 'Volume', path: '', chapters: [{number: 1, title: 'Chapter', path: '', source: 'chapter.md', scenes: [{path: 'one.md'}, {path: 'two.md'}]}]}]};
let app: ReturnType<typeof mountStudio>;
function bridge() {
  const files = new Map([['one.md', '---\r\ntitle: First\r\n---\r\nRepeated 🦊—passage.\r\n'], ['two.md', 'Repeated 🦊—passage.']]);
  const doc = (path: string) => {const text = files.get(path)!; return {path, text, contentHash: `hash:${text}`, sizeBytes: text.length, frontmatter: null, generatedCompatibility: false};};
  const core: LocalCore = {
    available: () => true, pickRepository: vi.fn(async () => session), recentRepositories: vi.fn(async () => []), openRecentRepository: vi.fn(async () => session),
    listDirectory: vi.fn(async () => []), loadManuscript: vi.fn(async () => manuscript), listSystemFonts: vi.fn(async () => []),
    readDocument: vi.fn(async (_id, path) => {if (!files.has(path)) throw new Error('Do not open or save an exported chapter'); return doc(path);}),
    readRecovery: vi.fn(async () => null), stageRecovery: vi.fn(async (_id, path, baseHash, text) => ({id: 'draft', path, baseHash, text, updatedAt: 0})), discardRecovery: vi.fn(async () => {}),
    saveDocument: vi.fn(async (_id, path, _hash, text) => {files.set(path, text); return doc(path);}),
    setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
    askQuestion: vi.fn(), questionStatus: vi.fn(async () => ({configured: false, model: null, message: 'Offline', accounts: [], models: [], activeAccountId: null, selectedModel: null, signInPending: false, generation: 0, usageLimited: false})),
  };
  return {core, files};
}
const settle = async () => {await new Promise(resolve => setTimeout(resolve, 0));};
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
async function start(core: LocalCore) {app = mountStudio(document.body, core); button('Open Folder…').click(); await settle(); await app.showDocument('chapter.md');}
beforeEach(() => {Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect(); document.body.replaceChildren();});
afterEach(() => {app?.destroy();});
describe('assembled chapter to proposed revision', () => {
  it('opens a live chapter without reading its export and selects repeated prose in the correct editable source', async () => {
    const {core} = bridge(); await start(core);
    expect(view().state.readOnly).toBe(true); expect(document.body.textContent).toContain('Assembled chapter');
    expect(core.readRecovery).not.toHaveBeenCalled();
    const source = view().state.doc.toString(); const from = source.lastIndexOf('Repeated');
    view().dispatch({selection: {anchor: from, head: source.length}});
    button('Revise source passage').click(); await settle(); await settle();
    expect(view().state.readOnly).toBe(false);
    expect(document.querySelector('.page-meta .path')?.textContent).toBe('two.md');
    expect(view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to)).toBe('Repeated 🦊—passage.');
    expect((document.querySelector('[aria-label="Response mode"]') as HTMLSelectElement).value).toBe('revision');
    expect(document.querySelector('[aria-label="Exact revision target"]')?.textContent).toBe('Repeated 🦊—passage.');
    expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.stageRecovery).not.toHaveBeenCalled(); expect(core.askQuestion).not.toHaveBeenCalled();
    view().dispatch({changes: {from: 0, to: 8, insert: 'Revised'}});
    await app.saveCurrent();
    expect(core.saveDocument).toHaveBeenCalledWith('session', 'two.md', expect.any(String), 'Revised 🦊—passage.');
  });
  it('refuses cross-scene selection without leaving the chapter', async () => {
    const {core} = bridge(); await start(core); const reader = view();
    reader.dispatch({selection: {anchor: 0, head: reader.state.doc.length}}); button('Revise source passage').click(); await settle();
    expect(view()).toBe(reader); expect(document.querySelector('.status')?.textContent).toContain('crosses source scenes'); expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('opens a changed source for inspection without attaching stale revision text', async () => {
    const {core, files} = bridge(); await start(core); const text = view().state.doc.toString(); const from = text.lastIndexOf('Repeated');
    view().dispatch({selection: {anchor: from, head: text.length}}); files.set('two.md', 'Changed externally.');
    button('Revise source passage').click(); await settle();
    expect(view().state.doc.toString()).toBe('Changed externally.'); expect(view().state.selection.main.empty).toBe(true);
    expect(document.querySelector('.status')?.textContent).toContain('source scene changed'); expect(core.askQuestion).not.toHaveBeenCalled();
  });
  it('distinguishes a chapter entry scene from its explicitly assembled view', async () => {
    const {core} = bridge();
    const book = structuredClone(manuscript); book.volumes[0].chapters[0].source = 'one.md';
    core.loadManuscript = vi.fn(async () => book);
    app = mountStudio(document.body, core); button('Open Folder…').click(); await settle();
    await app.showDocument('one.md');
    expect(view().state.readOnly).toBe(false); expect(view().state.doc.toString()).toContain('title: First');
    button('Read assembled chapter').click(); await settle();
    expect(view().state.readOnly).toBe(true); expect(view().state.doc.toString()).not.toContain('title: First');
    expect(view().state.doc.toString().match(/Repeated/g)).toHaveLength(2);
    button('Open source scene 1 · one.md').click(); await settle();
    expect(view().state.readOnly).toBe(false); expect(document.querySelector('.page-meta .path')?.textContent).toBe('one.md');
  });
  it('opens source scenes directly for ordinary editing', async () => {
    const {core} = bridge(); await start(core); button('Open source scene 1 · one.md').click(); await settle();
    expect(view().state.readOnly).toBe(false); expect(view().state.doc.toString()).toContain('title: First');
    expect(document.body.textContent).toContain('Source scene · Editable Markdown');
  });
});
