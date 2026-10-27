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
const items = () => [...document.querySelectorAll<HTMLButtonElement>('.scene-break-list button')];
async function start(bridge = core()) {
  app = mountStudio(document.body, bridge);
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent === 'Open local folder…')!.click(); await settle();
  await app.showDocument('scene.md'); return bridge;
}
beforeEach(() => {localStorage.clear(); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect(); document.body.replaceChildren();});
afterEach(() => {app?.destroy();});
describe('scene navigator drawer', () => {
  it('renders scene passages as the third tab and jumps to exact source without saving', async () => {
    const bridge = await start();
    expect(document.querySelectorAll('.navigation-drawer > .panel')).toHaveLength(3);
    document.querySelector<HTMLButtonElement>('#navigation-tab-scenes')!.click();
    expect(document.querySelector<HTMLElement>('#navigation-panel-scenes')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#navigation-panel-files')!.hidden).toBe(true);
    expect(items().map(item=>item.textContent)).toEqual(['First 🦊—passage.', 'Second passage.']);
    items()[1].click();
    const range = view().state.selection.main;
    expect(view().state.sliceDoc(range.from, range.to)).toBe('Second passage.');
    expect(items()[1].getAttribute('aria-current')).toBe('location');
    expect(document.activeElement).toBe(view().contentDOM);
    expect(bridge.saveDocument).not.toHaveBeenCalled(); expect(bridge.stageRecovery).not.toHaveBeenCalled();
  });
  it('updates first lines after unsaved edits without stealing editor focus', async () => {
    await start(); view().focus(); const from = view().state.doc.toString().indexOf('Second passage.');
    view().dispatch({changes:{from, to: from + 'Second passage.'.length, insert:'Changed—still ours.'}});
    await new Promise(resolve=>setTimeout(resolve, 150));
    expect(items()[1].textContent).toBe('Changed—still ours.'); expect(document.activeElement).toBe(view().contentDOM);
  });
  it('refuses an outdated entry during the debounce window', async () => {
    await start(); const stale = items()[1];
    view().dispatch({changes:{from: 0, insert:'Shifted\n'}});
    const before = view().state.selection.main; stale.click();
    expect(view().state.selection.main).toEqual(before); expect(document.querySelector('.scene-navigator-body')?.textContent).toContain('document changed');
  });
  it('clears entries on document changes and remembers the shared drawer state', async () => {
    await start();
    document.querySelector<HTMLButtonElement>('#navigation-tab-scenes')!.click();
    const toggle = document.querySelector<HTMLButtonElement>('.navigation-toggle')!; toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(JSON.parse(localStorage.getItem('heinlein-studio-navigation-v1')!)).toEqual({open: false, active: 'scenes'});
    expect(document.querySelector('.workspace')?.classList.contains('navigation-open')).toBe(false);
    await app.showDocument('empty.md'); expect(items()).toHaveLength(0); expect(document.querySelector('.scene-navigator-body')?.textContent).toContain('No --- scene breaks');
    app.destroy(); app = mountStudio(document.body, core()); expect(document.querySelector('.navigation-toggle')?.getAttribute('aria-expanded')).toBe('false');
  });
});
