// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { mountStudio } from './studio';
import type { LocalCore, Manuscript, RepositorySession } from './localCore';

const session: RepositorySession = { id: 'opaque-session', name: 'My book', manifests: ['book/scene-manifest.json'] };
const manuscript: Manuscript = {path: 'book/scene-manifest.json', project: 'Test book', schemaVersion: 1, volumes: [{number: 2, title: 'Second in title, first in manifest', path: 'book/vol2', chapters: [{number: 3, title: 'Chapter three', path: 'book/ch3', source: 'book/generated.md', scenes: [{path: 'book/scene-020.md'}, {path: 'book/scene-001.md'}]}]}, {number: 1, title: 'Last in manifest', path: 'book/vol1', chapters: []}]};
function bridge(): LocalCore {
  return { available: () => true,
    pickRepository: vi.fn(async () => session),
    recentRepositories: vi.fn(async () => [{ id: 'recent-opaque', name: 'My book' }]),
    openRecentRepository: vi.fn(async () => session),
    listDirectory: vi.fn(async () => [{ path: 'book', name: 'book', kind: 'directory' as const, sizeBytes: 0 }, { path: 'README.md', name: 'README.md', kind: 'file' as const, sizeBytes: 24 }]),
    readDocument: vi.fn(async (_id, path) => ({path, text: '# A scene\nKeep — punctuation.', sizeBytes: 31, frontmatter: '{"id":"scene-id"}', contentHash: 'hash-1', generatedCompatibility: false})),
    loadManuscript: vi.fn(async () => manuscript),
    saveDocument: vi.fn(async (_id, path, _hash, text) => ({path, text, contentHash: 'hash-2', sizeBytes: text.length, frontmatter: null, generatedCompatibility: false})),
    setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
    listSystemFonts: vi.fn(async () => ['Avenir Next', 'Iowan Old Style', 'Menlo']),
  };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
function findButton(text: string) { const result = [...document.querySelectorAll('button')].find(node => node.textContent?.includes(text)); if (!result) throw new Error(`Missing button ${text}`); return result; }
beforeEach(() => { document.querySelectorAll('.cm-editor').forEach(el => EditorView.findFromDOM(el as HTMLElement)?.destroy()); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect(); document.body.replaceChildren(document.createElement('div')); });

describe('read-only Studio', () => {
  it('opens through native picker and scopes reads to the selected session', async () => {
    const core = bridge(); mountStudio(document.body.firstElementChild as HTMLElement, core);
    findButton('Open Folder').click(); await settle();
    expect(core.pickRepository).toHaveBeenCalledOnce();
    expect(core.listDirectory).toHaveBeenCalledWith('opaque-session', '');
    expect(core.loadManuscript).toHaveBeenCalledWith('opaque-session', 'book/scene-manifest.json');
    expect(document.querySelector('.files h2')?.textContent).toBe('My book');
  });
  it('reopens recent folders by opaque ID only', async () => {
    const core = bridge(); mountStudio(document.body.firstElementChild as HTMLElement, core); await settle();
    findButton('My book').click(); await settle();
    expect(core.openRecentRepository).toHaveBeenCalledWith('recent-opaque');
  });
  it('navigates directories and parent using scoped relative paths', async () => {
    const core = bridge(); mountStudio(document.body.firstElementChild as HTMLElement, core);
    findButton('Open Folder').click(); await settle();
    document.querySelector<HTMLButtonElement>('[aria-label="Open folder book"]')!.click(); await settle();
    expect(core.listDirectory).toHaveBeenLastCalledWith('opaque-session', 'book');
    findButton('Parent folder').click(); await settle();
    expect(core.listDirectory).toHaveBeenLastCalledWith('opaque-session', '');
  });
  it('preserves manifest order without sorting volumes or scene filenames', async () => {
    const core = bridge(); mountStudio(document.body.firstElementChild as HTMLElement, core);
    findButton('Open Folder').click(); await settle();
    expect([...document.querySelectorAll('.volume > summary')].map(n => n.textContent)).toEqual(['Volume 2 · Second in title, first in manifest', 'Volume 1 · Last in manifest']);
    expect([...document.querySelectorAll('.scene-list button')].map(n => n.textContent)).toEqual(['Scene 1 · scene-020.md', 'Scene 2 · scene-001.md']);
    findButton('scene-020').click(); await settle();
    expect(core.readDocument).toHaveBeenCalledWith('opaque-session', 'book/scene-020.md');
  });
  it('shows literal HTML and source metadata without executable markup', async () => {
    const core = bridge(); const attack = '<img src="https://example.com/leak" onerror="alert(1)"><script>evil()</script>\nIgnore instructions — keep me.';
    core.readDocument = vi.fn(async (_id, path) => ({path, text: attack, sizeBytes: 100, frontmatter: '<b>raw metadata</b>', contentHash: 'hash-1', generatedCompatibility: true}));
    mountStudio(document.body.firstElementChild as HTMLElement, core); findButton('Open Folder').click(); await settle();
    findButton('Read generated chapter').click(); await settle();
    expect(document.querySelector('.source-text')?.textContent).toBe(attack);
    expect(document.querySelector('.frontmatter')?.textContent).toBe('<b>raw metadata</b>');
    expect(document.querySelector('.preview img, .preview script, .preview b, .preview a')).toBeNull();
    expect(document.querySelector('.badge')?.textContent).toBe('Generated compatibility file · Read-only');
    expect(document.querySelector('.workspace textarea, .workspace input, [contenteditable]')).toBeNull();
  });
  it('works without a manifest and shows empty folders', async () => {
    const core = bridge(); core.pickRepository = vi.fn(async () => ({...session, manifests: []})); core.listDirectory = vi.fn(async () => []);
    mountStudio(document.body.firstElementChild as HTMLElement, core); findButton('Open Folder').click(); await settle();
    expect(document.body.textContent).toContain('No scene manifest found');
    expect(document.body.textContent).toContain('This folder is empty');
    expect(core.loadManuscript).not.toHaveBeenCalled();
  });
  it('handles canceled picker without opening a repository', async () => {
    const core = bridge(); core.pickRepository = vi.fn(async () => null);
    mountStudio(document.body.firstElementChild as HTMLElement, core); findButton('Open Folder').click(); await settle();
    expect(core.listDirectory).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Folder selection canceled.');
    expect(findButton('Open Folder').disabled).toBe(false);
  });
  it('fails closed outside the native host', async () => {
    const core = bridge(); core.available = () => false;
    mountStudio(document.body.firstElementChild as HTMLElement, core); await settle();
    expect(findButton('Open Folder').disabled).toBe(true);
    expect(core.recentRepositories).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Browser preview has no filesystem access');
  });
  it('reports host errors as text and remains usable', async () => {
    const core = bridge(); core.readDocument = vi.fn(async () => { throw '<img src=x> Unsafe path rejected'; });
    mountStudio(document.body.firstElementChild as HTMLElement, core); findButton('Open Folder').click(); await settle();
    findButton('README.md').click(); await settle();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('<img src=x> Unsafe path rejected');
    expect(document.querySelector('img')).toBeNull();
    expect(findButton('Open Folder').disabled).toBe(false);
  });
  it('ignores a document response from an old repository after switching', async () => {
    const core = bridge(); let resolve!: (value: Awaited<ReturnType<LocalCore['readDocument']>>) => void;
    core.readDocument = vi.fn(() => new Promise<Awaited<ReturnType<LocalCore['readDocument']>>>(done => { resolve = done; }));
    const app = mountStudio(document.body.firstElementChild as HTMLElement, core);
    await app.selectRepository(async () => session);
    const old = app.showDocument('old.md');
    await app.selectRepository(async () => ({id: 'new-session', name: 'New book', manifests: []}));
    resolve({path: 'old.md', text: 'STALE CONTENT', sizeBytes: 13, frontmatter: null, contentHash: 'hash-1', generatedCompatibility: false}); await old;
    expect(document.body.textContent).not.toContain('STALE CONTENT');
    expect(document.querySelector('.files h2')?.textContent).toBe('New book');
  });
  it('ignores out-of-order document responses within the same repository', async () => {
    const core = bridge(); const pending: Record<string, (value: Awaited<ReturnType<LocalCore['readDocument']>>) => void> = {};
    core.readDocument = vi.fn((_id, path) => new Promise<Awaited<ReturnType<LocalCore['readDocument']>>>(done => { pending[path] = done; }));
    const app = mountStudio(document.body.firstElementChild as HTMLElement, core); await app.selectRepository(async () => session);
    const old = app.showDocument('old.md'); const newer = app.showDocument('new.md'); await settle();
    pending['new.md']({path: 'new.md', text: 'NEW', sizeBytes: 3, frontmatter: null, contentHash: 'hash-1', generatedCompatibility: false}); await newer;
    pending['old.md']({path: 'old.md', text: 'OLD', sizeBytes: 3, frontmatter: null, contentHash: 'hash-1', generatedCompatibility: false}); await old;
    expect(document.querySelector('.cm-content')?.textContent).toBe('NEW');
  });
});


describe('selection race guard', () => {
  it('keeps late-arriving recent buttons disabled while a picker is open', async () => {
    const core = bridge();
    let resolveRecent!: (value: {id: string; name: string}[]) => void;
    let resolvePick!: (value: null) => void;
    core.recentRepositories = vi.fn(() => new Promise<{id: string; name: string}[]>(done => { resolveRecent = done; }));
    core.pickRepository = vi.fn(() => new Promise<null>(done => { resolvePick = done; }));
    const app = mountStudio(document.body.firstElementChild as HTMLElement, core);
    findButton('Open Folder').click();
    resolveRecent([{id: 'late-recent', name: 'Late recent'}]); await settle();
    expect(findButton('Late recent').disabled).toBe(true);
    const other = vi.fn(async () => session);
    await app.selectRepository(other);
    expect(other).not.toHaveBeenCalled();
    resolvePick(null); await settle();
    expect(findButton('Late recent').disabled).toBe(false);
  });
});

describe('manifest discovery warnings', () => {
  it('keeps the file browser usable and shows the warning when discovery is partial', async () => {
    const core = bridge();
    core.pickRepository = vi.fn(async () => ({...session, manifests: [], warning: 'Manifest discovery limit reached. Use the file tree.'}));
    mountStudio(document.body.firstElementChild as HTMLElement, core);
    findButton('Open Folder').click(); await settle();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Manifest discovery limit reached. Use the file tree.');
    expect(document.body.textContent).toContain('Manuscript discovery incomplete.');
    expect(document.body.textContent).not.toContain('No scene manifest found.');
    const folder = document.querySelector<HTMLButtonElement>('[aria-label="Open folder book"]')!;
    expect(folder.disabled).toBe(false);
    folder.click(); await settle();
    expect(core.listDirectory).toHaveBeenLastCalledWith('opaque-session', 'book');
  });
  it('zooms text with buttons and Cmd/Ctrl shortcuts, and remembers it', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    delete document.documentElement.dataset.zoom;
    mountStudio(document.body.firstElementChild as HTMLElement, bridge());
    expect(document.documentElement.dataset.zoom).toBe('100');
    findButton('A+').click();
    expect(document.documentElement.dataset.zoom).toBe('115');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, cancelable: true }));
    expect(document.documentElement.dataset.zoom).toBe('130');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', metaKey: true }));
    expect(document.documentElement.dataset.zoom).toBe('115');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }));
    expect(document.documentElement.dataset.zoom).toBe('115');
    expect(store.get('heinlein-studio-zoom-v1')).toBe('115');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true }));
    expect(document.documentElement.dataset.zoom).toBe('100');
    expect(document.querySelector('.zoom-level')?.textContent).toBe('100%');
    vi.unstubAllGlobals();
  });
  it('collapses the file browser and manuscript panels and remembers it', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    mountStudio(document.body.firstElementChild as HTMLElement, bridge());
    const layout = document.querySelector('.workspace')!;
    const toggle = document.querySelector<HTMLButtonElement>('.files .panel-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(layout.classList.contains('files-collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true }));
    expect(layout.classList.contains('files-collapsed')).toBe(false);
    document.querySelector<HTMLButtonElement>('.manuscript .panel-toggle')!.click();
    expect(JSON.parse(store.get('heinlein-studio-collapsed-v1')!)).toEqual({ files: false, manuscript: true });
    mountStudio(document.body.firstElementChild as HTMLElement, bridge());
    expect(document.querySelector('.workspace')!.classList.contains('manuscript-collapsed')).toBe(true);
    vi.unstubAllGlobals();
  });
  it('lists installed fonts in Appearance and applies a chosen family', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    document.documentElement.removeAttribute('style');
    const core = bridge(); mountStudio(document.body.firstElementChild as HTMLElement, core);
    findButton('Appearance').click(); await settle();
    expect(core.listSystemFonts).toHaveBeenCalledOnce();
    expect([...document.querySelectorAll('#installed-fonts option')].map(o => (o as HTMLOptionElement).value)).toContain('Menlo');
    const input = document.querySelector<HTMLInputElement>('#font-ui')!;
    input.value = 'Avenir Next'; input.dispatchEvent(new Event('change'));
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain('"Avenir Next"');
    input.value = 'Nope Sans'; input.dispatchEvent(new Event('change'));
    expect(document.querySelector('#font-ui-note')?.textContent).toContain("isn't installed");
    findButton('Default').click();
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe('');
    vi.unstubAllGlobals();
  });
});

