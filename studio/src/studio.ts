import { createEditor } from './editor';
import type { LocalCore, RepositorySession, Manuscript, Document } from './localCore';
import { FONT_ROLES, applyChoices, cleanFamily, loadChoices, saveChoices, type FontChoices } from './fonts';
import { ZOOM_STEPS, loadZoom, saveZoom, nextZoom, shortcutAction, type ZoomAction } from './zoom';

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

let zoomKeyHandler: ((event: KeyboardEvent) => void) | null = null;

export function mountStudio(root: HTMLElement, core: LocalCore) {
  let generation = 0;
  let opened: Document | null = null;
  let editor: ReturnType<typeof createEditor> | null = null;
  let dirty = false;
  let saving = false;
  let edits = 0;
  let saveButton: HTMLButtonElement | null = null;
  let dirtyBadge: HTMLElement | null = null;
  let guardPending: Promise<boolean> | null = null;
  let closeUnlisten: (() => void) | null = null;
  let dirtySync = Promise.resolve();
  function setDirty(value: boolean) {
    dirty = value;
    if (dirtyBadge) dirtyBadge.textContent = value ? 'Unsaved changes' : 'Saved locally';
    if (saveButton) saveButton.disabled = saving || !dirty;
    dirtySync = dirtySync.then(() => core.setUnsavedChanges(value)).catch(error => {
      status.textContent = `Close protection unavailable: ${String(error)}. Keep this window open until you save.`;
      status.classList.add('error');
    });
  }
  function allowLeave(): Promise<boolean> {
    if (saving) { status.textContent = 'Wait for the current save to finish.'; return Promise.resolve(false); }
    if (!dirty) return Promise.resolve(true);
    if (guardPending) return Promise.resolve(false);
    const prompt = el('dialog', '', 'appearance-dialog');
    prompt.setAttribute('aria-label', 'Unsaved changes');
    prompt.append(el('h2', 'Keep your changes?'), el('p', 'This scene has unsaved changes. Save them before leaving, or discard them.'));
    guardPending = new Promise(resolve => {
      let settled = false;
      let committing = false;
      const finish = (allowed: boolean) => { if (settled || committing) return; settled = true; prompt.remove(); guardPending = null; resolve(allowed); };
      prompt.append(button('Keep editing', () => finish(false)), button('Discard changes', () => finish(true)), button('Save and continue', () => { if (committing || settled) return; committing = true; prompt.querySelectorAll('button').forEach(control => { control.disabled = true; }); void saveCurrent().then(ok => { committing = false; finish(ok); }); }, 'primary'));
      prompt.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      root.append(prompt);
      if (prompt.showModal) prompt.showModal(); else prompt.setAttribute('open', '');
      prompt.querySelector('button')?.focus();
    });
    return guardPending;
  }
  async function saveCurrent(): Promise<boolean> {
    if (!opened || !editor || !repository || saving) return false;
    if (!dirty) return true;
    saving = true;
    saveButton!.disabled = true;
    const activeEditor = editor;
    const activeRepository = repository;
    const text = editor.text();
    const doc = opened;
    status.classList.remove('error'); status.textContent = `Saving ${doc.path}…`;
    try {
      const saved = await core.saveDocument(repository.id, doc.path, doc.contentHash, text);
      if (editor !== activeEditor || opened !== doc || repository !== activeRepository) return false;
      opened = saved;
      editor.markSaved(saved.text);
      setDirty(editor.text() !== saved.text);
      status.textContent = dirty ? 'Saved the submitted revision. Newer edits are still unsaved.' : `Saved ${saved.path} locally`;
      return !dirty;
    } catch (error) {
      status.textContent = `Save failed: ${String(error)}. Your edits remain here. Compare the file on disk before retrying a conflict.`;
      status.classList.add('error');
      return false;
    } finally { saving = false; if (saveButton) saveButton.disabled = !dirty; }
  }
  const unload = (event: BeforeUnloadEvent) => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  let selecting = false;
  let repository: RepositorySession | null = null;
  let directoryRequest = 0;
  let documentRequest = 0;
  let manuscriptRequest = 0;
  const header = el('header', '', 'topbar');
  const brand = el('div');
  brand.append(el('p', 'HEINLEIN', 'eyebrow'), el('h1', 'Studio'), el('p', 'Your manuscript, close at hand.', 'muted'));
  const open = button('Open Folder…', () => { void selectRepository(() => core.pickRepository()); }, 'primary');
  const zoomLevel = button('100%', () => setZoom('reset'), 'zoom-level');
  zoomLevel.title = 'Reset text size (Cmd/Ctrl+0)';
  const zoomGroup = el('div', '', 'zoom');
  zoomGroup.setAttribute('role', 'group');
  zoomGroup.setAttribute('aria-label', 'Text size');
  const smaller = button('A−', () => setZoom('out'), 'zoom-step');
  smaller.title = 'Smaller text (Cmd/Ctrl+−)';
  smaller.setAttribute('aria-label', 'Smaller text');
  const larger = button('A+', () => setZoom('in'), 'zoom-step');
  larger.title = 'Larger text (Cmd/Ctrl++)';
  larger.setAttribute('aria-label', 'Larger text');
  zoomGroup.append(smaller, zoomLevel, larger);
  const actions = el('div', '', 'actions');
  const appearance = button('Appearance', () => openAppearance(), 'appearance');
  appearance.title = 'Fonts and text size (Cmd/Ctrl+,)';
  appearance.setAttribute('aria-haspopup', 'dialog');
  actions.append(zoomGroup, appearance, open);
  header.append(brand, actions);
  const banner = el('p', 'LOCAL DRAFTING · Save explicitly · No AI or network required', 'safety-banner');
  const status = el('p', 'Choose a repository folder to begin.', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const recent = el('section', '', 'recent');
  recent.setAttribute('aria-label', 'Recent folders');
  const layout = el('main', '', 'workspace');
  // Collapsible side panels (file browser, manuscript outline); remembered between launches.
  const collapsed: Record<string, boolean> = (() => { try { const v = JSON.parse(localStorage.getItem('heinlein-studio-collapsed-v1') ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } })();
  const toggles = new Map<string, HTMLButtonElement>();
  function setCollapsed(key: string, value: boolean) {
    collapsed[key] = value;
    try { localStorage.setItem('heinlein-studio-collapsed-v1', JSON.stringify(collapsed)); } catch { /* convenience only */ }
    layout.classList.toggle(`${key}-collapsed`, value);
    const toggle = toggles.get(key);
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!value));
      toggle.textContent = value ? '▸' : '◂';
      toggle.title = `${value ? 'Show' : 'Hide'} ${toggle.dataset.what}${key === 'files' ? ' (Cmd/Ctrl+\\)' : ''}`;
      toggle.setAttribute('aria-label', toggle.title);
    }
  }
  function panelHead(heading: HTMLElement, key: string, what: string) {
    const head = el('div', '', 'panel-head');
    const toggle = button('◂', () => setCollapsed(key, !collapsed[key]), 'panel-toggle');
    toggle.dataset.what = what;
    toggles.set(key, toggle);
    head.append(heading, toggle);
    return head;
  }
  const files = el('section', '', 'panel files');
  files.setAttribute('aria-label', 'Repository files');
  const repoName = el('h2', 'Repository');
  const directoryPath = el('p', 'No folder selected', 'path');
  const listing = el('div', '', 'file-list');
  const filesBody = el('div', '', 'panel-body');
  filesBody.append(directoryPath, listing);
  files.append(panelHead(repoName, 'files', 'file browser'), filesBody);
  const manuscriptPane = el('section', '', 'panel manuscript');
  manuscriptPane.setAttribute('aria-label', 'Manuscript order');
  const manifests = el('div', '', 'manifest-picker');
  const outline = el('div');
  outline.append(el('p', 'Open a folder with a scene-manifest.json to browse manuscript order.', 'empty'));
  const manuscriptBody = el('div', '', 'panel-body');
  manuscriptBody.append(manifests, outline);
  manuscriptPane.append(panelHead(el('h2', 'Manuscript'), 'manuscript', 'manuscript outline'), manuscriptBody);
  const preview = el('section', '', 'panel preview');
  preview.setAttribute('aria-label', 'Document preview');
  resetPreview();
  layout.append(files, manuscriptPane, preview);
  setCollapsed('files', Boolean(collapsed.files));
  setCollapsed('manuscript', Boolean(collapsed.manuscript));
  const footer = el('footer', 'Pass 2 · Local Markdown editing · Save with Cmd/Ctrl+S');
  root.replaceChildren(header, banner, recent, status, layout, footer);

  let zoom = loadZoom();
  function applyZoom(announce: boolean) {
    document.documentElement.dataset.zoom = String(zoom);
    zoomLevel.textContent = `${zoom}%`;
    smaller.disabled = zoom === ZOOM_STEPS[0];
    larger.disabled = zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1];
    if (announce) { zoomAnnounce.textContent = `Text size ${zoom}%`; }
  }
  function setZoom(action: ZoomAction) {
    zoom = nextZoom(zoom, action);
    saveZoom(zoom);
    applyZoom(true);
  }
  const zoomAnnounce = el('p', '', 'sr-only');
  zoomAnnounce.setAttribute('aria-live', 'polite');
  header.append(zoomAnnounce);
  // Appearance: interface, text, and monospace font families, saved between launches.
  let fontChoices: FontChoices = loadChoices();
  applyChoices(fontChoices);
  let installedFonts: string[] | null = null;
  const dialog = el('dialog', '', 'appearance-dialog');
  dialog.setAttribute('aria-labelledby', 'appearance-title');
  const dialogTitle = el('h2', 'Appearance');
  dialogTitle.id = 'appearance-title';
  dialog.append(dialogTitle);
  const fontList = el('datalist');
  fontList.id = 'installed-fonts';
  dialog.append(fontList);
  for (const role of FONT_ROLES) {
    const row = el('div', '', 'font-row');
    const id = `font-${role.key}`;
    const label = el('label', role.label);
    label.htmlFor = id;
    const field = el('input');
    field.id = id;
    field.type = 'text';
    field.setAttribute('list', fontList.id);
    field.setAttribute('autocomplete', 'off');
    field.setAttribute('spellcheck', 'false');
    field.placeholder = 'Default';
    field.value = fontChoices[role.key] ?? '';
    const note = el('p', role.hint, 'muted');
    note.id = `${id}-note`;
    field.setAttribute('aria-describedby', note.id);
    const commit = () => {
      const name = cleanFamily(field.value);
      if (name) fontChoices = { ...fontChoices, [role.key]: name };
      else { const { [role.key]: _gone, ...rest } = fontChoices; fontChoices = rest; }
      field.value = name ?? '';
      saveChoices(fontChoices);
      applyChoices(fontChoices);
      const missing = name && installedFonts && !installedFonts.some(f => f.toLowerCase() === name.toLowerCase());
      note.textContent = missing ? `“${name}” isn't installed on this computer, so the default is used.` : role.hint;
      note.classList.toggle('warn', Boolean(missing));
    };
    field.addEventListener('change', commit);
    const reset = button('Default', () => { field.value = ''; commit(); field.focus(); }, 'font-reset');
    reset.setAttribute('aria-label', `Reset ${role.label.toLowerCase()} to default`);
    row.append(label, field, reset, note);
    dialog.append(row);
  }
  dialog.append(el('p', 'Changes apply immediately. Text size lives in the top bar.', 'muted'));
  dialog.append(button('Done', () => dialog.close ? dialog.close() : dialog.removeAttribute('open'), 'primary'));
  root.append(dialog);
  async function openAppearance() {
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    dialog.querySelector('input')?.focus();
    if (installedFonts) return;
    try {
      installedFonts = await core.listSystemFonts();
      fontList.replaceChildren(...installedFonts.map(name => { const option = el('option'); option.value = name; return option; }));
    } catch { /* typing a family name still works without the list */ }
  }

  // One live handler per document, so remounting never stacks listeners.
  if (zoomKeyHandler) document.removeEventListener('keydown', zoomKeyHandler);
  zoomKeyHandler = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === ',') { event.preventDefault(); void openAppearance(); return; }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === '\\') { event.preventDefault(); setCollapsed('files', !collapsed.files); return; }
    const action = shortcutAction(event);
    if (!action) return;
    event.preventDefault();
    setZoom(action);
  };
  document.addEventListener('keydown', zoomKeyHandler);
  applyZoom(false);

  function resetPreview() {
    editor?.destroy(); editor = null; opened = null; setDirty(false);
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
    if (selecting || !await allowLeave() || selecting) return;
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
    if (!await allowLeave()) return;
    const editRevision = edits;
    const current = generation;
    const request = ++documentRequest;
    status.classList.remove('error');
    status.textContent = `Reading ${path}…`;
    // Keep the current buffer visible until a successful replacement read.
    try {
      const doc = await core.readDocument(repository!.id, path);
      if (current !== generation || request !== documentRequest || editRevision !== edits) return;
      renderDocument(doc);
      status.textContent = `Read ${doc.path} · ${doc.sizeBytes.toLocaleString()} bytes`;
    } catch (error) { if (current === generation && request === documentRequest) reportError(error); }
  }
  function renderDocument(doc: Document) {
    editor?.destroy(); editor = null; opened = doc; saveButton = null; dirtyBadge = null; setDirty(false);
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
    if (!doc.generatedCompatibility && /\.(md|markdown)$/i.test(doc.path)) {
      badge.textContent = 'Local working draft · Plain Markdown';
      const toolbar = el('div', '', 'editor-toolbar');
      saveButton = button('Save', () => { void saveCurrent(); }, 'primary'); saveButton.disabled = true;
      dirtyBadge = el('span', 'Saved locally', 'badge'); dirtyBadge.setAttribute('role', 'status');
      toolbar.append(saveButton, button('Undo', () => editor?.undo()), button('Redo', () => editor?.redo()), button('Find', () => editor?.find()), dirtyBadge);
      const host = el('div', '', 'markdown-editor');
      text.replaceWith(toolbar, host);
      editor = createEditor(host, doc.text, raw => { edits++; setDirty(raw !== opened?.text); }, () => { void saveCurrent(); });
    }
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
  if (core.available()) {
    void refreshRecent();
    void core.onCloseRequested(() => {
      const revision = edits;
      void allowLeave().then(async allowed => {
        if (!allowed || revision !== edits || saving) return;
        root.inert = true;
        try { await dirtySync; if (revision === edits && !saving) await core.requestClose(true); }
        finally { root.inert = false; }
      }).catch(reportError);
    }).then(unlisten => { closeUnlisten = unlisten; }).catch(reportError);
  }
  else {
    open.disabled = true;
    status.textContent = 'Open Heinlein Studio in its native desktop app to choose local folders. Browser preview has no filesystem access.';
  }
  return { showDirectory, showDocument, showManuscript, selectRepository, saveCurrent,
    destroy: () => { editor?.destroy(); closeUnlisten?.(); window.removeEventListener('beforeunload', unload); if (zoomKeyHandler) document.removeEventListener('keydown', zoomKeyHandler); }
  };
}
