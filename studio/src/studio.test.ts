// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    readDocument: vi.fn(async (_id, path) => ({path, text: '# A scene\nKeep — punctuation.', sizeBytes: 31, frontmatter: '{"id":"scene-id"}', generatedCompatibility: false})),
    loadManuscript: vi.fn(async () => manuscript),
  };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
function findButton(text: string) { const result = [...document.querySelectorAll('button')].find(node => node.textContent?.includes(text)); if (!result) throw new Error(`Missing button ${text}`); return result; }
beforeEach(() => { document.body.replaceChildren(document.createElement('div')); });

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
    core.readDocument = vi.fn(async (_id, path) => ({path, text: attack, sizeBytes: 100, frontmatter: '<b>raw metadata</b>', generatedCompatibility: true}));
    mountStudio(document.body.firstElementChild as HTMLElement, core); findButton('Open Folder').click(); await settle();
    findButton('Read generated chapter').click(); await settle();
    expect(document.querySelector('.source-text')?.textContent).toBe(attack);
    expect(document.querySelector('.frontmatter')?.textContent).toBe('<b>raw metadata</b>');
    expect(document.querySelector('.preview img, .preview script, .preview b, .preview a')).toBeNull();
    expect(document.querySelector('.badge')?.textContent).toBe('Generated compatibility file · Read-only');
    expect(document.querySelector('textarea, input, [contenteditable]')).toBeNull();
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
    resolve({path: 'old.md', text: 'STALE CONTENT', sizeBytes: 13, frontmatter: null, generatedCompatibility: false}); await old;
    expect(document.body.textContent).not.toContain('STALE CONTENT');
    expect(document.querySelector('.files h2')?.textContent).toBe('New book');
  });
  it('ignores out-of-order document responses within the same repository', async () => {
    const core = bridge(); const pending: Record<string, (value: Awaited<ReturnType<LocalCore['readDocument']>>) => void> = {};
    core.readDocument = vi.fn((_id, path) => new Promise<Awaited<ReturnType<LocalCore['readDocument']>>>(done => { pending[path] = done; }));
    const app = mountStudio(document.body.firstElementChild as HTMLElement, core); await app.selectRepository(async () => session);
    const old = app.showDocument('old.md'); const newer = app.showDocument('new.md');
    pending['new.md']({path: 'new.md', text: 'NEW', sizeBytes: 3, frontmatter: null, generatedCompatibility: false}); await newer;
    pending['old.md']({path: 'old.md', text: 'OLD', sizeBytes: 3, frontmatter: null, generatedCompatibility: false}); await old;
    expect(document.querySelector('.source-text')?.textContent).toBe('NEW');
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
});
