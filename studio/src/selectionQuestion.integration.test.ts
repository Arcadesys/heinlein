// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import type {LocalCore, RecoveryDraft} from './localCore';
const source = '---\r\ntitle: Exact\r\n---\r\nA 🐺 passage.\r\nLast line';
const session = {id: 'session', name: 'Synthetic', manifests: []};
let app: ReturnType<typeof mountStudio> | undefined;
function core() {
  let draft: RecoveryDraft | null = null;
  const doc = (path: string, text = source) => ({path, text, contentHash: 'a'.repeat(64), sizeBytes: new TextEncoder().encode(text).length, frontmatter: null, generatedCompatibility: false});
  return {
    available: () => true, recentRepositories: vi.fn(async () => []), pickRepository: vi.fn(async () => session),
    openRecentRepository: vi.fn(async () => session), listDirectory: vi.fn(async () => []), listSystemFonts: vi.fn(async () => []),
    loadManuscript: vi.fn(async () => {throw new Error('No manuscript');}), readDocument: vi.fn(async (_id, path) => doc(path)),
    readRecovery: vi.fn(async () => draft), stageRecovery: vi.fn(async (_id, path, baseHash, text) => {draft = {id: 'draft', path, baseHash, text, updatedAt: 0}; return draft;}),
    discardRecovery: vi.fn(async () => {draft = null;}), saveDocument: vi.fn(async (_id, path, _hash, text) => doc(path, text)),
    setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
  } satisfies LocalCore;
}
function button(label: string) {const node = [...document.querySelectorAll('button')].find(node => node.textContent === label); if (!node) throw new Error(`Missing ${label}`); return node;}
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
async function dialog() {await vi.waitFor(() => expect(document.querySelector('[aria-label="Ask ChatGPT about selection"]')).not.toBeNull());}
async function start(bridge: LocalCore) {
  app = mountStudio(document.body, bridge); await app.selectRepository(async () => session); await app.showDocument('scene.md');
  const text = view().state.doc.toString(); const from = text.indexOf('🐺'); view().dispatch({selection: {anchor: from, head: from + '🐺 passage'.length}});
}
function replacement(text: string) {const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Proposed replacement (paste text only)"]')!; input.value = text; input.dispatchEvent(new Event('input', {bubbles: true}));}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear(); document.body.replaceChildren();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {app?.destroy(); app = undefined; vi.unstubAllGlobals();});
describe('Studio selection question integration', () => {
  it('keeps folded document details byte-exact through prose saves, source edits, and conflict pauses', async () => {
    const bridge = core(); await start(bridge);
    const details = document.querySelector<HTMLDetailsElement>('.document-details')!;
    expect(details.open).toBe(false); expect(view().contentDOM.textContent).not.toContain('title: Exact');
    view().dispatch({changes: {from: view().state.doc.length, insert: '!'}}); await app!.saveCurrent();
    expect(bridge.saveDocument).toHaveBeenLastCalledWith('session', 'scene.md', 'a'.repeat(64), source + '!');
    button('Edit source fields').click(); const from = view().state.doc.toString().indexOf('Exact');
    view().dispatch({changes: {from, to: from + 5, insert: 'Changed'}});
    expect(details.textContent).toContain('Changed'); await app!.saveCurrent();
    expect(bridge.saveDocument).toHaveBeenLastCalledWith('session', 'scene.md', 'a'.repeat(64), source.replace('Exact', 'Changed') + '!');
    bridge.saveDocument.mockRejectedValueOnce(new Error('External conflict'));
    view().dispatch({changes: {from: view().state.doc.length, insert: '?'}}); await app!.saveCurrent();
    expect(view().state.doc.toString()).toContain('title: Changed');
    expect(bridge.stageRecovery).toHaveBeenLastCalledWith('session', 'scene.md', 'a'.repeat(64), source.replace('Exact', 'Changed') + '!?');
  });
  it('reviews a passage and saves exact untouched source through existing recovery', async () => {
    const bridge = core(); await start(bridge); button('Ask about selection').click(); await dialog();
    expect(document.body.textContent).toContain('No provider is connected');
    replacement('brighter passage'); button('Review replacement').click();
    expect(bridge.saveDocument).not.toHaveBeenCalled(); button('Apply reviewed replacement').click();
    expect(view().state.doc.toString()).toContain('A brighter passage.'); await app!.saveCurrent();
    const expected = source.replace('🐺 passage', 'brighter passage');
    expect(bridge.stageRecovery).toHaveBeenCalledWith('session', 'scene.md', 'a'.repeat(64), expected);
    expect(bridge.saveDocument).toHaveBeenCalledWith('session', 'scene.md', 'a'.repeat(64), expected);
  });
  it('rejects a reviewed response after a late buffer edit', async () => {
    const bridge = core(); await start(bridge); button('Ask about selection').click(); await dialog();
    replacement('replacement'); button('Review replacement').click();
    view().dispatch({changes: {from: view().state.doc.length, insert: '!'}}); button('Apply reviewed replacement').click();
    expect(view().state.doc.toString()).toContain('🐺 passage'); expect(view().state.doc.toString()).toMatch(/!$/);
    expect(bridge.saveDocument).not.toHaveBeenCalled();
  });
  it('clears discussion on navigation and refuses empty selections', async () => {
    const bridge = core(); await start(bridge); button('Ask about selection').click(); await dialog();
    await app!.showDocument('other.md'); expect(document.querySelector('[aria-label="Ask ChatGPT about selection"]')).toBeNull();
    button('Ask about selection').click(); await vi.waitFor(() => expect(document.body.textContent).toContain('Highlight one nonempty passage first'));
    expect(bridge.saveDocument).not.toHaveBeenCalled();
  });
});
