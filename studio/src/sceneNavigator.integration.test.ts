// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import type {LocalCore} from './localCore';
let app: ReturnType<typeof mountStudio>;
const source = '---\r\ntitle: Hidden\r\n---\r\nOpening.\r\n---\r\n\r\nFirst 🦊—passage.\r\n---\r\nSecond passage.';
function core(): LocalCore {
  return {available: () => true, pickRepository: vi.fn(async () => ({id: 'synthetic', projectKey: 'synthetic-nav', name: 'Synthetic', manifests: []})), recentRepositories: vi.fn(async () => []), openRecentRepository: vi.fn(), listDirectory: vi.fn(async () => []), loadManuscript: vi.fn(), listSystemFonts: vi.fn(async () => []),
    readDocument: vi.fn(async (_id, path) => ({path, text: path === 'empty.md' ? 'No breaks.' : source, contentHash: 'hash', sizeBytes: source.length, generatedCompatibility: false, frontmatter: null})),
    readRecovery: vi.fn(async () => null), stageRecovery: vi.fn(async (_id, path, baseHash, text) => ({id: 'draft', path, baseHash, text, updatedAt: 0})), discardRecovery: vi.fn(async () => {}), saveDocument: vi.fn(), setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {})};
}
const settle = async () => {await new Promise(resolve => setTimeout(resolve, 0));};
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
const press = (key: string, init: KeyboardEventInit = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...init}));
/** Passages of the open document, listed after scenes in the ⌘K palette. */
const passages = () => { press('k', {ctrlKey: true}); return [...document.querySelectorAll<HTMLElement>('.palette-item')].filter(row => row.querySelector('.palette-num')?.textContent === '§'); };
async function start(bridge = core()) {
  app = mountStudio(document.body, bridge);
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent === 'Open local folder…')!.click(); await settle();
  await app.showDocument('scene.md'); return bridge;
}
beforeEach(() => {localStorage.clear(); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect(); document.body.replaceChildren();});
afterEach(() => {app?.destroy();});
describe('scene breaks in the palette', () => {
  it('lists passages after scenes and jumps to exact source without saving', async () => {
    const bridge = await start();
    expect(document.querySelectorAll('.navigation-drawer > .panel')).toHaveLength(1);
    const rows = passages();
    expect(rows.map(row => row.querySelector('.palette-label')!.textContent)).toEqual(['First 🦊—passage.', 'Second passage.']);
    rows[1].click();
    const range = view().state.selection.main;
    expect(view().state.sliceDoc(range.from, range.to)).toBe('Second passage.');
    expect(document.querySelector('.palette')).toBeNull();
    expect(document.activeElement).toBe(view().contentDOM);
    expect(bridge.saveDocument).not.toHaveBeenCalled(); expect(bridge.stageRecovery).not.toHaveBeenCalled();
  });
  it('reflects unsaved edits the next time the palette opens', async () => {
    await start(); const from = view().state.doc.toString().indexOf('Second passage.');
    view().dispatch({changes:{from, to: from + 'Second passage.'.length, insert:'Changed—still ours.'}});
    expect(passages()[1].querySelector('.palette-label')!.textContent).toBe('Changed—still ours.');
  });
  it('lists nothing for a document without breaks', async () => {
    await start(); await app.showDocument('empty.md');
    expect(passages()).toHaveLength(0);
  });
});
