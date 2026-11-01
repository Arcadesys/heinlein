import {actionMenu} from './actionMenu';
import {createDocumentTabs,type DocumentTab} from './documentTabs';
import {createReferencePane,REFERENCE_ACTION_MESSAGE} from './referencePane';
import {requestGitHub} from './githubRequests';
import type {GitHubLocalEvidence} from './githubTypes';
import {createProjectLibrary,type Project,type ProjectResume} from './projects';
import {createRepositoryHome, documentOrigin, sharingStatus} from './repositoryHome';
import {wordCount} from './writingFeedback';
import {createStandaloneDrafts} from './standaloneDrafts';
import {createUpdatePanel} from './updatePanel';
import {createGitHubPanel} from './githubPanel';
import {createFirstStory} from './firstStory';
import { createReviewPanel } from './reviewPanel';
import { createMarkdownReader, type ReaderContent } from './markdownReader';
import { createReviewMarkPublisher, reviewMarkExtension, reviewMarksIn, setReviewMarks, type ReviewMarkTarget } from './reviewMarks';
import { createDocumentDetails } from './documentDetails';
import { createSceneNavigator, sceneBreaks } from './sceneNavigator';
import { createNavigationDrawer } from './navigationDrawer';
import { assembleChapter, chapterSelection, frontmatterEnd, type AssembledChapter } from './assembledChapter';
import { createManuscriptSearch, editorOffset, type SearchScope, type SearchMatch } from './manuscriptSearch';
import {StateEffect} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import { createProposalPanel } from './proposalPanel';
import { createWritingPanel, type WritingSummary } from './writingPanel';
import { createEditor, rawOffset } from './editor';
import { captureSelectionQuestion, createSelectionQuestionPanel, selectionQuestionAvailability, selectionQuestionProblem, type SelectionQuestionState } from './selectionQuestion';
import { createQuestionPanel, questionBytes, QUESTION_LIMITS } from './questionPanel';
import { createSelectionAskAction } from './selectionAsk';
import { createDraftingPanel, REPOSITORY_DRAG_TYPE } from './draftingPanel';
import type { DraftingFileChange, DraftingState } from './localCore';
import type { LocalCore, RepositorySession, Manuscript, Document, RecoveryDraft, Chapter } from './localCore';
import { BUNDLED_FONTS, FONT_PRESETS, FONT_ROLES, applyChoices, cleanFamily, familyValue, loadChoices, saveChoices, type FontChoices } from './fonts';
import { createThemePanel } from './themePanel';
import { ACCENTS, LEADINGS, THEMES, WIDTHS, accentColor, applyAppearance, loadAppearance, saveAppearance, type Appearance } from './appearance';
import { attachMenu, type MenuItem } from './menu';
import { createBinderTree } from './binderTree';
import { createPalette, type PaletteItem, type PaletteScope } from './palette';
import { formatKeys, shortcutSheet } from './shortcuts';
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
const SAMPLE_TEXT = 'The mist hung heavy, clinging to his skin and muffling the distant hum of late-night traffic. He had been walking along the Seine, the fog hiding the river’s dark waters, his fingers threaded through his short, curly hair.';
const typingTarget = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export const AUTOSAVE_DELAY_MS = 600;
export const AUTOSAVE_MAX_WAIT_MS = 5000;
export const SAVE_NOTICE_IDLE_MS = 5000;

