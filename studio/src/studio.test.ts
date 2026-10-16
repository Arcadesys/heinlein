// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { createEditor } from './editor';
import { AUTOSAVE_DELAY_MS, AUTOSAVE_MAX_WAIT_MS, mountStudio as mount } from './studio';
const apps: ReturnType<typeof mount>[] = [];
function mountStudio(...args: Parameters<typeof mount>) { const app = mount(...args); apps.push(app); return app; }
afterEach(() => { apps.splice(0).forEach(app => app.destroy()); vi.useRealTimers(); });
import type { LocalCore, Manuscript, RecoveryDraft, RepositorySession } from './localCore';

const session: RepositorySession = { id: 'opaque-session', projectKey: 'stable-project', name: 'My book', manifests: ['book/scene-manifest.json'] };
const manuscript: Manuscript = {path: 'book/scene-manifest.json', project: 'Test book', schemaVersion: 1, volumes: [{number: 2, title: 'Second in title, first in manifest', path: 'book/vol2', chapters: [{number: 3, title: 'Chapter three', path: 'book/ch3', source: 'book/generated.md', scenes: [{path: 'book/scene-020.md'}, {path: 'book/scene-001.md'}]}]}, {number: 1, title: 'Last in manifest', path: 'book/vol1', chapters: []}]};
function bridge(): LocalCore {
  let nextDraft = 0;
  const recovery = new Map<string, RecoveryDraft>();
  return { available: () => true,
    pickRepository: vi.fn(async () => session),
    recentRepositories: vi.fn(async () => [{ id: 'recent-opaque', name: 'My book' }]),
    openRecentRepository: vi.fn(async () => session),
    listDirectory: vi.fn(async () => [{ path: 'book', name: 'book', kind: 'directory' as const, sizeBytes: 0 }, { path: 'README.md', name: 'README.md', kind: 'file' as const, sizeBytes: 24 }]),
    readDocument: vi.fn(async (_id, path) => ({path, text: '# A scene\nKeep — punctuation.', sizeBytes: 31, frontmatter: '{"id":"scene-id"}', contentHash: 'hash-1', generatedCompatibility: false})),
    loadManuscript: vi.fn(async () => manuscript),
    saveDocument: vi.fn(async (_id, path, _hash, text) => ({path, text, contentHash: 'hash-2', sizeBytes: text.length, frontmatter: null, generatedCompatibility: false})),
    readRecovery: vi.fn(async (_id, path) => recovery.get(path) ?? null),
    stageRecovery: vi.fn(async (_id, path, baseHash, text) => { const draft = {id: `draft-${++nextDraft}`, path, baseHash, text, updatedAt: Date.now()}; recovery.set(path, draft); return draft; }),
    discardRecovery: vi.fn(async (_id, path, id) => { if (recovery.has(path) && recovery.get(path)!.id !== id) throw 'A newer recovery draft exists'; recovery.delete(path); }),
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
    const file = document.querySelector<HTMLButtonElement>('[aria-label="Read file README.md"]')!; file.click(); await settle();
    expect(document.querySelector('.source-text')?.textContent).toBe(attack);
    expect(document.querySelector('.frontmatter')?.textContent).toBe('<b>raw metadata</b>');
    expect(document.querySelector('.preview img, .preview script, .preview b, .preview a')).toBeNull();
    expect(document.querySelector('.badge')?.textContent).toBe('Assembled chapter · Revise its source scenes');
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
    expect(document.querySelector('.status')?.textContent).toBe('Folder selection canceled.');
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
    expect(document.querySelector('.status')?.textContent).toContain('<img src=x> Unsafe path rejected');
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
    expect(document.querySelector('.status')?.textContent).toContain('Manifest discovery limit reached. Use the file tree.');
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
    expect(JSON.parse(store.get('heinlein-studio-collapsed-v1')!)).toEqual({ files: false, manuscript: true, scenes: false });
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

describe('editing and loss protection', () => {
  async function setup() {
    const core = bridge(); const app = mountStudio(document.body.firstElementChild as HTMLElement, core);
    await app.selectRepository(async () => ({...session, manifests: []})); await app.showDocument('scene.md');
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
    const change = (text = 'New words') => view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, annotations: Transaction.userEvent.of('input.type')});
    return {core, app, view, change};
  }
  it('supports immediate Save before the debounce, with expected hash and exact raw source', async () => {
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
    await app.showDocument('other.md'); expect(core.readDocument).toHaveBeenCalledTimes(1); await settle();
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
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Find')!.click(); expect(document.querySelector('[name="search"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Markdown editor"]')).not.toBeNull(); app.destroy();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const savedDocument = (text: string, contentHash = 'hash-2') => ({path: 'scene.md', text, contentHash, sizeBytes: text.length, frontmatter: null, generatedCompatibility: false});
async function openEditor(core = bridge()) {
  const app = mountStudio(document.body.firstElementChild as HTMLElement, core);
  await app.selectRepository(async () => ({...session, manifests: []}));
  await app.showDocument('scene.md');
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
  const change = (text: string) => view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, annotations: Transaction.userEvent.of('input.type')});
  return {core, app, view, change};
}
const fakeClock = () => vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});

describe('durable debounced autosave', () => {
  it('coalesces typing and stages exact text before any manuscript write', async () => {
    fakeClock();
    const {core, change} = await openEditor();
    const stage = deferred<RecoveryDraft>();
    core.stageRecovery = vi.fn(() => stage.promise);
    change('First'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    change('Latest — words'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    expect(core.stageRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(core.stageRecovery).toHaveBeenCalledExactlyOnceWith(session.id, 'scene.md', 'hash-1', 'Latest — words');
    expect(core.saveDocument).not.toHaveBeenCalled();
    stage.resolve({id: 'durable', path: 'scene.md', baseHash: 'hash-1', text: 'Latest — words', updatedAt: 1}); await flush();
    expect(core.saveDocument).toHaveBeenCalledExactlyOnceWith(session.id, 'scene.md', 'hash-1', 'Latest — words');
    expect(core.discardRecovery).toHaveBeenCalledWith(session.id, 'scene.md', 'durable');
    expect(document.querySelector('.editor-toolbar [role="status"]')?.textContent).toBe('Saved locally');
  });
  it('stages newer typing during an in-flight save and never clears it with the older result', async () => {
    fakeClock();
    const {core, change} = await openEditor(); const save = deferred<Awaited<ReturnType<LocalCore['saveDocument']>>>();
    vi.mocked(core.saveDocument).mockImplementationOnce(() => save.promise);
    change('First'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    change('Second'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(core.saveDocument).toHaveBeenCalledTimes(1);
    expect((await core.readRecovery(session.id, 'scene.md'))?.text).toBe('Second');
    save.resolve(savedDocument('First')); await flush();
    expect(document.querySelector('.cm-content')?.textContent).toBe('Second');
    expect(document.querySelector('.editor-toolbar [role="status"]')?.textContent).toContain('Unsaved');
    expect(core.discardRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(core.saveDocument).toHaveBeenLastCalledWith(session.id, 'scene.md', 'hash-2', 'Second');
    expect(await core.readRecovery(session.id, 'scene.md')).toBeNull();
  });
  it('pauses manuscript writes after conflict while continuing to stage the latest buffer', async () => {
    fakeClock();
    const {core, change, app} = await openEditor();
    core.saveDocument = vi.fn(async () => { throw 'Conflict: disk changed'; });
    change('First'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    change('Latest conflict text'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(core.saveDocument).toHaveBeenCalledTimes(1);
    expect(await core.readRecovery(session.id, 'scene.md')).toMatchObject({text: 'Latest conflict text', baseHash: 'hash-1'});
    expect(document.querySelector('.status')?.textContent).toContain('Automatic manuscript saves are paused');
    expect(await app.saveCurrent()).toBe(false);
    expect(core.saveDocument).toHaveBeenLastCalledWith(session.id, 'scene.md', 'hash-1', 'Latest conflict text');
  });
  it('does not write a manuscript if durable staging fails and keeps the editor usable', async () => {
    fakeClock();
    const {core, change, app, view} = await openEditor();
    vi.mocked(core.stageRecovery).mockRejectedValueOnce('Storage full');
    change('Keep these words'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(core.saveDocument).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('Keep these words');
    expect(document.querySelector('.status')?.textContent).toContain('Recovery could not be saved');
    change('Keep newer words'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect((await core.readRecovery(session.id, 'scene.md'))?.text).toBe('Keep newer words');
    expect(core.saveDocument).not.toHaveBeenCalled();
    expect(await app.saveCurrent()).toBe(true);
  });
  it('distinguishes recovery cleanup failure from a failed manuscript save', async () => {
    fakeClock();
    const {core, change, app} = await openEditor(); core.discardRecovery = vi.fn(async () => { throw 'Storage read-only'; });
    change('Safely saved'); expect(await app.saveCurrent()).toBe(true);
    expect(document.querySelector('.status')?.textContent).toContain('Manuscript saved locally, but recovery cleanup failed');
    expect(document.querySelector('.status')?.textContent).not.toContain('Save failed');
    expect(document.querySelector('.editor-toolbar [role="status"]')?.textContent).toBe('Saved locally');
    expect((await core.readRecovery(session.id, 'scene.md'))?.text).toBe('Safely saved');
  });
  it('flushes newer edits when explicit Save waits for an in-flight autosave', async () => {
    fakeClock();
    const {core, change, app} = await openEditor(); const save = deferred<Awaited<ReturnType<LocalCore['saveDocument']>>>();
    vi.mocked(core.saveDocument).mockImplementationOnce(() => save.promise);
    change('First'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    change('Second'); const explicit = app.saveCurrent();
    save.resolve(savedDocument('First'));
    expect(await explicit).toBe(true);
    expect(core.saveDocument).toHaveBeenCalledTimes(2);
    expect(core.saveDocument).toHaveBeenLastCalledWith(session.id, 'scene.md', 'hash-2', 'Second');
  });
});

describe('restart recovery and explicit choices', () => {
  it('reopens a durable draft after restart and restores it only after an explicit choice', async () => {
    fakeClock();
    const first = await openEditor();
    vi.mocked(first.core.saveDocument).mockRejectedValueOnce('Disk unavailable');
    first.change('Recovered — words'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    first.app.destroy();
    const second = await openEditor(first.core);
    expect(second.view.state.readOnly).toBe(true);
    expect(second.view.state.doc.toString()).toContain('Keep — punctuation');
    expect(first.core.saveDocument).toHaveBeenCalledTimes(1);
    findButton('Restore draft').click();
    expect(second.view.state.doc.toString()).toBe('Recovered — words');
    expect(second.view.state.readOnly).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(first.core.saveDocument).toHaveBeenCalledTimes(2);
    expect(await first.core.readRecovery(session.id, 'scene.md')).toBeNull();
  });
  it('preserves exact recovered newline bytes and excludes recovery from daily growth', async () => {
    fakeClock();
    const core = bridge(); const raw = 'Restored\r\nnew — line\nlast';
    await core.stageRecovery(session.id, 'scene.md', 'hash-1', raw);
    await openEditor(core);
    const progress = document.querySelector('[aria-label="Daily writing goal"]') as HTMLProgressElement;
    const before = progress.value;
    findButton('Restore draft').click(); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(core.saveDocument).toHaveBeenCalledWith(session.id, 'scene.md', 'hash-1', raw);
    expect(progress.value).toBe(before);
  });
  it('restores a divergent recovery for comparison without overwriting external disk changes', async () => {
    fakeClock();
    const core = bridge(); await core.stageRecovery(session.id, 'scene.md', 'older-base', '<script>never execute</script> recovered');
    core.saveDocument = vi.fn(async () => { throw 'Conflict: disk changed'; });
    const {change, app} = await openEditor(core);
    expect(document.querySelector('.recovery-notice')?.textContent).toContain('file on disk changed');
    expect(document.querySelector('.recovery-notice script')).toBeNull();
    findButton('Restore draft').click(); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(core.saveDocument).not.toHaveBeenCalled();
    change('New recovered words'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(await core.readRecovery(session.id, 'scene.md')).toMatchObject({text: 'New recovered words', baseHash: 'older-base'});
    expect(core.saveDocument).not.toHaveBeenCalled();
    expect(await app.saveCurrent()).toBe(false);
    expect(core.saveDocument).toHaveBeenCalledWith(session.id, 'scene.md', 'older-base', 'New recovered words');
  });
  it('keeps recovery and the disk document read-only when discard fails', async () => {
    const core = bridge(); const draft = await core.stageRecovery(session.id, 'scene.md', 'hash-1', 'Recovered');
    const {view} = await openEditor(core);
    vi.mocked(core.discardRecovery).mockRejectedValueOnce('Storage locked');
    findButton('Discard recovery').click(); await flush();
    expect(view.state.readOnly).toBe(true);
    expect(document.querySelector('.recovery-notice')).not.toBeNull();
    expect(await core.readRecovery(session.id, 'scene.md')).toEqual(draft);
    findButton('Discard recovery').click(); await flush();
    expect(core.discardRecovery).toHaveBeenLastCalledWith(session.id, 'scene.md', draft.id);
    expect(view.state.readOnly).toBe(false);
    expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('cleans an already-saved recovery copy without rewriting the manuscript', async () => {
    const core = bridge(); const doc = await core.readDocument(session.id, 'scene.md');
    const draft = await core.stageRecovery(session.id, 'scene.md', 'earlier-hash', doc.text);
    const {view} = await openEditor(core);
    expect(document.querySelector('.recovery-notice')).toBeNull();
    expect(view.state.readOnly).toBe(false);
    expect(core.discardRecovery).toHaveBeenCalledWith(session.id, 'scene.md', draft.id);
    expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('shows disk read-only after a recovery-read failure and retries without assuming absence', async () => {
    const core = bridge(); vi.mocked(core.readRecovery).mockRejectedValueOnce('Recovery corrupt');
    const {view} = await openEditor(core);
    expect(view.state.doc.toString()).toContain('Keep — punctuation');
    expect(view.state.readOnly).toBe(true);
    expect(document.querySelector('.status')?.textContent).toContain('Recovery could not be read');
    expect(core.stageRecovery).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled();
    findButton('Retry recovery').click(); await flush();
    expect(EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!.state.readOnly).toBe(false);
    expect(document.querySelector('.recovery-notice')).toBeNull();
  });
});

describe('autosave navigation and close races', () => {
  it('does not close during recovery staging or a pending autosave', async () => {
    fakeClock();
    const {core, change} = await openEditor();
    const stage = deferred<RecoveryDraft>(); const save = deferred<Awaited<ReturnType<LocalCore['saveDocument']>>>();
    core.stageRecovery = vi.fn(() => stage.promise); core.saveDocument = vi.fn(() => save.promise);
    const close = vi.mocked(core.onCloseRequested).mock.calls[0][0];
    change('Writing'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    close(); await flush(); expect(core.requestClose).not.toHaveBeenCalled();
    stage.resolve({id: 'draft', path: 'scene.md', baseHash: 'hash-1', text: 'Writing', updatedAt: 1}); await flush();
    close(); await flush(); expect(core.requestClose).not.toHaveBeenCalled();
    save.resolve(savedDocument('Writing')); await flush();
    close(); await flush(); expect(core.requestClose).toHaveBeenCalledOnce();
  });
  it('never closes over newer edits while Save and continue is in flight', async () => {
    fakeClock();
    const {core, change} = await openEditor(); const save = deferred<Awaited<ReturnType<LocalCore['saveDocument']>>>();
    core.saveDocument = vi.fn(() => save.promise);
    change('First'); vi.mocked(core.onCloseRequested).mock.calls[0][0](); await flush();
    findButton('Save and continue').click(); await flush();
    change('Newer'); save.resolve(savedDocument('First')); await flush();
    expect(core.requestClose).not.toHaveBeenCalled();
    expect(document.querySelector('.cm-content')?.textContent).toBe('Newer');
    expect(document.querySelector('.editor-toolbar [role="status"]')?.textContent).toContain('Unsaved');
  });
  it('keeps the dirty buffer if recovery discard fails during navigation', async () => {
    fakeClock();
    const {core, change, app, view} = await openEditor();
    core.saveDocument = vi.fn(async () => { throw 'Conflict'; });
    change('Retain me'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    core.discardRecovery = vi.fn(async () => { throw 'Recovery unavailable'; });
    const leave = app.showDocument('other.md'); await flush(); findButton('Discard changes').click(); await leave;
    expect(view.state.doc.toString()).toBe('Retain me');
    expect(core.readDocument).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.status')?.textContent).toContain('Recovery could not be discarded');
  });
  it('does not autosave a discarded buffer after the next document read fails', async () => {
    fakeClock();
    const {core, change, app, view} = await openEditor(); change('Discard on departure');
    vi.mocked(core.readDocument).mockRejectedValueOnce('Missing next scene');
    const leave = app.showDocument('other.md'); await flush(); findButton('Discard changes').click(); await leave;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(view.state.doc.toString()).toBe('Discard on departure');
    expect(core.saveDocument).not.toHaveBeenCalled();
    change('Resume drafting'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(core.saveDocument).toHaveBeenCalledWith(session.id, 'scene.md', 'hash-1', 'Resume drafting');
  });
});


describe('editor origin and exact recovery hooks', () => {
  it('credits only actual user events and identifies history and recovery', () => {
    const changed = vi.fn();
    const editor = createEditor(document.createElement('div'), 'Initial', changed, () => {});
    editor.view.dispatch({changes: {from: 0, insert: 'Programmatic '}});
    expect(changed).toHaveBeenLastCalledWith('Programmatic Initial', 'programmatic');
    editor.view.dispatch({changes: {from: 0, insert: 'Typed '}, annotations: Transaction.userEvent.of('input.type')});
    expect(changed).toHaveBeenLastCalledWith('Typed Programmatic Initial', 'user');
    editor.undo(); expect(changed.mock.calls.at(-1)?.[1]).toBe('history');
    editor.replaceText('Recovered\r\nexact\nbytes', 'recovery');
    expect(changed).toHaveBeenLastCalledWith('Recovered\r\nexact\nbytes', 'recovery');
    expect(editor.text()).toBe('Recovered\r\nexact\nbytes');
    editor.destroy();
  });
});


describe('recovery warning and browsing regressions', () => {
  it('keeps a newer failed-staging warning visible after an older save succeeds', async () => {
    fakeClock();
    const {core, change} = await openEditor();
    const save = deferred<Awaited<ReturnType<LocalCore['saveDocument']>>>();
    vi.mocked(core.saveDocument).mockImplementationOnce(() => save.promise);
    change('First'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    vi.mocked(core.stageRecovery).mockRejectedValueOnce('Storage full');
    change('Newer unprotected'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    save.resolve(savedDocument('First')); await flush();
    expect(document.querySelector('.status')?.textContent).toContain('Recovery could not be saved');
    expect(document.querySelector('.editor-toolbar [role="status"]')?.textContent).toBe('Unsaved · autosave paused');
    expect(document.querySelector('.cm-content')?.textContent).toBe('Newer unprotected');
    expect(core.saveDocument).toHaveBeenCalledTimes(1);
  });
  it('allows browsing read-only files and closing when recovery is unavailable', async () => {
    const core = bridge(); vi.mocked(core.readRecovery).mockRejectedValueOnce('Unavailable');
    const {app} = await openEditor(core);
    const reads = vi.mocked(core.readRecovery).mock.calls.length;
    await app.showDocument('notes.txt');
    expect(document.querySelector('.source-text')?.textContent).toContain('Keep — punctuation');
    expect(document.querySelector('.cm-editor')).toBeNull();
    expect(core.readRecovery).toHaveBeenCalledTimes(reads);
    expect(core.stageRecovery).not.toHaveBeenCalled();
    vi.mocked(core.onCloseRequested).mock.calls[0][0](); await flush();
    expect(core.requestClose).toHaveBeenCalledOnce();
  });
  it('removes an obsolete recovery after undoing to disk before navigation', async () => {
    fakeClock();
    const {core, app, change, view} = await openEditor();
    const original = view.state.doc.toString();
    core.saveDocument = vi.fn(async () => { throw 'Conflict'; });
    change('Unsaved'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    change(original); await app.showDocument('other.md');
    expect(await core.readRecovery(session.id, 'scene.md')).toBeNull();
    expect(core.saveDocument).toHaveBeenCalledTimes(1);
    expect(core.readDocument).toHaveBeenLastCalledWith(session.id, 'other.md');
  });
});


describe('bounded autosave while continuously typing', () => {
  it('stages at least every five seconds without waiting for an idle typing gap', async () => {
    fakeClock();
    const {core, change} = await openEditor();
    const steps = AUTOSAVE_MAX_WAIT_MS / 100;
    for (let i = 0; i < steps + 10; i++) {
      change(`Words ${i}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(core.saveDocument).toHaveBeenCalledTimes(1);
    expect(core.stageRecovery).toHaveBeenCalledWith(session.id, 'scene.md', 'hash-1', `Words ${steps - 1}`);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(core.saveDocument).toHaveBeenCalledTimes(2);
    expect(core.saveDocument).toHaveBeenLastCalledWith(session.id, 'scene.md', 'hash-2', `Words ${steps + 9}`);
  });
  it('keeps making bounded recovery snapshots while an earlier manuscript save is stalled', async () => {
    fakeClock();
    const {core, change} = await openEditor();
    const save = deferred<Awaited<ReturnType<LocalCore['saveDocument']>>>();
    core.saveDocument = vi.fn(() => save.promise);
    change('First'); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    const steps = AUTOSAVE_MAX_WAIT_MS / 100;
    for (let i = 0; i < steps * 2; i++) {
      change(`Continuous ${i}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(core.saveDocument).toHaveBeenCalledTimes(1);
    expect(core.stageRecovery).toHaveBeenCalledTimes(3);
    expect((await core.readRecovery(session.id, 'scene.md'))?.text).toBe(`Continuous ${steps * 2 - 1}`);
    save.resolve(savedDocument('First')); await flush();
    expect(document.querySelector('.editor-toolbar [role="status"]')?.textContent).toContain('Unsaved');
  });
});


describe('recovery retries and shutdown', () => {
  it('reloads the latest disk and recovery versions after an unavailable ownership retry', async () => {
    const core = bridge(); vi.mocked(core.readRecovery).mockRejectedValueOnce('Another Studio owns this scene');
    await openEditor(core);
    vi.mocked(core.readDocument).mockResolvedValueOnce(savedDocument('New external disk', 'external-hash'));
    await core.stageRecovery(session.id, 'scene.md', 'hash-1', 'Surviving recovery from first Studio');
    findButton('Retry recovery').click(); await flush();
    expect(document.querySelector('.cm-content')?.textContent).toBe('New external disk');
    expect(document.querySelector('.recovery-notice')?.textContent).toContain('Surviving recovery from first Studio');
    expect(document.querySelector('.recovery-notice')?.textContent).toContain('file on disk changed');
    expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('ignores a late native close callback after this renderer has been destroyed', async () => {
    const {core, app} = await openEditor();
    const close = vi.mocked(core.onCloseRequested).mock.calls[0][0];
    app.destroy(); close(); await flush();
    expect(core.requestClose).not.toHaveBeenCalled();
  });
});

describe('programmatic editor updates', () => {
  it('updates visible word counts without adding daily writing credit', async () => {
    const {view} = await openEditor();
    const progress = document.querySelector('[aria-label="Daily writing goal"]') as HTMLProgressElement;
    const before = progress.value;
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: 'Programmatically supplied words must not earn daily writing credit merely by entering the editor.'}});
    expect(progress.value).toBe(before);
    expect(document.querySelector('.writing-panel')?.textContent).toContain('Scene: 14 words');
  });
});

// These fixtures create only synthetic host responses; no author files are opened.
describe('ms drafting structure and recovery guard', () => {
  const initial = (): import('./localCore').DraftingState => ({
    manifestPath: 'ms/manuscript.json', revision: 'manifest-1', project: 'Draft book', groups: [{id: 'g1', title: 'First chapter'}],
    scenes: [{id: 'scene-b', title: 'Opening', path: 'ms/z-opening.md', groupId: null}, {id: 'scene-a', title: 'Later', path: 'ms/nested/a-later.md', groupId: 'g1'}],
    untrackedPaths: [], missingPaths: [],
  });
  function draftingBridge() {
    const core = bridge();
    core.loadDrafting = vi.fn(async () => initial());
    core.previewDraftingChange = vi.fn(async () => ({id: 'opaque-preview', summary: 'Reorder scene', changes: [{kind: 'order', source: null, destination: 'ms/manuscript.json'}], warnings: []}));
    core.applyDraftingChange = vi.fn(async () => ({state: {...initial(), revision: 'manifest-2', scenes: [...initial().scenes].reverse()}, undoId: 'opaque-undo'}));
    core.undoDraftingChange = vi.fn(async () => initial());
    core.pickDraftingImport = vi.fn(async () => ({id: 'opaque-selection', files: [{name: 'Chosen.md', sizeBytes: 20}]}));
    return core;
  }
  async function setupDrafting(core = draftingBridge()) {
    const app = mountStudio(document.body.firstElementChild as HTMLElement, core);
    await app.selectRepository(async () => ({...session, manifests: []}));
    return {app, core};
  }
  const exact = (text: string) => {
    const match = [...document.querySelectorAll('button')].find(node => node.textContent === text);
    if (!match) throw new Error(`Missing ${text}`); return match;
  };
  function edit(text = 'Still my exact — draft') {
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, annotations: Transaction.userEvent.of('input.type')}); return view;
  }
  function moveLaterSceneEarlier() { document.querySelector<HTMLButtonElement>('[aria-label="Move Later earlier"]')!.click(); }
  it('requires explicit initialization and approval before creating an ms manuscript', async () => {
    const core = draftingBridge(); core.loadDrafting = vi.fn(async () => ({...initial(), revision: null, scenes: []}));
    await setupDrafting(core);
    expect(core.previewDraftingChange).not.toHaveBeenCalled(); expect(core.applyDraftingChange).not.toHaveBeenCalled();
    exact('Create ms manuscript').click(); exact('Preview manuscript').click(); await settle();
    expect(core.previewDraftingChange).toHaveBeenCalledWith(session.id, null, {kind: 'initialize', project: session.name});
    expect(core.applyDraftingChange).not.toHaveBeenCalled();
    exact('Cancel').click(); await settle();
    expect(core.applyDraftingChange).not.toHaveBeenCalled(); expect(document.querySelector<HTMLElement>('.workspace')?.inert).toBe(false);
  });
  it('shows explicit ID order and reorders without including a filename mutation', async () => {
    const {core} = await setupDrafting();
    expect([...document.querySelectorAll('.scene-open')].map(node => node.textContent)).toEqual(['1. Opening', '2. Later']);
    moveLaterSceneEarlier(); await settle();
    expect(core.previewDraftingChange).toHaveBeenCalledWith(session.id, 'manifest-1', {kind: 'reorderScene', sceneId: 'scene-a', beforeId: 'scene-b', groupId: 'g1'});
    expect(core.applyDraftingChange).not.toHaveBeenCalled();
    exact('Apply change').click(); await settle();
    expect(core.applyDraftingChange).toHaveBeenCalledWith(session.id, 'opaque-preview');
    expect([...document.querySelectorAll('.scene-open')].map(node => node.textContent)).toEqual(['1. Later', '2. Opening']);
    expect([...document.querySelectorAll('.scene-path')].map(node => node.textContent)).toEqual(['ms/nested/a-later.md', 'ms/z-opening.md']);
    expect(exact('Undo last change').disabled).toBe(false);
  });
  it('flushes a dirty editor before preview and locks it until cancellation', async () => {
    const {core, app} = await setupDrafting(); await app.showDocument('ms/nested/a-later.md'); edit();
    moveLaterSceneEarlier(); await settle();
    expect(core.saveDocument).toHaveBeenCalledWith(session.id, 'ms/nested/a-later.md', 'hash-1', 'Still my exact — draft');
    expect(vi.mocked(core.saveDocument).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(core.previewDraftingChange!).mock.invocationCallOrder[0]);
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect(document.querySelector<HTMLElement>('.workspace')?.inert).toBe(true);
    exact('Cancel').click(); await settle();
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true');
    expect(core.applyDraftingChange).not.toHaveBeenCalled();
  });
  it('blocks structure while recovery is unresolved and preserves its read-only editor', async () => {
    const {core, app} = await setupDrafting();
    core.readRecovery = vi.fn(async (_id, path) => ({id: 'recover-me', path, baseHash: 'hash-1', text: 'Recovered words', updatedAt: 1}));
    await app.showDocument('ms/nested/a-later.md'); moveLaterSceneEarlier(); await settle();
    expect(core.previewDraftingChange).not.toHaveBeenCalled(); expect(core.discardRecovery).not.toHaveBeenCalled();
    expect(document.querySelector('.status')?.textContent).toContain('Your recovery has been kept');
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect(exact('Restore draft').disabled).toBe(false);
  });
  it('does not preview on save conflict and leaves text and recovery available', async () => {
    const {core, app} = await setupDrafting(); await app.showDocument('ms/nested/a-later.md'); const view = edit();
    core.saveDocument = vi.fn(async () => { throw new Error('Conflict: file changed on disk'); });
    moveLaterSceneEarlier(); await settle();
    expect(core.previewDraftingChange).not.toHaveBeenCalled(); expect(core.stageRecovery).toHaveBeenCalledOnce(); expect(core.discardRecovery).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('Still my exact — draft'); expect(document.querySelector('.status')?.textContent).toContain('Conflict');
    expect(document.querySelector<HTMLElement>('.workspace')?.inert).toBe(false);
  });
  it('blocks structure if recovery cleanup fails even when manuscript save succeeds', async () => {
    const {core, app} = await setupDrafting(); await app.showDocument('ms/nested/a-later.md'); edit();
    core.discardRecovery = vi.fn(async () => { throw new Error('Recovery cleanup refused'); });
    moveLaterSceneEarlier(); await settle();
    expect(core.saveDocument).toHaveBeenCalledOnce(); expect(core.previewDraftingChange).not.toHaveBeenCalled();
    expect(document.querySelector('.status')?.textContent).toContain('recovery are preserved');
  });
  it('reopens a moved scene by stable identity and uses the destination for later saves', async () => {
    const {core, app} = await setupDrafting(); await app.showDocument('ms/nested/a-later.md');
    core.previewDraftingChange = vi.fn(async () => ({id: 'move-preview', summary: 'Move Later', changes: [{kind: 'move', source: 'ms/nested/a-later.md', destination: 'ms/other/later.md'}], warnings: []}));
    core.applyDraftingChange = vi.fn(async () => ({state: {...initial(), revision: 'manifest-2', scenes: initial().scenes.map(scene => scene.id === 'scene-a' ? {...scene, path: 'ms/other/later.md'} : scene)}, undoId: 'move-undo'}));
    moveLaterSceneEarlier(); await settle(); exact('Apply change').click(); await settle();
    expect(core.readDocument).toHaveBeenLastCalledWith(session.id, 'ms/other/later.md');
    edit('After moving'); await app.saveCurrent();
    expect(core.saveDocument).toHaveBeenLastCalledWith(session.id, 'ms/other/later.md', 'hash-1', 'After moving');
  });
  it('does not reopen an old pending read after a structural change', async () => {
    const {core, app} = await setupDrafting(); await app.showDocument('ms/nested/a-later.md');
    const read = core.readDocument; let resolve!: (doc: Awaited<ReturnType<LocalCore['readDocument']>>) => void;
    core.readDocument = vi.fn((id, path) => path === 'slow.md' ? new Promise<Awaited<ReturnType<LocalCore['readDocument']>>>(done => { resolve = done; }) : read(id, path));
    const slow = app.showDocument('slow.md'); await settle(); moveLaterSceneEarlier(); await settle(); exact('Apply change').click(); await settle();
    resolve({path: 'slow.md', text: 'STALE DOC', sizeBytes: 9, frontmatter: null, generatedCompatibility: false, contentHash: 'old'}); await slow;
    expect(document.querySelector('.cm-content')?.textContent).not.toContain('STALE DOC');
    expect(document.querySelector('.preview .path')?.textContent).toBe('ms/nested/a-later.md');
  });
  it('shows collision details and never applies a rejected preview', async () => {
    const {core, app} = await setupDrafting(); await app.showDocument('ms/nested/a-later.md');
    core.previewDraftingChange = vi.fn(async () => { throw new Error('Collision: ms/existing.md already exists'); });
    moveLaterSceneEarlier(); await settle();
    expect(core.applyDraftingChange).not.toHaveBeenCalled(); expect(document.querySelector('.status')?.textContent).toContain('Collision: ms/existing.md');
    expect(document.querySelector('.preview .path')?.textContent).toBe('ms/nested/a-later.md');
  });
  it('imports external files only through opaque native selection authorization', async () => {
    const {core} = await setupDrafting(); exact('Import files…').click(); await settle();
    expect(core.pickDraftingImport).toHaveBeenCalledWith(session.id); expect(document.body.textContent).toContain('Their originals stay where they are');
    exact('Preview import').click(); await settle();
    expect(core.previewDraftingChange).toHaveBeenCalledWith(session.id, 'manifest-1', {kind: 'importExternal', selectionId: 'opaque-selection', destination: 'ms', groupId: null, beforeId: null});
    expect(core.applyDraftingChange).not.toHaveBeenCalled(); exact('Cancel').click(); await settle();
  });
  it('keeps guarded undo available when changed files make undo fail', async () => {
    const {core} = await setupDrafting(); moveLaterSceneEarlier(); await settle(); exact('Apply change').click(); await settle();
    core.undoDraftingChange = vi.fn(async () => { throw new Error('File changed since operation'); });
    exact('Undo last change').click(); await settle(); expect(core.undoDraftingChange).not.toHaveBeenCalled();
    exact('Apply change').click(); await settle();
    expect(core.undoDraftingChange).toHaveBeenCalledWith(session.id, 'opaque-undo'); expect(exact('Undo last change').disabled).toBe(false);
    expect(document.querySelector('.status')?.textContent).toContain('File changed since operation');
  });
  it('offers interrupted rollback before any other structure action', async () => {
    const core = draftingBridge(); core.loadDrafting = vi.fn(async () => ({...initial(), recoveryRequired: true})); await setupDrafting(core);
    expect(document.querySelector('.drafting-actions')).toBeNull(); exact('Preview rollback of interrupted change').click(); await settle();
    expect(core.previewDraftingChange).toHaveBeenCalledWith(session.id, 'manifest-1', {kind: 'recoverInterrupted'});
    exact('Cancel').click(); await settle();
  });
  function transfer() {
    const values = new Map<string, string>();
    return {setData: (type: string, value: string) => { values.set(type, value); }, getData: (type: string) => values.get(type) ?? '', get types() { return [...values.keys()]; }, files: [] as {name: string}[], effectAllowed: '', dropEffect: ''};
  }
  function dragEvent(target: Element, type: string, dataTransfer: ReturnType<typeof transfer>) {
    const event = new Event(type, {bubbles: true, cancelable: true}); Object.defineProperty(event, 'dataTransfer', {value: dataTransfer}); target.dispatchEvent(event);
  }
  it('moves repository drags using the scoped source and previews before mutation', async () => {
    const {core} = await setupDrafting(); const data = transfer();
    dragEvent(document.querySelector('[aria-label="Read file README.md"]')!, 'dragstart', data);
    expect(data.getData('application/x-heinlein-repository-entry')).toBe(JSON.stringify({repositoryId: session.id, path: 'README.md'}));
    dragEvent(document.querySelector('.drafting-drop')!, 'drop', data);
    expect(document.body.textContent).toContain('Files referenced by a legacy manuscript cannot be moved');
    exact('Preview import').click(); await settle();
    expect(core.previewDraftingChange).toHaveBeenCalledWith(session.id, 'manifest-1', {kind: 'importRepository', paths: ['README.md'], destination: 'ms', mode: 'move', groupId: null, beforeId: null});
    expect(core.applyDraftingChange).not.toHaveBeenCalled(); exact('Cancel').click(); await settle();
  });
  it('reorders an outline drag by stable ID with no filename change', async () => {
    const {core} = await setupDrafting(); const data = transfer();
    dragEvent(document.querySelector('[data-scene-id="scene-a"] .scene-open')!, 'dragstart', data);
    dragEvent(document.querySelector('[data-scene-id="scene-b"]')!, 'drop', data); await settle();
    expect(core.previewDraftingChange).toHaveBeenCalledWith(session.id, 'manifest-1', {kind: 'reorderScene', sceneId: 'scene-a', beforeId: 'scene-b', groupId: 'g1'});
    exact('Cancel').click(); await settle();
  });
  it('ignores repository drags from another session', async () => {
    const {core} = await setupDrafting(); const data = transfer(); data.setData('application/x-heinlein-repository-entry', JSON.stringify({repositoryId: 'other-session', path: 'README.md'}));
    dragEvent(document.querySelector('.drafting-drop')!, 'drop', data); await settle();
    expect(document.querySelector('.drafting-dialog')).toBeNull(); expect(core.previewDraftingChange).not.toHaveBeenCalled();
  });
  it('copies a trusted Finder drop using the native selection without opening another picker', async () => {
    const core = draftingBridge(); let drop!: (selection: import('./localCore').DraftingSelection) => void;
    core.onDraftingFilesDropped = vi.fn(async callback => { drop = callback; return () => {}; });
    await setupDrafting(core); drop({id: 'authorized-drop', files: [{name: 'Finder scene.md', sizeBytes: 80}]}); await settle();
    expect(core.pickDraftingImport).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('Their originals stay where they are');
    exact('Preview import').click(); await settle();
    expect(core.previewDraftingChange).toHaveBeenCalledWith(session.id, 'manifest-1', {kind: 'importExternal', selectionId: 'authorized-drop', destination: 'ms', groupId: null, beforeId: null});
    exact('Cancel').click(); await settle();
  });
  it('never constructs an external import from a browser file path', async () => {
    const {core} = await setupDrafting(); const data = transfer(); data.files.push({name: 'browser-scene.md'});
    dragEvent(document.querySelector('.drafting-drop')!, 'drop', data); await settle();
    expect(core.previewDraftingChange).not.toHaveBeenCalled(); expect(core.pickDraftingImport).not.toHaveBeenCalled();
    expect(document.querySelector('.status')?.textContent).toContain('native picker');
  });
  it('offers a keyboard-accessible independent legacy copy without moving originals', async () => {
    const {core} = await setupDrafting(); exact('Copy legacy scenes…').click(); await settle();
    const check = document.querySelector<HTMLInputElement>('.repository-choice input')!; check.checked = true; check.dispatchEvent(new Event('change'));
    exact('Choose destination').click();
    expect(document.body.textContent).toContain('The old manuscript stays unchanged; these copies are not synchronized');
    exact('Preview import').click(); await settle();
    expect(core.previewDraftingChange).toHaveBeenCalledWith(session.id, 'manifest-1', {kind: 'importRepository', paths: ['README.md'], destination: 'ms', mode: 'copy', groupId: null, beforeId: null});
    exact('Cancel').click(); await settle();
  });
  it('prevents duplicate native picker requests while a selection is pending', async () => {
    const core = draftingBridge(); let resolve!: (selection: null) => void;
    core.pickDraftingImport = vi.fn(() => new Promise<null>(done => { resolve = done; }));
    await setupDrafting(core); exact('Import files…').click(); exact('Import files…').click();
    expect(core.pickDraftingImport).toHaveBeenCalledOnce(); resolve(null); await settle();
  });
  it('surfaces native drop authorization failures', async () => {
    const core = draftingBridge(); let failed!: (message: string) => void;
    core.onDraftingImportError = vi.fn(async callback => { failed = callback; return () => {}; });
    await setupDrafting(core); failed('Folders are unsupported; choose Markdown files');
    expect(document.querySelector('.status')?.textContent).toContain('Native import failed: Folders are unsupported');
    expect(core.previewDraftingChange).not.toHaveBeenCalled();
  });
  it('keeps a recovery-read failure visible after a successful structure apply', async () => {
    const {core, app} = await setupDrafting(); await app.showDocument('ms/nested/a-later.md');
    core.readRecovery = vi.fn(async () => { throw new Error('Recovery owned by another window'); });
    moveLaterSceneEarlier(); await settle(); exact('Apply change').click(); await settle();
    expect(document.querySelector('.status')?.textContent).toContain('Change saved locally, but the view could not refresh');
    expect(document.querySelector('.status')?.textContent).toContain('Recovery owned by another window');
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
  });
  it('creates a scene only after preview, then opens its exact requested path', async () => {
    const {core} = await setupDrafting();
    core.applyDraftingChange = vi.fn(async () => ({state: {...initial(), revision: 'manifest-2', scenes: [...initial().scenes, {id: 'new-scene-id', title: 'Untitled scene', path: 'ms/untitled-scene.md', groupId: null}]}, undoId: 'create-undo'}));
    exact('New scene').click(); exact('Preview new scene').click(); await settle();
    expect(core.previewDraftingChange).toHaveBeenCalledWith(session.id, 'manifest-1', {kind: 'createScene', title: 'Untitled scene', path: 'ms/untitled-scene.md', groupId: null, beforeId: null});
    expect(core.applyDraftingChange).not.toHaveBeenCalled(); exact('Apply change').click(); await settle();
    expect(core.readDocument).toHaveBeenLastCalledWith(session.id, 'ms/untitled-scene.md');
    expect(document.querySelector('.preview .path')?.textContent).toBe('ms/untitled-scene.md');
  });
  it('blocks native close throughout an approved structure operation', async () => {
    const core = draftingBridge(); let requestClose!: () => void;
    core.onCloseRequested = vi.fn(async callback => { requestClose = callback; return () => {}; });
    await setupDrafting(core); moveLaterSceneEarlier(); await settle(); requestClose(); await settle();
    expect(core.requestClose).not.toHaveBeenCalled(); expect(core.setUnsavedChanges).toHaveBeenLastCalledWith(false);
    exact('Cancel').click(); await settle(); expect(core.setUnsavedChanges).toHaveBeenLastCalledWith(false);
  });

  it('synchronizes actual editor dirtiness before native preview, apply, and undo gates', async () => {
    const core = draftingBridge(); let nativeDirty = false;
    core.setUnsavedChanges = vi.fn(async dirty => { await settle(); nativeDirty = dirty; });
    const preview = core.previewDraftingChange!; const apply = core.applyDraftingChange!; const undo = core.undoDraftingChange!;
    const cleanEditor = () => { if (nativeDirty) throw new Error('Save or discard the current scene before changing manuscript structure'); };
    core.previewDraftingChange = vi.fn(async (repositoryId, revision, change) => { cleanEditor(); return preview(repositoryId, revision, change); });
    core.applyDraftingChange = vi.fn(async (repositoryId, previewId) => { cleanEditor(); return apply(repositoryId, previewId); });
    core.undoDraftingChange = vi.fn(async (repositoryId, undoId) => { cleanEditor(); return undo(repositoryId, undoId); });
    const {app} = await setupDrafting(core); await app.showDocument('ms/nested/a-later.md'); edit('Dirty before structure');
    moveLaterSceneEarlier();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Review manuscript change"]')).not.toBeNull());
    expect(nativeDirty).toBe(false); expect(core.saveDocument).toHaveBeenCalledOnce();
    exact('Apply change').click(); await vi.waitFor(() => expect(exact('Undo last change').disabled).toBe(false));
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.workspace')?.inert).toBe(false));
    exact('Undo last change').click(); await vi.waitFor(() => expect(document.querySelector('[aria-label="Review manuscript change"]')).not.toBeNull());
    exact('Apply change').click(); await vi.waitFor(() => expect(core.undoDraftingChange).toHaveBeenCalledOnce());
    expect(nativeDirty).toBe(false); expect(document.querySelector('.status')?.textContent).not.toContain('Save or discard');
  });

  it('clears an earlier undo token after interrupted rollback and makes no undo promise', async () => {
    const {core} = await setupDrafting(); moveLaterSceneEarlier(); await settle(); exact('Apply change').click(); await settle();
    expect(exact('Undo last change').disabled).toBe(false);
    core.loadDrafting = vi.fn(async () => ({...initial(), revision: 'interrupted-revision', recoveryRequired: true}));
    exact('Refresh ms').click(); await settle();
    core.previewDraftingChange = vi.fn(async () => ({id: 'rollback-preview', summary: 'Interrupted change rolled back', changes: [{kind: 'restore', source: 'ms/manuscript.json', destination: 'ms/manuscript.json'}], warnings: []}));
    core.applyDraftingChange = vi.fn(async () => ({state: initial(), undoId: null}));
    exact('Preview rollback of interrupted change').click(); await settle(); exact('Apply change').click(); await settle();
    expect(exact('Undo last change').disabled).toBe(true);
    expect(document.querySelector('.status')?.textContent).toBe('Interrupted change rolled back · Saved locally.');
    expect(document.querySelector('.status')?.textContent).not.toContain('Undo is available');
    exact('Undo last change').click(); expect(core.undoDraftingChange).not.toHaveBeenCalled();
  });

});

describe('trusted local proposal review', () => {
  const origin = {kind: 'localMcp' as const, sessionId: 'unverified-session', clientLabel: '<script>hostile client</script>', identityAssurance: 'unverifiedLocalProcess' as const};
  const view = {id: 'native-review', kind: 'apply' as const, proposalId: 'proposal-id', path: 'scene.md', baseHash: 'hash-1', replacementHash: 'replacement-hash', diffHash: 'exact-diff-hash', baseText: '# A scene\nKeep — punctuation.', replacementText: '<img src=x onerror=evil()>\nProposed — words.', origin, expiresAtMs: Date.now() + 300000, parentReceiptId: null};
  const receipt = {id: 'receipt-id', kind: 'apply' as const, proposalId: view.proposalId, path: view.path, baseHash: view.baseHash, replacementHash: view.replacementHash, diffHash: view.diffHash, origin, parentReceiptId: null, status: 'completed' as const, message: null, createdAtMs: Date.now(), revertAvailable: true};
  function proposalBridge() {
    const core = bridge();
    core.listProposals = vi.fn(async () => ({pending: [{...view, id: view.proposalId, createdAtMs: Date.now()}], receipts: []}));
    core.reviewProposal = vi.fn(async () => view);
    core.reviewProposalRevert = vi.fn(async () => ({...view, id: 'native-revert', kind: 'revert' as const, baseHash: view.replacementHash, replacementHash: view.baseHash, baseText: view.replacementText, replacementText: view.baseText, diffHash: 'reverse-diff', parentReceiptId: receipt.id}));
    core.applyProposalReview = vi.fn(async () => ({receipt, warning: null}));
    core.cancelProposalReview = vi.fn(async () => {});
    return core;
  }
  async function setup(core = proposalBridge()) {
    const app = mountStudio(document.body.firstElementChild as HTMLElement, core);
    await app.selectRepository(async () => ({...session, manifests: []})); await app.showDocument('scene.md');
    const editor = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
    const edit = (text: string) => editor.dispatch({changes: {from: 0, to: editor.state.doc.length, insert: text}, annotations: Transaction.userEvent.of('input.type')});
    return {core, app, editor, edit};
  }
  async function openReview() { findButton('Proposed revisions').click(); await settle(); findButton('Review proposal').click(); await settle(); }
  it('displays literal whole-scene bytes with unverified attribution and exact native binding', async () => {
    const {core} = await setup(); await openReview();
    const modal = document.querySelector('[aria-label="Review whole-scene proposal"]')!;
    expect([...modal.querySelectorAll('pre')].map(n => n.textContent)).toEqual([view.baseText, view.replacementText]);
    expect(modal.textContent).toContain('Unverified local MCP client: <script>hostile client</script>');
    expect(modal.querySelector('img, script')).toBeNull();
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    findButton('Continue to native confirmation').click(); await settle();
    expect(core.applyProposalReview).toHaveBeenCalledWith(session.id, {reviewId: view.id, proposalId: view.proposalId, baseHash: view.baseHash, replacementHash: view.replacementHash, diffHash: view.diffHash});
    expect(core.cancelProposalReview).toHaveBeenCalledWith(session.id, view.id);
  });
  it('cancels without applying and returns the unchanged editable buffer', async () => {
    const {core, editor} = await setup(); await openReview();
    const review = document.querySelector('[aria-label="Review whole-scene proposal"]')!;
    [...review.querySelectorAll('button')].find(node => node.textContent === 'Cancel')!.click(); await settle();
    expect(core.applyProposalReview).not.toHaveBeenCalled(); expect(core.cancelProposalReview).toHaveBeenCalledWith(session.id, view.id);
    expect(editor.state.doc.toString()).toBe(view.baseText); expect(editor.contentDOM.getAttribute('contenteditable')).toBe('true');
  });
  it('blocks dirty scenes without autosaving or replacing the buffer', async () => {
    const {core, edit, editor} = await setup(); edit('My unsaved — draft'); await openReview();
    expect(core.reviewProposal).not.toHaveBeenCalled(); expect(core.applyProposalReview).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled();
    expect(editor.state.doc.toString()).toBe('My unsaved — draft'); expect(document.querySelector('.status')?.textContent).toContain('Save your scene');
  });
  it('blocks pending recovery even with a clean visible file', async () => {
    const core = proposalBridge(); core.readRecovery = vi.fn(async () => ({id: 'recovery', path: 'scene.md', baseHash: 'hash-1', text: 'Recovered draft', updatedAt: 1}));
    await setup(core); await openReview();
    expect(core.reviewProposal).not.toHaveBeenCalled(); expect(core.discardRecovery).not.toHaveBeenCalled();
    expect(document.querySelector('.recovery-notice')?.textContent).toContain('Recovered draft');
  });
  it('blocks proposal review while a manuscript save is pending', async () => {
    const {core, app, edit} = await setup(); let finish!: (value: Awaited<ReturnType<LocalCore['saveDocument']>>) => void;
    core.saveDocument = vi.fn(() => new Promise<Awaited<ReturnType<LocalCore['saveDocument']>>>(resolve => { finish = resolve; }));
    edit('Saving draft'); const saving = app.saveCurrent(); await settle(); await openReview();
    expect(core.reviewProposal).not.toHaveBeenCalled();
    finish({path: 'scene.md', text: 'Saving draft', contentHash: 'saved', sizeBytes: 12, frontmatter: null, generatedCompatibility: false}); await saving;
  });
  it('does not falsify native dirty state while review is busy and reopens successful source cleanly', async () => {
    const {core} = await setup(); await settle(); vi.mocked(core.setUnsavedChanges).mockClear();
    await openReview(); expect(vi.mocked(core.setUnsavedChanges).mock.calls.some(([dirty]) => dirty)).toBe(false);
    core.applyProposalReview = vi.fn(async () => {
      expect(vi.mocked(core.setUnsavedChanges).mock.calls.some(([dirty]) => dirty)).toBe(false);
      core.readDocument = vi.fn(async (_id, path) => ({path, text: view.replacementText, contentHash: view.replacementHash, sizeBytes: 50, frontmatter: null, generatedCompatibility: false})); return {receipt, warning: null};
    });
    findButton('Continue to native confirmation').click(); await settle();
    const current = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
    expect(current.state.doc.toString()).toBe(view.replacementText); expect(document.querySelector('.editor-toolbar .badge')?.textContent).toBe('Saved locally');
    expect(current.contentDOM.getAttribute('contenteditable')).toBe('true'); expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('preserves unexpected late editor text instead of replacing it after an apply', async () => {
    const {core, edit, editor} = await setup(); let finish!: (value: {receipt: typeof receipt; warning: null}) => void;
    core.applyProposalReview = vi.fn(() => new Promise<{receipt: typeof receipt; warning: null}>(resolve => { finish = resolve; }));
    await openReview(); findButton('Continue to native confirmation').click(); await settle();
    // Programmatic editor events can still arrive even while DOM editing is disabled.
    edit('Late author — words'); finish({receipt, warning: null}); await settle();
    expect(editor.state.doc.toString()).toBe('Late author — words'); expect(core.readDocument).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.status')?.textContent).toContain('newer editor text was preserved');
    expect(document.querySelector('.editor-toolbar .badge')?.textContent).toContain('autosave paused');
  });
  it('keeps stale or failed native review from causing a replacement or retry', async () => {
    const {core, editor} = await setup(); core.applyProposalReview = vi.fn(async () => { throw new Error('Scene changed on disk'); });
    await openReview(); findButton('Continue to native confirmation').click(); await settle();
    expect(core.applyProposalReview).toHaveBeenCalledOnce(); expect(core.readDocument).toHaveBeenCalledTimes(1); expect(editor.state.doc.toString()).toBe(view.baseText);
    expect(document.querySelector('.status')?.textContent).toContain('Check the local receipts');
  });
  it('shows native cancel without touching the current scene', async () => {
    const {core, editor} = await setup(); core.applyProposalReview = vi.fn(async () => null);
    await openReview(); findButton('Continue to native confirmation').click(); await settle();
    expect(editor.state.doc.toString()).toBe(view.baseText); expect(core.readDocument).toHaveBeenCalledTimes(1); expect(document.querySelector('.status')?.textContent).toContain('Native confirmation canceled');
  });
  it('shows immutable attributed receipts and reviews exact guarded reversal', async () => {
    const {core} = await setup(); core.listProposals = vi.fn(async () => ({pending: [], receipts: [receipt]}));
    findButton('Proposed revisions').click(); await settle();
    expect(document.body.textContent).toContain('not an authenticated revision ledger'); expect(document.body.textContent).toContain('Author action: Studio native confirmation');
    expect(document.querySelector('.proposal-receipt script')).toBeNull(); findButton('Review revert').click(); await settle();
    const modal = document.querySelector('[aria-label="Review guarded revert"]')!;
    expect([...modal.querySelectorAll('pre')].map(n => n.textContent)).toEqual([view.replacementText, view.baseText]);
    expect(core.reviewProposalRevert).toHaveBeenCalledWith(session.id, receipt.id); findButton('Cancel').click(); await settle();
  });
  it('never offers revert for an uncertain receipt', async () => {
    const {core} = await setup(); core.listProposals = vi.fn(async () => ({pending: [], receipts: [{...receipt, status: 'uncertain' as const, revertAvailable: false, message: 'Inspect current source'}]}));
    findButton('Proposed revisions').click(); await settle(); expect(document.body.textContent).toContain('uncertain');
    expect([...document.querySelectorAll('button')].some(n => n.textContent === 'Review revert')).toBe(false);
  });
  it('drops old list responses on repository switch', async () => {
    const {core, app} = await setup(); let finish!: (value: Awaited<ReturnType<NonNullable<LocalCore['listProposals']>>>) => void;
    core.listProposals = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<LocalCore['listProposals']>>>>(resolve => { finish = resolve; }));
    findButton('Proposed revisions').click(); await settle(); await app.selectRepository(async () => ({...session, id: 'new-session', manifests: []}));
    finish({pending: [{...view, id: view.proposalId, createdAtMs: 1}], receipts: []}); await settle();
    expect(document.querySelector('.proposal-dialog')).toBeNull();
  });
});
