// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import type {LocalCore, RecoveryDraft} from './localCore';

const session = {id: 'synthetic-session', name: 'Invented book', manifests: []};
const raw = '---\r\ntitle: 星\r\n---\r\n# Fox — 🐺\r\n\r\nA *second* line.\n';
const doc = (path: string, text = raw) => ({path, text, contentHash: `hash:${path}`, sizeBytes: new TextEncoder().encode(text).length, frontmatter: null, generatedCompatibility: false});
function bridge(draft: RecoveryDraft | null = null) {
  return {available: () => true, pickRepository: vi.fn(async () => session), recentRepositories: vi.fn(async () => []), openRecentRepository: vi.fn(async () => session), listDirectory: vi.fn(async () => []), loadManuscript: vi.fn(async () => { throw Error('No manuscript'); }), readDocument: vi.fn(async (_id: string, path: string) => doc(path)), readRecovery: vi.fn(async () => draft), stageRecovery: vi.fn(async (_id: string, path: string, baseHash: string, text: string) => ({id: 'draft', path, baseHash, text, updatedAt: 0})), discardRecovery: vi.fn(async () => {}), saveDocument: vi.fn(async (_id: string, path: string, _hash: string, text: string) => doc(path, text)), setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}), listSystemFonts: vi.fn(async () => [])} as unknown as LocalCore & {saveDocument: ReturnType<typeof vi.fn>};
}
let app: ReturnType<typeof mountStudio>;
const view = () => EditorView.findFromDOM(document.querySelector('.active-document-pane .cm-editor') as HTMLElement)!;
const reader = () => document.querySelector<HTMLElement>('.active-document-pane .markdown-reader');
const toggle = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.active-document-pane .md-view-toggle button')].find(node => node.textContent === label)!;
const status = () => document.querySelector('.status')!.textContent;
const tab = (path: string) => [...document.querySelectorAll<HTMLButtonElement>('[role=tab][id^=document-tab]')].find(node => node.textContent?.includes(path))!;
async function start(core: LocalCore, path = 'a.md') {app = mountStudio(document.body, core); await app.selectRepository(async () => session); await app.showDocument(path);}
beforeEach(() => {localStorage.clear(); document.body.replaceChildren(); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();});
afterEach(() => app?.destroy());

describe('Source and Reading in one writer', () => {
  it('defaults to Source for each document and keeps the choice for this session as tabs change', async () => {
    await start(bridge());
    expect(toggle('Source').getAttribute('aria-pressed')).toBe('true');
    expect(reader()!.hidden).toBe(true);
    toggle('Reading').click();
    expect(reader()!.hidden).toBe(false);
    await app.showDocument('b.md');
    expect(toggle('Source').getAttribute('aria-pressed')).toBe('true');
    tab('a.md').click();
    await vi.waitFor(() => expect(toggle('Reading').getAttribute('aria-pressed')).toBe('true'));
    expect(reader()!.hidden).toBe(false);
    expect(reader()!.querySelector('h3')!.textContent).toContain('Fox — 🐺');
    app.destroy();
    await start(bridge());
    expect(reader()!.hidden).toBe(true);
  });
  it('never writes or changes raw source when toggling', async () => {
    const core = bridge();
    await start(core);
    const before = view().state;
    toggle('Reading').click();
    toggle('Source').click();
    toggle('Reading').click();
    expect(view().state.doc).toBe(before.doc);
    expect(core.saveDocument).not.toHaveBeenCalled();
    expect(core.setUnsavedChanges).not.toHaveBeenCalledWith(true);
  });
  it('keeps the writer position through Reading and never takes it from the reader', async () => {
    await start(bridge());
    view().dispatch({selection: {anchor: 9, head: 12}});
    view().scrollDOM.scrollTop = 120;
    toggle('Reading').click();
    view().scrollDOM.scrollTop = 999;
    toggle('Source').click();
    expect(view().scrollDOM.scrollTop).toBe(120);
    expect(view().state.selection.main.anchor).toBe(9);
    expect(view().state.selection.main.head).toBe(12);
  });
  it('remembers the Source position, not the reader, when leaving and returning to a tab in Reading', async () => {
    await start(bridge());
    view().dispatch({selection: {anchor: 9}});
    view().scrollDOM.scrollTop = 120;
    toggle('Reading').click();
    await app.showDocument('b.md');
    tab('a.md').click();
    await vi.waitFor(() => expect(toggle('Reading').getAttribute('aria-pressed')).toBe('true'));
    toggle('Source').click();
    expect(view().state.selection.main.anchor).toBe(9);
    expect(view().scrollDOM.scrollTop).toBe(120);
  });
  it('forces Source while recovery is pending, with a reason, so the recovery choice stays visible', async () => {
    const draft: RecoveryDraft = {id: 'draft', path: 'a.md', baseHash: 'hash:a.md', text: `${raw}Recovered.`, updatedAt: 1};
    await start(bridge(draft));
    expect(toggle('Reading').disabled).toBe(true);
    expect(toggle('Reading').title).toContain('Resolve recovery');
    expect(reader()!.hidden).toBe(true);
    expect(document.querySelector('.recovery-notice')).toBeTruthy();
  });
  it('restores nothing to Reading while recovery is pending, even if the document was in Reading', async () => {
    const core = bridge();
    await start(core);
    toggle('Reading').click();
    await app.showDocument('b.md');
    (core.readRecovery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({id: 'draft', path: 'a.md', baseHash: 'hash:a.md', text: `${raw}Recovered.`, updatedAt: 1});
    await app.showDocument('a.md');
    expect(reader()!.hidden).toBe(true);
    expect(toggle('Source').getAttribute('aria-pressed')).toBe('true');
  });
  it('offers Reading for .markdown but not for other text', async () => {
    await start(bridge(), 'a.markdown');
    expect(toggle('Reading')).toBeTruthy();
    await app.showDocument('notes.txt');
    expect(document.querySelector('.active-document-pane .md-view-toggle')).toBeNull();
  });
  it('returns to Source before a scene jump, so the selection lands in a visible editor', async () => {
    const core = bridge();
    (core.readDocument as ReturnType<typeof vi.fn>).mockImplementation(async (_id: string, path: string) => doc(path, 'One.\n\n---\n\nTwo words here.\n'));
    await start(core);
    toggle('Reading').click();
    const passage = await vi.waitFor(() => {const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label')?.startsWith('Passage 1')); expect(found).toBeTruthy(); return found!;});
    passage.click();
    expect(reader()!.hidden).toBe(true);
    expect(toggle('Source').getAttribute('aria-pressed')).toBe('true');
    expect(view().state.selection.main.empty).toBe(false);
  });
  it('keeps saving available while in Reading', async () => {
    const core = bridge();
    await start(core);
    view().dispatch({changes: {from: view().state.doc.length, insert: 'More.'}});
    toggle('Reading').click();
    await app.saveCurrent();
    expect(core.saveDocument).toHaveBeenCalledOnce();
    expect(core.saveDocument.mock.calls[0][3]).toBe(`${raw}More.`);
    expect(reader()!.hidden).toBe(false);
  });

});
