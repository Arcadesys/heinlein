import {StateEffect} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import { createProposalPanel } from './proposalPanel';
import { createWritingPanel } from './writingPanel';
import { createEditor, rawOffset } from './editor';
import { captureSelectionQuestion, createSelectionQuestionPanel, selectionQuestionAvailability, selectionQuestionProblem, type SelectionQuestionState } from './selectionQuestion';
import { createQuestionPanel, questionBytes, QUESTION_LIMITS } from './questionPanel';
import { createSelectionAskAction } from './selectionAsk';
import { createDraftingPanel, REPOSITORY_DRAG_TYPE } from './draftingPanel';
import type { DraftingFileChange, DraftingState } from './localCore';
import type { LocalCore, RepositorySession, Manuscript, Document, RecoveryDraft } from './localCore';
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

// Scan raw lines once: unfinished CRLF metadata must not trigger regex
// backtracking. null means an opening fence without a closing fence.
function splitBodyStart(source: string): number | null {
  let start = source.startsWith('\uFEFF') ? 1 : 0;
  let first = true;
  while (start <= source.length) {
    let end = start;
    while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end++;
    const line = source.slice(start, end).trimEnd();
    const next = end < source.length ? end + (source[end] === '\r' && source[end + 1] === '\n' ? 2 : 1) : end;
    if (first) {
      if (line !== '---') return 0;
      first = false;
    } else if (line === '---' || line === '...') return next;
    if (end === source.length) return null;
    start = next;
  }
  return null;
}

let zoomKeyHandler: ((event: KeyboardEvent) => void) | null = null;

export const AUTOSAVE_DELAY_MS = 600;
export const AUTOSAVE_MAX_WAIT_MS = 5000;