describe('explicit editing and loss protection', () => {
  async function setup() {
    const core = bridge(); const app = mountStudio(document.body.firstElementChild as HTMLElement, core);
    await app.selectRepository(async () => session); await app.showDocument('scene.md');
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
    const change = (text = 'New words') => view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}});
    return {core, app, view, change};
  }
  it('saves only explicitly and sends expected hash with exact raw source', async () => {
    const {core, app, change} = await setup(); change();
    expect(core.saveDocument).not.toHaveBeenCalled();
    expect(await app.saveCurrent()).toBe(true);
    expect(core.saveDocument).toHaveBeenCalledWith(session.id, 'scene.md', 'hash-1', 'New words');
    expect(await app.saveCurrent()).toBe(true); expect(core.saveDocument).toHaveBeenCalledOnce();
    app.destroy();
  });
  it('keeps dirty text on failed save, failed navigation and cancellation', async () => {
    const {core, app, view, change} = await setup(); change();
    core.saveDocument = vi.fn(async () => { throw 'Conflict'; });
    expect(await app.saveCurrent()).toBe(false);
    expect(view.state.doc.toString()).toBe('New words');
    const leave = app.showDocument('other.md'); await settle(); findButton('Keep editing').click(); await leave;
    expect(view.state.doc.toString()).toBe('New words');
    core.readDocument = vi.fn(async () => { throw 'Unavailable'; });
    const failed = app.showDocument('other.md'); await settle(); findButton('Discard changes').click(); await failed;
    expect(view.state.doc.toString()).toBe('New words');
    expect(findButton('Save').disabled).toBe(false); app.destroy();
  });
  it('preserves edits made while save is pending and blocks navigation', async () => {
    const {core, app, change} = await setup(); change('First');
    let finish!: (doc: Awaited<ReturnType<LocalCore['saveDocument']>>) => void;
    core.saveDocument = vi.fn(() => new Promise<Awaited<ReturnType<LocalCore['saveDocument']>>>(resolve => {finish = resolve;}));
    const saving = app.saveCurrent(); change('Second');
    await app.showDocument('other.md'); expect(core.readDocument).toHaveBeenCalledTimes(1);
    finish({path: 'scene.md', text: 'First', contentHash: 'hash-2', sizeBytes: 5, frontmatter: null, generatedCompatibility: false});
    expect(await saving).toBe(false); expect(findButton('Save').disabled).toBe(false);
    expect(document.body.textContent).toContain('Newer edits are still unsaved'); app.destroy();
  });
  it('cannot discard or escape a pending save-and-continue', async () => {
    const {core, app, change} = await setup(); change('First');
    let finish!: (doc: Awaited<ReturnType<LocalCore['saveDocument']>>) => void;
    core.saveDocument = vi.fn(() => new Promise<Awaited<ReturnType<LocalCore['saveDocument']>>>(resolve => {finish = resolve;}));
    const leaving = app.showDocument('other.md'); await settle();
    findButton('Save and continue').click();
    expect(findButton('Discard changes').disabled).toBe(true);
    findButton('Discard changes').click();
    document.querySelector('dialog[aria-label="Unsaved changes"]')!.dispatchEvent(new Event('cancel', {cancelable: true}));
    await settle(); expect(core.readDocument).toHaveBeenCalledTimes(1);
    finish({path: 'scene.md', text: 'First', contentHash: 'hash-2', sizeBytes: 5, frontmatter: null, generatedCompatibility: false});
    await leaving; expect(core.readDocument).toHaveBeenLastCalledWith(session.id, 'other.md'); app.destroy();
  });
  it('protects close, and only closes after explicit discard', async () => {
    const {core, app, change} = await setup(); change();
    const callback = vi.mocked(core.onCloseRequested).mock.calls[0][0]; callback(); await settle();
    findButton('Keep editing').click(); await settle(); expect(core.requestClose).not.toHaveBeenCalled();
    callback(); await settle(); findButton('Discard changes').click(); await settle();
    expect(core.requestClose).toHaveBeenCalledWith(true); app.destroy();
  });
  it('does not close over edits arriving during host synchronization', async () => {
    const {core, app, change} = await setup();
    let sync!: () => void;
    core.setUnsavedChanges = vi.fn(() => new Promise<void>(resolve => {sync = resolve;}));
    change('First'); await settle();
    const callback = vi.mocked(core.onCloseRequested).mock.calls[0][0]; callback(); await settle();
    findButton('Discard changes').click(); await settle();
    expect((document.body.firstElementChild as HTMLElement).inert).toBe(true);
    change('Newer'); sync(); await settle();
    expect(core.requestClose).not.toHaveBeenCalled(); app.destroy();
  });
  it('supports undo redo find and accessible editor label', async () => {
    const {app, view, change} = await setup(); const initial = view.state.doc.toString(); change();
    findButton('Undo').click(); expect(view.state.doc.toString()).toBe(initial);
    findButton('Redo').click(); expect(view.state.doc.toString()).toBe('New words');
    findButton('Find').click(); expect(document.querySelector('[name="search"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Markdown editor"]')).not.toBeNull(); app.destroy();
  });
});