export function mountStudio(root: HTMLElement, core: LocalCore) {
  // The status pill mirrors the writing panel; it is built further down, so render only once it exists.
  let chromeReady = false; let draftingStarted = false; let writingSummary: WritingSummary | null = null;
  const writing = createWritingPanel(summary => { writingSummary = summary; if (chromeReady) renderPill(); });
  let generation = 0;
  let searchScopeRevision = 0;
  let opened: Document | null = null;
  let standalone: ReturnType<typeof createStandaloneDrafts>|null=null;
  let newDraftButton: HTMLButtonElement|null=null;
  let newScenePending = false;
  let editor: ReturnType<typeof createEditor> | null = null;
  let chapterEditor: ReturnType<typeof createEditor> | null = null;
  let questions: ReturnType<typeof createSelectionQuestionPanel> | null = null;
  let draftingQuestions: ReturnType<typeof createQuestionPanel> | null = null;
  let reviewPanel: ReturnType<typeof createReviewPanel> | null = null;
  let reviewApplying = false;
  let documentReader: ReturnType<typeof createMarkdownReader> | null = null;
  let documentView: {host: HTMLElement; toolbar: HTMLElement; source: HTMLButtonElement; reading: HTMLButtonElement; editor: EditorView; modeChanged?: (mode: 'source' | 'reading') => void} | null = null;
  let readerSourceScroll = 0;
  let editorCommands:ReturnType<typeof actionMenu>|null=null;
  const readingDocuments = new Set<string>();
  let currentChapter: AssembledChapter | null = null;
  let questionButton: HTMLButtonElement | null = null;
  let selectionAsk: ReturnType<typeof createSelectionAskAction> | null = null;
  let selectionCaptureVersion = 0; let selectionCapturePending = false;
  let dirty = false;
  let saving = false;
  let edits = 0;
  let documentEpoch = 0;
  let disposed = false;
  let repositoryDetached = false;
  let projectResumeQueue:Promise<void>=Promise.resolve();
  let projectPositionTimer:ReturnType<typeof setTimeout>|null=null;
  let placedText: {repositoryId:string;path:string}|null=null;
  let structuralBusy = false;
  let structuralFocusPath:string|null=null;
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
  let quitRefusedUnlisten:(()=>void)|null=null;
  let quitInProgress=false;
  let closeUnlisten: (() => void) | null = null;
  let dirtySync = Promise.resolve();
  let sharingEvidence:GitHubLocalEvidence|null=null;
  let sharingGeneration=0;
  let saveNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEditAt = -Infinity;
  let composing = false;
  let pendingSaveNotice: (() => void) | null = null;
  let visibleSaveNotice: string | null = null;
  function cancelSaveNotice() {
    if (saveNoticeTimer !== null) clearTimeout(saveNoticeTimer);
    saveNoticeTimer = null; pendingSaveNotice = null;
  }
  function noteEditing() {
    lastEditAt = Date.now(); cancelSaveNotice();
    // A resumed writing session also dismisses its own previous success notice.
    // Never dismiss errors or unrelated status messages.
    if (visibleSaveNotice && status.textContent === visibleSaveNotice) status.textContent = '';
    visibleSaveNotice = null;
  }
  function scheduleSaveNotice() {
    if (!pendingSaveNotice) return;
    if (saveNoticeTimer !== null) clearTimeout(saveNoticeTimer);
    saveNoticeTimer = setTimeout(() => {
      saveNoticeTimer = null;
      if (composing || editor?.view.compositionStarted) {
        composing = true;
        // CodeMirror can end a Safari dead-key composition without a DOM
        // compositionend event. Recheck its state instead of suppressing notices
        // forever; allow a full idle interval after observing the fallback end.
        if (!editor?.view.compositionStarted) { composing = false; lastEditAt = Date.now(); }
        scheduleSaveNotice(); return;
      }
      const show = pendingSaveNotice; pendingSaveNotice = null; show?.();
    }, composing ? 100 : Math.max(0, SAVE_NOTICE_IDLE_MS - (Date.now() - lastEditAt)));
  }
  function queueSaveNotice(path: string, epoch: number) {
    cancelSaveNotice();
    // Keep the inline save badge current; only the floating success notice waits.
    const previousStatus = status.textContent;
    pendingSaveNotice = () => {
      if (!active(epoch) || selecting || repositoryDetached || dirty || composing || status.classList.contains('error') || status.textContent !== previousStatus) return;
      visibleSaveNotice = `Saved ${path} locally`;
      status.textContent = visibleSaveNotice;
    };
    scheduleSaveNotice();
  }

  function updateSaveState() {
    const label = recoveryPending ? 'Recovery available' : saving ? 'Saving on this Mac…' : dirty ? (writePaused ? 'Unsaved · autosave paused' : 'Unsaved changes') : 'Saved on this Mac';
    if (dirtyBadge) dirtyBadge.textContent = label;
    if (chromeReady) {
      const fullState=standalone?.active ? (dirty?'Keeping on this Mac…':'Kept on this Mac') : dirtyBadge ? label : opened?.generatedCompatibility ? 'Assembled chapter' : opened ? 'Read-only' : 'Nothing open';
      pillSaveLabel.textContent=standalone?.active?(dirty?'Keeping':'Kept'):dirtyBadge?(recoveryPending?'Recovery':writePaused?'Paused':saving?'Saving':dirty?'Unsaved':'Saved'):opened?.generatedCompatibility?'Assembled':opened?'Read-only':'Nothing open';pillSave.setAttribute('aria-label',fullState);
      pillSave.dataset.state = !dirtyBadge ? 'idle' : recoveryPending || writePaused ? 'error' : saving ? 'saving' : dirty ? 'dirty' : 'saved';
    }
    if (saveButton) saveButton.disabled = saving || recoveryPending || !dirty;
    if (chromeReady) renderOrigin();
    draftingQuestions?.stateChanged();
    reviewPanel?.stateChanged();
    if (documentView) {documentView.reading.disabled = recoveryPending; documentView.reading.title = recoveryPending ? 'Resolve recovery in Source before using Reading.' : '';}
    if (recoveryPending && readingActive()) setDocumentView('source');
    const marked = (chapterEditor ?? editor)?.view;
    if (reviewPanel && marked && reviewMarksIn(marked.state).length && !reviewMarkTargets()) {setReviewMarks(marked, []); reviewPanel.marksInvalidated();}
  }
  function setDirty(value: boolean) {
    dirty = value;
    if(value){sharingEvidence=null;sharingGeneration++;}
    if (value && !standalone?.active) { firstStory?.sourceChanged(); github?.sourceChanged(); }
    updateSaveState();
    if(chromeReady)renderPill();
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
    if(standalone?.active)return standalone.flush();
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
      cancelSaveNotice();
      status.classList.remove('error');
      if (manual) status.textContent = `Saving ${snapshot.path}…`;
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
      opened = saved; writeBaseHash = saved.contentHash; reference.markChanged(saved.path);
      writing.saved(repository?.projectKey ?? '', snapshot.path, saved.text);
      editor!.markSaved(saved.text);
      setDirty(editor!.text() !== saved.text);
      const cleaned = await clearRecovery(draft, snapshot.repositoryId, epoch);
      if (!active(epoch)) return false;
      if (dirty && recoveryErrorMessage) { status.textContent = recoveryErrorMessage; status.classList.add('error'); }
      else if (cleaned) {
        if (dirty) status.textContent = 'Saved the submitted revision. Newer edits are still unsaved.';
        else {
          if (status.textContent === `Saving ${snapshot.path}…`) status.textContent = '';
          queueSaveNotice(saved.path, epoch);
        }
      }
      return !dirty;
    })();
    writeInFlight = task;
    try { return await task; }
    finally {
      if (writeInFlight === task) writeInFlight = null;
      if (active(epoch)) {
        saving = false; updateSaveState();
        if(!dirty&&!failed)void refreshSharing();
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
    if(standalone?.active) return standalone.flush();
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
  let fileFirstRepository = false;
  let directoryRequest = 0;
  let documentRequest = 0;
  let manuscriptRequest = 0;
  root.classList.add('studio');
  const glow = el('div', '', 'stage-glow'); glow.setAttribute('aria-hidden', 'true');
  const open = button('Open local folder…', () => { void selectRepository(() => core.pickRepository()); }, 'primary');
  open.setAttribute('aria-keyshortcuts', 'Control+O Meta+O');
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
  const appearance = button('Appearance', () => { void openAppearance(); }, 'appearance');
  appearance.append(el('kbd', formatKeys('⌘,')));
  appearance.title = 'Theme, fonts, text size and spacing (Cmd/Ctrl+,)';
  appearance.setAttribute('aria-haspopup', 'dialog');
  const proposalsEntry = button('Proposed revisions', () => { void proposals.open(); });
  proposalsEntry.hidden = true;

  // Floating status pill: where you are, what you've written, and the way into everything else.
  let appCommands:ReturnType<typeof actionMenu>|undefined;
  let headerMedia:MediaQueryList|undefined;
  const pill = el('header', '', 'status-pill chrome');
  pill.setAttribute('aria-label', 'Writing status');
  const pillProject = core.projectRequest?button('Projects…',()=>void projectLibrary.open(),'pill-project project-switcher'):el('span','Heinlein Studio','pill-muted pill-project');
  if(core.projectRequest)pillProject.setAttribute('aria-haspopup','dialog');
  const pillChapter = button('', () => {}, 'pill-chapter pill-menu'); pillChapter.hidden = true;
  const pillChapterSep = el('span', '/', 'pill-muted'); pillChapterSep.hidden = true;
  const pillScene = button('No scene open', () => {}, 'pill-scene pill-menu'); pillScene.disabled = true;
  pillChapter.setAttribute('aria-label', 'Chapters');
  const pillWords = el('span', '', 'pill-mono pill-words');
  const pillSave = el('span', '', 'pill-save'); const pillSaveLabel = el('span', 'Nothing open');
  const pillDot = el('span', '', 'pill-dot'); pillDot.setAttribute('aria-hidden', 'true');
  pillSave.append(pillDot, pillSaveLabel);
  const goalFill = el('span', '', 'pill-bar-fill'); const goalBar = el('span', '', 'pill-bar'); goalBar.setAttribute('aria-hidden', 'true'); goalBar.append(goalFill);
  const goalText = el('span', '', 'pill-mono');
  const goalButton = el('button', '', 'pill-goal'); goalButton.type = 'button'; goalButton.append(goalBar, goalText);
  goalButton.setAttribute('aria-haspopup', 'dialog'); goalButton.setAttribute('aria-expanded', 'false');
  goalButton.addEventListener('click', () => toggleGoal());
  const paletteButton = button(formatKeys('⌘K'), () => openPalette('scenes'), 'pill-key');
  paletteButton.setAttribute('aria-label', 'Open command palette'); paletteButton.title = 'Jump to a scene, file or command (Cmd/Ctrl+K)';
  // Breadcrumb menus read live manuscript state when opened, so they never go stale.
  const currentScenePath = () => opened?.path ?? null;
  // The manifest's scene array is the reading order; chapters are labels on it.
  const sceneOrder = () => drafting.state?.scenes ?? [];
  function stepScene(direction: 1 | -1) {
    const order = sceneOrder(); const index = order.findIndex(scene => scene.path === currentScenePath());
    const target = order[index + direction];
    if (index < 0 || !target) { status.textContent = direction > 0 ? 'This is the last scene.' : 'This is the first scene.'; return; }
    void showDocument(target.path);
  }
  const pillMenus = [attachMenu(pillChapter, 'Chapters', (): MenuItem[] => {
    const state = drafting.state; if (!state) return [];
    const here = state.scenes.find(scene => scene.path === currentScenePath())?.groupId ?? null;
    const chapters = [...state.groups.map(group => ({id: group.id as string | null, title: group.title})), ...(state.scenes.some(scene => !scene.groupId) ? [{id: null, title: 'No chapter'}] : [])];
    return [{label: `Chapters in ${state.project || 'this project'}`, heading: true}, ...chapters.map(chapter => {
      const scenes = state.scenes.filter(scene => (scene.groupId ?? null) === chapter.id);
      return {label: chapter.title, detail: `${scenes.length} ${scenes.length === 1 ? 'scene' : 'scenes'}`, current: chapter.id === here, disabled: !scenes.length,
        run: () => { void showDocument(scenes[0].path); }};
    })];
  }),
  attachMenu(pillScene, 'Scenes', (): MenuItem[] => {
    const state = drafting.state; if (!state) return [];
    const path = currentScenePath(); const scene = state.scenes.find(item => item.path === path);
    const group = scene?.groupId ?? null; const siblings = state.scenes.filter(item => (item.groupId ?? null) === group);
    const chapter = state.groups.find(item => item.id === group)?.title ?? 'No chapter';
    const order = sceneOrder(); const index = order.findIndex(item => item.path === path);
    const items: MenuItem[] = [{label: `Scenes in ${chapter}`, heading: true},
      ...siblings.map(item => ({label: item.title || basename(item.path), current: item.path === path, run: () => { void showDocument(item.path); }})),
      {label: 'Move', heading: true},
      {label: 'Previous scene', disabled: index <= 0, run: () => stepScene(-1)},
      {label: 'Next scene', disabled: index < 0 || index >= order.length - 1, run: () => stepScene(1)}];
    const view = editor?.view ?? chapterEditor?.view ?? null;
    const breaks = view ? sceneBreaks(view.state.doc.toString()) : [];
    if (breaks.length) {
      items.push({label: 'Breaks in this scene', heading: true});
      breaks.slice(0, 12).forEach((entry, number) => items.push({label: entry.label, detail: `Passage ${number + 1}`, run: () => {
        showSourceView();
        view!.dispatch({selection: {anchor: entry.from, head: entry.to}, scrollIntoView: true}); view!.focus();
      }}));
    }
    return items;
  })];
  pill.append(pillProject, el('span', '/', 'pill-muted'), pillChapter, pillChapterSep, pillScene, el('span', '', 'pill-rule'), pillWords, pillSave, goalButton, proposalsEntry, paletteButton);
  const status = el('p', 'Open from GitHub, open a local folder, or start a draft.', 'status');
  const noticeSlot=el('div','','notice-slot');pillSave.setAttribute('role','status');noticeSlot.append(pillSave,status);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  // Messages like "Opening your writing…" mean work is under way; show a spinner until the text changes.
  const busyObserver = new MutationObserver(() => status.setAttribute('aria-busy', String(/^(Opening|Reading|Saving|Loading|Checking)\b.*…$/.test(status.textContent ?? ''))));
  busyObserver.observe(status, {childList: true, characterData: true, subtree: true});
  const recent = el('section', '', 'recent');
  recent.setAttribute('aria-label', 'Recent local folders');

  // Daily goal: the full writing panel, opened from the pill's progress bar.
  const goalCard = el('section', '', 'floating-card goal-card');
  goalCard.setAttribute('role', 'dialog'); goalCard.setAttribute('aria-label', 'Daily goal'); goalCard.hidden = true;
  const goalHead = el('div', '', 'card-head');
  const goalClose = button('esc', () => toggleGoal(false), 'card-close'); goalClose.setAttribute('aria-label', 'Close daily goal');
  goalHead.append(el('h2', 'Daily goal'), goalClose);
  goalCard.append(goalHead, writing.element);
  goalCard.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); toggleGoal(false); } });
  function toggleGoal(show = goalCard.hidden) {
    goalCard.hidden = !show; goalButton.setAttribute('aria-expanded', String(show));
    if (show) writing.focusGoal(); else if (goalCard.contains(document.activeElement) || document.activeElement === document.body) focusEditor();
  }

  const corner = el('div', '', 'corner-actions chrome');
  const helpButton = button('shortcuts', () => toggleHelp(), 'ghost');
  helpButton.prepend(el('kbd', formatKeys('⌘/')), ' '); helpButton.setAttribute('aria-haspopup', 'dialog');
  corner.append(appearance, helpButton);

  const layout = el('main', '', 'workspace');
  const files = el('section', '', 'panel files');
  files.setAttribute('aria-label', 'Repository files');
  const repoName = el('h2', 'Open a repository');
  const directoryPath = el('p', '', 'path');
  const originStatus=el('p','','repository-origin-status');originStatus.setAttribute('role','status');
  const originSend=button('Send to GitHub…',()=>{void github.openSend();},'repository-send');originSend.hidden=true;originSend.setAttribute('aria-haspopup','dialog');
  const projectLibrary=createProjectLibrary(core,{
    current:()=>standalone?.active?null:repository,
    switchProject,
    openLocal:async()=>{const before=repository?.id;await dirtySync;if(writeInFlight)await writeInFlight;await stageQueue;if(dirty&&!await saveCurrent())return false;await selectRepository(()=>core.pickRepository());return !!repository&&repository.id!==before&&!repositoryDetached;},
    openGitHub:()=>{void github.open(true);},
    newDraft:async()=>{await standalone?.newDraft();},drafts:async()=>{await standalone?.list();},
    metadata:p=>{if(repository?.projectId===p.id&&p.revision>=(repository.projectRevision??0)){repository.name=p.name;repository.projectRevision=p.revision;renderOrigin();if(chromeReady)renderPill();}},
    focusWriting:()=>{showSourceView();editor?.view.focus();},
  });
  const projectSettings=button('Project settings',()=>{if(repository?.projectId)void projectLibrary.settings(repository.projectId);});projectSettings.hidden=true;
  const repositoryHome=createRepositoryHome(core,{openGitHub:()=>{void github.open(true);},select:run=>selectRepository(run)});
  const localFolders=el('details');localFolders.className='local-folders';localFolders.open=true;localFolders.append(el('summary','Local folders'),open,recent);
  const listing = el('div', '', 'file-list');
  const sourceFileGuide = el('p', 'Browse writing files to edit or review. No manuscript setup is required.', 'source-file-guide');
  sourceFileGuide.hidden = true;
  const projectInfo = el('details', '', 'source-project-info');
  projectInfo.hidden = true;
  projectInfo.append(el('summary', 'Project & GitHub'), projectSettings, originStatus, originSend, sourceFileGuide);
  const filesBody = el('div', '', 'panel-body');
  filesBody.append(projectInfo,repositoryHome.element,localFolders,directoryPath,listing);
  if(projectLibrary.supported){repositoryHome.element.hidden=true;localFolders.hidden=true;root.classList.add('project-first');}
  files.append(repoName, filesBody);
  const manuscriptPane = el('section', '', 'panel manuscript');
  manuscriptPane.setAttribute('aria-label', 'Manuscript order');
  const manifests = el('div', '', 'manifest-picker');
  const firstStoryEntry = button('First story', () => {void firstStory.open();}, 'first-story-entry');
  firstStoryEntry.setAttribute('aria-haspopup', 'dialog');
  const firstStory = createFirstStory(core, {session: () => repository,
    problem: () => dirty || saving || recoveryPending || recoveryErrorMessage || structuralBusy || selecting || repositoryDetached ? 'Save your story and resolve recovery drafts before proofing or preparing a publishing copy.' : null,
    settle: async () => {await dirtySync;},
    openFolder: async () => {await selectRepository(() => core.pickRepository());},
    draft: async () => {navigation.select('manuscript'); await openDrafting();},
    review: () => {if(refuseReferenceAction())return;if (reviewPanel) {draftingQuestions?.close(); reviewPanel.open();} else {status.textContent = 'Open a scene, then choose Heinlein Review when you want advisory suggestions.';}},
  });
  async function quitSafely() {
    if (quitInProgress) return;
    quitInProgress = true;
    let requested = false;
    try {
      if (disposed || selecting || structuralBusy || saving || staging) return;
      const revision = edits,epoch=documentEpoch,session=repository?.id;
      if (!await allowLeave() || disposed || revision !== edits || saving || structuralBusy || selecting || staging) return;
      if(!await rememberProjectPositionAfterLeave())return;
      root.inert = true;
      await dirtySync;
      if (!disposed && revision === edits && epoch === documentEpoch && session === repository?.id && !projectWritingBlocksLeave() && !saving && !structuralBusy && !selecting && !staging) {
        await core.requestClose(true);
        requested = true;
      }
    } finally {
      if (!requested) {
        quitInProgress = false;
        root.inert = false;
        await core.finishQuitRequest?.();
      }
    }
  }
  const updates=createUpdatePanel(core,{quit:quitSafely});
  const updateEntry=button('Updates…',()=>{void updates.open();},'update-entry');updateEntry.setAttribute('aria-haspopup','dialog');
  const openGitHubEntry = button('Open GitHub project…', () => {void github.open(true);}, 'github-open-entry');
  openGitHubEntry.setAttribute('aria-haspopup', 'dialog');
  const githubEntry = button('GitHub actions…', () => {void github.open();}, 'github-entry');
  githubEntry.setAttribute('aria-haspopup', 'dialog');
  const github = createGitHubPanel(core, {
    session: () => standalone?.active ? null : repository,
    saveForSend: async () => {await dirtySync; if(writeInFlight)await writeInFlight; await stageQueue; return dirty ? saveCurrent() : !recoveryPending && !recoveryErrorMessage && !writePaused;},
    problem: () => dirty || saving || recoveryPending || recoveryErrorMessage || structuralBusy || selecting || repositoryDetached ? 'Save your writing and resolve recovery before preparing a GitHub action.' : null,
    settle: async () => {await dirtySync; if (writeInFlight) await writeInFlight; await stageQueue;},
    select: selectRepository,
    authorAction: async action => {let executed = false; await runStructural(async () => {await action(); executed = true;}); if (!executed) throw new Error('GitHub action stopped. Check the local save or recovery status before trying again.');},
    changed:()=>{void refreshSharing();void repositoryHome.refresh();},
    incomingChanged: async () => {
      verifyStructuralBuffer(); firstStory.sourceChanged(); reviewPanel?.clear(); proposals.clear(); manuscriptSearch.invalidate();
      const previous = drafting.state; const next = await drafting.load();
      if (next) await draftingChanged(next, previous, []);
      else {resetPreview(); await showDirectory('');}
    },
  });
  corner.prepend(openGitHubEntry, firstStoryEntry, githubEntry, updateEntry);
  const draftingEntry = button('ms drafting', () => { void openDrafting(); }, 'drafting-entry');
  draftingEntry.hidden = true;
  const outline = el('div');
  outline.append(el('p', 'Open a folder with a scene-manifest.json to browse manuscript order.', 'empty'));
  const manuscriptBody = el('div', '', 'panel-body');
  const searchManuscript = button('Find in manuscript', openManuscriptSearch);
  searchManuscript.setAttribute('aria-keyshortcuts', 'Control+Shift+F Meta+Shift+F');
  const binderTree = createBinderTree({state: () => (standalone?.active ? null : drafting.state), currentPath: () => opened?.path ?? null, open: path => { void showDocument(path); }});
  manuscriptBody.append(draftingEntry, searchManuscript, binderTree.element, manifests, outline);
  manuscriptPane.append(manuscriptBody);
  const sceneNavigator = createSceneNavigator(() => editor?.view ?? chapterEditor?.view ?? null, () => showSourceView());
  const scenePane = el('section', '', 'panel scene-navigator');
  scenePane.setAttribute('aria-label', 'Scene navigator');
  scenePane.append(sceneNavigator.element);
  const preview = el('section', '', 'panel preview');
  preview.setAttribute('aria-label', 'Document preview');
  preview.tabIndex = 0;
  const activeDocumentPane=el('section','','active-document-pane');activeDocumentPane.id='active-document-pane';activeDocumentPane.setAttribute('role','tabpanel');
  const readingPanes=el('div','','document-reading-panes');
  const documentWorkspace=el('div','','document-workspace');
  const documentCommandBar=el('div','','document-command-bar');
  const splitReadingOffer=el('div','','split-reading-offer');splitReadingOffer.hidden=true;
  const reference=createReferencePane(core,{binding:()=>!disposed&&!selecting&&!repositoryDetached&&repository?{session:repository.id,generation}:null,
    edit:path=>{void showDocument(path);},focusWriter:()=>{focusWriterView();if(!editor&&!chapterEditor)activeDocumentPane.focus();}});
  const documentTabs=createDocumentTabs({open:openDocumentTab,close:closeDocumentTab,read:tab=>{if(!repositoryDetached&&!selecting)void reference.read({path:tab.path,sceneId:tab.sceneId});}});
  for(const host of [activeDocumentPane,documentCommandBar])for(const event of ['focusin','pointerdown'])host.addEventListener(event,e=>{if((e.target as Element)?.closest('.markdown-editor,.source-text,.markdown-reader,.md-view-toggle'))reference.activateWriter();});activeDocumentPane.tabIndex=-1;
  activeDocumentPane.addEventListener('scroll',scheduleProjectPosition);
  readingPanes.append(activeDocumentPane,reference.element);documentWorkspace.append(documentTabs.element,documentCommandBar,splitReadingOffer,readingPanes);
  function mountActive(page:HTMLElement){if(window.matchMedia?.('(max-width:760px)').matches)navigation.close();activeDocumentPane.replaceChildren(page);if(!preview.contains(documentWorkspace))preview.replaceChildren(documentWorkspace);refreshHeaderLayout();}
  function refuseReferenceAction(){if(!reference.fromReference())return false;status.textContent=REFERENCE_ACTION_MESSAGE;status.classList.add('error');return true;}
  function writerAction(run:()=>void){if(!refuseReferenceAction())run();}
  // Reading has no editing selection: nothing may act on the hidden editor's caret or selection from there.
  function refuseReadingAction(){if(!readingActive())return false;status.textContent='Switch to Source to use this. Reading view has no editing selection.';status.classList.add('error');return true;}
  function sourceAction(run:()=>void){if(!refuseReferenceAction()&&!refuseReadingAction())run();}
  const readingActive=()=>Boolean(documentReader&&!documentReader.element.hidden);
  const readingKey=()=>repository&&opened?`${repository.id}\0${opened.path}`:null;
  function focusWriterView(){if(readingActive())documentReader!.focus();else (editor??chapterEditor)?.view.focus();}
  // Source position stays writer authority. Reader scroll is never stored as a CodeMirror position.
  function writerScrollTop(){return readingActive()?readerSourceScroll:primaryScroller()?.scrollTop??0;}
  function showSourceView(){if(readingActive())setDocumentView('source');}
  function setDocumentView(mode:'source'|'reading'){
    const reader=documentReader,view=documentView;
    if(!reader||!view)return;
    if(mode==='reading'&&recoveryPending){status.textContent='Resolve recovery in Source before using Reading.';status.classList.add('error');return;}
    const key=readingKey();
    if(key){if(mode==='reading')readingDocuments.add(key);else readingDocuments.delete(key);}
    if(mode==='reading'&&!readingActive()){
      readerSourceScroll=primaryScroller()?.scrollTop??0;
      view.host.hidden=true;reader.element.hidden=false;reader.update();
      // The toggle keeps focus, so it has to stay in view with the start of the formatted text.
      // Only the real scroller moves: scrollIntoView would also shift the overflow-hidden Studio root.
      const scroller=primaryScroller();
      if(scroller&&scroller.contains(view.toolbar)){const top=Math.max(scroller.getBoundingClientRect().top,documentTabs.element.getBoundingClientRect().bottom);scroller.scrollTop+=view.source.getBoundingClientRect().top-top-8;}
    }else if(mode==='source'&&readingActive()){
      reader.element.hidden=true;view.host.hidden=false;
      const scroller=primaryScroller();if(scroller)scroller.scrollTop=readerSourceScroll;
      view.editor.requestMeasure();
    }
    view.toolbar.classList.toggle('document-reading',mode==='reading');
    view.modeChanged?.(mode);
    view.source.setAttribute('aria-pressed',String(mode==='source'));view.reading.setAttribute('aria-pressed',String(mode==='reading'));
    sceneNavigator.refresh();
  }
  function mountDocumentView(toolbar:HTMLElement,host:HTMLElement,target:EditorView,content:()=>Omit<ReaderContent,'marks'>,modeChanged?:(mode:'source'|'reading')=>void){
    const reader=createMarkdownReader({label:'Reading view',content:()=>({...content(),marks:reviewMarksIn(target.state)}),open:id=>{reviewPanel?.openSuggestion(id);},showSource:()=>{setDocumentView('source');focusWriterView();}});
    host.after(reader.element);
    const group=el('div','','md-view-toggle');group.setAttribute('role','group');group.setAttribute('aria-label','Document view');
    const source=button('Source',()=>{setDocumentView('source');focusWriterView();}),reading=button('Reading',()=>setDocumentView('reading'));
    source.setAttribute('aria-pressed','true');reading.setAttribute('aria-pressed','false');
    group.append(source,reading);toolbar.prepend(group);
    const secondary=[...toolbar.children].filter(node=>node!==group) as HTMLElement[];const metadata=host.closest('.page')?.querySelector<HTMLElement>('.metadata');if(metadata)secondary.push(metadata);const badge=host.closest('.page')?.querySelector<HTMLElement>('.page-meta .badge');if(badge)secondary.push(badge);
    editorCommands?.destroy();const commands=actionMenu('Editor actions',secondary,root);editorCommands=commands;const role=host.closest('.page')?.querySelector<HTMLElement>('.document-role');if(role){commands.button.replaceChildren(role,document.createTextNode(' actions'));commands.button.setAttribute('aria-description','Editor actions for this document');}toolbar.append(commands.button,commands.storage);documentCommandBar.replaceChildren(toolbar);
    documentReader=reader;documentView={host,toolbar,source,reading,editor:target,modeChanged};
    target.dispatch({effects:StateEffect.appendConfig.of(EditorView.updateListener.of(update=>{if(documentReader===reader&&readingActive()&&(update.docChanged||reviewMarksIn(update.state)!==reviewMarksIn(update.startState)))reader.update();}))});
    const key=readingKey();if(key&&readingDocuments.has(key)&&!recoveryPending)setDocumentView('reading');
  }
  function primaryScroller():HTMLElement|null {
    if(!editor)return null;
    if(activeDocumentPane.contains(editor.view.dom)&&activeDocumentPane.clientHeight>0)return activeDocumentPane;
    for(let node:HTMLElement|null=editor.view.scrollDOM;node&&preview.contains(node);node=node.parentElement){
      if(node.clientHeight>0&&node.scrollHeight>node.clientHeight+1&&/(auto|scroll)/.test(getComputedStyle(node).overflowY))return node;
    }
    return editor.view.scrollDOM;
  }
  function rememberTabPosition(){
    const tab=documentTabs.active();if(!tab||!opened||!editor||dirty||recoveryPending)return;
    const range=editor.view.state.selection.main;tab.position={hash:opened.contentHash,anchor:range.anchor,head:range.head,scrollTop:writerScrollTop()};
  }
  function restorePosition(position:{anchor:number;head:number;scrollTop:number}){
    if(!editor)return;editor.view.dispatch({selection:{anchor:position.anchor,head:position.head}});if(readingActive()){readerSourceScroll=position.scrollTop;return;}const scroller=primaryScroller();if(scroller)scroller.scrollTop=position.scrollTop;
  }
  function openDocumentTab(tab:DocumentTab){return !tab.unavailable&&!repositoryDetached&&!structuralBusy?showDocument(tab.path,false,()=>true,tab.chapter):Promise.resolve(false);}
  async function closeDocumentTab(tab:DocumentTab){
    if(disposed||selecting||structuralBusy||repositoryDetached)return;
    if(documentTabs.active()!==tab){documentTabs.remove(tab);documentTabs.focus();return;}
    const entries=documentTabs.items();const index=entries.indexOf(tab);const next=entries.slice(index+1).find(item=>!item.unavailable)??entries.slice(0,index).reverse().find(item=>!item.unavailable);
    if(next){await openDocumentTab(next);if(documentTabs.active()===next){documentTabs.remove(tab);documentTabs.focus();}return;}
    const epoch=documentEpoch,revision=edits,current=generation;
    if(!await allowLeave()||disposed||epoch!==documentEpoch||revision!==edits||current!==generation)return;
    documentRequest++;documentTabs.remove(tab);resetPreview();const heading=preview.querySelector('h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}else preview.focus({preventScroll:true});
  }

  standalone=createStandaloneDrafts(core,{root,parent:preview,dirty:setDirty,sync:()=>dirtySync,leave:allowLeave,modeChanged:active=>{sharingEvidence=null;sharingGeneration++;root.classList.toggle('standalone-writing',active);if(chromeReady){renderPill();renderOrigin();if(active&&navigation.visible('manuscript'))void openDrafting();}},beforeMount:()=>{
    documentTabs.clear();reference.clear();
    questions?.clear(); draftingQuestions?.clear(); reviewPanel?.clear(); selectionAsk?.destroy(); selectionAsk=null;
    editorCommands?.destroy();editorCommands=null;documentCommandBar.replaceChildren();documentReader=null;documentView=null;chapterEditor?.destroy();chapterEditor=null;editor?.destroy();editor=null;opened=null;currentChapter=null;
    cancelAutosave();cancelSaveNotice();documentEpoch++;recovery=null;recoveryPending=false;writePaused=null;saveButton=null;dirtyBadge=null;writing.clearScene();
  },openCopy:async(session,path)=>{placedText={repositoryId:session.id,path};await selectRepository(()=>Promise.resolve(session));if(repository?.id===session.id)await showDocument(path);}});
  if(standalone.supported){
    status.textContent='Start writing. Drafts are kept on this Mac; choosing a folder is optional.';
    newDraftButton=button('New draft',()=>{
      if (!newDraftButton || newDraftButton.disabled) return;
      newDraftButton.disabled=true;
      void standalone!.newDraft().catch(reportError).finally(()=>{ if (newDraftButton) newDraftButton.disabled=false; });
    });
    newDraftButton.setAttribute('aria-keyshortcuts','Meta+N Control+N');
    corner.prepend(button('Drafts',()=>void standalone!.list()),newDraftButton);
  }

  const navigation = createNavigationDrawer(files, manuscriptPane, scenePane, open => layout.classList.toggle('navigation-open', open),'Source files',tab=>{if(tab==='manuscript')void openDrafting();},projectLibrary.supported?'manuscript':'files');
  layout.append(navigation.element, preview);
  chromeReady = true;
  resetPreview();
  appCommands=actionMenu('More actions',[...corner.children,...pill.children].filter(node=>node!==pillProject&&node!==pillSave) as HTMLElement[],root,()=>repository?.name??'Heinlein Studio',refreshHeaderLayout);
  pill.replaceChildren(pillProject,appCommands.button,appCommands.storage);pill.prepend(navigation.element.querySelector('.navigation-toggle')!);corner.hidden=true;
  headerMedia=window.matchMedia?.('(max-width:480px)');headerMedia?.addEventListener?.('change',refreshHeaderLayout);
  function refreshHeaderLayout(){if(!appCommands)return;if(standalone?.active)pill.insertBefore(pillSave,appCommands.button);else noticeSlot.prepend(pillSave);const compact=!!headerMedia?.matches&&preview.contains(documentWorkspace)&&!standalone?.active;if(!appCommands.isOpen()){if(compact)appCommands.storage.prepend(pillProject);else pill.insertBefore(pillProject,appCommands.button);}if(compact){const context=el('span',repository?.name??'Project','header-project-context');appCommands.button.replaceChildren(context,document.createTextNode(' · More'));appCommands.button.setAttribute('aria-label',`${repository?.name??'Project'} · More actions`);}else{appCommands.button.textContent='More actions';appCommands.button.setAttribute('aria-label','More actions');}}
  root.replaceChildren(glow, ...(projectLibrary.supported ? [pill, layout] : [layout, pill]), noticeSlot, goalCard, corner, firstStory.element, github.element, updates.element, projectLibrary.element);
  const drafting = createDraftingPanel(core, {
    root, repository: () => standalone?.active?null:repository, run: runStructural, verify: verifyStructuralBuffer, selectedPath:()=>opened?.path??null,
    show: () => { renderPill(); outline.replaceChildren(drafting.element); if (drafting.state) void writing.setManuscript(core, repository!, drafting.state); },
    open: path => { void showDocument(path); }, changed: draftingChanged,
    report: (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); },
  });
  draftingStarted = true;
  const proposals = createProposalPanel(core, {
    root, repository: () => repository, run: runProposal,
    changed: proposalChanged,
    report: (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); },
  });
  async function proposalChanged(path:string) {
      // A late editor event must never be discarded by an applied proposal refresh.
      if (dirty || edits !== proposalEditRevision || recoveryPending || recovery) {
        writePaused = 'conflict'; updateSaveState();
        throw new Error('The disk may have changed; newer editor text was preserved. Compare it with the source before saving');
      }
      reference.markChanged(path);resetPreview();
      if (!await showDocument(path, true)) throw new Error('The operation was recorded, but the scene could not be safely reopened. Reload it before editing');
      if (drafting.state) await writing.setManuscript(core, repository!, drafting.state);
  }
  function selectionQuestionState() {
    if(reference.fromReference()||readingActive())return null;
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
      if (reference.fromReference() || disposed || !opened || !repository) return null;
      if (!editor) return {repositoryId: repository.id, path: opened.path, source: '', from: 0, to: 0, canCapture: false};
      if (readingActive()) return {repositoryId: repository.id, path: opened.path, source: editor.text(), from: -1, to: -1, canCapture: false};
      const source = editor.text(); const range = editor.view.state.selection.main;
      const single = editor.view.state.selection.ranges.length === 1;
      return {repositoryId: repository.id, path: opened.path, source,
        from: single ? rawOffset(source, range.from) : -1, to: single ? rawOffset(source, range.to) : -1,
        canCapture: !editor.view.state.readOnly && !opened.generatedCompatibility && !recoveryPending && !repositoryDetached && !selecting && !structuralBusy && !proposalBusy};
    },
    focusEditor: () => focusWriterView(),
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
  reviewPanel = createReviewPanel(core, {
    capture: () => {
      if (reference.fromReference() || !repository || !opened || disposed || repositoryDetached || selecting || structuralBusy || recoveryPending) return null;
      if (currentChapter) return {repositoryId: repository.id, scope: 'chapter', label: currentChapter.chapter.title,
        snapshots: currentChapter.parts.map(({document}) => ({path: document.path, source: document.text, sourceHash: document.contentHash}))};
      if (!editor || opened.generatedCompatibility || editor.view.state.readOnly) return null;
      return {repositoryId: repository.id, scope: 'scene', label: opened.path,
        snapshots: [{path: opened.path, source: editor.text(), sourceHash: opened.contentHash}]};
    },
    unavailable: reviewing => {
      if (!repository || !opened || repositoryDetached || disposed) return 'Open the reviewed repository before accepting an edit.';
      if (!proposals.supported) return 'Native revision approval is unavailable.';
      if (dirty || saving || staging || writeInFlight || recovery || recoveryPending || guardPending || writePaused) return 'Save the matching source file and resolve recovery before accepting an edit. Your working text is preserved.';
      if (selecting || ((structuralBusy || proposalBusy) && !reviewing)) return 'Finish the current local operation first.';
      return null;
    },
    reviewProposal: async (id, guard) => {reviewApplying = true; try {await proposals.reviewProposal(id, guard);} finally {reviewApplying = false;}},
    approveReview: async (run,guard)=>{reviewApplying=true;let outcome:import('./localCore').ProposalOutcome|null=null;try{await runProposal(async()=>{const problem=guard();if(problem)throw new Error(problem);outcome=await run();if(outcome&&outcome.receipt.status!=='failed')await proposalChanged(outcome.receipt.path);});return outcome;}finally{reviewApplying=false;}},
    openConnection: () => {reviewPanel?.clear(); if (draftingQuestions) {root.append(draftingQuestions.element); draftingQuestions.open();}},
    announce: text => {status.classList.remove('error'); status.textContent = text;},
    marksChanged: (input, report) => reviewMarkPublisher.publish(input, report),
    focusEditor: () => focusWriterView(),
  });
  root.append(reviewPanel.element);

  // Marks show only over clean text this exact view can prove it holds. Chapter parts already carry their source mapping.
  function reviewMarkTargets(): ReviewMarkTarget[] | null {
    if (!repository || repositoryDetached || disposed || selecting || structuralBusy || dirty || saving || staging || writeInFlight || recovery || recoveryPending || guardPending || writePaused) return null;
    if (currentChapter && chapterEditor) return currentChapter.parts.map(part => ({path: part.document.path, source: part.document.text, contentHash: part.document.contentHash,
      toView: position => {const view = part.from + position - part.bodyFrom; return position >= part.bodyFrom && view <= part.to ? view : null;}}));
    if (editor && opened && !opened.generatedCompatibility) return [{path: opened.path, source: editor.text(), contentHash: opened.contentHash, toView: position => position}];
    return null;
  }
  const reviewMarkPublisher = createReviewMarkPublisher({view: () => (chapterEditor ?? editor)?.view ?? null, targets: reviewMarkTargets,
    owns: input => input.repositoryId === repository?.id && (!input.projectKey || !repository.projectKey || input.projectKey === repository.projectKey)});
  const reviewMarks = () => reviewMarkExtension({open: id => {reviewPanel?.openSuggestion(id);}, invalidated: () => reviewPanel?.marksInvalidated(), keys: {next: formatKeys('⌘⌥]'), previous: formatKeys('⌘⌥['), open: formatKeys('⌘⌥O')}});
  function revisionUnavailable(reviewing = false) {
    if(reference.fromReference())return REFERENCE_ACTION_MESSAGE;
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
    if(refuseReferenceAction()||refuseReadingAction())return;
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
    if(refuseReferenceAction())return;
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
    if(refuseReferenceAction()||refuseReadingAction())return;
    if (!editor || !opened || !repository || structuralBusy || selecting || repositoryDetached || recoveryPending || guardPending || editor.view.state.readOnly) return;
    const scene = drafting.state?.scenes.find(item => item.path === opened!.path);
    if(!drafting.supported||!drafting.state||drafting.state.recoveryRequired||(scene&&!drafting.state.revision)||!(/\.(md|markdown)$/i.test(opened.path))){
      status.textContent='Open editable Markdown and resolve manuscript loading or recovery before splitting.';return;
    }
    const ranges = editor.view.state.selection.ranges; const range = editor.view.state.selection.main;
    const source = editor.text(); const offset = rawOffset(source, range.from);
    // Raw offsets are UTF-16. Refuse a surrogate midpoint before encoding UTF-8.
    const midpoint = offset > 0 && /[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset] ?? '');
    const bodyStart = splitBodyStart(source);
    const invalidUnicode = new TextDecoder('utf-8', {ignoreBOM: true}).decode(new TextEncoder().encode(source)) !== source;
    if (bodyStart === null || invalidUnicode || (offset>0&&source[offset-1]==='\r'&&source[offset]==='\n') || ranges.length !== 1 || !range.empty || offset <= (bodyStart ?? 0) || offset >= source.length || midpoint) {
      status.textContent = 'Place one cursor inside the scene body, with text on both sides; clear any selection first.'; status.classList.add('error'); return;
    }
    const epoch = documentEpoch; const revision = edits; const repositoryId = repository.id; const path = opened.path;
    const byteOffset = new TextEncoder().encode(source.slice(0, offset)).length;
    const prepare=() => {
      if (!editor || !opened || repository?.id !== repositoryId || documentEpoch !== epoch || edits !== revision || opened.path !== path || editor.text() !== source || (scene?drafting.state?.scenes.find(item=>item.id===scene.id)?.path!==path:drafting.state?.scenes.some(item=>item.path===path)) || editor.view.state.selection.ranges.length !== 1 || !editor.view.state.selection.main.empty || rawOffset(source, editor.view.state.selection.main.from) !== offset) {
        throw new Error('The scene or cursor changed. Place the cursor again and start a new split');
      }
      return {expectedHash: opened.contentHash, byteOffset};
    };
    if(scene)drafting.splitScene(scene.id,prepare);else drafting.splitFile(path,prepare);
  }
  async function runStructural(action: () => Promise<void>) {
    if (disposed || structuralBusy || selecting || !repository) return;
    if (repositoryDetached) { reportDetachedRepository(); return; }
    if (recoveryPending || guardPending) {
      status.textContent = 'Resolve the open recovery draft or save dialog before changing manuscript structure. Your recovery has been kept.'; status.classList.add('error'); return;
    }
    structuralBusy = true; structuralFocusPath=null; structuralEditRevision = edits;
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
        if(structuralFocusPath&&opened?.path===structuralFocusPath)focusWriterView();
        structuralFocusPath=null;
      }
    }
  }
  async function draftingChanged(state: DraftingState, previous: DraftingState | null, changes: DraftingFileChange[], focusPath?: string) {
    verifyStructuralBuffer(); github.sourceChanged(); firstStory.sourceChanged();
    currentBook = null; searchScopeRevision++; manuscriptSearch.invalidate();
    const oldPath=opened?.path,oldText=opened?.text;
    const oldScene=previous?.scenes.find(scene=>scene.path===oldPath);
    const sameScene=oldScene?state.scenes.find(scene=>scene.id===oldScene.id):undefined;
    documentTabs.reconcile(state.scenes);reference.reconcile(state.scenes);
    for(const change of changes){
      if(change.source){reference.markChanged(change.source);documentTabs.invalidate(change.source);}
      if(change.destination){reference.markChanged(change.destination);documentTabs.invalidate(change.destination);}
      if(change.source&&(change.kind==='Undo splitFile'||(change.kind==='rollback'&&!change.destination))){documentTabs.invalidate(change.source,true);reference.markUnavailable(change.source);}
    }
    splitReadingOffer.replaceChildren();splitReadingOffer.hidden=true;
    const split=changes.find(change=>['split','splitFile'].includes(change.kind)&&change.source&&change.destination);
    const original=split&&previous?.scenes.find(scene=>scene.path===split.source);
    const retained=original&&state.scenes.find(scene=>scene.id===original.id&&scene.path===split?.source);
    const suffix=split&&state.scenes.find(scene=>scene.path===split.destination&&scene.id!==original?.id&&!previous?.scenes.some(old=>old.id===scene.id));
    let pair:{source:string;destination:string;sourceId?:string;suffixId?:string}|null=null;
    if(split&&focusPath===split.destination){
      if(split.kind==='split'&&retained&&suffix)pair={source:retained.path,destination:suffix.path,sourceId:retained.id,suffixId:suffix.id};
      else if(split.kind==='splitFile'&&split.source===oldPath&&split.destination&&split.source!==split.destination&&split.source!.slice(0,split.source!.lastIndexOf('/')+1)===split.destination.slice(0,split.destination.lastIndexOf('/')+1)&&[split.source!,split.destination].every(path=>/\.(md|markdown)$/i.test(path)))pair={source:split.source!,destination:split.destination};
    }
    if(pair){documentTabs.register({path:pair.source,sceneId:pair.sourceId,kind:'source'});documentTabs.register({path:pair.destination,sceneId:pair.suffixId,kind:'source'});}
    const moved=changes.find(change=>!['split','splitFile'].includes(change.kind)&&change.source===oldPath&&change.destination)?.destination;
    const nextPath=focusPath??sameScene?.path??moved??(oldScene?null:oldPath);
    // The operation has already committed. Never leave its old whole-file writer
    // alive while reloading either part or reporting a failed refresh.
    if(opened)resetPreview();
    if(split?.kind==='splitFile'&&!pair)throw Error('The split is saved, but its returned paths do not match this document. Reopen the files before editing.');
    await showDirectory(directoryPath.textContent==='/'?'':directoryPath.textContent||'');
    await writing.setManuscript(core,repository!,state);
    if(pair&&split?.kind==='splitFile'){
      const session=repository!.id,current=generation;
      const read=async(path:string)=>{try{const doc=await core.readDocument(session,path);if(disposed||generation!==current||repository?.id!==session)throw Error('The project changed while refreshing the split');if(doc.path!==path||doc.generatedCompatibility)throw Error('The split source is no longer an editable file');return doc;}catch(error){if(!disposed&&generation===current&&repository?.id===session){documentTabs.invalidate(path,true);reference.markUnavailable(path);}throw error;}};
      const [prefix,suffix]=await Promise.all([read(pair.source),read(pair.destination)]);
      if(oldText!==undefined&&prefix.text+suffix.text!==oldText){documentTabs.invalidate(pair.source,true);documentTabs.invalidate(pair.destination,true);throw Error('The saved split changed before it could be refreshed. Reopen both source files to inspect them.');}
    }
    if(nextPath&&!await showDocument(nextPath,true))throw Error(`The change is saved. ${status.textContent??'The scene could not be reopened.'} Resolve recovery or use the file browser to retry.`);
    if(pair){
      const savedPair=pair,session=repository?.id,current=generation;
      const readBoth=button('Read both sections',()=>{void(async()=>{
        if(repository?.id!==session||generation!==current||repositoryDetached)return;
        const first=savedPair.sourceId?drafting.state?.scenes.find(scene=>scene.id===savedPair.sourceId):{path:savedPair.source};
        const second=savedPair.suffixId?drafting.state?.scenes.find(scene=>scene.id===savedPair.suffixId):{path:savedPair.destination};
        if(!first||!second)return;
        if(opened?.path!==second.path)await showDocument(second.path);
        if(opened?.path===second.path&&repository?.id===session&&generation===current)await reference.read({path:first.path,sceneId:savedPair.sourceId});
      })();});
      splitReadingOffer.append(el('p','Split saved as two source files. Read both sections loads the original saved source beside the suffix; choose it to replace any existing reference.'),readBoth);
      if(drafting.canUndo)splitReadingOffer.append(button('Undo last split',()=>drafting.undoLastChange()));
      splitReadingOffer.hidden=false;
    }
    if(focusPath)structuralFocusPath=focusPath;
  }
  async function openDrafting() {
    if (structuralBusy || selecting) return;
    if(!repository||standalone?.active){drafting.clear();const message=el('p',standalone?.active?'This is a standalone draft. Choose a project manuscript, or place a copy later, to add chapters and scenes.':'Open a project and create or open its manuscript to add chapters and scenes.');message.id='manuscript-origin-reason';const actions=el('div','','drafting-actions');for(const label of ['Add scene','Add chapter']){const b=button(label,()=>{});b.disabled=true;b.setAttribute('aria-describedby',message.id);actions.append(b);}outline.replaceChildren(actions,message);return;}
    try {
      const state = await drafting.load();
      if (state) { currentBook = null; searchScopeRevision++; manuscriptSearch.invalidate(); outline.replaceChildren(drafting.element); void writing.setManuscript(core, repository, state); }
      return state;
    } catch (error) { reportError(error); }
  }

  let zoom = loadZoom();
  async function newWriting() {
    if (disposed || newScenePending || root.inert || selecting || structuralBusy || guardPending ||
        dialog.open || helpLayer || palette.isOpen() || document.querySelector('dialog[open]')) return;
    if (!repository || standalone?.active) { newDraftButton?.click(); return; }
    if (repositoryDetached) { reportDetachedRepository(); return; }
    if (recoveryPending) {
      status.textContent = 'Resolve the open recovery draft before adding a scene. Your writing is unchanged.';
      status.classList.add('error'); return;
    }
    if (!drafting.supported) { status.textContent = 'Scene creation is unavailable in this project. Your writing is unchanged.'; return; }
    const repositoryId = repository.id; const epoch = documentEpoch;
    newScenePending = true;
    try {
      // Reload through the existing manuscript gate; never initialize or write here.
      const state = await openDrafting();
      if (!state || disposed || repository?.id !== repositoryId || documentEpoch !== epoch || standalone?.active ||
          selecting || structuralBusy || guardPending || recoveryPending || repositoryDetached || root.inert ||
          dialog.open || helpLayer || palette.isOpen() || document.querySelector('dialog[open]')) return;
      if (state.revision && !state.recoveryRequired) drafting.newScene();
      else navigation.select('manuscript'); // Existing explicit setup/rollback affordance.
    } catch (error) { reportError(error); }
    finally { newScenePending = false; }
  }
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
  root.append(zoomAnnounce);

  // Appearance: a settings window with a live preview. Theme, accent, fonts, size, measure and
  // writing modes all apply instantly and are saved on this device.
  let look: Appearance = loadAppearance();
  applyAppearance(look);
  let fontChoices: FontChoices = loadChoices();
  applyChoices(fontChoices);
  let installedFonts: string[] | null = null;
  const lookControls: (() => void)[] = [];
  function setLook(patch: Partial<Appearance>) { if ((patch.theme || patch.accent) && !themeBuilder.usePreset()) {showCategory('vibecode'); themeBuilder.focusStatus(); return;} look = {...look, ...patch}; saveAppearance(look); applyAppearance(look); themeBuilder.refresh(); lookControls.forEach(sync => sync()); }
  function pressed(node: HTMLElement, on: boolean) { node.setAttribute('aria-pressed', String(on)); }
  const dialog = el('dialog', '', 'appearance-dialog settings-window');
  dialog.setAttribute('aria-labelledby', 'appearance-title');
  const sidebar = el('div', '', 'settings-sidebar');
  const dialogTitle = el('h2', 'Appearance');
  dialogTitle.id = 'appearance-title';
  sidebar.append(dialogTitle);
  const settingsMain = el('div', '', 'settings-main');
  const sample = el('p', SAMPLE_TEXT, 'settings-sample');
  const samplePane = el('div', '', 'settings-preview'); samplePane.append(el('p', 'Preview', 'overline'), sample);
  const settingsBody = el('div', '', 'settings-body');
  settingsMain.append(samplePane, settingsBody);
  dialog.append(sidebar, settingsMain);
  const sections = new Map<string, HTMLElement>(); const categoryButtons = new Map<string, HTMLButtonElement>();
  let category = 'theme';
  function showCategory(key: string) {
    category = key;
    if (key === 'vibecode') void themeBuilder.check();
    sections.forEach((section, name) => { section.hidden = name !== key; });
    categoryButtons.forEach((node, name) => node.setAttribute('aria-current', String(name === key)));
  }
  for (const [key, label] of [['theme', 'Theme'], ['vibecode', 'Vibecode theme'], ['type', 'Typography'], ['editor', 'Editor'], ['keys', 'Shortcuts']]) {
    const node = button(label, () => showCategory(key), 'settings-category'); categoryButtons.set(key, node); sidebar.append(node);
    const section = el('section', '', 'settings-section'); section.setAttribute('aria-label', label); sections.set(key, section); settingsBody.append(section);
  }
  sidebar.append(el('span', '', 'settings-spacer'), el('p', 'Saved on this device · esc to close', 'settings-note'));
  function group(section: string, title: string) {
    const node = el('div', '', 'settings-group'); node.append(el('p', title, 'overline')); sections.get(section)!.append(node); return node;
  }
  function segmented<T extends {id: string; label: string}>(label: string, items: readonly T[], current: () => string, choose: (id: T['id']) => void) {
    const row = el('div', '', 'segmented'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', label);
    const nodes = items.map(item => { const node = button(item.label, () => choose(item.id)); row.append(node); return [item.id, node] as const; });
    lookControls.push(() => nodes.forEach(([id, node]) => pressed(node, id === current())));
    return row;
  }
  function settingRow(label: string, control: HTMLElement) { const row = el('div', '', 'setting-row'); row.append(el('span', label), control); return row; }

  const themeBuilder = createThemePanel(core, () => look);
  sections.get('vibecode')!.append(themeBuilder.element);
  let appearanceSession = 0;
  let appearanceClose: (() => void)|null = null;
  function ownAppearanceClose() {
    const session = ++appearanceSession, epoch = documentEpoch;
    if (appearanceClose) dialog.removeEventListener('close', appearanceClose);
    appearanceClose = () => {
      // A queued close belongs to a closed session, never a reopened dialog.
      if (disposed || dialog.open || session !== appearanceSession) return;
      themeBuilder.close();
      const focused = document.activeElement;
      // Native modal restoration may already have handed focus to the next
      // document/control. Only provide a fallback while this session owns it.
      if (epoch === documentEpoch && (focused === document.body || focused === appearance || (focused instanceof Node && dialog.contains(focused)))) appearance.focus();
    };
    dialog.addEventListener('close', appearanceClose);
  }

  // Theme: four base themes and four accents.
  const themeGrid = el('div', '', 'theme-grid');
  for (const theme of THEMES) {
    const card = el('button', '', 'theme-card'); card.type = 'button';
    for (const [name, value] of [['--card-bg', theme.bg], ['--card-fg', theme.fg], ['--card-muted', theme.muted], ['--card-border', theme.border]]) card.style.setProperty(name, value);
    const swatch = el('span', '', 'theme-swatch'); swatch.setAttribute('aria-hidden', 'true'); swatch.append(el('span'), el('span'), el('span'));
    card.append(swatch, el('span', theme.name, 'theme-name'));
    card.addEventListener('click', () => setLook({theme: theme.id}));
    lookControls.push(() => { pressed(card, look.theme === theme.id); card.style.setProperty('--card-accent', accentColor({theme: theme.id, accent: look.accent})); });
    themeGrid.append(card);
  }
  group('theme', 'Base theme').append(themeGrid);
  const accentRow = el('div', '', 'accent-row'); accentRow.setAttribute('role', 'group'); accentRow.setAttribute('aria-label', 'Accent colour');
  for (const accent of ACCENTS) {
    const swatch = el('button', '', 'accent-swatch'); swatch.type = 'button'; swatch.setAttribute('aria-label', accent.name); swatch.title = accent.name;
    swatch.addEventListener('click', () => setLook({accent: accent.id}));
    lookControls.push(() => { pressed(swatch, look.accent === accent.id); swatch.style.setProperty('--swatch', accentColor({theme: look.theme, accent: accent.id})); });
    accentRow.append(swatch);
  }
  group('theme', 'Accent').append(accentRow);

  // Typography: the three font roles (with one-click presets), text size and line spacing.
  const fontList = el('datalist');
  fontList.id = 'installed-fonts';
  dialog.append(fontList);
  const fontGroup = group('type', 'Fonts');
  const presetNames = [...new Set(Object.values(FONT_PRESETS).flat())];
  function listFonts() {
    fontList.replaceChildren(...[...new Set([...presetNames, ...(installedFonts ?? [])])].map(name => { const option = el('option'); option.value = name; return option; }));
  }
  listFonts();
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
    const presets = el('div', '', 'font-presets'); presets.setAttribute('role', 'group'); presets.setAttribute('aria-label', `${role.label} presets`);
    const chips = FONT_PRESETS[role.key].map(name => {
      const chip = button(name, () => { field.value = name; commit(); }, 'font-chip');
      chip.style.fontFamily = familyValue(name, 'inherit'); presets.append(chip); return chip;
    });
    const commit = () => {
      const name = cleanFamily(field.value);
      if (name) fontChoices = { ...fontChoices, [role.key]: name };
      else { const { [role.key]: _gone, ...rest } = fontChoices; fontChoices = rest; }
      field.value = name ?? '';
      saveChoices(fontChoices);
      applyChoices(fontChoices);
      const known = (font: string) => font.toLowerCase() === name?.toLowerCase();
      const missing = name && installedFonts && !installedFonts.some(known) && !BUNDLED_FONTS.some(known);
      note.textContent = missing ? `“${name}” isn't installed on this computer, so the default is used.` : role.hint;
      note.classList.toggle('warn', Boolean(missing));
      chips.forEach(chip => pressed(chip, chip.textContent === (name ?? '')));
    };
    chips.forEach(chip => pressed(chip, chip.textContent === (fontChoices[role.key] ?? '')));
    field.addEventListener('change', commit);
    const reset = button('Default', () => { field.value = ''; commit(); field.focus(); }, 'font-reset');
    reset.setAttribute('aria-label', `Reset ${role.label.toLowerCase()} to default`);
    row.append(label, field, reset, presets, note);
    fontGroup.append(row);
  }
  const sizeGroup = group('type', 'Text size');
  sizeGroup.append(zoomGroup, el('p', `${formatKeys('⌘=')} larger · ${formatKeys('⌘−')} smaller · ${formatKeys('⌘0')} reset. Scales the whole window.`, 'settings-hint'));
  group('type', 'Line spacing').append(segmented('Line spacing', LEADINGS, () => look.leading, leading => setLook({leading})));

  // Editor: line width and the two writing modes.
  sections.get('editor')!.append(settingRow('Line width', segmented('Line width', WIDTHS, () => look.width, width => setLook({width}))));
  const modes = group('editor', 'While writing');
  for (const [key, label] of [['fade', 'Fade the status pill while typing'], ['focus', 'Dim all but the current paragraph']] as const) {
    const row = el('div', '', 'toggle-row'); const toggle = el('button', '', 'switch'); toggle.type = 'button';
    toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', label);
    toggle.addEventListener('click', () => setLook({[key]: !look[key]}));
    lookControls.push(() => toggle.setAttribute('aria-checked', String(look[key])));
    row.append(el('span', label), toggle); modes.append(row);
  }
  sections.get('keys')!.append(shortcutSheet());

  sidebar.append(button('Done', () => { themeBuilder.close(); if (dialog.close) dialog.close(); else { dialog.removeAttribute('open'); appearance.focus(); } }, 'primary'));
  root.append(dialog);
  lookControls.forEach(sync => sync());
  showCategory(category);
  async function openAppearance(section?: string) {
    if (section) showCategory(section);
    else if (category === 'vibecode') void themeBuilder.check();
    const passage = editor?.text().slice(splitBodyStart(editor.text()) ?? 0).split(/\r?\n\s*\r?\n/).map(part => part.replace(/^#+\s.*$/m, '').trim()).find(part => part.length > 40);
    sample.textContent = passage ? (passage.length > 320 ? `${passage.slice(0, 320)}…` : passage) : SAMPLE_TEXT;
    if (!dialog.open) { ownAppearanceClose(); if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
    categoryButtons.get(category)?.focus();
    if (installedFonts) return;
    try {
      installedFonts = await core.listSystemFonts();
      listFonts();
    } catch { /* typing a family name still works without the list */ }
  }

  // Keyboard cheat sheet (Cmd/Ctrl+/ or ?).
  let helpLayer: HTMLElement | null = null; let helpReturn: HTMLElement | null = null;
  function toggleHelp(show = !helpLayer) {
    if (!show) {
      helpLayer?.remove(); helpLayer = null;
      if (helpReturn?.isConnected) helpReturn.focus({preventScroll: true}); else focusEditor();
      return;
    }
    if (helpLayer) return;
    helpReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    helpLayer = el('div', '', 'overlay-layer');
    const backdrop = el('div', '', 'overlay-backdrop'); backdrop.addEventListener('mousedown', () => toggleHelp(false));
    const sheet = el('div', '', 'help-sheet'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'shortcuts-title');
    const head = el('div', '', 'card-head'); const heading = el('h2', 'Keyboard shortcuts'); heading.id = 'shortcuts-title';
    const close = button('Close', () => toggleHelp(false), 'card-close'); close.setAttribute('aria-label', 'Close keyboard shortcuts');
    head.append(heading, close);
    sheet.append(head, shortcutSheet(), el('p', 'Local drafting · Autosaves locally · Nothing goes to an AI provider until you choose Send in Questions.', 'help-foot'));
    sheet.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); toggleHelp(false); } });
    helpLayer.append(backdrop, sheet); root.append(helpLayer);
    close.focus();
  }

  // Command palette: scenes, files and commands in one fuzzy finder.
  let directoryEntries: {path: string; name: string; kind: 'file' | 'directory'}[] = [];
  let currentBook: Manuscript | null = null;
  const palette = createPalette(root, {
    items: paletteItems,
    reorder: async (key, direction) => {
      const before = drafting.state?.scenes.map(scene => scene.id).join('\n');
      if (!before) return false;
      await drafting.reorderScene(key, direction);
      return drafting.state?.scenes.map(scene => scene.id).join('\n') !== before;
    },
    closed: () => focusEditor(),
  });
  let searchNavigation = 0;
  const manuscriptSearch = createManuscriptSearch(root, {
    scope: searchScope,
    openResult: (match, source, key) => { void openSearchResult(match, source, key); },
    closed: () => focusEditor(),
  });
  function searchScope(): SearchScope | null {
    if (!repository || disposed || selecting || repositoryDetached || structuralBusy) return null;
    const scenes = currentBook
      ? currentBook.volumes.flatMap(volume => volume.chapters.flatMap(chapter => chapter.scenes.map(scene => ({path: scene.path, title: `${chapter.title} · ${basename(scene.path)}`}))))
      : drafting.state?.revision ? drafting.state.scenes.map(scene => ({path: scene.path, title: scene.title || basename(scene.path)})) : null;
    if (!scenes) return null;
    const repositoryId = repository.id;
    return {
      key: JSON.stringify([generation, searchScopeRevision, repositoryId, currentBook?.path ?? drafting.state?.manifestPath, drafting.state?.revision, scenes]),
      title: currentBook?.project ?? drafting.state?.project ?? repository.name, scenes,
      buffer: opened && editor ? {path: opened.path, text: editor.text()} : undefined,
      read: async path => (await core.readDocument(repositoryId, path)).text,
    };
  }
  function openManuscriptSearch() {
    if (!searchScope()) { status.textContent = 'Open a manuscript to search its scenes.'; return; }
    palette.close(); toggleGoal(false); if (helpLayer) toggleHelp(false);
    manuscriptSearch.open();
  }
  async function openSearchResult(match: SearchMatch, source: string, key: string) {
    const navigation = ++searchNavigation;
    const navigationCurrent = () => navigation === searchNavigation && searchScope()?.key === key;
    const stale = () => { status.textContent = 'This search result changed. Search the manuscript again to locate the current passage.'; status.classList.add('error'); };
    if (!navigationCurrent()) { stale(); return; }
    // Reusing the current editor preserves dirty text, undo history, and recovery.
    // Other scenes pass through the same save/discard/cancel guard as ordinary navigation.
    if (opened?.path !== match.path && !await showDocument(match.path, false, navigationCurrent)) return;
    if (disposed || !navigationCurrent() || opened?.path !== match.path) return;
    if (!editor || recoveryPending || editor.text() !== source) { stale(); return; }
    showSourceView();
    editor.view.dispatch({selection: {anchor: editorOffset(source, match.from), head: editorOffset(source, match.to)}, scrollIntoView: true});
    editor.view.focus();
    status.textContent = `Found passage in ${match.path} · line ${match.line}`;
    status.classList.remove('error');
  }
  function focusEditor() { if (editor && !document.querySelector('dialog[open]')) focusWriterView(); }
  function openPalette(scope: PaletteScope, query = '') {
    if (!core.available()) return;
    manuscriptSearch.close(); toggleGoal(false); if (helpLayer) toggleHelp(false);
    palette.open(scope, query);
  }
  function paletteItems(scope: PaletteScope): PaletteItem[] {
    if (scope === 'scenes') {
      if (drafting.state?.revision) return drafting.state.scenes.map((scene, index) => ({
        key: scene.id, num: String(index + 1).padStart(2, '0'), label: scene.title || basename(scene.path), sub: scene.path,
        right: opened?.path === scene.path ? 'open' : drafting.state!.groups.find(item => item.id === scene.groupId)?.title ?? '',
        run: () => { void showDocument(scene.path); },
      }));
      if (currentBook) {
        let index = 0;
        return currentBook.volumes.flatMap(volume => volume.chapters.flatMap(chapter => chapter.scenes.map(scene => ({
          key: scene.path, num: String(++index).padStart(2, '0'), label: basename(scene.path), sub: `${chapter.number}. ${chapter.title} · ${scene.path}`,
          right: opened?.path === scene.path ? 'open' : '', run: () => { void showDocument(scene.path); },
        }))));
      }
      return [];
    }
    if (scope === 'files') {
      const here = directoryPath.textContent === '/' ? '' : directoryPath.textContent ?? '';
      const items: PaletteItem[] = here ? [{key: '..', label: '↑ Parent folder', sub: parentPath(here) || '/', run: () => { void showDirectory(parentPath(here)).then(() => openPalette('files')); }}] : [];
      return items.concat(directoryEntries.map(entry => ({
        key: entry.path, label: entry.kind === 'directory' ? `${entry.name}/` : entry.name, sub: entry.path,
        right: entry.kind === 'directory' ? 'folder' : opened?.path === entry.path ? 'open' : /\.(md|markdown)$/i.test(entry.path) ? 'md' : 'read-only',
        run: () => { if (entry.kind === 'directory') void showDirectory(entry.path).then(() => openPalette('files')); else void showDocument(entry.path); },
      })));
    }
    const commands: (PaletteItem | false)[] = [
      Boolean(newDraftButton) && {key: 'new-draft', label: 'New Markdown draft', right: !repository || standalone?.active ? formatKeys('⌘N') : undefined, run: () => newDraftButton?.click()},
      Boolean(searchScope()) && {key: 'find-manuscript', label: 'Find in manuscript', sub: 'Search scene text locally, including the open buffer', right: formatKeys('⌘⇧F'), run: openManuscriptSearch},
      Boolean(editor) && {key: 'ask', label: 'Ask Heinlein about selection', sub: 'Opens Questions with the highlighted passage', right: formatKeys('⌘J'), run: () => askShortcut()},
      Boolean(editor) && {key: 'split', label: 'Split scene at cursor', sub: 'Previews before anything moves', right: formatKeys('⌘⇧↵'), run: splitAtCursor},
      Boolean(repository && !standalone?.active) && {key: 'new-scene', label: 'New scene', sub: 'Opens Add scene or manuscript setup', right: formatKeys('⌘N'), run: () => { void newWriting(); }},
      proposals.supported && Boolean(repository) && {key: 'proposals', label: 'Proposed revisions', sub: 'Review pending MCP proposals and receipts', run: () => { void proposals.open(); }},
      {key: 'appearance', label: 'Appearance', sub: 'Theme, accent, fonts, size, spacing', right: formatKeys('⌘,'), run: () => { void openAppearance(); }},
      {key: 'larger', label: 'Larger text', right: formatKeys('⌘='), run: () => setZoom('in')},
      {key: 'smaller', label: 'Smaller text', right: formatKeys('⌘−'), run: () => setZoom('out')},
      {key: 'reset-size', label: 'Reset text size', right: formatKeys('⌘0'), run: () => setZoom('reset')},
      Boolean(editor) && {key: 'save', label: 'Save now', sub: 'Autosave runs after a short pause', right: formatKeys('⌘S'), run: () => { void saveCurrent(); }},
      Boolean(editor) && {key: 'find', label: 'Find in scene', right: formatKeys('⌘F'), run: () => sourceAction(() => editor?.find())},
      {key: 'open', label: 'Open folder…', sub: 'Native folder picker', right: formatKeys('⌘O'), run: () => { if (!open.disabled) open.click(); }},
      Boolean(drafting.state?.revision) && {key: 'import', label: 'Import files…', sub: 'Copy Markdown files into ms/', run: () => { void drafting.importExternal(); }},
      Boolean(drafting.state?.revision) && {key: 'import-repo', label: 'Import repository files…', sub: 'Move Markdown files into ms/', run: () => drafting.importRepository('move')},
      Boolean(drafting.state?.revision) && {key: 'legacy', label: 'Copy legacy scenes…', sub: 'Independent copies; the old manuscript is unchanged', run: () => drafting.importRepository('copy')},
      drafting.canUndo && {key: 'undo-structure', label: 'Undo last manuscript change', run: () => drafting.undoLastChange()},
      !draftingEntry.hidden && {key: 'drafting', label: 'Show ms drafting manuscript', run: () => { navigation.select('manuscript'); void openDrafting(); }},
      {key: 'goal', label: 'Set daily goal…', sub: writingSummary ? `Currently ${writingSummary.goal.toLocaleString()} words` : '', run: () => toggleGoal(true)},
      {key: 'navigation', label: 'Toggle navigation drawer', right: formatKeys('⌘\\'), run: () => navigation.toggle()},
      {key: 'files', label: 'Show repository files', run: () => navigation.select('files')},
      {key: 'outline', label: 'Show manuscript outline', run: () => navigation.select('manuscript')},
      Boolean(drafting.state?.scenes.length) && {key: 'prev-scene', label: 'Previous scene', run: () => stepScene(-1)},
      Boolean(drafting.state?.scenes.length) && {key: 'next-scene', label: 'Next scene', run: () => stepScene(1)},
      {key: 'scene-navigator', label: 'Show scene navigator', run: () => navigation.select('scenes')},
      {key: 'shortcuts', label: 'Keyboard shortcuts', right: formatKeys('⌘/'), run: () => toggleHelp(true)},
    ];
    return commands.filter((item): item is PaletteItem => Boolean(item));
  }
  // Cmd/Ctrl+J: capture a highlighted passage, otherwise open or close Questions.
  function askShortcut() {
    if(refuseReferenceAction()||refuseReadingAction())return;
    if (!editor || !draftingQuestions) { status.textContent = 'Open a Markdown scene to ask about it.'; return; }
    const selection = editor.view.state.selection;
    if (selection.ranges.length === 1 && !selection.main.empty) { void askDraftingSelection(); return; }
    if (draftingQuestions.visible()) draftingQuestions.close(); else draftingQuestions.open();
  }
  async function refreshSharing() {
    const session=repository,revision=edits,view=documentEpoch,ticket=++sharingGeneration;
    sharingEvidence=null;
    if(!session?.githubWorkspaceId||standalone?.active||dirty||!core.githubRequest)return;
    await dirtySync;
    try {
      const value=await requestGitHub(core,{action:'localProject',repositoryId:session.id}) as GitHubLocalEvidence;
      if(!disposed&&ticket===sharingGeneration&&repository?.id===session.id&&edits===revision&&documentEpoch===view&&!dirty&&!standalone?.active&&value?.workspaceId===session.githubWorkspaceId){sharingEvidence=value;renderOrigin();}
    }catch{if(!disposed&&ticket===sharingGeneration){sharingEvidence=null;renderOrigin();}}
  }
  function renderOrigin() {
    const standaloneActive=Boolean(standalone?.active);
    projectInfo.hidden=standaloneActive||!repository;
    sourceFileGuide.hidden=standaloneActive||!fileFirstRepository;
    projectSettings.hidden=standaloneActive||!repository?.projectId;
    repoName.textContent=standaloneActive?'Standalone draft':repository?.name??'Open a repository';
    originStatus.textContent=(!standaloneActive&&repository?.githubWorkspaceId&&sharingEvidence?`Working branch: ${sharingEvidence.branch}. `:'')+sharingStatus(repository,standaloneActive,dirty,sharingEvidence);
    originSend.hidden=standaloneActive||!repository?.githubWorkspaceId;
    directoryPath.hidden=standaloneActive||!repository;
    listing.hidden=standaloneActive;
  }
  function renderPill() {
    if (newDraftButton) {
      if (repository && !standalone?.active) newDraftButton.removeAttribute('aria-keyshortcuts');
      else newDraftButton.setAttribute('aria-keyshortcuts', 'Meta+N Control+N');
    }
    refreshHeaderLayout();
    pillProject.textContent = projectLibrary.supported?(standalone?.active?'Standalone draft · Projects…':repository?.name??'Projects…'):documentOrigin(repository,Boolean(standalone?.active));
    if(projectLibrary.supported)pillProject.setAttribute('aria-label',`Projects. ${standalone?.active?'Standalone draft':repository?.name??'No project selected'}`);
    const scene = opened && drafting.state?.scenes.find(item => item.path === opened!.path);
    const chapterTitle = !standalone?.active && scene ? drafting.state?.groups.find(group => group.id === scene.groupId)?.title : undefined;
    pillChapter.textContent = chapterTitle ?? ''; pillChapter.hidden = pillChapterSep.hidden = !chapterTitle;
    pillScene.disabled = !(scene && !standalone?.active); pillChapter.setAttribute('aria-label', `Chapter: ${chapterTitle ?? ''}. Choose another chapter`);
    if (draftingStarted) binderTree.refresh();
    pillScene.textContent = standalone?.active ? 'Untitled draft' : opened ? (scene && scene.title) || basename(opened.path) : 'No scene open';
    pillScene.setAttribute('aria-label', fileFirstRepository && opened && !scene && !standalone?.active ? `Source file: ${pillScene.textContent}` : `Scene: ${pillScene.textContent}. Choose another scene`);
    const words = standalone?.active ? wordCount(standalone.text) : writingSummary?.sceneWords;
    pillWords.textContent = words == null ? '— words' : `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    if (writingSummary) {
      goalText.textContent = `${writingSummary.credited.toLocaleString()} / ${writingSummary.goal.toLocaleString()}`;
      goalFill.style.width = `${Math.min(100, (writingSummary.credited / Math.max(1, writingSummary.goal)) * 100)}%`;
      goalButton.setAttribute('aria-label', `Daily goal: ${goalText.textContent} words credited today`);
    }
  }
  renderPill();

  // One live handler per document, so remounting never stacks listeners. Capture phase, so
  // app shortcuts win over editor defaults (Cmd/Ctrl+/ would otherwise toggle a comment).
  if (zoomKeyHandler) document.removeEventListener('keydown', zoomKeyHandler, true);
  zoomKeyHandler = (event: KeyboardEvent) => {
    if (disposed || event.isComposing) return;
    const action = shortcutAction(event);
    if (action) { event.preventDefault(); setZoom(action); return; }
    const otherModal = [...document.querySelectorAll('dialog[open]')].some(node => node !== dialog);
    const newShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey;
    if (root.inert || otherModal) { if (newShortcut) event.preventDefault(); return; }
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) {
      if (event.key === '?' && !event.altKey && !typingTarget(event.target) && !dialog.open && !palette.isOpen()) { event.preventDefault(); toggleHelp(true); }
      return;
    }
    if (event.altKey) return;
    const key = event.key.toLowerCase();
    const run = (task: () => void) => { event.preventDefault(); event.stopPropagation(); task(); };
    if (key === ',') { run(() => { if (dialog.open) dialog.close(); else void openAppearance(); }); return; }
    if (dialog.open) { if (newShortcut) event.preventDefault(); return; }
    if (key === 'n' && !event.shiftKey && (newDraftButton || repository)) run(() => { if (!event.repeat) void newWriting(); });
    else if (key === 'f' && event.shiftKey) run(openManuscriptSearch);
    else if (key === 'k') run(() => openPalette('scenes'));
    else if (key === 'p') run(() => openPalette(event.shiftKey ? 'commands' : 'files'));
    else if (key === '\\') run(() => { if (palette.isOpen()) palette.close(); navigation.toggle(); });
    else if (key === '/' || (key === '?' && event.shiftKey)) run(() => toggleHelp());
    else if (key === 'j' && !event.shiftKey) run(askShortcut);
    else if (key === 'o' && !event.shiftKey) run(() => { if (!open.disabled) open.click(); });
  };
  document.addEventListener('keydown', zoomKeyHandler, true);
  // Chrome fades while typing and returns as soon as the pointer moves.
  const wake = () => { if (root.classList.contains('typing')) root.classList.remove('typing'); };
  document.addEventListener('mousemove', wake);
  // Routine status messages fade after a few seconds (text stays for assistive tech); errors stay put.
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  // Watches text only (never the class it toggles), so it cannot retrigger itself.
  // Source notices use a fixed, scrollable slot. Their appearance/fade must not
  // change the writing surface's padding while the author is reading or typing.
  status.tabIndex = 0;
  function reserveNoticeSpace(){root.style.setProperty('--notice-space','4rem');root.style.setProperty('--manuscript-footer-space',`${corner.offsetHeight}px`);}
  const noticeResize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(reserveNoticeSpace);
  noticeResize?.observe(status);
  noticeResize?.observe(corner);
  const statusQuiet = new MutationObserver(() => {
    queueMicrotask(reserveNoticeSpace);
    if (status.classList.contains('quiet')) status.classList.remove('quiet');
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusTimer = null; if (!status.classList.contains('error')) status.classList.add('quiet');reserveNoticeSpace(); }, 4000);
  });
  statusQuiet.observe(status, {childList: true, characterData: true, subtree: true});
  applyZoom(false);

  function resetPreview() {
    if(projectPositionTimer){clearTimeout(projectPositionTimer);projectPositionTimer=null;}
    standalone?.detach();
    questions?.clear();
    selectionAsk?.destroy(); selectionAsk = null;
    draftingQuestions?.clear(); questionButton = null;
    if (!reviewApplying) reviewPanel?.clear(); currentChapter = null;
    writing.clearScene();
    cancelAutosave(); cancelSaveNotice(); composing = false; documentEpoch++; recoveryErrorMessage = null; recovery = null; recoveryPending = false; writePaused = null;
    editorCommands?.destroy();editorCommands=null;documentCommandBar.replaceChildren();documentReader = null; documentView = null;
    chapterEditor?.destroy(); chapterEditor = null;
    editor?.destroy(); editor = null; opened = null; saveButton = null; dirtyBadge = null; setDirty(false); documentTabs.unmount();activeDocumentPane.removeAttribute('aria-labelledby');
    sceneNavigator.refresh();
    if(!repository&&standalone?.supported){queueMicrotask(()=>{if(!repository&&!disposed)void standalone!.start();});return;}
    const welcome = el('div', '', 'welcome');
    welcome.append(el('p', repository ? repository.name : 'Heinlein Studio', 'eyebrow'), el('h2', repository ? 'A quiet place to write' : 'A quiet place to write'),
      el('p', repository ? 'Pick a scene to start writing. Markdown source is preserved exactly. Document details are tucked away above the writing area.' : 'Choose a GitHub repository to work on your writing. Local folders and standalone Drafts are also available.', 'empty'));
    if(repository)welcome.append(button('New scene',()=>{void newWriting();}));
    if(!repository&&projectLibrary.supported)welcome.append(button('Open Projects',()=>void projectLibrary.open()));
    if (!repository && core.available()&&!projectLibrary.supported) welcome.append(button('Choose a GitHub repository…', () => {void github.open(true);}, 'primary github-welcome-entry'),button('Open a local folder…',()=>{void selectRepository(()=>core.pickRepository());}));
    const keys = el('dl', '', 'welcome-keys');
    for (const [shortcut, label] of [['⌘K', 'Jump to a scene'], ['⌘P', 'Browse files'], ['⌘⇧P', 'Every command'], ['⌘,', 'Theme, fonts and size'], ['⌘/', 'All shortcuts']]) {
      const term = el('dt'); term.append(el('kbd', formatKeys(shortcut))); keys.append(term, el('dd', label));
    }
    welcome.append(keys);
    const page = el('div', '', 'page'); page.append(welcome);
    if(documentTabs.items().length||reference.hasSnapshot())mountActive(page);else preview.replaceChildren(page);
    if (chromeReady) { renderPill(); updateSaveState(); }
  }
  function reportError(error: unknown) {
    status.textContent = `Unable to open: ${typeof error === 'string' ? error : error instanceof Error ? error.message : 'The local host rejected this request.'}`;
    status.classList.add('error');
  }
  function reportDetachedRepository() {
    documentTabs.setBlocked(true);reference.setDetached(true);
    status.textContent = 'The editor changed while the folder was opening. Your text is preserved here, but the previous folder session is no longer active. Copy these edits before reopening the original folder. Saving and autosave are paused.';
    status.classList.add('error');
  }
  async function refreshRecent() {
    void repositoryHome.refresh();
    try {
      const items = await core.recentRepositories();
      recent.replaceChildren(el('span', 'Recent local folders', 'muted'));
      if (!items.length) recent.append(el('span', 'None yet', 'muted'));
      for (const item of items) {
        const entry = button(item.name, () => { void selectRepository(() => core.openRecentRepository(item.id)); });
        entry.disabled = selecting;
        recent.append(entry);
      }
    } catch (error) { reportError(error); }
  }
  async function rememberProjectPosition():Promise<void> {
    if(!core.projectRequest||standalone?.active||!repository?.projectId||!opened||!editor||opened.generatedCompatibility)return;
    if(dirty||saving||recoveryPending||recoveryErrorMessage||repositoryDetached)throw Error('Keep the current writing locally and resolve recovery before switching projects.');
    const session=repository,epoch=documentEpoch,revision=edits,doc=opened,range=editor.view.state.selection.main;
    const hint:ProjectResume={path:doc.path,sourceHash:doc.contentHash,sceneId:drafting.state?.scenes.find(s=>s.path===doc.path)?.id??null,anchor:range.anchor,head:range.head,scrollTop:Math.max(0,Math.round(writerScrollTop()))};
    const task=projectResumeQueue.then(async()=>{
      if(disposed||repository?.id!==session.id||documentEpoch!==epoch||edits!==revision||dirty)throw Error('Writing changed while remembering its position. Keep it locally and try again.');
      const p=await core.projectRequest!({action:'saveResume',repositoryId:session.id,projectId:session.projectId!,revision:session.projectRevision!,resume:hint}) as Project;
      if(repository?.id===session.id){repository.projectRevision=p.revision;repository.name=p.name;}
    });projectResumeQueue=task.catch(()=>{});await task;
  }
  // A detached buffer blocks quitting and project switches, but not reselecting a repository: that is how it is reattached.
  function projectWritingBlocksLeave(detachedBlocks=true):boolean {
    return !!editor&&!standalone?.active&&!opened?.generatedCompatibility&&!!(saving||staging||recoveryPending||recoveryErrorMessage||(detachedBlocks&&repositoryDetached));
  }
  async function rememberProjectPositionAfterLeave(detachedBlocks=true):Promise<boolean> {
    const revision=edits,wasDirty=dirty,session=repository?.id,epoch=documentEpoch,draftText=standalone?.active?standalone.text:null;
    try{if(!(dirty&&writePaused==='discard'))await rememberProjectPosition();}catch(error){
      // A position hint is not a writing save. Clean external changes may make
      // it unavailable; native activation validates any retained hint afresh.
      if(dirty||projectWritingBlocksLeave(detachedBlocks)){reportError(error);return false;}
    }
    return !disposed&&!projectWritingBlocksLeave(detachedBlocks)&&documentEpoch===epoch&&edits===revision&&repository?.id===session&&dirty===wasDirty&&(draftText===null||standalone?.text===draftText);
  }
  function scheduleProjectPosition(){if(projectPositionTimer)clearTimeout(projectPositionTimer);projectPositionTimer=setTimeout(()=>{projectPositionTimer=null;if(!dirty&&!saving&&!selecting&&!standalone?.active)void rememberProjectPosition().catch(()=>{});},600);}
  async function switchProject(id:string):Promise<boolean>{
    if(!core.projectRequest||selecting||structuralBusy||proposalBusy)return false;
    await dirtySync;if(writeInFlight)await writeInFlight;await stageQueue;
    if(dirty&&!await saveCurrent())return false;
    let activated:RepositorySession|null=null;
    await selectRepository(async()=>{
      const source=repository?.id,revision=edits,epoch=documentEpoch,draftText=standalone?.active?standalone.text:null;
      const plan=await core.projectRequest!({action:'previewOpen',id}) as {id:string};
      await dirtySync;
      if(disposed||source!==repository?.id||revision!==edits||epoch!==documentEpoch||dirty||(draftText!==null&&standalone?.text!==draftText)){
        await core.projectRequest!({action:'cancel',previewId:plan.id});return null;
      }
      activated=await core.projectRequest!({action:'activate',previewId:plan.id}) as RepositorySession;
      return activated;
    });return !!activated&&repository?.id===(activated as RepositorySession).id&&!repositoryDetached;
  }

  async function selectRepository(select: () => Promise<RepositorySession | null>) {
    if (selecting || !await allowLeave() || selecting) return;
    if(!await rememberProjectPositionAfterLeave(false))return;
    selecting = true;
    reviewPanel?.clear();
    manuscriptSearch.close();
    questions?.clear();
    draftingQuestions?.clear();
    const editRevision = edits;
    const previousEditor = editor;
    const wasReadOnly = editor?.view.state.readOnly ?? false;
    const current = ++generation;
    open.disabled = true;
    recent.querySelectorAll('button').forEach(node => { node.disabled = true; });
    // Block navigation while the host may be switching its selected root.
    layout.inert = true; cancelAutosave(); cancelSaveNotice(); editor?.setEditable(false);
    status.classList.remove('error');
    status.textContent = 'Opening your writing…';
    try {
      const selected = await select();
      if (disposed || current !== generation) return;
      if (!selected) { if (repositoryDetached) reportDetachedRepository(); else status.textContent = repository ? `${repository.name} · Local drafting` : 'Opening canceled.'; return; }
      if (editRevision !== edits) {
        // A programmatic/late editor event can bypass DOM inert/readOnly. The
        // native host may already have selected a different repository, so do
        // not replace this buffer or try saving it into the new session.
        repositoryDetached = true; writePaused = 'error'; updateSaveState();
        reportDetachedRepository();
        return;
      }
      firstStory.clear(); github.clear();
      documentTabs.clear();reference.clear();splitReadingOffer.replaceChildren();splitReadingOffer.hidden=true;
      repository = selected;
      fileFirstRepository = false;
      repositoryDetached = false;
      writing.clearManuscript();
      drafting.clear(); proposals.clear();
      proposalsEntry.hidden = !proposals.supported;
      draftingEntry.hidden = !drafting.supported;
      resetPreview();
      listing.replaceChildren();
      outline.replaceChildren();
      manifests.replaceChildren();
      renderOrigin(); currentBook = null; directoryEntries = []; renderPill();
      directoryPath.textContent = '/';
      for (const path of selected.manifests) {
        manifests.append(button(path, () => { void showManuscript(path); }, 'manifest-button'));
      }
      if (!selected.manifests.length) outline.append(el('p', selected.warning ? 'Manuscript discovery incomplete. You can still browse and read repository files.' : 'No scene manifest found. You can still browse and read repository files.', 'empty'));
      let draftState: DraftingState | null = null;
      let draftingLoadFailed = false;
      if (drafting.supported) {
        try { draftState = await drafting.load(); } catch (error) { draftingLoadFailed = true; reportError(error); }
      }
      if (disposed || current !== generation) return;
      renderPill();
      fileFirstRepository = !selected.manifests.length && !selected.warning && !draftingLoadFailed && !draftState?.revision && !draftState?.recoveryRequired;
      renderOrigin();
      if (fileFirstRepository) {
        outline.replaceChildren(el('p', sourceFileGuide.textContent!, 'empty'));
        await showDirectory('');
        // Open the existing file browser before resuming a document, so saved
        // Binder/closed preferences cannot hide it or steal resumed focus.
        navigation.select('files', false);
      } else if (draftState?.revision || draftState?.recoveryRequired || (draftState && !selected.manifests.length)) {
        outline.replaceChildren(drafting.element); void writing.setManuscript(core, selected, draftState);
        await showDirectory('');
      } else await Promise.all([showDirectory(''), selected.manifests[0] ? showManuscript(selected.manifests[0]) : Promise.resolve()]);
      if (!disposed && current === generation && !status.classList.contains('error')) status.textContent = `${selected.name} · Local drafting${selected.warning ? ` · ${selected.warning}` : ''}`;
      await refreshRecent();
      void refreshSharing();
      if(selected.resume){await showDocument(selected.resume.path,true,()=>!disposed&&generation===current,undefined,selected.resume);}
    } catch (error) { if (!disposed && current === generation) { if (repositoryDetached) reportDetachedRepository(); else reportError(error); } }
    finally { if (!disposed && current === generation) { selecting = false; open.disabled = false; layout.inert = false; editor?.setEditable(!recoveryPending && (editor !== previousEditor || !wasReadOnly)); recent.querySelectorAll('button').forEach(node => { node.disabled = false; }); if (dirty && !writePaused) scheduleAutosave(); } }
  }
  async function showDirectory(path: string) {
    const current = generation;
    const request = ++directoryRequest;
    try {
      const entries = await core.listDirectory(repository!.id, path);
      if (disposed || current !== generation || request !== directoryRequest) return;
      directoryPath.textContent = path || '/';
      directoryEntries = entries.map(({path, name, kind}) => ({path, name, kind}));
      if (palette.scope() === 'files') palette.refresh();
      listing.replaceChildren();
      if (path) listing.append(button('↑ Parent folder', () => { void showDirectory(parentPath(path)); }, 'file-entry parent'));
      for (const entry of entries) {
        const folder = entry.kind === 'directory';
        const item = button(`${folder ? '▸' : '·'} ${entry.name}`, () => { void (folder ? showDirectory(entry.path) : showDocument(entry.path)); }, 'file-entry');
        item.setAttribute('aria-label', `${folder ? 'Open folder' : 'Open file'} ${entry.name}`);
        if (!folder && /\.(md|markdown)$/i.test(entry.path) && drafting.supported) {
          item.draggable = true; item.title = 'Drag into the manuscript to move this file, or use Import repository files…';
          item.addEventListener('dragstart', event => { if (!event.dataTransfer) return; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(REPOSITORY_DRAG_TYPE, JSON.stringify({repositoryId: repository!.id, path: entry.path})); });
        }
        listing.append(item);
      }
      if (!entries.length) listing.append(el('p', 'This folder is empty.', 'empty'));
    } catch (error) { if (!disposed && current === generation && request === directoryRequest) reportError(error); }
  }
  async function showDocument(path: string, structuralRefresh = false, navigationCurrent: () => boolean = () => true, requestedChapter?: Chapter, resume?:ProjectResume) {
    if (selecting && !structuralRefresh) return false;
    if (!structuralRefresh && !await allowLeave()) return false;
    if (!navigationCurrent()) return false;
    rememberTabPosition();
    const editRevision = edits;
    const current = generation;
    const request = ++documentRequest;
    status.classList.remove('error');
    status.textContent = `Reading ${path}…`;
    // Keep the current buffer visible until a successful replacement read.
    try {
      const repositoryId = repository!.id;
      let chapter = requestedChapter ?? currentBook?.volumes.flatMap(volume => volume.chapters).find(chapter => chapter.source === path && !chapter.scenes.some(scene => scene.path === path));
      let doc: Document | undefined;
      let assembled: AssembledChapter | null = null;
      if (!chapter) {
        doc = await core.readDocument(repositoryId, path);
        if (doc.generatedCompatibility) {
          // File-browser navigation may precede opening the outline.
          for (const manifest of repository!.manifests) {
            const book = await core.loadManuscript(repositoryId, manifest);
            chapter = book.volumes.flatMap(volume => volume.chapters).find(chapter => chapter.source === path);
            if (chapter) break;
          }
        }
      }
      if (chapter) {
        if (!chapter.scenes.length || chapter.scenes.length > 500) throw new Error('Open source scenes individually; this chapter has no bounded source mapping.');
        const sources: Document[] = [];
        let totalChars = 0;
        for (const scene of chapter.scenes) {
          const source = await core.readDocument(repositoryId, scene.path);
          totalChars += source.text.length;
          if (totalChars > 8_000_000) throw new Error('This chapter is too large for an assembled view. Open a source scene instead.');
          sources.push(source);
        }
        assembled = assembleChapter(chapter, sources);
        doc = {path, text: assembled.text, generatedCompatibility: true, contentHash: '', sizeBytes: new TextEncoder().encode(assembled.text).length, frontmatter: null};
      }
      if (!doc) throw new Error('The document could not be read.');
      if (disposed || current !== generation || request !== documentRequest || editRevision !== edits || !navigationCurrent()) return;
      let draft: RecoveryDraft | null = null;
      let recoveryError: {error: unknown} | null = null;
      if (!doc.generatedCompatibility && (/\.(md|markdown)$/i.test(doc.path)||(/\.txt$/i.test(doc.path)&&placedText?.repositoryId===repository?.id&&placedText?.path===doc.path))) {
        try { draft = await core.readRecovery(repositoryId, path); }
        catch (error) { recoveryError = {error}; }
      }
      if (disposed || current !== generation || request !== documentRequest || editRevision !== edits || !navigationCurrent()) return;
      if(resume&&(doc.contentHash!==resume.sourceHash||doc.path!==resume.path||doc.generatedCompatibility||(resume.sceneId&&!drafting.state?.scenes.some(s=>s.id===resume.sceneId&&s.path===doc!.path))))throw Error('The last document changed. Open it from Writing; no saved position was guessed.');
      renderDocument(doc, draft, assembled);
      const position=documentTabs.active()?.position;
      if(!resume&&position&&editor&&!recoveryPending&&!recoveryError&&position.hash===doc.contentHash&&position.anchor>=0&&position.head>=0&&position.anchor<=editor.view.state.doc.length&&position.head<=editor.view.state.doc.length)restorePosition(position);
      if(resume&&editor&&!recoveryPending&&!recoveryError){const len=editor.view.state.doc.length;if(!Number.isInteger(resume.anchor)||!Number.isInteger(resume.head)||resume.anchor<0||resume.head<0||resume.anchor>len||resume.head>len){resetPreview();throw Error('The last position is invalid. Open a document from Writing.');}restorePosition(resume);}
      if(!recoveryError&&!recoveryPending)scheduleProjectPosition();
      if (recoveryError) showRecoveryReadFailure(doc, recoveryError.error);
      else if (!recoveryPending) {
        status.textContent = `Read ${doc.path} · ${doc.sizeBytes.toLocaleString()} bytes`;
        if (draft) await clearRecovery(draft, repositoryId, documentEpoch);
      }
      if(!recoveryError&&!recoveryPending)void refreshSharing();
      return !recoveryError && !recoveryPending;
    } catch (error) { if (!disposed && current === generation && request === documentRequest && navigationCurrent()) reportError(error); return false; }
  }
  function renderDocument(doc: Document, draft: RecoveryDraft | null = null, assembled: AssembledChapter | null = null) {
    standalone?.detach();
    editorCommands?.destroy();editorCommands=null;documentCommandBar.replaceChildren();documentReader = null; documentView = null;
    chapterEditor?.destroy(); chapterEditor = null;
    questions?.clear();
    selectionAsk?.destroy(); selectionAsk = null;
    draftingQuestions?.clear(); questionButton = null;
    if (!reviewApplying) reviewPanel?.clear(); currentChapter = null;
    if (doc.generatedCompatibility) writing.clearScene();
    else writing.openScene(repository?.projectKey ?? '', doc.path, doc.text, drafting.state?.scenes.find(scene => scene.path === doc.path)?.id);
    cancelAutosave(); cancelSaveNotice(); composing = false; documentEpoch++; recoveryErrorMessage = null; recovery = draft; recoveryPending = Boolean(draft && draft.text !== doc.text); writePaused = null; writeBaseHash = doc.contentHash;
    editor?.destroy(); editor = null; opened = doc; saveButton = null; dirtyBadge = null; setDirty(false);
    const sceneInfo = drafting.state?.scenes.find(scene => scene.path === doc.path);
    const sceneIndex = sceneInfo ? drafting.state!.scenes.indexOf(sceneInfo) : -1;
    const sourceKind = sceneInfo || currentBook?.volumes.some(volume => volume.chapters.some(chapter => chapter.scenes.some(scene => scene.path === doc.path))) ? 'Source scene' : 'Source file';
    const title = el('h2', assembled?.chapter.title || sceneInfo?.title || basename(doc.path), 'page-title');
    title.tabIndex = -1;
    const source = el('p', doc.path, 'path');
    const documentRole=el('span',doc.generatedCompatibility?'Reading assembled source':/\.(md|markdown)$/i.test(doc.path)||(/\.txt$/i.test(doc.path)&&placedText?.repositoryId===repository?.id&&placedText?.path===doc.path)?'Editing':'Reading source','document-role');
    const badge = el('p', doc.generatedCompatibility ? 'Assembled chapter · Revise its source scenes' : 'Source file · Read-only', 'badge');
    const metadata = el('details', '', 'metadata');
    metadata.append(el('summary', 'Frontmatter & source metadata'), el('p', `${doc.sizeBytes.toLocaleString()} bytes · Raw UTF-8 source`), el('pre', doc.frontmatter ?? 'No frontmatter', 'frontmatter'));
    const text = el('pre', doc.text, 'source-text');
    text.tabIndex = 0;
    text.setAttribute('aria-label', 'Read-only raw source');
    // Never interpret manuscript HTML, scripts, links, or embedded instructions.
    const meta = el('div', '', 'page-meta'); meta.append(documentRole, source, badge);
    const page = el('div', '', 'page');
    page.append(el('p', assembled ? 'Assembled chapter' : sceneIndex >= 0 ? `Scene ${sceneIndex + 1} of ${drafting.state!.scenes.length}` : sourceKind, 'eyebrow'), title, meta, metadata, text);
    const mountedTab=documentTabs.mount({path:doc.path,kind:doc.generatedCompatibility?'assembled':'source',sceneId:sceneInfo?.id,chapter:assembled?structuredClone(assembled.chapter):undefined});
    if(mountedTab)activeDocumentPane.setAttribute('aria-labelledby',mountedTab.id);
    reference.activateWriter();mountActive(page);
    currentChapter = assembled;
    if (assembled) renderAssembledChapter(assembled, text);
    else if (doc.generatedCompatibility) text.before(el('p', 'This assembled file has no chapter mapping in the available manifests. Open its source scenes from the file browser to edit.', 'muted'));
    if (!doc.generatedCompatibility && (/\.(md|markdown)$/i.test(doc.path)||(/\.txt$/i.test(doc.path)&&placedText?.repositoryId===repository?.id&&placedText?.path===doc.path))) {
      badge.textContent = /\.txt$/i.test(doc.path)?'Source file · Editable text':`${sourceKind} · Editable Markdown`;
      const toolbar = el('div', '', 'editor-toolbar');
      saveButton = button('Save', () => { void saveCurrent(); }, 'primary'); saveButton.disabled = true;
      dirtyBadge = el('span', 'Saved locally', 'badge'); dirtyBadge.setAttribute('role', 'status');
      const askSelection = button('Ask about selection', () => sourceAction(()=>{ void questions?.open(); }), 'source-only');
      askSelection.setAttribute('aria-haspopup', 'dialog');
      askSelection.title = 'Prepare a question for manual copy/paste into ChatGPT or another assistant';
      questionButton = button('Questions', () => writerAction(()=>{reviewPanel?.clear(); draftingQuestions?.open();}));
      questionButton.setAttribute('aria-controls', 'drafting-questions'); questionButton.setAttribute('aria-expanded', 'false');
      questionButton.title = 'Ask OpenAI while drafting, with only the context you choose';
      const askDrafting = button('Ask Heinlein about selection', () => {void askDraftingSelection();}, 'source-only'); askDrafting.disabled = true;
      askDrafting.setAttribute('aria-keyshortcuts', 'Control+Alt+Enter Meta+Alt+Enter');
      askDrafting.title = 'Capture the selected passage into Questions (Cmd/Ctrl+Alt+Enter). Nothing is sent automatically.';
      const split = button('Split scene at cursor', splitAtCursor, 'source-only');
      split.setAttribute('aria-haspopup', 'dialog'); split.setAttribute('aria-keyshortcuts', 'Control+Shift+Enter Meta+Shift+Enter');
      split.title = 'Split scene at cursor (Cmd/Ctrl+Shift+Enter)';
      split.disabled = !drafting.supported||!drafting.state||!!drafting.state.recoveryRequired||!(/\.(md|markdown)$/i.test(doc.path));
      toolbar.append(button('Heinlein Review', () => writerAction(()=>{draftingQuestions?.close(); reviewPanel?.open();})), questionButton, askDrafting, askSelection, split, saveButton, button('Undo', () => sourceAction(()=>editor?.undo()), 'source-only'), button('Redo', () => sourceAction(()=>editor?.redo()), 'source-only'), button('Find', () => sourceAction(()=>editor?.find()), 'source-only'), dirtyBadge);
      const host = el('div', '', 'markdown-editor');
      host.addEventListener('compositionstart', () => { composing = true; noteEditing(); });
      host.addEventListener('compositionend', () => { composing = false; lastEditAt = Date.now(); scheduleSaveNotice(); });
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
        noteEditing();
        writing.changed(previousText, raw, origin); previousText = raw;
        if (origin === 'user' && !root.classList.contains('typing')) root.classList.add('typing');
        edits++;
        if (writePaused === 'discard' && !repositoryDetached) writePaused = null;
        setDirty(raw !== opened?.text);
        scheduleAutosave(); sceneNavigator.schedule();
      }, () => { void saveCurrent(); });
      editor.view.dispatch({effects: StateEffect.appendConfig.of(reviewMarks())});
      if(core.projectRequest){editor.view.dispatch({effects:StateEffect.appendConfig.of(EditorView.updateListener.of(update=>{if(update.selectionSet)scheduleProjectPosition();}))});editor.view.scrollDOM.addEventListener('scroll',scheduleProjectPosition);}
      createDocumentDetails(metadata, editor);
      editor.view.dispatch({effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {if (update.docChanged || update.selectionSet) draftingQuestions?.stateChanged();}))});
      selectionAsk = createSelectionAskAction(editor.view, {current: draftingSelectionState, fallback: askDrafting, keys: formatKeys('⌘J'),
        revise: () => { if (!draftingQuestions) return; draftingQuestions.open(); draftingQuestions.setMode('revision'); },
        ask: snapshot => {void askDraftingSelection(snapshot);}, stale: () => {status.textContent = 'The selection changed. Highlight the passage again before asking.';}});
      if (recoveryPending && draft) showRecoveryChoice(doc, draft, host);
      if (/\.(md|markdown)$/i.test(doc.path)) {
        const target = editor.view;
        const roleInSource = documentRole.textContent;
        mountDocumentView(toolbar, host, target, () => {
          const value = target.state.doc.toString();
          const body = frontmatterEnd(value) ?? 0;
          return {text: value, ranges: [{from: body, to: value.length}], note: body ? 'Frontmatter is not shown in Reading. See Document details or Source.' : undefined};
        }, mode => { documentRole.textContent = mode === 'reading' ? 'Reading' : roleInSource; });
      }
      updateSaveState();
    }
    sceneNavigator.refresh();
    renderPill(); updateSaveState();
    title.focus({ preventScroll: true });
  }
  function renderAssembledChapter(assembled: AssembledChapter, text: HTMLElement) {
    const sourceHint = 'Assembled from current source scenes. Select a passage, then choose Revise source passage. Changes are reviewed as proposed revisions before they reach the source.';
    const explanation = el('p', sourceHint, 'muted');
    const toolbar = el('div', '', 'editor-toolbar assembled-toolbar');
    const revise = button('Revise source passage', () => { void reviseSelection(); }, 'primary source-only');
    revise.disabled = true;
    const host = el('div', '', 'markdown-editor assembled-editor');
    const sources = el('details', '', 'chapter-sources'); sources.open = true;
    sources.append(el('summary', 'Source scenes'));
    for (const [index, part] of assembled.parts.entries()) sources.append(button(`Open source scene ${index + 1} · ${basename(part.document.path)}`, () => { void showDocument(part.document.path); }));
    toolbar.append(button('Heinlein Review', () => writerAction(()=>{draftingQuestions?.close(); reviewPanel?.open();})), revise);
    text.replaceWith(explanation, toolbar, host, sources);
    const reader = createEditor(host, assembled.text, () => {}, () => {});
    chapterEditor = reader; reader.setEditable(false);
    reader.view.dispatch({effects: StateEffect.appendConfig.of(reviewMarks())});
    mountDocumentView(toolbar, host, reader.view, () => ({text: assembled.text, ranges: assembled.parts.map(part => ({from: part.from, to: part.to}))}), mode => { explanation.textContent = mode === 'reading' ? 'A formatted, read-only copy of the current source scenes. Switch to Source to select a passage and revise it.' : sourceHint; });
    reader.view.contentDOM.setAttribute('aria-label', 'Assembled chapter — select a passage to revise its source');
    reader.view.contentDOM.setAttribute('aria-readonly', 'true');
    reader.view.contentDOM.tabIndex = 0;
    reader.view.dispatch({effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {
      if (update.selectionSet) revise.disabled = update.state.selection.ranges.length !== 1 || update.state.selection.main.empty;
    }))});
    host.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key === 'Enter') {event.preventDefault(); void reviseSelection();}
    });
    async function reviseSelection() {
      if (refuseReferenceAction() || refuseReadingAction() || chapterEditor !== reader || disposed || selecting || repositoryDetached || structuralBusy || proposalBusy) return;
      const range = reader.view.state.selection.main;
      const current = () => !disposed && chapterEditor === reader && reader.view.state.selection.ranges.length === 1 && reader.view.state.selection.main.from === range.from && reader.view.state.selection.main.to === range.to;
      try {
        if (!current()) return;
        const target = chapterSelection(assembled, range.from, range.to);
        if (!await showDocument(target.document.path, false, current)) return;
        // Never replace intervening edits, or guess at repeated passages.
        if (!editor || opened?.path !== target.document.path || opened.contentHash !== target.document.contentHash || editor.text() !== target.document.text || recoveryPending) {
          status.textContent = 'The source scene changed or needs recovery. It is open for inspection; select the passage again before proposing a revision.';
          return;
        }
        showSourceView();
        editor.view.dispatch({selection: {anchor: target.from, head: target.to}, scrollIntoView: true});
        draftingQuestions?.open(); draftingQuestions?.setMode('revision');
        await askDraftingSelection();
        status.textContent = 'Source passage selected for a proposed revision. Describe the change, then explicitly send it. You can also edit this source scene directly.';
      } catch (error) { if (current()) {status.textContent = error instanceof Error ? error.message : String(error); status.classList.add('error');} }
    }
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
    searchScopeRevision++; manuscriptSearch.invalidate();
    currentBook = book;
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
        section.append(scenes, button('Read assembled chapter', () => { void showDocument(chapter.source, false, () => true, chapter); }, 'compatibility'));
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
    if(core.onQuitRefused)void core.onQuitRefused(message=>{root.inert=false;quitInProgress=false;status.textContent=message;}).then(unlisten=>{if(disposed)unlisten();else quitRefusedUnlisten=unlisten;}).catch(reportError);
    void core.onCloseRequested(() => {
      void quitSafely().catch(reportError);
    }).then(unlisten => { if (disposed) unlisten(); else closeUnlisten = unlisten; }).catch(reportError);
  }
  else {
    open.disabled = true;
    status.textContent = 'Open Heinlein Studio in its native desktop app to choose local folders. Browser preview has no filesystem access.';
  }
  return { showDirectory, showDocument, showManuscript, selectRepository, saveCurrent,
    destroy: () => { headerMedia?.removeEventListener?.('change',refreshHeaderLayout);appCommands?.destroy();editorCommands?.destroy();navigation.destroy();reference.clear();documentTabs.destroy();if(projectPositionTimer)clearTimeout(projectPositionTimer);projectLibrary.destroy();pillMenus.forEach(menu => menu.destroy());busyObserver.disconnect();repositoryHome.destroy(); standalone?.destroy(); updates.destroy(); github.destroy(); firstStory.destroy(); themeBuilder.destroy(); reviewPanel?.destroy(); sceneNavigator.destroy(); chapterEditor?.destroy(); manuscriptSearch.close(); questions?.destroy(); selectionAsk?.destroy(); draftingQuestions?.destroy(); proposals.destroy(); drafting.destroy(); dropUnlisten?.(); dropErrorUnlisten?.(); writing.destroy(); disposed = true; cancelAutosave(); cancelSaveNotice(); composing = false; documentEpoch++; editor?.destroy(); closeUnlisten?.(); quitRefusedUnlisten?.(); root.inert=false; window.removeEventListener('beforeunload', unload); if (zoomKeyHandler) document.removeEventListener('keydown', zoomKeyHandler, true); document.removeEventListener('mousemove', wake); statusQuiet.disconnect(); noticeResize?.disconnect(); if (statusTimer) clearTimeout(statusTimer); palette.close(); helpLayer?.remove(); root.classList.remove('studio', 'typing'); }
  };
}
