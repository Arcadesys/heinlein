import {GROUP_DRAG_TYPE,moveIntent,moveTargetLabel,type MoveSource,type MoveTarget} from './manuscriptMoves';
import type { DraftingChange, DraftingFileChange, DraftingPreview, DraftingScene, DraftingSelection, DraftingState, LocalCore, RepositorySession } from './localCore';

export const REPOSITORY_DRAG_TYPE = 'application/x-heinlein-repository-entry';
export const SCENE_DRAG_TYPE = 'application/x-heinlein-scene';
const basename = (path: string) => path.split('/').pop() || path;
const parentPath = (path: string) => path.split('/').slice(0, -1).join('/');
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function button(label: string, action: () => void, className = '') {
  const node = el('button', label, className); node.type = 'button'; node.addEventListener('click', action); return node;
}
interface DraftingHooks {
  root: HTMLElement;
  repository(): RepositorySession | null;
  verify?(): void;
  selectedPath?(): string | null;
  run(action: () => Promise<void>): Promise<void>;
  show(): void;
  open(path: string): void;
  changed(state: DraftingState, previous: DraftingState | null, changes: DraftingFileChange[], focusPath?: string): Promise<void>;
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
  let undo: {id: string; changes: DraftingFileChange[]; summary: string} | null = null;
  const moveLive=el('p','','manuscript-move-status');moveLive.setAttribute('role','status');
  let movementBusy=false,drag:{token:string;source:MoveSource;repositoryId:string;revision:string}|null=null;
  const dialogs = new Map<HTMLDialogElement, () => void>();
  function closeDialogs() { for (const cancel of [...dialogs.values()]) cancel(); }
  function clear() { version++; clearDrag(); closeDialogs(); state = null; undo = null; element.replaceChildren(); }
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
    const row = el('label', '', 'drafting-field'); row.append(el('span', 'Chapter (optional)'));
    const select = el('select'); const loose = el('option', 'No chapter'); loose.value = ''; select.append(loose);
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
      node.append(el('p', preview.summary));
      const list = el('ul', '', 'change-preview');
      for (const change of preview.changes) {
        const description = change.source && change.destination && change.source !== change.destination
          ? `${change.kind}: ${change.source} → ${change.destination}`
          : `${change.kind}: ${change.destination ?? change.source ?? 'manuscript order'}`;
        list.append(el('li', description));
      }
      node.append(list);
      for (const warning of preview.warnings) node.append(el('p', warning, 'drafting-warning'));
      node.append(el('p', 'File collisions are blocked. Affected files are checked again before this change is applied.', 'muted'));
      let done = false;
      const finish = (confirmed: boolean) => { if (done) return; done = true; remove(node); resolve(confirmed); };
      node.append(button('Cancel', () => finish(false)), button('Apply change', () => finish(true), 'primary'));
      display(node, () => finish(false));
    });
  }
  async function changeManuscript(change: DraftingChange, focusPath?: string, prepare?: () => DraftingChange) {
    const before = state; const repositoryId = hooks.repository()?.id;
    if (!before || !repositoryId) return false;
    let didApply=false;
    loadRequest++;
    await hooks.run(async () => {
      let applied = false;
      try {
        if (prepare) change = prepare();
        hooks.verify?.();
        const preview = await core.previewDraftingChange!(repositoryId, before.revision, change);
        if (disposed || repositoryId !== hooks.repository()?.id) return;
        if(!preview.changes.length){hooks.report(preview.summary);return;}
        if (!await confirmPreview(preview)) { hooks.report('Change canceled.'); return; }
        if (disposed || repositoryId !== hooks.repository()?.id) return;
        hooks.verify?.();
        if (prepare) prepare();
        const result = await core.applyDraftingChange!(repositoryId, preview.id);
        if (disposed || repositoryId !== hooks.repository()?.id) return;
        applied = true; didApply=true; state = result.state; undo = result.undoId ? {id: result.undoId, changes: preview.changes, summary: preview.summary} : null; render(); hooks.show();
        await hooks.changed(state, before, preview.changes, focusPath);
        hooks.report(`${preview.summary} · Saved locally.${undo ? ' Undo is available until the next structural change or app restart.' : ''}`);
      } catch (error) {
        const alternative = change.kind === 'importRepository' && change.mode === 'move' && /legacy|referenced/i.test(String(error)) ? ' Use Copy legacy scenes… to make an independent copy; the old manuscript stays unchanged and is not synchronized.' : '';
        hooks.report(`${applied ? 'Change saved locally, but the view could not refresh' : 'Manuscript change could not be completed'}: ${String(error)}${alternative}`, true);
      }
    });
    return didApply;
  }
  function initialize() {
    form('Create an ms manuscript', (body, submit) => {
      body.append(el('p', 'Create ms/manuscript.json for drafting. Markdown scenes live under ms/; filenames stay unchanged when you reorder. Existing legacy manifests are left intact.', 'muted'));
      const title = field(body, 'Manuscript title', hooks.repository()?.name ?? 'Untitled manuscript');
      submitButton(body, 'Preview manuscript', () => submit({kind: 'initialize', project: title.value.trim()}));
    });
  }
  function newScene() {
    form('Add scene', (body, submit) => {
      const title = field(body, 'Scene title', 'Untitled scene');
      const path = field(body, 'Scene file', 'ms/untitled-scene.md', 'Use a Markdown path inside ms/. Folders are optional.');
      let pathChanged = false; path.addEventListener('input', () => { pathChanged = true; });
      title.addEventListener('input', () => { if (!pathChanged) path.value = `ms/${title.value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'untitled-scene'}.md`; });
      const selected=state?.scenes.find(s=>s.path===hooks.selectedPath?.());
      const group = groupField(body,selected?.groupId); const before = beforeField(body);
      submitButton(body, 'Preview new scene', () => submit({kind: 'createScene', title: title.value.trim(), path: path.value.trim(), groupId: group.value || null, beforeId: before.value || null}, path.value.trim()));
    });
  }
  function splitScene(sceneId: string, prepare: () => {expectedHash: string; byteOffset: number}) {
    const scene=state?.scenes.find(item=>item.id===sceneId);if(!scene||!state?.revision)return;
    splitSource(scene.path,prepare,scene);
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
    const path=field(body,scene?'New scene file':'New file name',scene?suggested:basename(suggested),scene?'Use a new Markdown path inside ms/.':'Use a new sibling Markdown filename. Existing files are never replaced.');
    path.addEventListener('input',()=>path.setCustomValidity(''));
    submitButton(body,'Preview split',()=>{
      const name=path.value.trim();
      if(!scene&&(/[\/\\]/.test(name)||name==='.'||name==='..')){path.setCustomValidity('Use a sibling filename without folders.');path.reportValidity();return;}
      const destination=scene?name:sourcePath.slice(0,sourcePath.lastIndexOf('/')+1)+name;
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
  function newGroup() {
    form('Add chapter', (body, submit) => {
      body.append(el('p', 'A chapter groups scenes in your manuscript. It starts empty and does not add text or rename files.', 'muted'));
      const title = field(body, 'Chapter title', '');
      submitButton(body, 'Preview chapter', () => submit({kind: 'createGroup', title: title.value.trim()}));
    });
  }
  function importSettings(paths: string[] | DraftingSelection, beforeId: string | null = null, mode: 'move' | 'copy' = 'move') {
    const external = !Array.isArray(paths);
    form(external ? 'Copy files into manuscript' : mode === 'copy' ? 'Copy legacy scenes independently' : 'Move repository files into manuscript', (body, submit) => {
      const names = external ? paths.files.map(file => file.name) : paths;
      body.append(el('p', external ? 'Selected files will be copied into ms/. Their originals stay where they are.' : mode === 'copy' ? 'Create independent copies in ms/. The old manuscript stays unchanged; these copies are not synchronized with it.' : 'These repository files will be moved into ms/. Files referenced by a legacy manuscript cannot be moved; use Copy legacy scenes… for independent copies.', 'muted'));
      const list = el('ul', '', 'change-preview'); names.forEach(name => list.append(el('li', name))); body.append(list);
      const destination = field(body, 'Destination folder', 'ms', 'Use ms or a folder below it. Filename collisions stop the change.');
      const group = groupField(body); const before = beforeField(body, undefined, beforeId);
      submitButton(body, 'Preview import', () => submit(external
        ? {kind: 'importExternal', selectionId: paths.id, destination: destination.value.trim(), groupId: group.value || null, beforeId: before.value || null}
        : {kind: 'importRepository', paths, destination: destination.value.trim(), mode, groupId: group.value || null, beforeId: before.value || null}));
    });
  }
  async function importExternal(selection?: DraftingSelection) {
    if (picking) return;
    if (!state?.revision || state.recoveryRequired || dialogs.size) { hooks.report('Open an initialized ms manuscript and finish any open dialog or interrupted change before importing.', true); return; }
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
    node.append(el('p', mode === 'copy' ? 'Choose legacy Markdown scenes to copy into ms/. The originals remain unchanged; the new manuscript is independent and not synchronized.' : 'Choose Markdown files to move into ms/. Files used by legacy manifests must be copied instead. You can also drag an eligible file from the repository pane.', 'muted'));
    const pathLabel = el('p', '/', 'path'); const list = el('div', '', 'repository-picker'); const selected = new Set<string>();
    const count = el('p', '0 files selected', 'muted');
    const cancel = () => remove(node); let request = 0;
    const repositoryId = hooks.repository()!.id;
    async function browse(path: string) {
      const current = ++request;
      try {
        const entries = await core.listDirectory(repositoryId, path);
        if (disposed || current !== request || !dialogs.has(node)) return;
        pathLabel.textContent = path || '/'; list.replaceChildren();
        if (path) list.append(button('↑ Parent folder', () => { void browse(parentPath(path)); }));
        for (const entry of entries) {
          if (entry.kind === 'directory') { list.append(button(`Open ${entry.name}/`, () => { void browse(entry.path); })); continue; }
          if (!/\.(md|markdown)$/i.test(entry.path)) continue;
          const row = el('label', '', 'repository-choice'); const check = el('input'); check.type = 'checkbox'; check.checked = selected.has(entry.path);
          check.addEventListener('change', () => { if (check.checked) selected.add(entry.path); else selected.delete(entry.path); count.textContent = `${selected.size} files selected`; next.disabled = !selected.size; });
          row.append(check, el('span', entry.name)); list.append(row);
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
    grip.addEventListener('dragstart',event=>{if(!event.dataTransfer||!state?.revision||movementBusy||dialogs.size||state.recoveryRequired||!hooks.repository()){event.preventDefault();return;}clearDrag();drag={token:crypto.randomUUID(),source,repositoryId:hooks.repository()!.id,revision:state.revision};event.dataTransfer.clearData();event.dataTransfer.effectAllowed='move';event.dataTransfer.setData(source.kind==='group'?GROUP_DRAG_TYPE:SCENE_DRAG_TYPE,drag.token);element.dataset.dragKind=source.kind;moveLive.textContent=`Moving “${sourceName(source)}”. Drop on a labelled position to preview; Escape cancels.`;});
    grip.addEventListener('dragend',clearDrag);
  }
  function moveDrop(node:HTMLElement,resolve:(source:MoveSource,event:DragEvent)=>MoveTarget|null,label:string){
    const caption=el('span',label,'manuscript-drop-label');caption.dataset.dropLabel=label;node.append(caption);
    const targetFor=(event:DragEvent)=>{if(!drag||!event.dataTransfer||movementBusy||dialogs.size||drag.repositoryId!==hooks.repository()?.id||drag.revision!==state?.revision)return null;const mime=drag.source.kind==='group'?GROUP_DRAG_TYPE:SCENE_DRAG_TYPE;if(!event.dataTransfer.types.includes(mime))return null;return resolve(drag.source,event);};
    node.addEventListener('dragover',event=>{const target=targetFor(event);if(!target)return;event.preventDefault();event.stopPropagation();event.dataTransfer!.dropEffect='move';node.classList.add('move-drop-active');node.dataset.dropSide='side'in target?target.side:'inside';caption.textContent=`Move “${sourceName(drag!.source)}” ${moveTargetLabel(state!,target)}. Release to preview.`;if(moveLive.textContent!==caption.textContent)moveLive.textContent=caption.textContent;});
    node.addEventListener('dragleave',event=>{if(event.relatedTarget instanceof Node&&node.contains(event.relatedTarget))return;node.classList.remove('move-drop-active');caption.textContent=label;});
    node.addEventListener('drop',event=>{const target=targetFor(event),active=drag;if(!target||!active)return;event.preventDefault();event.stopImmediatePropagation();const raw=event.dataTransfer!.getData(active.source.kind==='group'?GROUP_DRAG_TYPE:SCENE_DRAG_TYPE);clearDrag();if(raw!==active.token){hooks.report('This move did not come from the current manuscript. Nothing changed.',true);return;}void performMove(active.source,target,active.revision,active.repositoryId);});
  }
  function acceptDrop(event: DragEvent, beforeId: string | null = null) {
    if (!event.dataTransfer || !state?.revision || state.recoveryRequired) return;
    event.preventDefault(); event.stopPropagation();
    try {
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
    clearDrag();element.replaceChildren(); if (!state) return;
    element.append(moveLive);
    element.append(el('h3', state.project || hooks.repository()?.name || 'Manuscript'), el('p', 'ms/ · Local scenes · Explicit reading order', 'muted'));
    if (state.recoveryRequired) {
      element.append(el('p', 'An interrupted manuscript change needs attention. Review its guarded rollback before making more structural changes.', 'drafting-warning'), button('Preview rollback of interrupted change', () => { void changeManuscript({kind: 'recoverInterrupted'}); }));
      return;
    }
    if (!state.revision) {
      const disabled=el('div','','drafting-actions');for(const label of ['Add scene','Add chapter']){const b=button(label,()=>{});b.disabled=true;b.setAttribute('aria-describedby','manuscript-setup-reason');disabled.append(b);}element.append(disabled);
      const reason=el('p','Create a manuscript before adding chapters or scenes.','drafting-help');reason.id='manuscript-setup-reason';element.append(reason);
      element.append(el('p', 'Start a drafting manuscript in ms/. Legacy scenes stay available in the file browser and their existing manifests.', 'empty'), button('Create ms manuscript', initialize, 'primary')); return;
    }
    const controls = el('div', '', 'drafting-actions');
    controls.append(button('Add scene', newScene, 'primary'), button('Add chapter', newGroup), button('Import files…', () => { void importExternal(); }), button('Import repository files…', () => { void importRepository(); }), button('Copy legacy scenes…', () => { void importRepository('copy'); }));
    const undoButton = button('Undo last change', () => { void undoLastChange(); }); undoButton.disabled = !undo;
    controls.append(undoButton, button('Refresh ms', () => { void hooks.run(async () => { try { const loaded = await load(); if (loaded) { await hooks.changed(loaded, null, []); hooks.report('Manuscript refreshed from disk.'); } } catch (error) { hooks.report(`Refresh failed: ${String(error)}`, true); } }); }));
    element.append(controls);
    if (state.untrackedPaths.length || state.missingPaths.length) {
      const changes = el('details', '', 'drafting-warning');
      changes.append(el('summary', `${state.untrackedPaths.length} unlisted · ${state.missingPaths.length} missing scene files`));
      const list = el('ul'); state.untrackedPaths.forEach(path => list.append(el('li', `Unlisted: ${path}`))); state.missingPaths.forEach(path => list.append(el('li', `Missing: ${path}`)));
      changes.append(list, el('p', 'Discovery adds unlisted files and removes missing paths from the index. Existing scenes keep their order and IDs; source text is not rewritten.'), button('Preview ms discovery', () => { void changeManuscript({kind: 'reconcile'}); })); element.append(changes);
    }
    element.append(el('p', 'Drag scenes to reorder, or use Move earlier / Move later. Reordering never renames files.', 'drafting-help'));
    const list = el('ol', '', 'drafting-scenes'); list.setAttribute('aria-label', 'Drafting scenes in manuscript order');
    state.scenes.forEach((scene, index) => {
      const item = el('li', '', 'drafting-scene'); item.dataset.sceneId = scene.id;
      const open = button(`${index + 1}. ${scene.title || basename(scene.path)}`, () => hooks.open(scene.path), 'scene-open'); open.title = scene.path;
      item.append(moveGrip({kind:'scene',id:scene.id}));
      item.append(open, el('p', scene.path, 'scene-path'));
      moveDrop(item,(source,event)=>source.kind==='scene'?{kind:'scene',id:scene.id,side:event.clientY<item.getBoundingClientRect().top+item.getBoundingClientRect().height/2?'before':'after'}:null,`Drop a scene before or after “${scene.title}”`);
      const group = state!.groups.find(group => group.id === scene.groupId); item.append(el('span', group?.title ?? 'Loose scene', 'scene-group'));
      const actions = el('div', '', 'scene-actions');
      const earlier = button('↑', () => reorder(scene, -1)); earlier.setAttribute('aria-label', `Move ${scene.title || basename(scene.path)} earlier`); earlier.title = 'Move earlier'; earlier.disabled = index === 0;
      const later = button('↓', () => reorder(scene, 1)); later.setAttribute('aria-label', `Move ${scene.title || basename(scene.path)} later`); later.title = 'Move later'; later.disabled = index === state!.scenes.length - 1;
      const fileOptions=el('details');fileOptions.append(el('summary','File location options'),button('Move…',()=>moveScene(scene)));actions.append(earlier, later, button(`Move scene “${scene.title}”…`,()=>moveForm({kind:'scene',id:scene.id})),fileOptions); item.append(actions); dropTarget(item, scene.id); list.append(item);
    });
    element.append(list);
    const dropEnd = el('div', state.scenes.length ? 'End of manuscript — No chapter' : 'No scenes yet. Create a scene or import Markdown files.', 'drafting-drop');
    moveDrop(dropEnd,source=>source.kind==='scene'?{kind:'ungroupedEnd'}:null,'Drop a scene here to preview moving it to the document end with No chapter. Repository files open import settings.');
    dropTarget(dropEnd); element.append(dropEnd);
    const chapters=el('section','','drafting-chapters');chapters.setAttribute('aria-label','Chapters and scene groups');chapters.append(el('h4','Chapters and scene groups'));
    if(state.groupMoveIssue){const issue=el('p',state.groupMoveIssue,'drafting-warning');issue.id='manuscript-group-move-issue';chapters.append(issue);}
    for(const group of state.groups){const members=state.scenes.filter(s=>s.groupId===group.id),card=el('section','','manuscript-group-card');card.dataset.groupId=group.id;card.setAttribute('aria-label',group.title);card.append(el('h5',group.title),el('p',`${members.length} scene${members.length===1?'':'s'}${members.length?'':' — empty'}`),moveGrip({kind:'group',id:group.id}),button(`Move group “${group.title}”…`,()=>moveForm({kind:'group',id:group.id})));
      if(members.length)card.append(el('p',`Contains, in reading order: ${members.map(s=>s.title).join(' → ')}`));
      moveDrop(card,(source,event)=>source.kind==='group'?{kind:'group',id:group.id,side:event.clientY<card.getBoundingClientRect().top+card.getBoundingClientRect().height/2?'before':'after'}:{kind:'groupEnd',id:group.id},`Drop a group before/after “${group.title}”, or a scene into it`);chapters.append(card);
    }
    const endGroup=el('div','Drop a group after the other groups','manuscript-boundary-target');moveDrop(endGroup,source=>source.kind==='group'?{kind:'groupEndSlot'}:null,'After the other groups; ungrouped writing stays put');chapters.append(endGroup);
    const ungrouped=el('div','Move to end of manuscript, without a group','manuscript-boundary-target');moveDrop(ungrouped,source=>source.kind==='scene'?{kind:'ungroupedEnd'}:null,'Drop a scene here to place it at the document end with No chapter');chapters.append(ungrouped);element.append(chapters);

  }
  return { element, supported, clear, load, initialize, importExternal, splitScene, splitFile, bindMoveSource, bindMoveTarget: moveDrop, get state() { return state; },
    /** The same previewed, confirmed reorder as the ↑/↓ buttons. Resolves once the change settles. */
    async reorderScene(sceneId: string, delta: -1 | 1) { const scene = state?.scenes.find(item => item.id === sceneId); if (scene && state?.revision && !dialogs.size) await reorder(scene, delta); },
    newScene() { if (state?.revision && !dialogs.size) newScene(); },
    importRepository(mode: 'move' | 'copy' = 'move') { void importRepository(mode); },
    undoLastChange() { void undoLastChange(); },
    get canUndo() { return Boolean(undo); }, destroy() { disposed = true; clear(); } };
}