export function mountStudio(root: HTMLElement, core: LocalCore) {
  const writing = createWritingPanel();
  let generation = 0;
  let opened: Document | null = null;
  let editor: ReturnType<typeof createEditor> | null = null;
  let questions: ReturnType<typeof createSelectionQuestionPanel> | null = null;
  let draftingQuestions: ReturnType<typeof createQuestionPanel> | null = null;
  let questionButton: HTMLButtonElement | null = null;
  let selectionAsk: ReturnType<typeof createSelectionAskAction> | null = null;
  let selectionCaptureVersion = 0; let selectionCapturePending = false;
  let dirty = false;
  let saving = false;
  let edits = 0;
  let documentEpoch = 0;
  let disposed = false;
  let repositoryDetached = false;
  let structuralBusy = false;
  let structuralEditRevision = 0;
  let proposalBusy = false;
  let proposalEditRevision = 0;
  let dropUnlisten: (() => void) | null = null;
  let dropErrorUnlisten: (() => void) | null = null;
  let recovery: RecoveryDraft | null = null;
  let recoveryPending = false;
  let writeBaseHash = '';
  let recoveryErrorMessage: string | null = null;
  let writePaused: 'conflict' | 'error' | 'discard' | null = null;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let stageQueue: Promise<unknown> = Promise.resolve();
  let staging = 0;
  let writeInFlight: Promise<boolean> | null = null;
  let saveButton: HTMLButtonElement | null = null;
  let dirtyBadge: HTMLElement | null = null;
  let guardPending: Promise<boolean> | null = null;
  let closeUnlisten: (() => void) | null = null;
  let dirtySync = Promise.resolve();
  function updateSaveState() {
    if (dirtyBadge) dirtyBadge.textContent = recoveryPending ? 'Recovery available' : saving ? 'Saving locally…' : dirty ? (writePaused ? 'Unsaved · autosave paused' : 'Unsaved changes') : 'Saved locally';
    if (saveButton) saveButton.disabled = saving || recoveryPending || !dirty;
    draftingQuestions?.stateChanged();
  }
  function setDirty(value: boolean) {
    dirty = value;
    updateSaveState();
    dirtySync = dirtySync.then(() => { if (!disposed) return core.setUnsavedChanges(value); }).catch(error => {
      if (disposed) return;
      status.textContent = `Close protection unavailable: ${String(error)}. Keep this window open until you save.`;
      status.classList.add('error');
    });
  }
  function cancelAutosave() {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
    autosaveTimer = null; maxWaitTimer = null;
  }
  function scheduleAutosave() {
    if (disposed || structuralBusy || selecting || repositoryDetached || recoveryPending || guardPending || !editor) { cancelAutosave(); return; }
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    const flush = () => { cancelAutosave(); void persistCurrent(false); };
    autosaveTimer = setTimeout(flush, AUTOSAVE_DELAY_MS);
    // Continuous typing must not postpone the first durable snapshot forever.
    // While a save is pending this timer stages only, without a concurrent save.
    if (maxWaitTimer === null) maxWaitTimer = setTimeout(flush, AUTOSAVE_MAX_WAIT_MS);
  }
  function active(epoch: number) { return !disposed && epoch === documentEpoch; }
  // Recovery writes are ordered separately, so typing during a slow manuscript
  // save can still become durable without allowing concurrent manuscript saves.
  function stageCurrent() {
    const snapshot = {epoch: documentEpoch, repositoryId: repository!.id, path: opened!.path, baseHash: writeBaseHash, text: editor!.text()};
    staging++;
    const task = stageQueue.then(async () => {
      if (!active(snapshot.epoch)) return null;
      const draft = await core.stageRecovery(snapshot.repositoryId, snapshot.path, snapshot.baseHash, snapshot.text);
      if (!active(snapshot.epoch)) return null;
      recovery = draft;
      if (draft.text === editor?.text()) recoveryErrorMessage = null;
      return {snapshot, draft};
    });
    stageQueue = task.catch(() => {}).finally(() => { staging--; });
    return task;
  }
  function recoveryFailure(error: unknown) {
    writePaused = 'error'; updateSaveState();
    recoveryErrorMessage = `Recovery could not be saved: ${String(error)}. Your edits remain in this window; keep it open and retry Save. The manuscript was not written for this snapshot.`;
    status.textContent = recoveryErrorMessage;
    status.classList.add('error');
  }
  async function clearRecovery(draft: RecoveryDraft, repositoryId: string, epoch: number) {
    // A newer staged draft is not ours to remove. The native CAS also protects
    // against a stage finishing between this check and the delete.
    if (!active(epoch) || recovery?.id !== draft.id) return true;
    try {
      await core.discardRecovery(repositoryId, draft.path, draft.id);
      if (active(epoch) && recovery?.id === draft.id) recovery = null;
      return true;
    } catch (error) {
      if (!active(epoch) || recovery?.id !== draft.id) return true;
      status.textContent = `Manuscript saved locally, but recovery cleanup failed: ${String(error)}. The saved file is safe; a recovery copy remains.`;
      status.classList.add('error');
      return false;
    }
  }
  async function persistCurrent(manual: boolean): Promise<boolean> {
    if (repositoryDetached) { reportDetachedRepository(); return false; }
    if (disposed || proposalBusy || selecting || !opened || !editor || !repository || recoveryPending) return false;
    if (writeInFlight) {
      if (manual) {
        const epoch = documentEpoch;
        await writeInFlight;
        if (!active(epoch)) return false;
        return dirty ? persistCurrent(true) : true;
      }
      try { await stageCurrent(); } catch (error) { if (!disposed) recoveryFailure(error); }
      return false;
    }
    if (!dirty && !recovery) return true;
    const epoch = documentEpoch;
    saving = true; updateSaveState();
    let failed = false;
    const task = (async () => {
      let staged: Awaited<ReturnType<typeof stageCurrent>>;
      try { staged = await stageCurrent(); }
      catch (error) { if (active(epoch)) recoveryFailure(error); failed = true; return false; }
      if (!staged || !active(epoch)) return false;
      const {snapshot, draft} = staged;
      if (!dirty && snapshot.text === opened!.text) {
        await clearRecovery(draft, snapshot.repositoryId, epoch);
        return true;
      }
      if (writePaused && !manual) return false;
      if (manual) writePaused = null;
      status.classList.remove('error'); status.textContent = `Saving ${snapshot.path}…`;
      let saved: Document;
      try {
        saved = await core.saveDocument(snapshot.repositoryId, snapshot.path, snapshot.baseHash, snapshot.text);
      } catch (error) {
        failed = true;
        if (active(epoch)) {
          writePaused = /conflict|changed/i.test(String(error)) ? 'conflict' : 'error';
          status.textContent = `Save failed: ${String(error)}. ${recoveryErrorMessage ?? 'A draft is kept in local recovery.'} Automatic manuscript saves are paused; compare the file on disk before retrying a conflict.`;
          status.classList.add('error');
        }
        return false;
      }
      if (!active(epoch)) return false;
      opened = saved; writeBaseHash = saved.contentHash;
      writing.saved(repository?.projectKey ?? '', snapshot.path, saved.text);
      editor!.markSaved(saved.text);
      setDirty(editor!.text() !== saved.text);
      const cleaned = await clearRecovery(draft, snapshot.repositoryId, epoch);
      if (!active(epoch)) return false;
      if (dirty && recoveryErrorMessage) { status.textContent = recoveryErrorMessage; status.classList.add('error'); }
      else if (cleaned) status.textContent = dirty ? 'Saved the submitted revision. Newer edits are still unsaved.' : `Saved ${saved.path} locally`;
      return !dirty;
    })();
    writeInFlight = task;
    try { return await task; }
    finally {
      if (writeInFlight === task) writeInFlight = null;
      if (active(epoch)) {
        saving = false; updateSaveState();
        if (dirty && !failed && !writePaused) scheduleAutosave();
      }
    }
  }
  async function saveCurrent(): Promise<boolean> {
    cancelAutosave();
    return persistCurrent(true);
  }
  async function discardCurrent(): Promise<boolean> {
    cancelAutosave();
    const epoch = documentEpoch;
    const revision = edits;
    // If the subsequent read/picker fails, keep the visible buffer and do not
    // unexpectedly autosave text the author just asked to discard.
    writePaused = 'discard';
    await stageQueue;
    if (!active(epoch) || revision !== edits) return false;
    try {
      if (recovery && !repositoryDetached) await core.discardRecovery(repository!.id, opened!.path, recovery.id);
      if (!active(epoch) || revision !== edits) return false;
      recovery = null;
      return true;
    } catch (error) {
      status.textContent = `Recovery could not be discarded: ${String(error)}. Your edits remain here.`;
      status.classList.add('error');
      return false;
    }
  }
  function allowLeave(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (structuralBusy) { status.textContent = 'Finish the current manuscript change before leaving.'; return Promise.resolve(false); }
    if (saving || staging) { status.textContent = 'Wait for the current local save to finish; your editor is still available.'; return Promise.resolve(false); }
    if (!dirty) return recovery && !recoveryPending ? persistCurrent(false) : Promise.resolve(true);
    if (guardPending) return Promise.resolve(false);
    cancelAutosave();
    const prompt = el('dialog', '', 'appearance-dialog');
    prompt.setAttribute('aria-label', 'Unsaved changes');
    prompt.append(el('h2', 'Keep your changes?'), el('p', 'This scene has unsaved changes. Save them before leaving, or discard them and their recovery copy.'));
    guardPending = new Promise(resolve => {
      let settled = false;
      let committing = false;
      const finish = (allowed: boolean) => {
        if (settled || committing) return;
        settled = true; prompt.remove(); guardPending = null;
        if (!allowed && !writePaused) scheduleAutosave();
        resolve(allowed);
      };
      const commit = (action: () => Promise<boolean>) => {
        if (committing || settled) return;
        committing = true; prompt.querySelectorAll('button').forEach(control => { control.disabled = true; });
        void action().then(ok => { committing = false; finish(ok); });
      };
      prompt.append(button('Keep editing', () => finish(false)), button('Discard changes', () => commit(discardCurrent)), button('Save and continue', () => commit(saveCurrent), 'primary'));
      prompt.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      root.append(prompt);
      if (prompt.showModal) prompt.showModal(); else prompt.setAttribute('open', '');
      prompt.querySelector('button')?.focus();
    });
    return guardPending;
  }
  const unload = (event: BeforeUnloadEvent) => { if (dirty || saving || staging || structuralBusy) { event.preventDefault(); event.returnValue = ''; } };
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
  const proposalsEntry = button('Revision proposals', () => { void proposals.open(); });
  proposalsEntry.hidden = true;
  actions.append(zoomGroup, appearance, proposalsEntry, open);
  header.append(brand, actions);
  const banner = el('p', 'LOCAL DRAFTING · Autosave & local recovery · No AI or network required', 'safety-banner');
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
  const draftingEntry = button('ms drafting', () => { void openDrafting(); }, 'drafting-entry');
  draftingEntry.hidden = true;
  const outline = el('div');
  outline.append(el('p', 'Open a folder with a scene-manifest.json to browse manuscript order.', 'empty'));
  const manuscriptBody = el('div', '', 'panel-body');
  manuscriptBody.append(draftingEntry, manifests, outline);
  manuscriptPane.append(panelHead(el('h2', 'Manuscript'), 'manuscript', 'manuscript outline'), manuscriptBody);
  const preview = el('section', '', 'panel preview');
  preview.setAttribute('aria-label', 'Document preview');
  resetPreview();
  layout.append(files, manuscriptPane, preview);
  setCollapsed('files', Boolean(collapsed.files));
  setCollapsed('manuscript', Boolean(collapsed.manuscript));
  const footer = el('footer', 'Local Markdown drafting · Autosaves locally · Save now with Cmd/Ctrl+S');
  root.replaceChildren(header, banner, writing.element, recent, status, layout, footer);
  const drafting = createDraftingPanel(core, {
    root, repository: () => repository, run: runStructural, verify: verifyStructuralBuffer,
    show: () => { outline.replaceChildren(drafting.element); if (drafting.state) void writing.setManuscript(core, repository!, drafting.state); },
    open: path => { void showDocument(path); }, changed: draftingChanged,
    report: (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); },
  });
  const proposals = createProposalPanel(core, {
    root, repository: () => repository, run: runProposal,
    changed: async path => {
      // A late editor event must never be discarded by an applied proposal refresh.
      if (dirty || edits !== proposalEditRevision || recoveryPending || recovery) {
        writePaused = 'conflict'; updateSaveState();
        throw new Error('The disk may have changed; newer editor text was preserved. Compare it with the source before saving');
      }
      resetPreview();
      if (!await showDocument(path, true)) throw new Error('The operation was recorded, but the scene could not be safely reopened. Reload it before editing');
      if (drafting.state) await writing.setManuscript(core, repository!, drafting.state);
    },
    report: (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); },
  });
  function selectionQuestionState() {
    if (disposed || !editor || !opened || !repository || editor.view.state.selection.ranges.length !== 1) return null;
    const range = editor.view.state.selection.main;
    const source = editor.text();
    return {
      repositoryId: repository.id, path: opened.path,
      sceneId: drafting.state?.scenes.find(scene => scene.path === opened!.path)?.id ?? null,
      documentEpoch, revision: edits, source, sourceHash: opened.contentHash,
      from: rawOffset(source, range.from), to: rawOffset(source, range.to),
      readOnly: editor.view.state.readOnly || opened.generatedCompatibility,
      recoveryPending, detached: repositoryDetached,
      busy: selecting || structuralBusy || proposalBusy || saving || staging > 0 || Boolean(guardPending) || Boolean(writePaused),
    };
  }
  questions = createSelectionQuestionPanel({
    root, current: selectionQuestionState,
    apply: review => {
      if (!editor || selectionQuestionProblem(review.snapshot, selectionQuestionState())) return false;
      editor.replaceText(review.nextSource, 'programmatic');
      editor.view.focus();
      return true;
    },
    report: (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); },
  });
  draftingQuestions = createQuestionPanel(core, {
    current: () => {
      if (disposed || !editor || !opened || !repository) return null;
      const source = editor.text(); const range = editor.view.state.selection.main;
      const single = editor.view.state.selection.ranges.length === 1;
      return {repositoryId: repository.id, path: opened.path, source,
        from: single ? rawOffset(source, range.from) : -1, to: single ? rawOffset(source, range.to) : -1,
        canCapture: !editor.view.state.readOnly && !opened.generatedCompatibility && !recoveryPending && !repositoryDetached && !selecting && !structuralBusy && !proposalBusy};
    },
    focusEditor: () => editor?.view.focus(),
    selectionState: reviewing => {
      const current = selectionQuestionState();
      return reviewing && current && proposalBusy ? {...current, readOnly: Boolean(opened?.generatedCompatibility), busy: false} : current;
    },
    revisionUnavailable: reviewing => revisionUnavailable(Boolean(reviewing)),
    prepareRevision: async snapshot => {
      await dirtySync;
      const problem = revisionUnavailable(false) ?? selectionQuestionProblem(snapshot, selectionQuestionState());
      if (problem) throw new Error(problem);
    },
    reviewRevision: (id, _snapshot, guard) => proposals.reviewProposal(id, guard),
    visibilityChanged: visible => {questionButton?.setAttribute('aria-expanded', String(visible)); if (!visible) {selectionCaptureVersion++; selectionCapturePending = false;}},
  });
  draftingQuestions.element.id = 'drafting-questions';
  function revisionUnavailable(reviewing = false) {
    if (!proposals.supported) return 'Revision review is unavailable in this native host.';
    if (!editor || !opened || !repository || repositoryDetached || opened.generatedCompatibility) return 'Open an attached, editable saved scene before requesting a revision.';
    if (dirty || saving || staging || writeInFlight || recovery || recoveryPending || guardPending || writePaused) return 'Save your scene and resolve local recovery before requesting or reviewing a revision. Nothing is saved automatically by Questions.';
    if (selecting || ((structuralBusy || proposalBusy) && !reviewing)) return 'Finish the current local operation before requesting a revision.';
    return null;
  }
  function draftingSelectionState(): SelectionQuestionState | null {
    const current = selectionQuestionState();
    // Asking is read-only; an in-flight local save does not block capture.
    return current ? {...current, busy: selecting || structuralBusy || proposalBusy || Boolean(guardPending)} : null;
  }
  async function askDraftingSelection(expected?: SelectionQuestionState) {
    if (selectionCapturePending) return;
    const initial = expected ?? draftingSelectionState(); const unavailable = selectionQuestionAvailability(initial);
    if (!initial || unavailable) {status.textContent = unavailable ?? 'Highlight a passage first.'; return;}
    if (questionBytes(initial.source.slice(initial.from, initial.to)) > QUESTION_LIMITS.context) {
      status.textContent = `This selection exceeds ${QUESTION_LIMITS.context.toLocaleString()} UTF-8 bytes. Highlight a shorter passage before asking. Nothing was sent.`; status.classList.add('error'); return;
    }
    const request = ++selectionCaptureVersion; selectionCapturePending = true;
    const contextVersion = draftingQuestions?.selectionVersion();
    try {
      const snapshot = await captureSelectionQuestion(initial);
      if (disposed || selectionCaptureVersion !== request) return;
      const problem = selectionQuestionProblem(snapshot, draftingSelectionState()); if (problem) throw new Error(problem);
      draftingQuestions?.openSelection({repositoryId: snapshot.repositoryId, path: snapshot.path, source: snapshot.source, from: snapshot.from, to: snapshot.to, canCapture: true}, contextVersion);
    } catch (error) {
      if (!disposed && selectionCaptureVersion === request) {status.textContent = error instanceof Error ? error.message : 'The selection could not be captured. Highlight the passage again.'; status.classList.add('error');}
    } finally {if (selectionCaptureVersion === request) selectionCapturePending = false;}
  }
  async function runProposal(action: () => Promise<void>) {
    if (disposed || structuralBusy || selecting || !repository) return;
    if (repositoryDetached) { reportDetachedRepository(); return; }
    if (dirty || saving || staging || writeInFlight || recovery || recoveryPending || guardPending || writePaused) {
      status.textContent = 'Save your scene and resolve local recovery before reviewing a proposal. Your current editor and recovery are preserved.'; status.classList.add('error'); return;
    }
    proposalBusy = true; structuralBusy = true; proposalEditRevision = edits;
    documentRequest++; manuscriptRequest++; directoryRequest++;
    cancelAutosave(); editor?.setEditable(false); layout.inert = true; open.disabled = true; proposalsEntry.disabled = true;
    recent.querySelectorAll('button').forEach(node => { node.disabled = true; });
    try {
      await dirtySync; await stageQueue;
      if (dirty || recovery || recoveryPending || saving || edits !== proposalEditRevision) throw new Error('The editor changed while preparing review; save it and review again');
      await action();
    } catch (error) { status.textContent = `Proposal review stopped: ${String(error)}`; status.classList.add('error'); }
    finally {
      proposalBusy = false; structuralBusy = false;
      if (!disposed) {
        layout.inert = false; open.disabled = !core.available(); proposalsEntry.disabled = false;
        editor?.setEditable(!recoveryPending); recent.querySelectorAll('button').forEach(node => { node.disabled = false; });
        setDirty(dirty); if (dirty && !writePaused) scheduleAutosave();
      }
    }
  }
  function verifyStructuralBuffer() {
    if (dirty || recovery || recoveryPending || edits !== structuralEditRevision) {
      writePaused = 'conflict'; updateSaveState();
      throw new Error('The editor changed during the manuscript change. Newer text is preserved; compare the source before saving');
    }
  }
  function splitAtCursor() {
    if (!editor || !opened || !repository || structuralBusy || selecting || repositoryDetached || recoveryPending || guardPending || editor.view.state.readOnly) return;
    const scene = drafting.state?.scenes.find(item => item.path === opened!.path);
    if (!scene || !drafting.state?.revision || drafting.state.recoveryRequired) {
      status.textContent = 'Open a scene in the ms manuscript before splitting.'; return;
    }
    const ranges = editor.view.state.selection.ranges; const range = editor.view.state.selection.main;
    const source = editor.text(); const offset = rawOffset(source, range.from);
    // Raw offsets are UTF-16. Refuse a surrogate midpoint before encoding UTF-8.
    const midpoint = offset > 0 && /[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset] ?? '');
    const bodyStart = splitBodyStart(source);
    const invalidUnicode = new TextDecoder('utf-8', {ignoreBOM: true}).decode(new TextEncoder().encode(source)) !== source;
    if (bodyStart === null || invalidUnicode || ranges.length !== 1 || !range.empty || offset <= (bodyStart ?? 0) || offset >= source.length || midpoint) {
      status.textContent = 'Place one cursor inside the scene body, with text on both sides; clear any selection first.'; status.classList.add('error'); return;
    }
    const epoch = documentEpoch; const revision = edits; const repositoryId = repository.id; const path = opened.path;
    const byteOffset = new TextEncoder().encode(source.slice(0, offset)).length;
    drafting.splitScene(scene.id, () => {
      if (!editor || !opened || repository?.id !== repositoryId || documentEpoch !== epoch || edits !== revision || opened.path !== path || editor.text() !== source || drafting.state?.scenes.find(item => item.id === scene.id)?.path !== path || editor.view.state.selection.ranges.length !== 1 || !editor.view.state.selection.main.empty || rawOffset(source, editor.view.state.selection.main.from) !== offset) {
        throw new Error('The scene or cursor changed. Place the cursor again and start a new split');
      }
      return {expectedHash: opened.contentHash, byteOffset};
    });
  }
  async function runStructural(action: () => Promise<void>) {
    if (disposed || structuralBusy || selecting || !repository) return;
    if (repositoryDetached) { reportDetachedRepository(); return; }
    if (recoveryPending || guardPending) {
      status.textContent = 'Resolve the open recovery draft or save dialog before changing manuscript structure. Your recovery has been kept.'; status.classList.add('error'); return;
    }
    structuralBusy = true; structuralEditRevision = edits;
    // Invalidate reads begun before a move so their old paths cannot become active.
    documentRequest++; manuscriptRequest++; directoryRequest++;
    cancelAutosave(); editor?.setEditable(false); layout.inert = true; open.disabled = true;
    recent.querySelectorAll('button').forEach(node => { node.disabled = true; });
    try {
      await dirtySync;
      if (writeInFlight) await writeInFlight;
      await stageQueue;
      if ((dirty || recovery) && !await persistCurrent(true)) return;
      if (dirty || recovery || recoveryPending || writePaused === 'conflict') {
        status.textContent = 'Save and resolve local recovery before changing manuscript structure. The current editor and recovery are preserved.'; status.classList.add('error'); return;
      }
      // Native drafting routes require the actual editor dirty flag to be clear.
      // OS closes always pass through allowLeave, which independently checks structuralBusy.
      await dirtySync;
      verifyStructuralBuffer();
      await action();
    } catch (error) { status.textContent = `Manuscript change stopped: ${String(error)}`; status.classList.add('error'); }
    finally {
      structuralBusy = false;
      if (!disposed) {
        layout.inert = false; open.disabled = !core.available(); editor?.setEditable(!recoveryPending);
        recent.querySelectorAll('button').forEach(node => { node.disabled = false; });
        setDirty(dirty); if (dirty && !writePaused) scheduleAutosave();
      }
    }
  }
  async function draftingChanged(state: DraftingState, previous: DraftingState | null, changes: DraftingFileChange[], focusPath?: string) {
    verifyStructuralBuffer();
    const oldPath = opened?.path;
    const oldScene = previous?.scenes.find(scene => scene.path === oldPath);
    const sameScene = oldScene ? state.scenes.find(scene => scene.id === oldScene.id) : undefined;
    const moved = changes.find(change => change.source === oldPath && change.destination)?.destination;
    const nextPath = focusPath ?? sameScene?.path ?? moved ?? (oldScene ? null : oldPath);
    // All buffers are saved before structural changes. Remove the old path's
    // editor before reading its replacement; a failed read must not leave it writable.
    if (opened) resetPreview();
    await showDirectory(directoryPath.textContent === '/' ? '' : directoryPath.textContent || '');
    await writing.setManuscript(core, repository!, state);
    if (nextPath && !await showDocument(nextPath, true)) throw new Error(`The change is saved. ${status.textContent ?? 'The scene could not be reopened.'} Resolve recovery or use the file browser to retry.`);
  }
  async function openDrafting() {
    if (structuralBusy || selecting || !repository) return;
    try {
      const state = await drafting.load();
      if (state) { outline.replaceChildren(drafting.element); void writing.setManuscript(core, repository, state); }
    } catch (error) { reportError(error); }
  }

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
    questions?.clear();
    selectionAsk?.destroy(); selectionAsk = null;
    draftingQuestions?.clear(); questionButton = null;
    writing.clearScene();
    cancelAutosave(); documentEpoch++; recoveryErrorMessage = null; recovery = null; recoveryPending = false; writePaused = null;
    editor?.destroy(); editor = null; opened = null; saveButton = null; dirtyBadge = null; setDirty(false);
    preview.replaceChildren(el('p', 'SOURCE PREVIEW', 'eyebrow'), el('h2', 'A quiet place to read'), el('p', 'Select a scene or file. Source text is displayed exactly as stored, including Markdown and frontmatter.', 'empty'));
  }
  function reportError(error: unknown) {
    status.textContent = `Unable to open: ${typeof error === 'string' ? error : error instanceof Error ? error.message : 'The local host rejected this request.'}`;
    status.classList.add('error');
  }
  function reportDetachedRepository() {
    status.textContent = 'The editor changed while the folder was opening. Your text is preserved here, but the previous folder session is no longer active. Copy these edits before reopening the original folder. Saving and autosave are paused.';
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
    questions?.clear();
    draftingQuestions?.clear();
    const editRevision = edits;
    const wasReadOnly = editor?.view.state.readOnly ?? false;
    const current = ++generation;
    open.disabled = true;
    recent.querySelectorAll('button').forEach(node => { node.disabled = true; });
    // Block navigation while the host may be switching its selected root.
    layout.inert = true; cancelAutosave(); editor?.setEditable(false);
    status.classList.remove('error');
    status.textContent = 'Opening folder…';
    try {
      const selected = await select();
      if (disposed || current !== generation) return;
      if (!selected) { if (repositoryDetached) reportDetachedRepository(); else status.textContent = repository ? `${repository.name} · Local drafting` : 'Folder selection canceled.'; return; }
      if (editRevision !== edits) {
        // A programmatic/late editor event can bypass DOM inert/readOnly. The
        // native host may already have selected a different repository, so do
        // not replace this buffer or try saving it into the new session.
        repositoryDetached = true; writePaused = 'error'; updateSaveState();
        reportDetachedRepository();
        return;
      }
      repository = selected;
      repositoryDetached = false;
      writing.clearManuscript();
      drafting.clear(); proposals.clear();
      proposalsEntry.hidden = !proposals.supported;
      draftingEntry.hidden = !drafting.supported;
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
      let draftState: DraftingState | null = null;
      if (drafting.supported) {
        try { draftState = await drafting.load(); } catch (error) { reportError(error); }
      }
      if (disposed || current !== generation) return;
      if (draftState?.revision || draftState?.recoveryRequired || (draftState && !selected.manifests.length)) {
        outline.replaceChildren(drafting.element); void writing.setManuscript(core, selected, draftState);
        await showDirectory('');
      } else await Promise.all([showDirectory(''), selected.manifests[0] ? showManuscript(selected.manifests[0]) : Promise.resolve()]);
      if (!disposed && current === generation && !status.classList.contains('error')) status.textContent = `${selected.name} · Local drafting${selected.warning ? ` · ${selected.warning}` : ''}`;
      await refreshRecent();
    } catch (error) { if (!disposed && current === generation) { if (repositoryDetached) reportDetachedRepository(); else reportError(error); } }
    finally { if (!disposed && current === generation) { selecting = false; open.disabled = false; layout.inert = false; editor?.setEditable(!recoveryPending && !wasReadOnly); recent.querySelectorAll('button').forEach(node => { node.disabled = false; }); if (dirty && !writePaused) scheduleAutosave(); } }
  }
  async function showDirectory(path: string) {
    const current = generation;
    const request = ++directoryRequest;
    try {
      const entries = await core.listDirectory(repository!.id, path);
      if (disposed || current !== generation || request !== directoryRequest) return;
      directoryPath.textContent = path || '/';
      listing.replaceChildren();
      if (path) listing.append(button('↑ Parent folder', () => { void showDirectory(parentPath(path)); }, 'file-entry parent'));
      for (const entry of entries) {
        const folder = entry.kind === 'directory';
        const item = button(`${folder ? '▸' : '·'} ${entry.name}`, () => { void (folder ? showDirectory(entry.path) : showDocument(entry.path)); }, 'file-entry');
        item.setAttribute('aria-label', `${folder ? 'Open folder' : 'Read file'} ${entry.name}`);
        if (!folder && /\.(md|markdown)$/i.test(entry.path) && drafting.supported) {
          item.draggable = true; item.title = 'Drag into the manuscript to move this file, or use Import repository files…';
          item.addEventListener('dragstart', event => { if (!event.dataTransfer) return; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(REPOSITORY_DRAG_TYPE, JSON.stringify({repositoryId: repository!.id, path: entry.path})); });
        }
        listing.append(item);
      }
      if (!entries.length) listing.append(el('p', 'This folder is empty.', 'empty'));
    } catch (error) { if (!disposed && current === generation && request === directoryRequest) reportError(error); }
  }
  async function showDocument(path: string, structuralRefresh = false) {
    if (selecting && !structuralRefresh) return false;
    if (!structuralRefresh && !await allowLeave()) return false;
    const editRevision = edits;
    const current = generation;
    const request = ++documentRequest;
    status.classList.remove('error');
    status.textContent = `Reading ${path}…`;
    // Keep the current buffer visible until a successful replacement read.
    try {
      const repositoryId = repository!.id;
      const doc = await core.readDocument(repositoryId, path);
      if (disposed || current !== generation || request !== documentRequest || editRevision !== edits) return;
      let draft: RecoveryDraft | null = null;
      let recoveryError: {error: unknown} | null = null;
      if (!doc.generatedCompatibility && /\.(md|markdown)$/i.test(doc.path)) {
        try { draft = await core.readRecovery(repositoryId, path); }
        catch (error) { recoveryError = {error}; }
      }
      if (disposed || current !== generation || request !== documentRequest || editRevision !== edits) return;
      renderDocument(doc, draft);
      if (recoveryError) showRecoveryReadFailure(doc, recoveryError.error);
      else if (!recoveryPending) {
        status.textContent = `Read ${doc.path} · ${doc.sizeBytes.toLocaleString()} bytes`;
        if (draft) await clearRecovery(draft, repositoryId, documentEpoch);
      }
      return !recoveryError && !recoveryPending;
    } catch (error) { if (!disposed && current === generation && request === documentRequest) reportError(error); return false; }
  }
  function renderDocument(doc: Document, draft: RecoveryDraft | null = null) {
    questions?.clear();
    selectionAsk?.destroy(); selectionAsk = null;
    draftingQuestions?.clear(); questionButton = null;
    writing.openScene(repository?.projectKey ?? '', doc.path, doc.text, drafting.state?.scenes.find(scene => scene.path === doc.path)?.id);
    cancelAutosave(); documentEpoch++; recoveryErrorMessage = null; recovery = draft; recoveryPending = Boolean(draft && draft.text !== doc.text); writePaused = null; writeBaseHash = doc.contentHash;
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
      const askSelection = button('Ask about selection', () => { void questions?.open(); });
      askSelection.setAttribute('aria-haspopup', 'dialog');
      askSelection.title = 'Prepare a question for manual copy/paste into ChatGPT or another assistant';
      questionButton = button('Questions', () => draftingQuestions?.open());
      questionButton.setAttribute('aria-controls', 'drafting-questions'); questionButton.setAttribute('aria-expanded', 'false');
      questionButton.title = 'Ask OpenAI while drafting, with only the context you choose';
      const askDrafting = button('Ask Heinlein about selection', () => {void askDraftingSelection();}); askDrafting.disabled = true;
      askDrafting.setAttribute('aria-keyshortcuts', 'Control+Alt+Enter Meta+Alt+Enter');
      askDrafting.title = 'Capture the selected passage into Questions (Cmd/Ctrl+Alt+Enter). Nothing is sent automatically.';
      const split = button('Split scene at cursor', splitAtCursor);
      split.setAttribute('aria-haspopup', 'dialog'); split.setAttribute('aria-keyshortcuts', 'Control+Shift+Enter Meta+Shift+Enter');
      split.title = 'Split scene at cursor (Cmd/Ctrl+Shift+Enter)';
      split.disabled = !drafting.state?.scenes.some(scene => scene.path === doc.path);
      toolbar.append(questionButton, askDrafting, askSelection, split, saveButton, button('Undo', () => editor?.undo()), button('Redo', () => editor?.redo()), button('Find', () => editor?.find()), dirtyBadge);
      const host = el('div', '', 'markdown-editor');
      host.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && event.key === 'Enter') {event.preventDefault(); event.stopPropagation(); void askDraftingSelection(); return;}
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); splitAtCursor(); }
      }, true);
      const draftingArea = el('div', '', 'drafting-editor-area');
      const editorColumn = el('div', '', 'drafting-editor-column'); editorColumn.append(toolbar, host);
      draftingArea.append(editorColumn); if (draftingQuestions) draftingArea.append(draftingQuestions.element);
      text.replaceWith(draftingArea);
      let previousText = doc.text;
      editor = createEditor(host, doc.text, (raw, origin) => {
        writing.changed(previousText, raw, origin); previousText = raw;
        edits++;
        if (writePaused === 'discard' && !repositoryDetached) writePaused = null;
        setDirty(raw !== opened?.text);
        scheduleAutosave();
      }, () => { void saveCurrent(); });
      editor.view.dispatch({effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {if (update.docChanged || update.selectionSet) draftingQuestions?.stateChanged();}))});
      selectionAsk = createSelectionAskAction(editor.view, {current: draftingSelectionState, fallback: askDrafting,
        ask: snapshot => {void askDraftingSelection(snapshot);}, stale: () => {status.textContent = 'The selection changed. Highlight the passage again before asking.';}});
      if (recoveryPending && draft) showRecoveryChoice(doc, draft, host);
      updateSaveState();
    }
    title.focus({ preventScroll: true });
  }
  function showRecoveryReadFailure(doc: Document, error: unknown) {
    recoveryPending = true;
    editor!.setEditable(false); updateSaveState();
    const notice = el('section', '', 'recovery-notice');
    notice.setAttribute('aria-label', 'Recovery unavailable');
    notice.append(el('h3', 'Recovery could not be checked'), el('p', 'The current file is shown read-only. Editing and autosave are paused so an unknown recovery draft cannot be replaced.'), button('Retry recovery', () => { void showDocument(doc.path); }));
    preview.querySelector('.markdown-editor')!.before(notice);
    status.textContent = `Recovery could not be read: ${String(error)}. The file on disk has not been changed.`;
    status.classList.add('error');
  }
  function showRecoveryChoice(doc: Document, draft: RecoveryDraft, host: HTMLElement) {
    const epoch = documentEpoch;
    const differs = draft.baseHash !== doc.contentHash;
    editor!.setEditable(false);
    const notice = el('section', '', 'recovery-notice');
    notice.setAttribute('aria-label', 'Recover local draft');
    notice.append(el('h3', 'A local recovery draft is available'), el('p', differs
      ? 'The file on disk changed after this draft began. Restoring opens your recovered text for comparison; manuscript autosave will stay paused to protect the disk version.'
      : 'Restore your recovered text to the editor, or discard it and keep the file on disk. Restored text will autosave locally.'));
    for (const [label, text] of [['Recovery draft', draft.text], ['Current file on disk', doc.text]]) {
      const detail = el('details'); detail.append(el('summary', label), el('pre', text, 'source-text')); notice.append(detail);
    }
    notice.append(button('Restore draft', () => {
      if (!active(epoch)) return;
      recoveryPending = false; writeBaseHash = draft.baseHash;
      writePaused = differs ? 'conflict' : null;
      editor!.setEditable(true); notice.remove();
      editor!.replaceText(draft.text, 'recovery');
      status.textContent = differs ? 'Recovered text restored. The disk version changed; manuscript autosave is paused. Both versions remain available until you resolve the conflict.' : 'Recovered text restored to the editor.';
      status.classList.toggle('error', differs);
      editor!.view.focus();
    }, 'primary'), button('Discard recovery', () => {
      notice.querySelectorAll('button').forEach(control => { control.disabled = true; });
      void core.discardRecovery(repository!.id, doc.path, draft.id).then(() => {
        if (!active(epoch)) return;
        recovery = null; recoveryPending = false; editor!.setEditable(true); notice.remove(); updateSaveState();
        status.classList.remove('error'); status.textContent = 'Recovery discarded. The file on disk is unchanged.';
      }).catch(error => {
        if (!active(epoch)) return;
        notice.querySelectorAll('button').forEach(control => { control.disabled = false; });
        status.textContent = `Recovery could not be discarded: ${String(error)}. The recovery draft is still available.`; status.classList.add('error');
      });
    }));
    host.before(notice);
    status.textContent = 'Choose whether to restore or discard the local recovery draft before editing.';
  }
  async function showManuscript(path: string) {
    if (structuralBusy) return;
    const current = generation;
    const request = ++manuscriptRequest;
    try {
      const book = await core.loadManuscript(repository!.id, path);
      if (disposed || current !== generation || request !== manuscriptRequest) return;
      renderManuscript(book);
      void writing.setManuscript(core, repository!, book);
    } catch (error) { if (!disposed && current === generation && request === manuscriptRequest) { outline.replaceChildren(el('p', 'Manuscript could not be loaded. Browse files or choose another manifest.', 'empty')); reportError(error); } }
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
    if (core.onDraftingFilesDropped) void core.onDraftingFilesDropped(selection => {
      if (disposed || structuralBusy || selecting || !repository) return;
      void drafting.importExternal(selection);
    }).then(unlisten => { if (disposed) unlisten(); else dropUnlisten = unlisten; }).catch(reportError);
    if (core.onDraftingImportError) void core.onDraftingImportError(message => { if (!disposed) { status.textContent = `Native import failed: ${message}`; status.classList.add('error'); } }).then(unlisten => { if (disposed) unlisten(); else dropErrorUnlisten = unlisten; }).catch(reportError);
    void core.onCloseRequested(() => {
      if (disposed) return;
      const revision = edits;
      void allowLeave().then(async allowed => {
        if (disposed || !allowed || revision !== edits || saving) return;
        root.inert = true;
        try { await dirtySync; if (!disposed && revision === edits && !saving) await core.requestClose(true); }
        finally { root.inert = false; }
      }).catch(reportError);
    }).then(unlisten => { if (disposed) unlisten(); else closeUnlisten = unlisten; }).catch(reportError);
  }
  else {
    open.disabled = true;
    status.textContent = 'Open Heinlein Studio in its native desktop app to choose local folders. Browser preview has no filesystem access.';
  }
  return { showDirectory, showDocument, showManuscript, selectRepository, saveCurrent,
    destroy: () => { questions?.destroy(); selectionAsk?.destroy(); draftingQuestions?.destroy(); proposals.destroy(); drafting.destroy(); dropUnlisten?.(); dropErrorUnlisten?.(); writing.destroy(); disposed = true; cancelAutosave(); documentEpoch++; editor?.destroy(); closeUnlisten?.(); window.removeEventListener('beforeunload', unload); if (zoomKeyHandler) document.removeEventListener('keydown', zoomKeyHandler); }
  };
}
