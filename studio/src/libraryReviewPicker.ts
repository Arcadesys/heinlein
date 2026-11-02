import {captureLibraryScope, type CapturedLibraryScope, type LibraryScopeSelection} from './librarySnapshot';
import type {Document, DraftingState} from './localCore';

/** Selection is local; preparing never contacts a provider. */
export function openLibraryReviewPicker(options: {
  root: HTMLElement; state: DraftingState; activeId: string;
  active(): {id: string; document: Document} | null;
  read(path: string): Promise<Document>;
  ready(scope: CapturedLibraryScope, recapture: () => Promise<CapturedLibraryScope>, useDefaultTarget: boolean): void;
}) {
  const state = structuredClone(options.state); const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', 'Choose revision context and targets'); dialog.className = 'appearance-dialog drafting-dialog';
  const title = document.createElement('h2'); title.textContent = 'Choose revision context and targets'; dialog.append(title);
  const description = document.createElement('p'); description.textContent = 'The active sheet is included as context. Choose other sheets or groups for context and choose revision targets separately. Nothing is sent until you run the review.'; dialog.append(description);
  const selection: LibraryScopeSelection = {contextSheets:[options.activeId],contextGroups:[],targetSheets:[options.activeId],targetGroups:[]};
  let defaultTarget = true;
  let activeTarget: HTMLInputElement | null = null;
  function choices(heading: string, items: {id:string;title:string}[], key: keyof LibraryScopeSelection) {
    const field = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = heading; field.append(legend);
    for (const item of items) { const label = document.createElement('label'); label.className = 'library-review-choice'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selection[key].includes(item.id); if (key === 'contextSheets' && item.id === options.activeId) input.disabled = true;
      if (key === 'targetSheets' && item.id === options.activeId) activeTarget = input;
      input.addEventListener('change', () => {
        if (key === 'targetSheets' || key === 'targetGroups') {
          if (defaultTarget && input.checked && !(key === 'targetSheets' && item.id === options.activeId)) {
            selection.targetSheets = selection.targetSheets.filter(id => id !== options.activeId);
            if (activeTarget) activeTarget.checked = false;
          }
          defaultTarget = false;
        }
        selection[key] = input.checked ? [...selection[key],item.id] : selection[key].filter(id => id !== item.id);
      });
      label.append(input, document.createTextNode(` ${item.title}`)); field.append(label); }
    dialog.append(field);
  }
  choices('Additional context sheets',state.scenes,'contextSheets'); choices('Context groups, including descendants',state.groups,'contextGroups');
  choices('Revision target sheets',state.scenes,'targetSheets'); choices('Revision target groups, including descendants',state.groups,'targetGroups');
  const status = document.createElement('p'); status.setAttribute('role','status'); dialog.append(status);
  const prepare = document.createElement('button'); prepare.type = 'button'; prepare.textContent = 'Prepare review';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.remove();
  prepare.onclick = async () => {
    prepare.disabled = true; status.textContent = 'Capturing selected sheets locally…';
    const frozen = structuredClone(selection);
    const recapture = () => { const active = options.active(); return captureLibraryScope(state, frozen, active?.id === options.activeId ? active : null, options.read); };
    try { const scope = await recapture(); if (!dialog.isConnected) return; dialog.remove(); options.ready(scope, recapture, defaultTarget); }
    catch (error) { if (dialog.isConnected) { status.textContent = String(error); prepare.disabled = false; } }
  };
  dialog.addEventListener('cancel', event => {event.preventDefault(); dialog.remove();});
  dialog.append(prepare,cancel); options.root.append(dialog);
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open',''); prepare.focus();
}
