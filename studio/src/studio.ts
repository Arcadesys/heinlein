import type { LocalCore, RepositorySession, Manuscript, Document } from './localCore';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
function button(label: string, action: () => void, className = '') {
  const node = el('button', label, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
const basename = (path: string) => path.split('/').pop() || path;
const parentPath = (path: string) => path.split('/').slice(0, -1).join('/');

export function mountStudio(root: HTMLElement, core: LocalCore) {
  let generation = 0;
  let selecting = false;
  let repository: RepositorySession | null = null;
  let directoryRequest = 0;
  let documentRequest = 0;
  let manuscriptRequest = 0;
  const header = el('header', '', 'topbar');
  const brand = el('div');
  brand.append(el('p', 'HEINLEIN', 'eyebrow'), el('h1', 'Studio'), el('p', 'Your manuscript, close at hand.', 'muted'));
  const open = button('Open Folder…', () => { void selectRepository(() => core.pickRepository()); }, 'primary');
  header.append(brand, open);
  const banner = el('p', 'READ-ONLY PREVIEW · Local files stay on your computer', 'safety-banner');
  const status = el('p', 'Choose a repository folder to begin.', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const recent = el('section', '', 'recent');
  recent.setAttribute('aria-label', 'Recent folders');
  const layout = el('main', '', 'workspace');
  const files = el('section', '', 'panel files');
  files.setAttribute('aria-label', 'Repository files');
  const repoName = el('h2', 'Repository');
  const directoryPath = el('p', 'No folder selected', 'path');
  const listing = el('div', '', 'file-list');
  files.append(repoName, directoryPath, listing);
  const manuscriptPane = el('section', '', 'panel manuscript');
  manuscriptPane.setAttribute('aria-label', 'Manuscript order');
  const manifests = el('div', '', 'manifest-picker');
  const outline = el('div');
  outline.append(el('p', 'Open a folder with a scene-manifest.json to browse manuscript order.', 'empty'));
  manuscriptPane.append(el('h2', 'Manuscript'), manifests, outline);
  const preview = el('section', '', 'panel preview');
  preview.setAttribute('aria-label', 'Document preview');
  resetPreview();
  layout.append(files, manuscriptPane, preview);
  const footer = el('footer', 'Pass 1 · Repository browser · No editing, publishing, or AI actions');
  root.replaceChildren(header, banner, recent, status, layout, footer);

  function resetPreview() {
    preview.replaceChildren(el('p', 'SOURCE PREVIEW', 'eyebrow'), el('h2', 'A quiet place to read'), el('p', 'Select a scene or file. Source text is displayed exactly as stored, including Markdown and frontmatter.', 'empty'));
  }
  function reportError(error: unknown) {
    status.textContent = `Unable to open: ${typeof error === 'string' ? error : error instanceof Error ? error.message : 'The local host rejected this request.'}`;
    status.classList.add('error');
  }
  async function refreshRecent() {
    try {
      const items = await core.recentRepositories();
      recent.replaceChildren(el('span', 'Recent folders', 'muted'));
      if (!items.length) recent.append(el('span', 'None yet', 'muted'));
      for (const item of items) {
        const entry = button(item.name, () => { void selectRepository(() => core.openRecentRepository(item.id)); });
        entry.disabled = selecting;
        recent.append(entry);
      }
    } catch (error) { reportError(error); }
  }
  async function selectRepository(select: () => Promise<RepositorySession | null>) {
    if (selecting) return;
    selecting = true;
    const current = ++generation;
    open.disabled = true;
    recent.querySelectorAll('button').forEach(node => { node.disabled = true; });
    // Block navigation while the host may be switching its selected root.
    layout.inert = true;
    status.classList.remove('error');
    status.textContent = 'Opening folder…';
    try {
      const selected = await select();
      if (current !== generation) return;
      if (!selected) { status.textContent = repository ? `${repository.name} · Read-only` : 'Folder selection canceled.'; return; }
      repository = selected;
      resetPreview();
      listing.replaceChildren();
      outline.replaceChildren();
      manifests.replaceChildren();
      repoName.textContent = selected.name;
      directoryPath.textContent = '/';
      for (const path of selected.manifests) {
        manifests.append(button(path, () => { void showManuscript(path); }, 'manifest-button'));
      }
      if (!selected.manifests.length) outline.append(el('p', selected.warning ? 'Manuscript discovery incomplete. You can still browse and read repository files.' : 'No scene manifest found. You can still browse and read repository files.', 'empty'));
      await Promise.all([showDirectory(''), selected.manifests[0] ? showManuscript(selected.manifests[0]) : Promise.resolve()]);
      if (current === generation && !status.classList.contains('error')) status.textContent = `${selected.name} · Read-only${selected.warning ? ` · ${selected.warning}` : ''}`;
      await refreshRecent();
    } catch (error) { if (current === generation) reportError(error); }
    finally { if (current === generation) { selecting = false; open.disabled = false; layout.inert = false; recent.querySelectorAll('button').forEach(node => { node.disabled = false; }); } }
  }
  async function showDirectory(path: string) {
    const current = generation;
    const request = ++directoryRequest;
    try {
      const entries = await core.listDirectory(repository!.id, path);
      if (current !== generation || request !== directoryRequest) return;
      directoryPath.textContent = path || '/';
      listing.replaceChildren();
      if (path) listing.append(button('↑ Parent folder', () => { void showDirectory(parentPath(path)); }, 'file-entry parent'));
      for (const entry of entries) {
        const folder = entry.kind === 'directory';
        const item = button(`${folder ? '▸' : '·'} ${entry.name}`, () => { void (folder ? showDirectory(entry.path) : showDocument(entry.path)); }, 'file-entry');
        item.setAttribute('aria-label', `${folder ? 'Open folder' : 'Read file'} ${entry.name}`);
        listing.append(item);
      }
      if (!entries.length) listing.append(el('p', 'This folder is empty.', 'empty'));
    } catch (error) { if (current === generation && request === directoryRequest) reportError(error); }
  }
  async function showDocument(path: string) {
    const current = generation;
    const request = ++documentRequest;
    status.classList.remove('error');
    status.textContent = `Reading ${path}…`;
    preview.replaceChildren(el('p', 'SOURCE PREVIEW', 'eyebrow'), el('h2', 'Reading source…'), el('p', path, 'path'));
    try {
      const doc = await core.readDocument(repository!.id, path);
      if (current !== generation || request !== documentRequest) return;
      renderDocument(doc);
      status.textContent = `Read ${doc.path} · ${doc.sizeBytes.toLocaleString()} bytes`;
    } catch (error) { if (current === generation && request === documentRequest) reportError(error); }
  }
  function renderDocument(doc: Document) {
    const title = el('h2', basename(doc.path));
    title.tabIndex = -1;
    const source = el('p', doc.path, 'path');
    const badge = el('p', doc.generatedCompatibility ? 'Generated compatibility file · Read-only' : 'Source file · Read-only', 'badge');
    const metadata = el('details', '', 'metadata');
    metadata.append(el('summary', 'Frontmatter & source metadata'), el('p', `${doc.sizeBytes.toLocaleString()} bytes · Raw UTF-8 source`), el('pre', doc.frontmatter ?? 'No frontmatter', 'frontmatter'));
    const text = el('pre', doc.text, 'source-text');
    text.tabIndex = 0;
    text.setAttribute('aria-label', 'Read-only raw source');
    // Never interpret manuscript HTML, scripts, links, or embedded instructions.
    preview.replaceChildren(el('p', 'SOURCE PREVIEW', 'eyebrow'), title, source, badge, metadata, text);
    title.focus({ preventScroll: true });
  }
  async function showManuscript(path: string) {
    const current = generation;
    const request = ++manuscriptRequest;
    try {
      const book = await core.loadManuscript(repository!.id, path);
      if (current !== generation || request !== manuscriptRequest) return;
      renderManuscript(book);
    } catch (error) { if (current === generation && request === manuscriptRequest) { outline.replaceChildren(el('p', 'Manuscript could not be loaded. Browse files or choose another manifest.', 'empty')); reportError(error); } }
  }
  function renderManuscript(book: Manuscript) {
    outline.replaceChildren(el('h3', book.project), el('p', `Manifest order · Schema ${book.schemaVersion}`, 'muted'));
    for (const volume of book.volumes) {
      const group = el('details', '', 'volume');
      group.open = true;
      group.append(el('summary', `Volume ${volume.number} · ${volume.title}`));
      for (const chapter of volume.chapters) {
        const section = el('details', '', 'chapter');
        section.append(el('summary', `${chapter.number}. ${chapter.title}`));
        const scenes = el('ol', '', 'scene-list');
        for (const [index, scene] of chapter.scenes.entries()) {
          const item = el('li');
          const sceneButton = button(`Scene ${index + 1} · ${basename(scene.path)}`, () => { void showDocument(scene.path); });
          sceneButton.title = scene.path;
          item.append(sceneButton);
          scenes.append(item);
        }
        section.append(scenes, button('Read generated chapter', () => { void showDocument(chapter.source); }, 'compatibility'));
        group.append(section);
      }
      outline.append(group);
    }
  }
  if (core.available()) void refreshRecent();
  else {
    open.disabled = true;
    status.textContent = 'Open Heinlein Studio in its native desktop app to choose local folders. Browser preview has no filesystem access.';
  }
  return { showDirectory, showDocument, showManuscript, selectRepository };
}
