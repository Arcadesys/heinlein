import {GROUP_DRAG_TYPE as LEGACY_GROUP_DRAG_TYPE,moveIntent,moveTargetLabel,type MoveSource,type MoveTarget} from './manuscriptMoves';
import type { DraftingChange, DraftingFileChange, DraftingPreview, DraftingScene, DraftingSelection, DraftingState, LibraryEntry, LocalCore, RepositorySession } from './localCore';
import { sheetPreview } from './sheetPreview';

export const REPOSITORY_DRAG_TYPE = 'application/x-heinlein-repository-entry';
export const SCENE_DRAG_TYPE = 'application/x-heinlein-scene';
export const GROUP_DRAG_TYPE = 'application/x-heinlein-group';
const basename = (path: string) => path.split('/').pop() || path;
const parentPath = (path: string) => path.split('/').slice(0, -1).join('/');
const friendlySummary = (summary: string) => /Create the manuscript index for ms\//.test(summary) ? 'Set up the library' : /(?:repository scenes|Markdown files) into ms\//i.test(summary) ? 'Import selected sheets' : summary;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function button(label: string, action: () => void, className = '') {
  const node = el('button', label, className); node.type = 'button'; node.addEventListener('click', action); return node;
}
function iconButton(label: string, path: string, action: () => void, className = '') {
  const node = button('', action, `library-icon-button ${className}`.trim());
  node.setAttribute('aria-label', label); node.title = label;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('d', path); svg.append(line); node.append(svg);
  return node;
}
interface DraftingHooks {
  root: HTMLElement;
  repository(): RepositorySession | null;
  verify?(): void;
  selectedPath?(): string | null;
  run(action: () => Promise<void>): Promise<void>;
  runOrganization?(action: () => Promise<void>): Promise<void>;
  show(): void;
  open(path: string): void;
  changed(state: DraftingState, previous: DraftingState | null, changes: DraftingFileChange[], focusPath?: string, organizationOnly?: boolean): Promise<void>;
  report(message: string, error?: boolean): void;
}
export function createDraftingPanel(core: LocalCore, hooks: DraftingHooks) {
  const element = el('div', '', 'drafting-panel');
  const supported = Boolean(core.loadDrafting && core.previewDraftingChange && core.applyDraftingChange && core.undoDraftingChange);
  let state: DraftingState | null = null;
  let version = 0;
  let loadRequest = 0;
  let disposed = false;
  let picking = false;
  let selectedGroup: string | null = null;
  let narrowStep: 'library' | 'sheets' = 'library';
  let libraryCollapsed = false, sheetsCollapsed = false;
  const selectedSheets = new Set<string>();
  let canUndo = false, canRedo = false;
  let activeBuffer: {path: string; text: string} | null = null;
  let previewGeneration = 0;
  let undo: {id: string; changes: DraftingFileChange[]; summary: string} | null = null;
  const moveLive=el('p','','manuscript-move-status');moveLive.setAttribute('role','status');
  let movementBusy=false,drag:{token:string;source:MoveSource;repositoryId:string;revision:string}|null=null;
  const dialogs = new Map<HTMLDialogElement, () => void>();
  function closeDialogs() { for (const cancel of [...dialogs.values()]) cancel(); }
  function clear() { version++; clearDrag(); previewGeneration++; activeBuffer = null; selectedGroup = null; narrowStep = 'library'; selectedSheets.clear(); canUndo = false; canRedo = false; closeDialogs(); state = null; undo = null; element.replaceChildren(); }
  function updateBuffer(path: string, text: string) {
    activeBuffer = {path, text};
    for (const item of element.querySelectorAll<HTMLElement>('[data-scene-id]')) {
      const selected = state?.scenes.find(scene => scene.id === item.dataset.sceneId)?.path === path;
      const control = item.querySelector<HTMLButtonElement>('.scene-open');
      if (selected) control?.setAttribute('aria-current', 'true'); else control?.removeAttribute('aria-current');
      const indicator = item.querySelector<HTMLElement>('.current-sheet'); if (indicator) indicator.hidden = !selected;
    }
    for (const node of element.querySelectorAll<HTMLElement>('[data-preview-path]')) {
      if (node.dataset.previewPath === path) node.textContent = sheetPreview(text) || 'No prose preview';
    }
  }
  async function load() {
    if (!supported || !hooks.repository()) return null;
    const current = version;
    const request = ++loadRequest;
    const repositoryId = hooks.repository()!.id;
    const loaded = await core.loadDrafting!(repositoryId);
    if (disposed || current !== version || request !== loadRequest || repositoryId !== hooks.repository()?.id) return null;
    state = loaded; render(); return loaded;
  }
  function dialog(title: string) {
    const node = el('dialog', '', 'appearance-dialog drafting-dialog');
    node.setAttribute('aria-label', title); node.append(el('h2', title));
    return node;
  }
  function display(node: HTMLDialogElement, cancel: () => void) {
    dialogs.set(node, cancel); hooks.root.append(node);
    node.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    if (node.showModal) node.showModal(); else node.setAttribute('open', '');
    node.querySelector<HTMLElement>('input, select, button')?.focus();
  }
  function remove(node: HTMLDialogElement) {
    // Finish split modal focus restoration before detaching it. Removing an open
    // scrolled dialog can otherwise collapse the captured editor cursor.
    if(node.classList.contains('drafting-split-dialog')&&node.open&&typeof node.close==='function')node.close();
    dialogs.delete(node); node.remove();
  }
  function field(node: HTMLElement, label: string, value: string, hint?: string) {
    const row = el('label', '', 'drafting-field'); row.append(el('span', label));
    const input = el('input'); input.type = 'text'; input.value = value; input.required = true; row.append(input);
    if (hint) row.append(el('span', hint, 'muted'));
    node.append(row); return input;
  }
  function groupField(node: HTMLElement, selected: string | null = null) {
    const row = el('label', '', 'drafting-field'); row.append(el('span', 'Group (optional)'));
    const select = el('select'); const loose = el('option', 'Library root'); loose.value = ''; select.append(loose);
    for (const group of state?.groups ?? []) { const option = el('option', group.title); option.value = group.id; select.append(option); }
    select.value = selected ?? ''; row.append(select); node.append(row); return select;
  }
  function beforeField(node: HTMLElement, sceneId?: string, selected: string | null = null) {
    const row = el('label', '', 'drafting-field'); row.append(el('span', 'Manuscript position'));
    const select = el('select'); const end = el('option', 'At the end'); end.value = ''; select.append(end);
    for (const scene of state?.scenes ?? []) {
      if (scene.id === sceneId) continue;
      const option = el('option', `Before ${scene.title || basename(scene.path)}`); option.value = scene.id; select.append(option);
    }
    select.value = selected ?? ''; row.append(select); node.append(row); return select;
  }
  function form(title: string, build: (body: HTMLFormElement, submit: (change: DraftingChange, focusPath?: string) => void) => void) {
    if (dialogs.size || !state) return;
    const opener=document.activeElement as HTMLElement|null;
    const restore=()=>{if(opener?.isConnected)opener.focus();else [...element.querySelectorAll('button')].find(b=>b.textContent===opener?.textContent)?.focus();};
    const node = dialog(title); const body = el('form');
    const cancel = () => {remove(node);restore();};
    build(body, (change, focusPath) => { cancel(); void changeManuscript(change, focusPath).then(applied=>{if(!applied||!focusPath)restore();}); });
    body.append(button('Cancel', cancel)); node.append(body); display(node, cancel);
  }
  function submitButton(body: HTMLFormElement, label: string, submit: () => void) {
    const submitControl = el('button', label, 'primary'); submitControl.type = 'submit'; body.append(submitControl);
    body.addEventListener('submit', event => { event.preventDefault(); if (body.reportValidity()) submit(); });
  }
  function confirmPreview(preview: DraftingPreview): Promise<boolean> {
    return new Promise(resolve => {
      const node = dialog('Review manuscript change');
      if(preview.changes.some(change=>change.kind==='split'||change.kind==='splitFile'))node.classList.add('drafting-split-dialog');
      node.append(el('p', friendlySummary(preview.summary)));
      const imported = preview.changes.filter(change => change.kind === 'index' && change.destination && change.destination !== state?.manifestPath);
      if (imported.length) {
        node.append(el('p', `${imported.length} existing ${imported.length === 1 ? 'sheet will' : 'sheets will'} be added to the library.`));
        const titles = el('ul'); imported.forEach(change => titles.append(el('li', basename(change.destination!).replace(/\.(?:md|markdown)$/i, '')))); node.append(titles);
      }
      const list = el('ul', '', 'change-preview');
      for (const change of preview.changes) {
        const description = change.source && change.destination && change.source !== change.destination
          ? `${change.kind}: ${change.source} → ${change.destination}`
          : `${change.kind}: ${change.destination ?? change.source ?? 'manuscript order'}`;
        list.append(el('li', description));
      }
      const details = el('details'); details.append(el('summary', 'Document details'), list); node.append(details);
      for (const warning of preview.warnings) node.append(el('p', warning, 'drafting-warning'));
      node.append(el('p', 'File collisions are blocked. Affected files are checked again before this change is applied.', 'muted'));
      let done = false;
      const finish = (confirmed: boolean) => { if (done) return; done = true; remove(node); resolve(confirmed); };
      node.append(button('Cancel', () => finish(false)), button('Apply change', () => finish(true), 'primary'));
      display(node, () => finish(false));
    });
  }
  async function changeManuscript(change: DraftingChange, focusPath?: string, prepare?: () => DraftingChange, immediate = false, announcement?: string, focusItem?: LibraryEntry) {
    const before = state; const repositoryId = hooks.repository()?.id;
    if (!before || !repositoryId) return false;
    let didApply=false;
    loadRequest++;
    const organizationOnly = change.kind === 'organizeLibrary';
    await (organizationOnly ? hooks.runOrganization ?? hooks.run : hooks.run)(async () => {
      let applied = false;
      try {
        if (prepare) change = prepare();
        if (!organizationOnly) hooks.verify?.();
        const preview = await core.previewDraftingChange!(repositoryId, before.revision, change);
        if (disposed || repositoryId !== hooks.repository()?.id) return;
        if(!preview.changes.length && !organizationOnly && !immediate){hooks.report(preview.summary);return;}
        if (!immediate && change.kind !== 'organizeLibrary' && !await confirmPreview(preview)) { hooks.report('Change canceled.'); return; }
        if (disposed || repositoryId !== hooks.repository()?.id) return;
        if (!organizationOnly) hooks.verify?.();
        if (prepare) prepare();
        const result = await core.applyDraftingChange!(repositoryId, preview.id);
        if (disposed || repositoryId !== hooks.repository()?.id) return;
        applied = true; didApply = true; state = result.state; undo = result.undoId ? {id: result.undoId, changes: preview.changes, summary: preview.summary} : null; canUndo = Boolean(result.undoId); canRedo = false; render(); hooks.show();
        await hooks.changed(state, before, preview.changes, focusPath, change.kind === 'organizeLibrary');
        if (focusItem) {
          const control = focusItem.kind === 'group'
            ? [...element.querySelectorAll<HTMLButtonElement>('[data-group-id]')].find(node => node.dataset.groupId === focusItem.id)
            : [...element.querySelectorAll<HTMLElement>('[data-scene-id]')].find(node => node.dataset.sceneId === focusItem.id)?.querySelector<HTMLButtonElement>('.scene-open');
          (control ?? element.querySelector<HTMLElement>('.sheets-heading'))?.focus();
        }
        hooks.report(`${announcement ?? friendlySummary(preview.summary)} · Saved locally.${undo ? ' Undo is available during this session.' : ''}`);
      } catch (error) {
        const alternative = change.kind === 'importRepository' && change.mode === 'move' && /legacy|referenced/i.test(String(error)) ? ' Use Copy legacy scenes… to make an independent copy; the old manuscript stays unchanged and is not synchronized.' : '';
        hooks.report(`${applied ? 'Change saved locally, but the view could not refresh' : 'Manuscript change could not be completed'}: ${String(error)}${alternative}`, true);
      }
    });
    return didApply;
  }
  function initialize() {
    form('Set up library', (body, submit) => {
      body.append(el('p', 'Set up a library and review any existing Markdown sheets found in the writing folder before importing them. Existing legacy manifests are left intact.', 'muted'));
      const title = field(body, 'Manuscript title', hooks.repository()?.name ?? 'Untitled manuscript');
      submitButton(body, 'Preview setup and import', () => submit({kind: 'initialize', project: title.value.trim()}));
    });
  }
  function newScene() {
    newSheet();
  }
  function newSheet() {
    const opener=document.activeElement as HTMLElement|null;
    const node = dialog('New sheet'); const body = el('form'); const cancel = () => { remove(node); if(opener?.isConnected)opener.focus(); };
    const name = field(body, 'Sheet title', 'Untitled sheet');
    submitButton(body, 'Create sheet', () => {
      const path = `ms/sheet-${crypto.randomUUID()}.md`;
      const title = name.value.trim(); cancel();
      void changeManuscript({kind: 'createScene', title, path, groupId: selectedGroup, beforeId: null}, path, undefined, true);
    });
    body.append(button('Cancel', cancel)); node.append(body); display(node, cancel);
  }
  function splitScene(sceneId: string, prepare: () => {expectedHash: string; byteOffset: number}) {
    const scene=state?.scenes.find(item=>item.id===sceneId);if(!scene||!state?.revision)return;
    splitSource(scene.path,prepare,scene);
  }
  function renameFile(sourcePath:string) {
    if(dialogs.size||!state||state.recoveryRequired)return;
    const revision=state.revision,opener=document.activeElement as HTMLElement|null;
    const node=dialog('Rename Markdown file'),body=el('form');
    body.append(el('p',sourcePath,'path'),el('p','Rename this file in its current folder. Its text stays exact. Unsaved writing is saved before preview.','muted'));
    const path=field(body,'New filename',basename(sourcePath),'Keep the .md or .markdown extension. If omitted, the current extension is kept.');
    path.addEventListener('input',()=>path.setCustomValidity(''));
    const cancel=()=>{remove(node);if(opener?.isConnected)opener.focus({preventScroll:true});};
    submitButton(body,'Preview rename',()=>{
      let name=path.value.trim();
      if(/[\/\\]/.test(name)||name==='.'||name==='..'){path.setCustomValidity('Use a filename without folders.');path.reportValidity();return;}
      if(!name.includes('.'))name+=sourcePath.match(/\.(md|markdown)$/i)?.[0]??'.md';
      if(!/\.(md|markdown)$/i.test(name)){path.setCustomValidity('Keep a Markdown extension: .md or .markdown.');path.reportValidity();return;}
      const destination=sourcePath.slice(0,sourcePath.lastIndexOf('/')+1)+name;
      cancel();void changeManuscript({kind:'renameFile',sourcePath,path:destination},hooks.selectedPath?.()===sourcePath?destination:undefined,()=>{
        if(state?.revision!==revision)throw Error('The manuscript changed. Start the rename again.');
        return {kind:'renameFile',sourcePath,path:destination};
      }).then(applied=>{if(!applied&&opener?.isConnected&&!document.querySelector('dialog[open]'))opener.focus({preventScroll:true});});
    });
    body.append(button('Cancel',cancel));node.append(body);display(node,cancel);
    path.setSelectionRange(0,path.value.lastIndexOf('.'));
  }
  function splitFile(sourcePath:string,prepare:()=>{expectedHash:string;byteOffset:number}) {splitSource(sourcePath,prepare);}
  function splitSource(sourcePath:string,prepare:()=>{expectedHash:string;byteOffset:number},scene?:DraftingScene) {
    if(dialogs.size||!state||state.recoveryRequired)return;
    const revision=state.revision,opener=document.activeElement as HTMLElement|null;
    const node=dialog(scene?'Split scene at cursor':'Split Markdown file at cursor'),body=el('form');node.classList.add('drafting-split-dialog');
    const cancel=()=>{remove(node);if(opener?.isConnected)opener.focus({preventScroll:true});};
    body.append(el('p',scene?'The prefix keeps this scene’s identity. The exact suffix becomes the next scene in the same group. Existing text earns no new growth credit.':'Keep the exact prefix here. Move the suffix to a new sibling Markdown file. No manuscript setup or metadata change.','muted'));
    body.append(el('p','Unsaved writing is saved before preview. Cancel does not undo that save. Frontmatter stays here. Text and line endings stay exact.','drafting-warning'));
    const title=scene?field(body,'New scene title',`${scene.title||'Scene'} continued`):null;
    const suggested=sourcePath.replace(/\.(md|markdown)$/i,'-continued$&');
    const path=scene?null:field(body,'New file name',basename(suggested),'Use a new sibling Markdown filename. We add .md if you omit the extension. Existing files are never replaced.');
    path?.addEventListener('input',()=>path.setCustomValidity(''));
    submitButton(body,'Preview split',()=>{
      let name=path?.value.trim() ?? `sheet-${crypto.randomUUID()}.md`;
      if(path&&(/[\/\\]/.test(name)||name==='.'||name==='..')){path.setCustomValidity('Use a sibling filename without folders.');path.reportValidity();return;}
      const filename=basename(name);
      if(filename&&!filename.includes('.'))name+='.md';
      if(!/\.(md|markdown)$/i.test(name)){path?.setCustomValidity('Use a Markdown filename ending in .md or .markdown.');path?.reportValidity();return;}
      const destination=sourcePath.slice(0,sourcePath.lastIndexOf('/')+1)+name;
      const change:DraftingChange=scene?{kind:'splitScene',sceneId:scene.id,title:title!.value.trim(),path:destination,expectedHash:'',byteOffset:0}:{kind:'splitFile',sourcePath,path:destination,expectedHash:'',byteOffset:0};
      cancel();void changeManuscript(change,destination,()=>{if(state?.revision!==revision)throw Error('The manuscript changed. Start a new split');return {...change,...prepare()};}).then(applied=>{if(!applied&&opener?.isConnected&&!document.querySelector('dialog[open]'))opener.focus({preventScroll:true});});
    });
    body.append(button('Cancel',cancel));node.append(body);display(node,cancel);
  }
  function moveScene(scene: DraftingScene) {
    form(`Move ${scene.title || basename(scene.path)}`, (body, submit) => {
      body.append(el('p', 'Change its folder, optional group, or manuscript position. Scene identity and text are preserved.', 'muted'));
      const path = field(body, 'Scene file', scene.path, 'Leave this path unchanged to only regroup or reorder.');
      const group = groupField(body, scene.groupId);
      const index = state!.scenes.findIndex(item => item.id === scene.id);
      const before = beforeField(body, scene.id, state!.scenes[index + 1]?.id ?? null);
      submitButton(body, 'Preview move', () => submit(path.value.trim() === scene.path
        ? {kind: 'reorderScene', sceneId: scene.id, groupId: group.value || null, beforeId: before.value || null}
        : {kind: 'moveScene', sceneId: scene.id, path: path.value.trim(), groupId: group.value || null, beforeId: before.value || null}));
    });
  }
  function libraryEntries(): LibraryEntry[] {
    return state?.library?.map(entry => ({...entry})) ?? [
      ...(state?.groups ?? []).map(group => ({id: group.id, kind: 'group' as const, parentId: null})),
      ...(state?.scenes ?? []).map(scene => ({id: scene.id, kind: 'scene' as const, parentId: scene.groupId})),
    ];
  }
  function orderedSheets(parent: string | null, entries = libraryEntries()): DraftingScene[] {
    return entries.filter(entry => entry.parentId === parent).flatMap(entry => entry.kind === 'group'
      ? orderedSheets(entry.id, entries)
      : state?.scenes.filter(scene => scene.id === entry.id) ?? []);
  }
  function organization(entries: LibraryEntry[], groups = state!.groups, scenes = state!.scenes): DraftingChange {
    return {kind: 'organizeLibrary', groups, sceneTitles: scenes.map(({id, title}) => ({id, title})), entries};
  }
  function createLibraryGroup() {
    form('New group', (body, submit) => {
      const name = field(body, 'Group name', 'Untitled group');
      submitButton(body, 'Create group', () => {
        const id = crypto.randomUUID();
        submit(organization([...libraryEntries(), {id, kind: 'group', parentId: selectedGroup}], [...state!.groups, {id, title: name.value.trim()}]));
      });
    });
  }
  function renameLibraryItem(id: string, kind: 'group' | 'scene') {
    const old = kind === 'group' ? state!.groups.find(item => item.id === id) : state!.scenes.find(item => item.id === id);
    if (!old) return;
    form(kind === 'group' ? 'Rename group' : 'Rename sheet', (body, submit) => {
      const name = field(body, kind === 'group' ? 'Group name' : 'Sheet title', old.title);
      submitButton(body, 'Rename', () => submit(organization(libraryEntries(),
        state!.groups.map(group => group.id === id && kind === 'group' ? {...group, title: name.value.trim()} : group),
        state!.scenes.map(scene => scene.id === id && kind === 'scene' ? {...scene, title: name.value.trim()} : scene))));
    });
  }
  function moveLibraryItems(ids: string[], parentId: string | null, beforeId: string | null = null): Promise<void> {
    const entries = libraryEntries(); const idSet = new Set(ids);
    if (beforeId && idSet.has(beforeId)) return Promise.resolve();
    const ordered = (state?.libraryLegacy ? state.scenes : orderedSheets(null, entries)).map(scene => scene.id);
    const moving = entries.filter(entry => idSet.has(entry.id)).sort((a, b) => {
      const ai = ordered.indexOf(a.id), bi = ordered.indexOf(b.id);
      return ai < 0 || bi < 0 ? 0 : ai - bi;
    }).map(entry => ({...entry, parentId}));
    const rest = entries.filter(entry => !idSet.has(entry.id));
    const at = beforeId ? rest.findIndex(entry => entry.id === beforeId && entry.parentId === parentId) : -1;
    rest.splice(at < 0 ? rest.length : at, 0, ...moving);
    const names = moving.map(entry => entry.kind === 'group' ? state!.groups.find(group => group.id === entry.id)?.title : state!.scenes.find(scene => scene.id === entry.id)?.title).filter(Boolean);
    const destination = parentId ? state!.groups.find(group => group.id === parentId)?.title ?? 'group' : 'library root';
    return changeManuscript(organization(rest), undefined, undefined, false, `Moved ${names.join(', ')} to ${destination}${beforeId ? ' in the chosen position' : ' at the end'}`, moving[0]).then(() => {});
  }
  function moveSheets(ids: string[]) {
    if (!ids.length) return;
    const node = dialog('Move selected sheets'); const body = el('form');
    const cancel = () => remove(node);
    const group = groupField(body, selectedGroup);
    submitButton(body, 'Move sheets', () => { cancel(); moveLibraryItems(ids, group.value || null); });
    body.append(button('Cancel', cancel)); node.append(body); display(node, cancel);
  }
  function moveSelectedSheets() { moveSheets([...selectedSheets]); }
  function moveGroup(id: string) {
    const node = dialog('Move group'); const body = el('form'); const cancel = () => remove(node);
    const group = groupField(body, libraryEntries().find(entry => entry.id === id)?.parentId ?? null);
    const self = [...group.options].find(option => option.value === id); if (self) self.disabled = true;
    submitButton(body, 'Move group', () => { cancel(); moveLibraryItems([id], group.value || null); });
    body.append(button('Cancel', cancel)); node.append(body); display(node, cancel);
  }
  function reorderLibraryItem(id: string, delta: -1 | 1): Promise<void> {
    const entries = libraryEntries(); const item = entries.find(entry => entry.id === id); if (!item) return Promise.resolve();
    const siblings = entries.filter(entry => entry.parentId === item.parentId); const at = siblings.findIndex(entry => entry.id === id);
    const target = at + delta; if (target < 0 || target >= siblings.length) return Promise.resolve();
    return moveLibraryItems([id], item.parentId, delta < 0 ? siblings[target].id : siblings[target + 1]?.id ?? null);
  }
  async function history(direction: 'undo' | 'redo') {
    const before = state; const repositoryId = hooks.repository()?.id;
    if (!before || !repositoryId || !core.historyDraftingChange) return;
    let needsFileGuard = false;
    async function perform(metadataOnly: boolean) {
      try {
        if (!metadataOnly) hooks.verify?.();
        const result = await core.historyDraftingChange!(repositoryId!, direction, metadataOnly);
        if (disposed || hooks.repository()?.id !== repositoryId) return;
        state = result.state; canUndo = result.canUndo; canRedo = result.canRedo; undo = null; render(); hooks.show();
        await hooks.changed(state, before, [], undefined, result.metadataOnly); hooks.report(`${direction === 'undo' ? 'Undid' : 'Redid'} library change locally.`);
      } catch (error) {
        if (metadataOnly && String(error).includes('HISTORY_REQUIRES_SAVED_EDITOR')) { needsFileGuard = true; return; }
        hooks.report(`Could not ${direction}: ${String(error)}. Current files and recovery remain available.`, true);
      }
    }
    if (hooks.runOrganization) { await hooks.runOrganization(() => perform(true)); if (needsFileGuard) await hooks.run(() => perform(false)); }
    else await hooks.run(() => perform(false));
  }
  function importSettings(paths: string[] | DraftingSelection, beforeId: string | null = null, mode: 'move' | 'copy' = 'move') {
    const external = !Array.isArray(paths);
    form(external ? 'Copy files into manuscript' : mode === 'copy' ? 'Copy legacy scenes independently' : 'Move repository files into manuscript', (body, submit) => {
      const names = (external ? paths.files.map(file => file.name) : paths.map(basename)).map(name => name.replace(/\.(?:md|markdown)$/i, ''));
      body.append(el('p', external ? 'Selected sheets will be copied into the library. Their originals stay where they are.' : mode === 'copy' ? 'Create independent copies in the library. The old manuscript stays unchanged; these copies are not synchronized with it.' : 'These sheets will be moved into the library. Sheets referenced by a legacy manuscript cannot be moved; use Copy legacy scenes… for independent copies.', 'muted'));
      const list = el('ul', '', 'change-preview'); names.forEach(name => list.append(el('li', name))); body.append(list);
      const group = groupField(body); const before = beforeField(body, undefined, beforeId);
      submitButton(body, 'Preview import', () => submit(external
        ? {kind: 'importExternal', selectionId: paths.id, destination: 'ms', groupId: group.value || null, beforeId: before.value || null}
        : {kind: 'importRepository', paths, destination: 'ms', mode, groupId: group.value || null, beforeId: before.value || null}));
    });
  }
  async function importExternal(selection?: DraftingSelection) {
    if (picking) return;
    if (!state?.revision || state.recoveryRequired || dialogs.size) { hooks.report('Set up the library and finish any open dialog or interrupted change before importing.', true); return; }
    if (!selection && !core.pickDraftingImport) return;
    const repositoryId = hooks.repository()!.id;
    picking = true;
    try {
      const picked = selection ?? await core.pickDraftingImport!(repositoryId);
      if (!disposed && repositoryId === hooks.repository()?.id && picked) { hooks.show(); importSettings(picked); }
    } catch (error) { hooks.report(`File selection failed: ${String(error)}`, true); }
    finally { picking = false; }
  }
  async function importRepository(mode: 'move' | 'copy' = 'move') {
    if (!state?.revision || dialogs.size) return;
    const node = dialog('Choose repository files');
    node.append(el('p', mode === 'copy' ? 'Choose legacy sheets to copy into the library. The originals remain unchanged; the new manuscript is independent and not synchronized.' : 'Choose sheets to move into the library. Files used by legacy manifests must be copied instead. You can also drag an eligible file from the repository pane.', 'muted'));
    const pathLabel = el('p', 'Project', 'muted'); const list = el('div', '', 'repository-picker'); const selected = new Set<string>();
    const count = el('p', '0 files selected', 'muted');
    const cancel = () => remove(node); let request = 0;
    const repositoryId = hooks.repository()!.id;
    async function browse(path: string) {
      const current = ++request;
      try {
        const entries = await core.listDirectory(repositoryId, path);
        if (disposed || current !== request || !dialogs.has(node)) return;
        pathLabel.textContent = path ? `Folder: ${basename(path)}` : 'Project'; list.replaceChildren();
        if (path) list.append(button('↑ Parent folder', () => { void browse(parentPath(path)); }));
        for (const entry of entries) {
          if (entry.kind === 'directory') { list.append(button(`Open ${entry.name}/`, () => { void browse(entry.path); })); continue; }
          if (!/\.(md|markdown)$/i.test(entry.path)) continue;
          const row = el('label', '', 'repository-choice'); const check = el('input'); check.type = 'checkbox'; check.checked = selected.has(entry.path);
          check.addEventListener('change', () => { if (check.checked) selected.add(entry.path); else selected.delete(entry.path); count.textContent = `${selected.size} files selected`; next.disabled = !selected.size; });
          row.append(check, el('span', entry.name.replace(/\.(?:md|markdown)$/i, ''))); list.append(row);
        }
        if (!list.children.length) list.append(el('p', 'No Markdown files in this folder.', 'empty'));
      } catch (error) { if (dialogs.has(node)) { list.replaceChildren(el('p', String(error), 'drafting-warning')); } }
    }
    const next = button('Choose destination', () => { cancel(); importSettings([...selected], null, mode); }, 'primary'); next.disabled = true;
    node.append(pathLabel, list, count, button('Cancel', cancel), next); display(node, cancel); await browse('');
  }
  function reorder(scene: DraftingScene, delta: -1 | 1) {
    const index = state!.scenes.findIndex(item => item.id === scene.id);
    const target = index + delta;
    if (target < 0 || target >= state!.scenes.length) return Promise.resolve();
    const beforeId = delta < 0 ? state!.scenes[target].id : state!.scenes[target + 1]?.id ?? null;
    return changeManuscript({kind: 'reorderScene', sceneId: scene.id, beforeId, groupId: scene.groupId});
  }
  async function undoLastChange() {
    const entry = undo; const before = state; const repositoryId = hooks.repository()?.id;
    if (!entry || !before || !repositoryId) return;
    loadRequest++;
    await hooks.run(async () => {
      const preview: DraftingPreview = {id: '', summary: `Undo: ${entry.summary}`, warnings: ['Undo is refused if any affected file has changed. Your current edits are saved before this check.'], changes: entry.changes.map(change => ({kind: `Undo ${change.kind}`, source: change.destination, destination: change.source}))};
      if (!await confirmPreview(preview)) { hooks.report('Undo canceled.'); return; }
      if (disposed || repositoryId !== hooks.repository()?.id) return;
      let applied = false;
      try {
        hooks.verify?.();
        const restored = await core.undoDraftingChange!(repositoryId, entry.id);
        if (disposed || repositoryId !== hooks.repository()?.id) return;
        applied = true; state = restored; undo = null; render(); hooks.show();
        await hooks.changed(restored, before, preview.changes);
        hooks.report('Last manuscript change undone locally.');
      } catch (error) { hooks.report(`${applied ? 'Undo saved locally, but the view could not refresh' : 'Undo could not be completed'}: ${String(error)}. Current files and recovery remain available.`, true); }
    });
  }
  function sourceName(source:MoveSource){return source.kind==='group'?state?.groups.find(g=>g.id===source.id)?.title??'group':state?.scenes.find(s=>s.id===source.id)?.title??'scene';}
  function focusMove(source:MoveSource){element.querySelector<HTMLButtonElement>(`[data-move-kind="${source.kind}"][data-move-id="${source.id}"]`)?.focus();}
  function clearDrag(){drag=null;delete element.dataset.dragKind;hooks.root.querySelectorAll('.move-drop-active').forEach(n=>{n.classList.remove('move-drop-active');delete (n as HTMLElement).dataset.dropSide;});hooks.root.querySelectorAll<HTMLElement>('[data-drop-label]').forEach(n=>n.textContent=n.dataset.dropLabel!);}
  async function performMove(source:MoveSource,target:MoveTarget,revision:string,repositoryId:string){
    if(movementBusy||!state?.revision||dialogs.size||state.recoveryRequired)return;
    if(state.revision!==revision||hooks.repository()?.id!==repositoryId){hooks.report('The manuscript changed during the move. Nothing was submitted; start again.',true);clearDrag();return;}
    try{const change=moveIntent(state,source,target);if(!change){moveLive.textContent='Already in that position. Nothing changed.';focusMove(source);return;}
      const name=sourceName(source),position=moveTargetLabel(state,target);movementBusy=true;
      moveLive.textContent=`Previewing move of “${name}” ${position}. No change until you confirm.`;
      const applied=await changeManuscript(change);moveLive.textContent=applied?`Moved “${name}” ${position}. Saved on this Mac.`:'Move canceled or blocked. Check the result message; no automatic retry.';
    }catch(error){hooks.report(`Move could not be prepared: ${String(error)}`,true);}finally{movementBusy=false;focusMove(source);}
  }
  function moveForm(source:MoveSource){
    if(!state?.revision||dialogs.size||movementBusy||state.recoveryRequired)return;
    const revision=state.revision,repositoryId=hooks.repository()?.id;if(!repositoryId)return;
    const node=dialog(`Move ${sourceName(source)}`),body=el('form'),label=el('label','','drafting-field'),select=el('select');
    node.classList.add('manuscript-move-dialog');
    label.append(el('span','New position'),select);select.setAttribute('aria-label','New position');
    const add=(target:MoveTarget)=>{const option=el('option',moveTargetLabel(state!,target));option.value=JSON.stringify(target);select.append(option);};
    const choose=el('option','Choose a position');choose.value='';select.append(choose);select.required=true;
    if(source.kind==='group'){
      if(state.groupMoveIssue){hooks.report(state.groupMoveIssue,true);return;}
      for(const group of state.groups){if(group.id===source.id)continue;add({kind:'group',id:group.id,side:'before'});add({kind:'group',id:group.id,side:'after'});}add({kind:'groupEndSlot'});
    }else{
      for(const scene of state.scenes){if(scene.id===source.id)continue;add({kind:'scene',id:scene.id,side:'before'});add({kind:'scene',id:scene.id,side:'after'});}
      for(const group of state.groups){if(state.groupMoveIssue&&!state.scenes.some(s=>s.groupId===group.id))continue;add({kind:'groupEnd',id:group.id});}add({kind:'ungroupedEnd'});
    }
    const selected=el('p','No position selected.','manuscript-move-position');selected.setAttribute('role','status');
    select.addEventListener('change',()=>{selected.textContent=select.value?`Destination: ${select.selectedOptions[0].textContent}`:'No position selected.';});
    const cancel=()=>{remove(node);focusMove(source);};body.append(label,selected,el('p','Preview the exact reading order before applying. Text, scene IDs and filenames are unchanged.','muted'));
    submitButton(body,'Preview move',()=>{try{const target=JSON.parse(select.value) as MoveTarget;cancel();void performMove(source,target,revision,repositoryId);}catch{hooks.report('Choose a valid position. Nothing changed.',true);}});body.append(button('Cancel',cancel));node.append(body);display(node,cancel);
  }
  function moveGrip(source:MoveSource){const grip=button(`Drag ${source.kind==='group'?'group':'scene'}: ${sourceName(source)}`,()=>{moveForm(source);},'manuscript-move-grip');grip.dataset.moveKind=source.kind;grip.dataset.moveId=source.id;grip.draggable=true;grip.title='Drag to a labelled position, or activate to choose a position with the keyboard.';
    if(source.kind==='group'&&state?.groupMoveIssue){grip.disabled=true;grip.setAttribute('aria-describedby','manuscript-group-move-issue');}
    bindMoveSource(grip,source);return grip;
  }
  function bindMoveSource(grip:HTMLElement,source:MoveSource){
    grip.draggable=true;
    grip.addEventListener('dragstart',event=>{if(!event.dataTransfer||!state?.revision||movementBusy||dialogs.size||state.recoveryRequired||!hooks.repository()){event.preventDefault();return;}clearDrag();drag={token:crypto.randomUUID(),source,repositoryId:hooks.repository()!.id,revision:state.revision};event.dataTransfer.clearData();event.dataTransfer.effectAllowed='move';event.dataTransfer.setData(source.kind==='group'?LEGACY_GROUP_DRAG_TYPE:SCENE_DRAG_TYPE,drag.token);element.dataset.dragKind=source.kind;moveLive.textContent=`Moving “${sourceName(source)}”. Drop on a labelled position to preview; Escape cancels.`;});
    grip.addEventListener('dragend',clearDrag);
  }
  function moveDrop(node:HTMLElement,resolve:(source:MoveSource,event:DragEvent)=>MoveTarget|null,label:string){
    const caption=el('span',label,'manuscript-drop-label');caption.dataset.dropLabel=label;node.append(caption);
    const targetFor=(event:DragEvent)=>{if(!drag||!event.dataTransfer||movementBusy||dialogs.size||drag.repositoryId!==hooks.repository()?.id||drag.revision!==state?.revision)return null;const mime=drag.source.kind==='group'?LEGACY_GROUP_DRAG_TYPE:SCENE_DRAG_TYPE;if(!event.dataTransfer.types.includes(mime))return null;return resolve(drag.source,event);};
    node.addEventListener('dragover',event=>{const target=targetFor(event);if(!target)return;event.preventDefault();event.stopPropagation();event.dataTransfer!.dropEffect='move';node.classList.add('move-drop-active');node.dataset.dropSide='side'in target?target.side:'inside';caption.textContent=`Move “${sourceName(drag!.source)}” ${moveTargetLabel(state!,target)}. Release to preview.`;if(moveLive.textContent!==caption.textContent)moveLive.textContent=caption.textContent;});
    node.addEventListener('dragleave',event=>{if(event.relatedTarget instanceof Node&&node.contains(event.relatedTarget))return;node.classList.remove('move-drop-active');caption.textContent=label;});
    node.addEventListener('drop',event=>{const target=targetFor(event),active=drag;if(!target||!active)return;event.preventDefault();event.stopImmediatePropagation();const raw=event.dataTransfer!.getData(active.source.kind==='group'?LEGACY_GROUP_DRAG_TYPE:SCENE_DRAG_TYPE);clearDrag();if(raw!==active.token){hooks.report('This move did not come from the current manuscript. Nothing changed.',true);return;}void performMove(active.source,target,active.revision,active.repositoryId);});
  }
  function acceptDrop(event: DragEvent, beforeId: string | null = null) {
    if (!event.dataTransfer || !state?.revision || state.recoveryRequired) return;
    event.preventDefault(); event.stopPropagation();
    try {
      const rawScene = event.dataTransfer.getData(SCENE_DRAG_TYPE);
      if (rawScene) {
        const source = JSON.parse(rawScene) as {repositoryId?: string; sceneId?: string};
        if (source.repositoryId !== hooks.repository()?.id || !state.scenes.some(scene => scene.id === source.sceneId)) return;
        if (source.sceneId === beforeId) return;
        const scene = state.scenes.find(scene => scene.id === source.sceneId)!;
        if (state.library) {
          const destination = beforeId ? state.library.find(entry => entry.id === beforeId)?.parentId : selectedGroup;
          moveLibraryItems(selectedSheets.has(scene.id) ? [...selectedSheets] : [scene.id], destination ?? null, beforeId); return;
        }
        void changeManuscript({kind: 'reorderScene', sceneId: scene.id, beforeId, groupId: scene.groupId}); return;
      }
      const rawPath = event.dataTransfer.getData(REPOSITORY_DRAG_TYPE);
      if (rawPath) {
        const source = JSON.parse(rawPath) as {repositoryId?: string; path?: string};
        if (source.repositoryId !== hooks.repository()?.id || typeof source.path !== 'string') return;
        importSettings([source.path], beforeId); return;
      }
      if (event.dataTransfer.files.length) hooks.report('Use Import files… to authorize these files with the native picker. Browser-provided file paths are not used.', true);
    } catch { hooks.report('This drag could not be read. Use Move… or Import repository files… instead.', true); }
  }
  function dropTarget(target: HTMLElement, beforeId: string | null = null) {
    target.addEventListener('dragover', event => {
      if (event.dataTransfer?.types.includes(REPOSITORY_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
    });
    target.addEventListener('drop', event => acceptDrop(event, beforeId));
  }
  function render() {
    const currentPreview = ++previewGeneration;
    element.replaceChildren(); if (!state) return;
    clearDrag(); element.append(moveLive);
    if (state.recoveryRequired) {
      element.append(el('p', 'An interrupted manuscript change needs attention. Review its guarded rollback before making more structural changes.', 'drafting-warning'), button('Preview rollback of interrupted change', () => { void changeManuscript({kind: 'recoverInterrupted'}); }));
      return;
    }
    if (!state.revision) {
      element.append(el('p', 'Set up a library. Existing legacy sheets remain available in the file browser and their existing manuscripts.', 'empty'), button('Set up library', initialize, 'primary')); return;
    }
    element.dataset.step = narrowStep;
    const library = el('section', '', 'library-groups'); library.setAttribute('aria-label', 'Library'); library.classList.toggle('pane-collapsed', libraryCollapsed);
    const toggleLibrary = iconButton(libraryCollapsed ? 'Show library' : 'Collapse library', libraryCollapsed ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7', () => { libraryCollapsed = !libraryCollapsed; render(); element.querySelector<HTMLButtonElement>('.library-groups .pane-collapse')?.focus(); }, 'pane-collapse'); toggleLibrary.setAttribute('aria-expanded', String(!libraryCollapsed));
    library.append(toggleLibrary, el('h3', 'Library'), el('p', state.project || hooks.repository()?.name || 'Project'));
    function chooseGroup(id: string | null) {
      selectedGroup = id; const narrow = Boolean(window.matchMedia?.('(max-width: 1000px)').matches);
      if (narrow) narrowStep = 'sheets'; render();
      if (narrow) element.querySelector<HTMLElement>('.sheets-heading')?.focus();
      else if (id === null) element.querySelector<HTMLButtonElement>('[data-group-root]')?.focus();
      else [...element.querySelectorAll<HTMLButtonElement>('[data-group-id]')].find(control => control.dataset.groupId === id)?.focus();
    }
    const all = button('All sheets', () => chooseGroup(null)); all.dataset.groupRoot = '';
    all.addEventListener('dragover', event => { if (event.dataTransfer?.types.some(type => type === GROUP_DRAG_TYPE || type === SCENE_DRAG_TYPE)) event.preventDefault(); });
    all.addEventListener('drop', event => {
      event.preventDefault();
      try {
        const transfer = event.dataTransfer; const group = transfer?.getData(GROUP_DRAG_TYPE);
        const source = JSON.parse(group || transfer?.getData(SCENE_DRAG_TYPE) || '{}') as {repositoryId?: string; groupId?: string; sceneId?: string};
        if (source.repositoryId !== hooks.repository()?.id) return;
        if (group && source.groupId && state!.groups.some(item => item.id === source.groupId)) moveLibraryItems([source.groupId], null);
        else if (source.sceneId && state!.scenes.some(item => item.id === source.sceneId)) moveLibraryItems(selectedSheets.has(source.sceneId) ? [...selectedSheets] : [source.sceneId], null);
      } catch { hooks.report('Could not read this drag. Use the move controls instead.', true); }
    });
    all.setAttribute('aria-pressed', String(selectedGroup === null)); library.append(all);
    const entries = libraryEntries();
    const drawGroups = (parent: string | null, container: HTMLElement) => {
      for (const entry of entries.filter(item => item.kind === 'group' && item.parentId === parent)) {
        const group = state!.groups.find(item => item.id === entry.id); if (!group) continue;
        const row = el('li'); const select = button(group.title, () => chooseGroup(group.id)); select.dataset.groupId = group.id;
        select.setAttribute('aria-pressed', String(selectedGroup === group.id));
        select.draggable = true;
        select.addEventListener('dragstart', event => { if (!event.dataTransfer) return; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(GROUP_DRAG_TYPE, JSON.stringify({repositoryId: hooks.repository()?.id, groupId: group.id})); });
        select.addEventListener('dragover', event => { if (event.dataTransfer?.types.some(type => type === SCENE_DRAG_TYPE || type === GROUP_DRAG_TYPE)) event.preventDefault(); });
        select.addEventListener('drop', event => {
          event.preventDefault();
          try {
            const rawGroup = event.dataTransfer?.getData(GROUP_DRAG_TYPE);
            if (rawGroup) {
              const source = JSON.parse(rawGroup) as {repositoryId?: string; groupId?: string};
              if (source.repositoryId !== hooks.repository()?.id || !source.groupId || source.groupId === group.id || !state!.groups.some(item => item.id === source.groupId)) return;
              const bounds = select.getBoundingClientRect(); const before = event.clientY < bounds.top + bounds.height / 3;
              moveLibraryItems([source.groupId], before ? entry.parentId : group.id, before ? group.id : null); return;
            }
            const source = JSON.parse(event.dataTransfer?.getData(SCENE_DRAG_TYPE) ?? '{}') as {repositoryId?: string; sceneId?: string};
            if (source.repositoryId === hooks.repository()?.id && source.sceneId && state!.scenes.some(scene => scene.id === source.sceneId)) {
              moveLibraryItems(selectedSheets.has(source.sceneId) ? [...selectedSheets] : [source.sceneId], group.id);
            }
          } catch { hooks.report('Could not read this drag. Use Move selected sheets instead.', true); }
        });
        const actions = el('details'); actions.append(el('summary', `Actions for ${group.title}`), button(`Rename ${group.title}`, () => renameLibraryItem(group.id, 'group')),
          button(`Move ${group.title}…`, () => moveGroup(group.id)), button(`Move ${group.title} earlier`, () => reorderLibraryItem(group.id, -1)),
          button(`Move ${group.title} later`, () => reorderLibraryItem(group.id, 1)));
        row.append(select, actions);
        const children = el('ul'); drawGroups(group.id, children); if (children.childElementCount) row.append(children);
        container.append(row);
      }
    };
    const groupsList = el('ul'); drawGroups(null, groupsList); library.append(groupsList, button('New library group', createLibraryGroup));
    const sheets = el('section', '', 'library-sheets'); sheets.setAttribute('aria-label', 'Sheets'); sheets.classList.toggle('pane-collapsed', sheetsCollapsed);
    const toggleSheets = iconButton(sheetsCollapsed ? 'Show sheets' : 'Collapse sheets', sheetsCollapsed ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7', () => { sheetsCollapsed = !sheetsCollapsed; render(); element.querySelector<HTMLButtonElement>('.library-sheets .pane-collapse')?.focus(); }, 'pane-collapse'); toggleSheets.setAttribute('aria-expanded', String(!sheetsCollapsed));
    const back = button('Back to library', () => { narrowStep = 'library'; render(); element.querySelector<HTMLButtonElement>('[data-group-root]')?.focus(); }, 'sheets-back');
    const heading = el('h3', selectedGroup ? `Sheets in ${state.groups.find(group => group.id === selectedGroup)?.title ?? 'group'}` : 'Sheets', 'sheets-heading'); heading.tabIndex = -1;
    sheets.append(toggleSheets, back, heading, button('New sheet', newSheet)); element.append(library, sheets);
    const controls = el('div', '', 'drafting-actions');
    const advanced = el('details', '', 'drafting-advanced'); advanced.append(el('summary', 'Import and document actions'));
    advanced.append(button('Import files…', () => { void importExternal(); }), button('Import repository files…', () => { void importRepository(); }), button('Copy legacy scenes…', () => { void importRepository('copy'); }));
    const undoButton = button('Undo last change', () => { void undoLastChange(); }); undoButton.disabled = !undo;
    advanced.append(undoButton, button('Refresh ms', () => { void hooks.run(async () => { try { const loaded = await load(); if (loaded) { await hooks.changed(loaded, null, []); hooks.report('Manuscript refreshed from disk.'); } } catch (error) { hooks.report(`Refresh failed: ${String(error)}`, true); } }); }));
    if (core.historyDraftingChange) {
      const undoLibrary = button('Undo library change', () => { void history('undo'); }); undoLibrary.disabled = !canUndo;
      const redoLibrary = button('Redo library change', () => { void history('redo'); }); redoLibrary.disabled = !canRedo;
      controls.append(undoLibrary, redoLibrary);
    }
    const moveSelected = button('Move selected sheets…', moveSelectedSheets); moveSelected.disabled = !selectedSheets.size; controls.append(moveSelected);
    sheets.append(controls, advanced);
    if (state.untrackedPaths.length || state.missingPaths.length) {
      const changes = el('details', '', 'drafting-warning');
      changes.append(el('summary', `${state.untrackedPaths.length} unlisted · ${state.missingPaths.length} missing scene files`));
      const list = el('ul'); state.untrackedPaths.forEach(path => list.append(el('li', `Unlisted: ${path}`))); state.missingPaths.forEach(path => list.append(el('li', `Missing: ${path}`)));
      changes.append(list, el('p', 'Discovery adds unlisted files and removes missing paths from the index. Existing scenes keep their order and IDs; source text is not rewritten.'), button('Preview ms discovery', () => { void changeManuscript({kind: 'reconcile'}); })); sheets.append(changes);
    }
    const list = el('ol', '', 'drafting-scenes'); list.setAttribute('aria-label', 'Drafting scenes in manuscript order');
    const visibleScenes = state.library && !(state.libraryLegacy && selectedGroup === null) ? orderedSheets(selectedGroup) : selectedGroup ? state.scenes.filter(scene => scene.groupId === selectedGroup) : state.scenes;
    visibleScenes.forEach((scene, visibleIndex) => {
      const index = state!.scenes.findIndex(item => item.id === scene.id);
      const item = el('li', '', 'drafting-scene'); item.dataset.sceneId = scene.id;
      const selection = el('label'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedSheets.has(scene.id);
      checkbox.addEventListener('change', () => { if (checkbox.checked) selectedSheets.add(scene.id); else selectedSheets.delete(scene.id); moveSelected.disabled = !selectedSheets.size; });
      selection.append(checkbox, document.createTextNode(` Select ${scene.title || 'untitled sheet'}`)); item.append(selection);
      const open = button(`${visibleIndex + 1}. ${scene.title || 'Untitled sheet'}`, () => hooks.open(scene.path), 'scene-open');
      open.draggable = true;
      open.addEventListener('dragstart', event => { if (!event.dataTransfer) return; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(SCENE_DRAG_TYPE, JSON.stringify({repositoryId: hooks.repository()!.id, sceneId: scene.id})); });
      const excerpt = el('p', 'Loading preview…', 'sheet-preview'); excerpt.dataset.previewPath = scene.path;
      if (activeBuffer?.path === scene.path) excerpt.textContent = sheetPreview(activeBuffer.text) || 'No prose preview';
      else {
        const repositoryId = hooks.repository()?.id;
        if (repositoryId) void core.readDocument(repositoryId, scene.path).then(doc => {
          if (currentPreview !== previewGeneration || repositoryId !== hooks.repository()?.id) return;
          excerpt.textContent = sheetPreview(activeBuffer?.path === scene.path ? activeBuffer.text : doc.text) || 'No prose preview';
        }).catch(() => { if (currentPreview === previewGeneration) excerpt.textContent = 'Preview unavailable'; });
      }
      const details = el('details'); details.append(el('summary', 'Document details'), el('p', scene.path, 'scene-path'));
      const current = el('span', 'Current sheet', 'current-sheet'); current.hidden = scene.path !== (activeBuffer?.path ?? hooks.selectedPath?.());
      if (!current.hidden) open.setAttribute('aria-current', 'true');
      item.append(open, current, excerpt, details);
      const group = state!.groups.find(group => group.id === scene.groupId); item.append(el('span', group?.title ?? 'Loose scene', 'scene-group'));
      const actions = el('div', '', 'scene-actions');
      const siblings = entries.filter(entry => entry.parentId === scene.groupId); const siblingIndex = siblings.findIndex(entry => entry.id === scene.id);
      const earlier = iconButton(`Move ${scene.title || basename(scene.path)} earlier`, 'M12 19V5m-6 6 6-6 6 6', () => state?.library ? reorderLibraryItem(scene.id, -1) : reorder(scene, -1)); earlier.disabled = state!.library ? siblingIndex <= 0 : index === 0;
      const later = iconButton(`Move ${scene.title || basename(scene.path)} later`, 'M12 5v14m-6-6 6 6 6-6', () => state?.library ? reorderLibraryItem(scene.id, 1) : reorder(scene, 1)); later.disabled = state!.library ? siblingIndex === siblings.length - 1 : index === state!.scenes.length - 1;
      const rename = iconButton('Rename sheet', 'M4 20l4-.8L19 8l-3-3L5 16l-1 4zm10-13 3 3', () => renameLibraryItem(scene.id, 'scene'));
      actions.append(earlier, later, button('Move…', () => state?.library ? moveSheets([scene.id]) : moveScene(scene)), rename); item.append(actions); dropTarget(item, scene.id); list.append(item);
    });
    sheets.append(list);
    const dropEnd = el('div', state.scenes.length ? 'Drop here to place at the end' : 'No scenes yet. Create a scene or import Markdown files.', 'drafting-drop');
    dropTarget(dropEnd); sheets.append(dropEnd);
  }
  return { element, supported, clear, load, initialize, importExternal, splitScene, splitFile, renameFile, bindMoveSource, bindMoveTarget: moveDrop, updateBuffer, get state() { return state; },
    /** The same previewed, confirmed reorder as the ↑/↓ buttons. Resolves once the change settles. */
    async reorderScene(sceneId: string, delta: -1 | 1) { const scene = state?.scenes.find(item => item.id === sceneId); if (scene && state?.revision && !dialogs.size) await (state.library ? reorderLibraryItem(sceneId, delta) : reorder(scene, delta)); },
    newScene() { if (state?.revision && !dialogs.size) newScene(); },
    importRepository(mode: 'move' | 'copy' = 'move') { void importRepository(mode); },
    undoLastChange() { void undoLastChange(); },
    get canUndoRename() { return Boolean(undo?.changes.some(change=>change.kind==='renameFile')); },
    get canUndo() { return Boolean(undo); }, destroy() { disposed = true; clear(); } };
}
