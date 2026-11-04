import {createReviewActivity} from './reviewActivity';
import {renderMarkdown} from './markdown';
import type { LocalCore, QuestionStatus, ReviewEdit, ReviewResult, ReviewRequest, ReviewerDefinition, CustomReviewer, ReviewCoverage, ReviewProgress, ProposalOutcome } from './localCore';
import { changedSpan, decisionLabel, invisibleChangeNote, lineageDelta, patchContext, waiting, type PatchContext } from './reviewComparison';
import type { ReviewMarkInput } from './reviewMarks';
import { formatKeys } from './shortcuts';
import type {CapturedLibraryScope} from './librarySnapshot';
import {createHeinleinHeader, setHeinleinStatus} from './heinleinHeader';
import './heinleinReview.css';
import { reviewerEditorForm, blankReviewer } from './reviewerEditor';
export interface ReviewScope {
    repositoryId: string;
    scope: 'scene' | 'chapter';
    snapshots: ReviewRequest['snapshots'];
    label: string;
    targetPaths?: string[];
    contextPaths?: string[];
    selectedRange?: {path: string; fromUtf8: number; toUtf8: number};
}
interface Hooks {
    rail?:boolean;
    closePane?():void;
    reviewChanged?(result:ReviewResult,scope:ReviewScope):void;
    capture(): ReviewScope | null;
    chapterLabel?(): string | null;
    captureChapter?(): Promise<ReviewScope>;
    unavailable(reviewing?: boolean): string | null;
    reviewProposal(id: string, guard: () => string | null): Promise<void>;
    openConnection(): void;
    focusEditor(): void;
    headerTabs?: HTMLElement;
    visibilityChanged?(visible: boolean): void;
    approveReview?(run: () => Promise<ProposalOutcome | null>, guard: () => string | null): Promise<ProposalOutcome | null>;
    announce?(text: string): void;
    jumpToEdit?(input: ReviewMarkInput, edit: ReviewEdit): Promise<boolean>;
    marksChanged?(input: ReviewMarkInput | null, report: (count: number | null) => void): void;
}
// Native catalog allows 50 saved custom agents plus two built-ins.
const MAX_REVIEWERS = 52;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const size = (n: number) => n < 1024 ? plural(n, 'byte') : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MiB`;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const clip = (s: string, n: number) => { const c = [...s]; return c.length > n ? `${c.slice(0, n - 1).join('')}…` : s; };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; }
function button(text: string, action: () => void, cls = '') { const n = el('button', text, cls); n.type = 'button'; n.onclick = action; return n; }
function icon(path: string, box = 14) { const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path'); svg.setAttribute('viewBox', `0 0 ${box} ${box}`); svg.setAttribute('width', String(box)); svg.setAttribute('height', String(box)); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); p.setAttribute('d', path); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.6'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); svg.append(p); return svg; }
function iconButton(label: string, path: string, action: () => void, cls: string, box = 14) { const n = button('', action, cls); n.setAttribute('aria-label', label); n.append(icon(path, box)); return n; }
function message(error: unknown) { return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'The review could not be completed. Retry when your connection is ready.'; }
function retryableCall(code: string | null) { return ['network', 'timeout', 'retryExhaustedNetwork', 'retryExhaustedTimeout', 'retryExhaustedProvider'].includes(code ?? ''); }
function callFailure(code: string | null) {
    const reasons: Record<string, string> = {retryExhaustedNetwork: 'Connection interrupted after three attempts. Successful chunks were kept.', retryExhaustedTimeout: 'The chunk timed out after three attempts. Successful chunks were kept.', retryExhaustedProvider: 'OpenAI remained unavailable after three attempts. Successful chunks were kept.', outputLimit: 'The model reached its response token limit before finishing the review.', timeout: 'The response timed out.', cancelled: 'The call was cancelled.', usageLimit: 'ChatGPT usage limit reached.', staleConnection: 'The ChatGPT account or model changed.', invalidReviewOrModel: 'The response did not match the selected model or review format.', incompleteReview: 'Consolidation needs all individual assessments to complete.', consolidationTooLarge: 'The individual assessments exceed the consolidation limit. Review a smaller scope; individual results are retained.', invalidResponse: 'The response could not be validated.', protocol: 'The response could not be validated.', findingLimit: 'The retained suggestion limit was reached.'};
    return reasons[code ?? ''] ?? 'The call did not return a valid review.';
}
/** Display-only trim of surrounding text so one diff reads as one line. The exact patch is in its details. */
function trimmed(before: string, after: string, limit: number) {
    let b = [...before], a = [...after], cutBefore = false, cutAfter = false;
    if (b.length > limit) { b = b.slice(-limit); const space = b.findIndex(c => /\s/.test(c)); if (space >= 0 && space < b.length - 1) b = b.slice(space + 1); cutBefore = true; }
    if (a.length > limit) { a = a.slice(0, limit); const space = a.map(c => /\s/.test(c)).lastIndexOf(true); if (space > 0) a = a.slice(0, space); cutAfter = true; }
    return {before: b.join(''), after: a.join(''), cutBefore, cutAfter};
}
export function createReviewPanel(core: LocalCore, hooks: Hooks) {
    const element = el('section', '', 'heinlein-review-panel');
    element.hidden = true;
    element.setAttribute('aria-label', 'Heinlein Review');
    if (hooks.headerTabs) {element.classList.add('heinlein-integrated'); element.setAttribute('role',hooks.rail?'region':'dialog'); if(!hooks.rail)element.setAttribute('aria-modal','true');}
    // Reuse the guarded card, rather than maintaining a second decision implementation.
    const suggestionDialog = el('dialog', '', 'review-suggestion-dialog');
    suggestionDialog.setAttribute('aria-label', 'Review suggestion');
    const dialogTitle = el('h2', 'Review suggestion');
    const dialogBody = el('div');
    const dialogClose = button('Close suggestion', () => closeSuggestion());
    const dialogNavigation = el('nav', '', 'review-suggestion-navigation');
    dialogNavigation.setAttribute('aria-label', 'Suggestion navigation');
    const dialogPrevious = button('Previous', () => navigateSuggestion(-1));
    const dialogNext = button('Next', () => navigateSuggestion(1));
    const dialogPosition = el('p', '', 'review-suggestion-position');
    dialogPosition.setAttribute('role', 'status');
    dialogPosition.setAttribute('aria-live', 'polite');
    dialogNavigation.append(dialogPrevious, dialogPosition, dialogNext);
    const dialogMessage = el('p', '', 'review-suggestion-message');
    dialogMessage.hidden = true;
    dialogMessage.setAttribute('aria-live', 'polite');
    suggestionDialog.append(dialogTitle, dialogClose, dialogNavigation, dialogBody, dialogMessage);
    let dialogCards: HTMLElement[] = [];
    let dialogIndex = -1;
    let dialogCard: HTMLElement | null = null;
    let dialogSlot: Comment | null = null;
    let dialogReturn: HTMLElement | null = null;
    let dialogSelection: Range | null = null;
    function restoreSuggestionCard() {
        if (!dialogCard) return;
        const card = dialogCard;
        dialogCard = null;
        card.querySelectorAll('h4').forEach(n => n.removeAttribute('aria-level'));
        dialogSlot?.replaceWith(card);
        dialogSlot = null;
        card.querySelectorAll<HTMLButtonElement>('button[data-edit-action="reject"]').forEach(n => { if (n.textContent === 'Reject') n.textContent = 'Keep mine'; });
    }
    function closeSuggestion() {
        if (!dialogCard && !suggestionDialog.open) return;
        restoreSuggestionCard();
        dialogCards = []; dialogIndex = -1;
        if (suggestionDialog.open) suggestionDialog.close();
        suggestionDialog.remove();
        if (dialogReturn?.isConnected && !dialogReturn.classList.contains('cm-content')) dialogReturn.focus({preventScroll: true});
        else hooks.focusEditor();
        if (dialogSelection?.startContainer.isConnected && dialogSelection.endContainer.isConnected) {
            const selection = document.getSelection();
            selection?.removeAllRanges(); selection?.addRange(dialogSelection);
        }
        if (dialogReturn?.isConnected && dialogReturn.hasAttribute('data-review-id')) dialogReturn.focus({preventScroll: true});
        dialogSelection = null;
        dialogReturn = null;
    }
    function showSuggestionCard(index: number) {
        restoreSuggestionCard();
        dialogIndex = index;
        const box = dialogCards[index];
        dialogSlot = document.createComment('suggestion card');
        box.before(dialogSlot);
        dialogCard = box;
        box.querySelectorAll('h4').forEach(n => n.setAttribute('aria-level', '3'));
        dialogBody.replaceChildren(box);
        box.querySelectorAll<HTMLButtonElement>('button[data-edit-action="reject"]').forEach(n => { if (n.textContent === 'Keep mine') n.textContent = 'Reject'; });
        dialogMessage.hidden = true;
        dialogPosition.textContent = `Suggestion ${index + 1} of ${dialogCards.length}`;
        dialogPrevious.disabled = busy || pending !== null || index === 0;
        dialogNext.disabled = busy || pending !== null || index === dialogCards.length - 1;
        update();
    }
    function navigateSuggestion(direction: 1 | -1) {
        const index = dialogIndex + direction;
        if (busy || pending || index < 0 || index >= dialogCards.length) return;
        const trigger = direction > 0 ? dialogNext : dialogPrevious;
        showSuggestionCard(index);
        // Keep keyboard focus on navigation; reaching an end focuses the remaining direction.
        (trigger.disabled ? direction > 0 ? dialogPrevious : dialogNext : trigger).focus({preventScroll: true});
    }
    const suggestionIds = (card: HTMLElement) => card.dataset.findingId ? [card.dataset.findingId] : [...card.querySelectorAll<HTMLElement>('[data-finding-id]')].map(node => node.dataset.findingId!);
    function pendingSuggestionCards() {
        const pendingEdits = result?.edits.filter(waiting) ?? [];
        const cardEdit = (card: HTMLElement) => pendingEdits.find(edit => suggestionIds(card).includes(edit.id));
        const sourceOrder = (path: string) => { const index = scope?.snapshots.findIndex(source => source.path === path) ?? -1; return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
        return [...edits.querySelectorAll<HTMLElement>('.review-card')].filter(card => cardEdit(card)).sort((a, b) => {
            const left = cardEdit(a)!, right = cardEdit(b)!;
            return sourceOrder(left.path) - sourceOrder(right.path) || left.path.localeCompare(right.path) || left.fromUtf8 - right.fromUtf8;
        });
    }
    function resumeSuggestion(preferredIds: string[], note?: string, warning = false, focusAccept = false) {
        if (!suggestionDialog.open) return false;
        restoreSuggestionCard();
        dialogCards = pendingSuggestionCards();
        if (dialogCards.length) {
            const index = preferredIds.map(id => dialogCards.findIndex(card => suggestionIds(card).includes(id))).find(index => index >= 0) ?? 0;
            showSuggestionCard(index);
            const target = focusAccept ? dialogCard?.querySelector<HTMLElement>('button[data-edit-action="accept"]:not(:disabled)') : null;
            (target ?? dialogCard?.querySelector<HTMLElement>('h4') ?? dialogClose).focus({preventScroll: true});
            dialogCard?.scrollIntoView?.({block: 'nearest'});
        } else {
            restoreSuggestionCard();
            dialogIndex = -1;
            dialogBody.replaceChildren(el('p', 'All suggestions decided. Close to return to your manuscript.'));
            dialogPosition.textContent = 'All suggestions decided';
            dialogPrevious.disabled = dialogNext.disabled = true;
            dialogClose.focus({preventScroll: true});
        }
        dialogMessage.textContent = note ?? '';
        dialogMessage.hidden = !note;
        dialogMessage.setAttribute('aria-live', warning ? 'assertive' : 'polite');
        if (note) say(note, warning ? 'warning' : 'note');
        return true;
    }
    suggestionDialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) closeSuggestion(); });
    let suspended = false;
    let scope: ReviewScope | null = null;
    let recaptureLibrary: (() => Promise<CapturedLibraryScope>) | null = null;
    let result: ReviewResult | null = null;
    let config: QuestionStatus | null = null;
    let generation = 0;
    let pending: string | null = null;
    let busy = false;
    let automaticRunning = false;
    let disposed = false;
    const background = createReviewActivity(() => show());
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const workflowMode = Boolean(core.reviewDefinitions && core.previewReview);
    let definitions: ReviewerDefinition[] = [];
    let customReviewers: CustomReviewer[] = [];
    let editing: CustomReviewer | null = null;
    let reviewerIds = ['contextual'];
    let selectedPaths = new Set<string>();
    let useSelection = false;
    let contextNote = '';
    let noteOpen = false;
    let preparedRequest: ReviewRequest | null = null;
    let coverage: ReviewCoverage[] = [];
    let editGeneration = 0;
    let savedRecords: ReviewResult[] = [];
    let shownReview: string | null = null;
    let historyOpen: boolean | null = null;
    // Results replace setup once a review is shown; "Start a new review" brings setup back without discarding it.
    let view: 'setup' | 'results' = 'setup';
    let libraryEntry: HTMLElement | null = null;
    const receipts = new Map<string, string>();
    const uid = Math.random().toString(36).slice(2, 8);

    // Header: the shared Heinlein header when this panel sits in the Heinlein pane; a minimal local row otherwise.
    const chip = el('button');
    chip.onclick = hooks.openConnection;
    const head = hooks.headerTabs ? createHeinleinHeader({tabs: hooks.headerTabs, status: chip, close: () => {tuck();hooks.closePane?.();}}) : el('header', '', 'heinlein-head');
    if (!hooks.headerTabs) head.append(el('h2', 'Heinlein'), iconButton('Close Heinlein', 'M3 3l8 8M11 3l-8 8', () => tuck(), 'heinlein-close'));
    const title = head.querySelector('h2')!;
    title.tabIndex = -1;
    // Results strip: a visible new-review action, progress, stepping and the overflow menu.
    const strip = el('div', '', 'review-strip');
    strip.hidden = true;
    const progressBox = el('div', '', 'review-progress-box'), progress = el('p', '', 'review-progress'), bar = el('div', '', 'review-bar'), barFill = el('div', '', 'review-bar-fill');
    bar.setAttribute('aria-hidden', 'true');
    bar.append(barFill);
    progressBox.append(progress, bar);
    const previous = iconButton('Previous suggestion', 'M8.5 3L4.5 7l4 4', () => step(-1), 'review-step');
    const next = iconButton('Next suggestion', 'M5.5 3l4 4-4 4', () => step(1), 'review-step');
    const counter = el('span', '', 'review-counter');
    const more = iconButton('More review actions', 'M3 7h.01M7 7h.01M11 7h.01', () => toggleMenu(), 'review-more');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-controls', `review-more-${uid}`);
    const stepper = el('div', '', 'review-stepper');
    stepper.append(previous, counter, next, more);
    strip.append(progressBox, stepper);

    // One live line for announcements and decision notes.
    const status = el('p', '', 'review-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    function say(text: string, kind: 'note' | 'warning' | '' = '') { status.textContent = text; status.className = `review-status${kind ? ' review-decision-note' : ''}${kind === 'warning' ? ' review-status-warning' : ''}`; }

    const activity = el('div', '', 'review-activity');
    activity.hidden = true;
    activity.tabIndex = -1;
    activity.setAttribute('role', 'group');
    activity.setAttribute('aria-label', 'Live review progress');
    const callProgress = el('progress');
    callProgress.setAttribute('aria-label', 'Review calls completed');
    const activityDetail = el('p');
    // Byte counts update visually; the existing polite status announces phase changes only.
    activityDetail.setAttribute('aria-live', 'off');
    activity.append(callProgress, activityDetail);
    let activityPhase = '';

    const body = el('div', '', 'review-body');

    // Overflow menu, in flow at the top of the body so enlarged text can still scroll it.
    const menu = el('section', '', 'review-more-menu');
    menu.id = `review-more-${uid}`;
    menu.setAttribute('aria-label', 'More review actions');
    menu.hidden = true;
    const refreshReview = button('Refresh review', () => { void refreshResult(); });
    const json = el('details', '', 'review-json');
    json.append(el('summary', 'Versioned review JSON'));
    const blob = el('pre', '', 'question-text');
    blob.tabIndex = 0;
    json.append(blob);
    const historyHost = el('div'), aboutHost = el('div');
    const markHelp = el('details', '', 'review-mark-help');
    markHelp.append(el('summary', 'How to read and open the marks'), el('p', `A solid underline is a change, a line through is a removal, a wavy underline is competing alternatives and a small bar is an insertion. Click one to open it here, or use ${formatKeys('⌘⌥]')} and ${formatKeys('⌘⌥[')} to move between them and ${formatKeys('⌘⌥O')} to open one. Marks never apply or choose anything.`));
    const startNew = button('Start a new review', () => { view = 'setup'; toggleMenu(false); update(); (firstSetupControl() ?? run).focus(); });
    const discard = button('Discard review', () => { clear(); hooks.focusEditor(); });
    strip.prepend(startNew);
    menu.append(refreshReview, json, historyHost, aboutHost, markHelp, discard);

    // Setup.
    const setupView = el('div', '', 'review-setup-view');
    const scopeSet = el('fieldset', '', 'review-scope');
    const scopeCards = el('div', '', 'review-scope-cards'), targets = el('div', '', 'review-targets');
    scopeSet.append(el('legend', 'What to review', 'review-label'), scopeCards, targets);
    const setup = el('div', '', 'review-setup');
    const send = el('div', '', 'review-send');
    const sendLine = el('div', '', 'review-send-line'), sendSummary = el('p', '', 'review-send-summary');
    const preview = el('details', '', 'review-preview');
    preview.append(el('summary', 'Preview text'));
    const sources = el('div', '', 'review-sources'), batchPreview = el('div', '', 'review-batch-preview');
    preview.append(batchPreview, sources);
    sendLine.append(sendSummary, preview);
    const sendNote = el('p', '', 'review-send-note'), limit = el('p', '', 'drafting-warning review-limit');
    limit.hidden = true;
    limit.setAttribute('aria-live', 'polite');
    send.append(sendLine, sendNote, limit);
    const saved = el('div', '', 'review-saved');
    const reload = button('Reload saved reviews', () => { void savedReviews(); }, 'review-reload');
    reload.hidden = !core.listReviews;
    const savedSection = el('section', '', 'review-saved-section');
    savedSection.setAttribute('aria-label', 'Earlier reviews');
    savedSection.hidden = true;
    savedSection.append(el('h3', 'Earlier reviews', 'review-label'), saved, reload);
    setupView.append(scopeSet, setup, send, savedSection);

    // Results.
    const resultsView = el('div', '', 'review-results');
    resultsView.hidden = true;
    const edits = el('div', '', 'review-edits');
    const continueBatch = button('Continue next reviewer batch', () => { void submit(true); });
    continueBatch.hidden = true;
    const continueNote = el('p', 'Continue sends the next selected calls to OpenAI through your selected account and model. Plan usage may count. Finish the remaining batches before applying suggestions; changed source needs a fresh review.', 'review-guidance');
    continueNote.hidden = true;
    const resultActions = el('div', '', 'review-result-actions');
    resultActions.append(continueNote, continueBatch);
    resultsView.append(edits, resultActions);
    body.append(menu, setupView, resultsView);

    // Footer, pinned: the one primary action and its context, or the marks legend.
    const footer = el('footer', '', 'review-footer');
    const connection = el('p', '', 'review-connection'), connectionText = el('span');
    const connect = button('Connect ChatGPT', hooks.openConnection, 'review-connect');
    connection.append(connectionText, connect);
    const run = button('Run review', () => { if (workflowMode && !preparedRequest) void prepareBatch(); else void submit(); }, 'review-run');
    const retry = button('Retry review', () => { void submit(); });
    retry.hidden = true;
    const cancel = button('Cancel review', () => { cancelRequest(); say('Review canceled locally. Already-sent text cannot be recalled and usage may count. Your manuscript was not changed.'); update(); });
    const footActions = el('div', '', 'review-foot-actions');
    footActions.append(run, retry, cancel);
    const advisory = el('p', 'Advisory. Nothing in your text changes until you accept a suggestion.', 'review-advisory');
    const markStatus = el('div', '', 'review-mark-status'), legend = el('p', '', 'review-legend'), markNote = el('p', '', 'review-mark-note');
    const swatch = (cls: string, text: string) => { const s = el('span', '', 'review-legend-item'); s.append(el('span', '', `review-swatch ${cls}`), document.createTextNode(text)); return s; };
    legend.append(swatch('review-swatch-change', 'change'), swatch('review-swatch-alt', 'alternatives'), el('kbd', `${formatKeys('⌘⌥]')} next`));
    markNote.hidden = true;
    markStatus.append(legend, markNote);
    markStatus.hidden = true;
    footer.append(connection, footActions, advisory, markStatus);
    element.append(head, strip, status, activity, body, footer);

    element.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!menu.hidden && (menu.contains(document.activeElement) || document.activeElement === more)) { toggleMenu(false); more.focus(); return; }
        if (hooks.headerTabs) {hide();hooks.closePane?.();} else clear();
        hooks.focusEditor();
    }
    if (hooks.headerTabs && !hooks.rail && event.key === 'Tab') {
      const controls=[...element.querySelectorAll<HTMLElement>('button,summary,input,select,textarea,[tabindex="0"]')].filter(n=>!n.closest('[hidden]')&&!n.matches(':disabled')&&n.getClientRects().length&&!n.closest('details:not([open]) :not(summary)'));
      if (event.shiftKey && document.activeElement===controls[0]) {event.preventDefault();controls.at(-1)?.focus();}
      else if (!event.shiftKey && document.activeElement===controls.at(-1)) {event.preventDefault();controls[0]?.focus();}
    } });
    function toggleMenu(open = menu.hidden) {
        menu.hidden = !open;
        more.setAttribute('aria-expanded', String(open));
        if (open) { body.scrollTop = 0; menu.querySelector<HTMLElement>('button:not(:disabled),summary')?.focus(); }
    }
    function firstSetupControl() { return [...setupView.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')].find(control => !control.closest('[hidden]') && !control.closest('details:not([open])')); }
    function live(token: number) { return !disposed && (!element.hidden || suspended) && token === generation; }
    function included() { return scope ? scope.snapshots.filter(s => !workflowMode || selectedPaths.has(s.path) || !scope!.contextPaths || scope!.contextPaths.includes(s.path)) : []; }
    function scopeProblem() {
        if (!scope)
            return 'Open an editable source file or a mapped assembled chapter.';
        if (workflowMode) {
            const total = scope.snapshots.reduce((n, s) => n + bytes(s.source), 0) + bytes(contextNote);
            if (!selectedPaths.size)
                return 'Choose at least one editable source. Unchecked sources are read-only context.';
            if (scope.contextPaths) {
                const contextBytes = scope.snapshots.filter(s => scope!.contextPaths!.includes(s.path)).reduce((n, s) => n + bytes(s.source), 0);
                const largestTarget = Math.max(0, ...scope.snapshots.filter(s => selectedPaths.has(s.path)).map(s => bytes(s.source)));
                if (contextBytes + largestTarget + bytes(contextNote) + 1000 > 16000)
                    return 'The complete context and target are too large for one request. Choose fewer or shorter sheets.';
            }
            if (total > 1024 * 1024 || scope.snapshots.length > 128 || bytes(contextNote) > 4000)
                return 'Choose at most 1 MiB of source and read-only context, plus at most 4,000 UTF-8 bytes of author notes within that scope. Nothing is truncated.';
            return null;
        }
        if (!scope.snapshots.length || scope.snapshots.length > 16 || scope.snapshots.reduce((n, s) => n + bytes(s.source), 0) > 16000)
            return 'This review exceeds 16 scenes or 16,000 UTF-8 bytes. Open a smaller source scene. Nothing was sent.';
        if (new Set(scope.snapshots.map(s => s.path)).size !== scope.snapshots.length)
            return 'This scope repeats a source scene. Open that source scene to review it.';
        return null;
    }
    function ready() { const c = config; if (!c)
        return false; const account = c.accounts.find(a => a.id === c.activeAccountId); return Boolean(c.configured && !c.usageLimited && !c.signInPending && account?.signedIn && account.planEnabled && c.model && c.model === c.selectedModel && c.models.some(m => m.slug === c.model) && Number.isSafeInteger(c.generation)); }
    function sendText() {
        if (!scope) return '';
        const shown = included(), editable = workflowMode ? shown.filter(s => selectedPaths.has(s.path)) : shown, context = shown.length - editable.length;
        const what = scope.contextPaths ? plural(editable.length, 'sheet') : scope.scope === 'scene' && shown.length === 1 ? '1 scene' : plural(editable.length, 'scene');
        const total = shown.reduce((n, s) => n + bytes(s.source), 0) + (workflowMode ? bytes(contextNote) : 0);
        const calls = !workflowMode ? '1 call' : preparedRequest ? `${plural(Math.min(8, coverage.length), 'call')}${coverage.length > 8 ? ` of ${coverage.length}` : ''}` : plural(reviewerIds.length, 'reviewer');
        return `Sends ${what}${context ? ` + ${context} context` : ''} · ${size(total)} · ${calls}`;
    }
    let sourceSignature = '';
    function update() {
        const scopeTab = hooks.headerTabs?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
        if (scopeTab) scopeTab.textContent = scope?.scope === 'chapter' ? 'Whole chapter' : 'Whole scene';
        const signature = scope && workflowMode ? JSON.stringify([...selectedPaths, '|', ...included().map(s => s.path)]) : '';
        if (scope && workflowMode && signature !== sourceSignature) {
            sourceSignature = signature;
            sources.replaceChildren();
            for (const snapshot of included()) {
                const roles = [scope.contextPaths?.includes(snapshot.path) || !selectedPaths.has(snapshot.path) ? 'context' : '', selectedPaths.has(snapshot.path) ? 'revision target' : ''].filter(Boolean).join(' and ');
                const text = el('pre', snapshot.source, 'question-text');
                text.tabIndex = 0;
                sources.append(el('h3', `${snapshot.path} · ${roles}`), text);
            }
        }
        const problem = scopeProblem();
        const showingResults = Boolean(result) && view === 'results';
        setupView.hidden = showingResults;
        resultsView.hidden = !showingResults;
        strip.hidden = !showingResults;
        if (!showingResults) toggleMenu(false);
        connection.hidden = showingResults || checking || ready() || !core.requestReview;
        connection.dataset.state = checking ? 'checking' : ready() ? 'ready' : 'problem';
        connectionText.textContent = config?.message ?? 'ChatGPT connection could not be checked.';
        if (hooks.headerTabs) setHeinleinStatus(chip, checking ? 'checking' : ready() ? 'ready' : 'attention', checking ? 'Checking connection' : ready() ? `Ready · ${config!.model}` : config?.usageLimited ? 'Usage limited' : 'Not connected');
        run.hidden = showingResults;
        advisory.hidden = showingResults;
        markStatus.hidden = !showingResults || markStatus.dataset.marked === undefined || !result!.edits.some(waiting);
        sendSummary.textContent = sendText();
        sendNote.textContent = `${ready() ? `To ChatGPT · ${config!.model}. ` : ''}Text captured now. Later typing isn’t added.`;
        limit.hidden = !problem || !scope;
        limit.textContent = problem ?? '';
        const previewing = workflowMode && !preparedRequest;
        run.textContent = previewing ? 'Preview review' : 'Run review';
        run.disabled = previewing ? Boolean(problem || pending || busy || automaticRunning || checking || !definitions.length) : Boolean(problem || pending || busy || automaticRunning || checking || !ready() || !core.requestReview);
        retry.disabled = Boolean(problem || pending || busy || automaticRunning || checking || !ready() || !core.requestReview || (workflowMode && !preparedRequest));
        const interruptedChunks = result?.workflow?.coverage.some(c => c.status === 'running' || c.status === 'cancelled');
        const failedChunks = result?.workflow?.coverage.some(c => c.status === 'failed' && retryableCall(c.error));
        continueBatch.textContent = failedChunks ? 'Retry failed chunks' : interruptedChunks ? 'Resume interrupted chunks' : 'Continue next reviewer batch';
        continueBatch.hidden = automaticRunning || !result?.workflow?.coverage.some(c => ((c.status === 'queued' || c.status === 'notRun') && c.error !== 'findingLimit') || c.status === 'running' || c.status === 'cancelled' || (c.status === 'failed' && retryableCall(c.error)));
        continueNote.textContent = failedChunks || interruptedChunks ? 'Retry sends only failed chunks and remaining calls, keeping completed results. Each chunk gets up to three attempts. Additional plan usage may count. Changed source requires a fresh review.' : 'Continue sends the next selected calls to OpenAI through your selected account and model. Plan usage may count. Finish the remaining batches before applying suggestions; changed source needs a fresh review.';
        continueNote.hidden = continueBatch.hidden;
        continueBatch.disabled = Boolean(pending || busy || checking || !ready());
        setupView.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(e => e.disabled = Boolean(pending || busy || automaticRunning) || e.dataset.full === 'true');
        refreshReview.hidden = !result || !core.getReview;
        refreshReview.disabled = Boolean(busy || pending);
        startNew.disabled = discard.disabled = Boolean(busy || pending || automaticRunning);
        cancel.hidden = !pending && !automaticRunning;
        keepWriting.hidden = !pending;
        activity.hidden = !pending || !workflowMode;
        connect.disabled = Boolean(pending || busy);
        const blocked = result?.edits.some(waiting) ? hooks.unavailable(false) : null;
        for (const host of [edits, dialogBody]) host.querySelectorAll<HTMLElement>('[data-blocked]').forEach(n => { n.textContent = blocked ?? ''; n.hidden = !blocked; });
        for (const host of [edits, dialogBody]) host.querySelectorAll<HTMLButtonElement>('button[data-edit-action]').forEach(n => { n.disabled = Boolean(busy || pending || (n.dataset.editAction === 'accept' && (blocked || n.dataset.unavailable === 'true'))); });
        for (const host of [edits, dialogBody]) host.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach(n => { n.disabled = Boolean(busy || pending); });
        for (const host of [edits, dialogBody]) host.querySelectorAll<HTMLElement>('[data-approve-reason]').forEach(n => { const why = n.dataset.approveReason ?? ''; n.textContent = why; n.hidden = !why; });
        dialogClose.disabled = Boolean(busy);
        dialogPrevious.disabled = Boolean(busy || pending || dialogIndex <= 0);
        dialogNext.disabled = Boolean(busy || pending || dialogIndex < 0 || dialogIndex >= dialogCards.length - 1);
        updateStrip();
        background.setVisible(!element.hidden && !element.classList.contains('review-tucked'));
    }
    function updateStrip() {
        const all = result?.edits ?? [];
        const decided = all.filter(e => !waiting(e)).length;
        progress.textContent = `${plural(all.length, 'suggestion')} · ${decided} decided`;
        barFill.style.width = `${all.length ? Math.round(decided / all.length * 100) : 0}%`;
        const cards = [...edits.querySelectorAll<HTMLElement>('.review-card')];
        const at = cards.findIndex(c => c.classList.contains('review-opened'));
        counter.textContent = cards.length ? `${at < 0 ? '–' : at + 1} / ${cards.length}` : '0 / 0';
        counter.setAttribute('aria-label', cards.length ? `${at < 0 ? 'No card opened' : `Card ${at + 1}`} of ${cards.length}` : 'No suggestions waiting');
        previous.disabled = next.disabled = !cards.length;
    }
    async function configure() { if (checking)
        return; const token = generation; checking = true; update(); try {
        let next = await core.questionStatus?.();
        if (live(token) && next && core.restoreQuestionConnection && !next.usageLimited && !next.signInPending
          && next.models.length === 0 && next.selectedModel
          && next.accounts.some(account => account.id === next!.activeAccountId && account.signedIn && account.planEnabled)) {
            next = await core.restoreQuestionConnection();
        }
        if (live(token))
            config = next ?? null;
    }
    catch {
        if (live(token))
            say('ChatGPT connection could not be checked. Choose Connect ChatGPT to retry.');
    }
    finally {
        if (live(token)) {
            checking = false;
            update();
        }
    } }
    function cancelRequest() { automaticRunning = false; const id = pending; if (id) background.cancel(id); pending = null; activity.hidden = true; clearTimeout(timer); generation++; checking = false; busy = false; if (id) {
        void core.cancelQuestion?.(id).catch(() => { });
        retry.hidden = false;
    } }
    function clear() { closeSuggestion(); suspended=false; cancelRequest(); background.clear(); element.hidden = true; hooks.visibilityChanged?.(false); element.classList.remove('review-tucked'); scope = null; recaptureLibrary = null; result = null; config = null; savedRecords = []; shownReview = null; historyOpen = null; view = 'setup'; receipts.clear(); publishMarks(); saved.replaceChildren(); savedSection.hidden = true; edits.replaceChildren(); historyHost.replaceChildren(); aboutHost.replaceChildren(); sources.replaceChildren(); sourceSignature = ''; batchPreview.replaceChildren(); blob.textContent = ''; say(''); toggleMenu(false); update(); }
    function untuck() {
        if (element.classList.contains('review-tucked')) {
            element.classList.remove('review-tucked');
            hooks.announce?.('');
        }
    }
    // Keeps the review and any running request while giving the whole window back to writing.
    function tuck() {
        if (hooks.headerTabs) {hide(); hooks.focusEditor(); return;}
        element.classList.add('review-tucked');
        background.setVisible(false);
        const count = result?.edits.filter(waiting).length ?? 0;
        hooks.announce?.(`Heinlein Review stays open${count ? ` with ${count} ${count === 1 ? 'suggestion' : 'suggestions'} waiting` : ''}. Choose Heinlein Review to come back.`);
        hooks.focusEditor();
    }
    function validate(value: ReviewResult, requestId?: string) {
        if (value?.readingFeedback !== undefined) {
            if (!Array.isArray(value.readingFeedback) || value.readingFeedback.length > 385 || value.readingFeedback.some(item =>
                !item || typeof item.path !== 'string' || typeof item.reviewer !== 'string' || !item.feedback
                || (item.feedback.assessment !== undefined && (!item.feedback.assessment || [item.feedback.assessment.strengths, item.feedback.assessment.improvements].some(text => typeof text !== 'string' || !text.trim() || bytes(text) > 2000)))
                || !Array.isArray(item.feedback.strengths) || !Array.isArray(item.feedback.improvements)
                || item.feedback.strengths.length > 32 || item.feedback.improvements.length > 32
                || [item.feedback.overview, ...item.feedback.strengths, ...item.feedback.improvements.map(point => typeof point === 'string' ? point : point?.text)].some(text => typeof text !== 'string' || !text.trim() || bytes(text) > 2000)))
                throw new Error('Invalid reading feedback. Reload the saved review.');
            for (const entry of value.readingFeedback) for (const point of entry.feedback.improvements) {
                if (typeof point === 'string') {
                    if (requestId) throw new Error('An improvement point contains invalid diff references. Run the review again.');
                    continue;
                }
                if (!point || !Array.isArray(point.editIds) || point.editIds.length > 32
                    || (point.evidence !== undefined && (typeof point.evidence !== 'string' || !point.evidence.trim() || bytes(point.evidence) > 2000))
                    || new Set(point.editIds).size !== point.editIds.length
                    || point.editIds.some(id => typeof id !== 'string' || !Array.isArray(value.edits) || !value.edits.some(edit => edit.id === id && edit.original !== edit.replacement)))
                    throw new Error('An improvement point contains invalid diff references. Run the review again.');
            }
        }
        if (value?.schemaVersion === 2) {
            if (!value.reviewId || !value.workflow || !Array.isArray(value.edits) || value.edits.length > 1024 || !Array.isArray(value.workflow.coverage) || value.workflow.coverage.length > 385 || (requestId && value.requestId !== requestId) || new Set(value.edits.map(e => e.id)).size !== value.edits.length)
                throw new Error('Invalid consolidated review. Reload the saved record.');
            for (const e of value.edits) {
                const source = value.workflow.sources.find(s => s.path === e.path && !s.readOnly);
                if (!source || !e.id || !Number.isSafeInteger(e.fromUtf8) || !Number.isSafeInteger(e.toUtf8) || e.fromUtf8 < 0 || e.toUtf8 < e.fromUtf8 || !['pending', 'prepared', 'accepted', 'rejected', 'supersededByAuthorChoice', 'blockedByAppliedDecision'].includes(e.status) || ![e.original, e.replacement, e.reason, e.patch].every(s => typeof s === 'string') || bytes(e.original) > 4000 || bytes(e.replacement) > 4000 || (e.fromUtf8 === e.toUtf8 && (!e.replacement || e.original)))
                    throw new Error('Invalid prepared review patch. It was ignored.');
            }
            return value;
        }
        if (!value || value.schemaVersion !== 1 || !value.reviewId || (requestId && value.requestId !== requestId) || value.scope !== scope?.scope || !Array.isArray(value.edits) || value.edits.length > 32 || new Set(value.edits.map(e => e.id)).size !== value.edits.length)
            throw new Error('The review response did not match this request. It was ignored.');
        const ranges = new Map<string, {
            from: number;
            to: number;
        }[]>();
        for (const edit of value.edits) {
            if (!edit.id || !scope?.snapshots.some(s => s.path === edit.path) || !['proofreader', 'editor'].includes(edit.role) || !['pending', 'prepared', 'accepted', 'rejected'].includes(edit.status) || ![edit.original, edit.replacement, edit.reason].every(s => typeof s === 'string') || !Number.isSafeInteger(edit.fromUtf8) || !Number.isSafeInteger(edit.toUtf8) || edit.fromUtf8 < 0 || edit.toUtf8 <= edit.fromUtf8)
                throw new Error('The review contained an invalid or out-of-scope edit. It was ignored.');
            const source = new TextEncoder().encode(scope!.snapshots.find(s => s.path === edit.path)!.source);
            let original: string;
            try {
                original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.slice(edit.fromUtf8, edit.toUtf8));
            }
            catch {
                throw new Error('The review split a source character. It was ignored.');
            }
            const prior = ranges.get(edit.path) ?? [];
            if (edit.toUtf8 > source.length || original !== edit.original || prior.some(r => edit.fromUtf8 < r.to && edit.toUtf8 > r.from))
                throw new Error('The review contained an invalid or overlapping target. It was ignored.');
            prior.push({ from: edit.fromUtf8, to: edit.toUtf8 });
            ranges.set(edit.path, prior);
        }
        return value;
    }
    function readingFeedback() {
        const section = el('section', '', 'review-reading-feedback');
        section.setAttribute('aria-label', 'Reading feedback');
        const entries = result?.readingFeedback ?? [];
        if (!entries.length) {
            section.append(el('h3', 'Reading overview'), el('p', 'Reading feedback is unavailable for this saved review. Start a new review to get an overview, strengths and any warranted improvements.', 'review-guidance'));
            return section;
        }
        const content = el('div');
        const render = (index: number) => {
            const entry = entries[index];
            content.replaceChildren(el('h3', entry.coverageId === 'consolidation' ? 'Consolidated review' : 'Reading overview'), el('p', entry.feedback.overview));
            if (entry.coverageId === 'consolidation') content.append(el('p', 'Combined assessment of all completed reviewer passes. Individual assessments remain available in Review assessment.', 'review-guidance'));
            else if (entries.length > 1) content.append(el('p', `${entry.path} · ${entry.reviewer}. This assessment covers this reviewer’s selected source or chunk.`, 'review-guidance'));
            for (const [title, marker, points, assessment] of [
                ['Strengths', '✅', entry.feedback.strengths, entry.feedback.assessment?.strengths],
                ['Points for improvement', '❌', entry.feedback.improvements, entry.feedback.assessment?.improvements],
            ] as const) {
                const list = el('ul', '', 'review-feedback-list');
                for (const point of points) {
                    const item = el('li'), emoji = el('span', marker, 'review-feedback-marker');
                    emoji.setAttribute('aria-hidden', 'true');
                    const content = el('div');
                    content.append(el('span', typeof point === 'string' ? point : point.text));
                    if (typeof point !== 'string' && point.evidence) content.append(el('p', `Evidence: ${point.evidence}`, 'review-guidance'));
                    if (typeof point !== 'string' && point.editIds.length) {
                        const links = el('div', '', 'review-improvement-diffs');
                        for (const id of point.editIds) {
                            const index = result!.edits.findIndex(edit => edit.id === id), edit = result!.edits[index];
                            if (!edit) continue;
                            if (!waiting(edit)) links.append(el('p', `Diff ${index + 1} · ${decisionLabel(edit.status)}`, 'review-guidance'));
                            else {
                                const link = button(`Jump to diff ${index + 1}: ${clip(edit.original, 45) || '(insertion)'} → ${clip(edit.replacement, 45) || '(removal)'}`, () => { void jumpToEdit(edit); }, 'review-improvement-jump');
                                link.disabled = Boolean(edit.sourceStale) || !hooks.jumpToEdit;
                                links.append(link);
                            }
                        }
                        content.append(links);
                    } else if (marker === '❌') content.append(el('p', 'Advice only · no text change proposed.', 'review-guidance'));
                    item.append(emoji, content); list.append(item);
                }
                content.append(el('h3', title));
                if (assessment) content.append(el('p', assessment));
                if (points.length) content.append(list);
                else if (!assessment) content.append(el('p', marker === '❌' ? 'No improvements suggested.' : 'No strengths listed.', 'review-guidance'));
            }
        };
        const consolidated = entries.findIndex(entry => entry.coverageId === 'consolidation');
        const workflow = result?.workflow;
        const contextual = entries.findIndex(entry => entry.coverageId && workflow?.coverage.some(call => call.id === entry.coverageId && workflow.definitions[call.reviewer]?.definition.id === 'contextual'));
        const initial = consolidated >= 0 ? consolidated : contextual >= 0 ? contextual : Math.max(0, entries.findIndex(entry => entry.feedback.assessment || entry.feedback.strengths.length || entry.feedback.improvements.length));
        if (entries.length > 1) {
            const label = el('label', 'Review assessment', 'review-feedback-picker'), select = el('select');
            entries.forEach((entry, index) => { const option = el('option', entry.coverageId === 'consolidation' ? 'Consolidated review · all reviewers' : `${entry.path} · ${entry.reviewer} · individual assessment ${index + 1}`); option.value = String(index); select.append(option); });
            select.value = String(initial);
            select.onchange = () => render(Number(select.value));
            label.append(select); section.append(label);
        }
        render(initial); section.append(content); return section;
    }
    async function jumpToEdit(edit: ReviewEdit) {
        if (!result || !scope || !hooks.jumpToEdit) return;
        const shown = result;
        try {
            const jumped = await hooks.jumpToEdit({repositoryId: scope.repositoryId, projectKey: shown.projectKey ?? null,
                edits: shown.edits, baselineHash: path => shown.workflow?.sources.find(s => s.path === path)?.sourceHash ?? scope?.snapshots.find(s => s.path === path)?.sourceHash}, edit);
            if (result !== shown || disposed) return;
            if (jumped) { tuck(); hooks.closePane?.(); hooks.focusEditor(); hooks.announce?.(`Jumped to suggestion in ${edit.path}.`); }
            else say('This suggestion could not be located in the current text. Open the matching saved source or refresh the review.', 'warning');
        } catch { if (result === shown) say('This suggestion could not be located in the current text. Refresh the review and try again.', 'warning'); }
    }
    function diffList() {
        const section = el('section', '', 'review-diff-list');
        section.setAttribute('aria-label', 'Diffs');
        section.append(el('h3', 'Diffs'));
        const pending = result!.edits.filter(waiting);
        if (!pending.length) section.append(el('p', result!.workflow?.coverage.some(call => call.status !== 'completed') ? 'No diffs retained yet.' : result!.edits.length ? 'No diffs awaiting your decision.' : 'No targeted edits suggested.', 'review-guidance'));
        else {
            section.append(el('p', 'Choose a diff to jump to that spot in your text.', 'review-guidance'));
            const list = el('ol');
            pending.forEach((edit, index) => {
                const item = el('li'), jump = button('', () => { void jumpToEdit(edit); }, 'review-diff-jump');
                jump.setAttribute('aria-description', clip(edit.reason, 160));
                jump.disabled = Boolean(edit.sourceStale) || !hooks.jumpToEdit;
                const preview = el('span', '', 'review-inline-diff'); preview.append(...inlineDiff(edit, contextFor(edit, hooks.capture()), 24).childNodes);
                jump.append(el('span', `Jump to diff ${index + 1}: ${meta(edit)}`, 'review-diff-location'), preview);
                item.append(jump); list.append(item);
            });
            section.append(list);
        }
        return section;
    }
    function renderSaved() {
        saved.replaceChildren();
        savedRecords = savedRecords.map(record => record.reviewId === result?.reviewId ? result : record);
        savedSection.hidden = !savedRecords.length;
        for (const record of savedRecords) {
            const list = Array.isArray(record.edits) ? record.edits : [];
            const names = [...new Set((record.workflow?.definitions ?? []).map(d => d.definition?.displayName).filter(Boolean))].join(', ');
            const paths = (record.workflow?.sources ?? []).filter(s => !s.readOnly).map(s => s.path).join(', ');
            // The accessible name stays the stable record name; the row shows what the author recognises.
            const reopen = button('', () => { void reopenSaved(record.reviewId); }, 'review-saved-item');
            reopen.setAttribute('aria-label', `Reopen saved review ${record.reviewId}`);
            reopen.append(el('span', [paths, names].filter(Boolean).join(' · ') || 'Saved review', 'review-saved-what'), el('span', `${list.filter(e => !waiting(e)).length} of ${list.length} decided`, 'review-saved-count'));
            if (record.reviewId === result?.reviewId) {
                reopen.setAttribute('aria-current', 'true');
                reopen.append(el('span', 'Open', 'review-chip'));
            }
            saved.append(reopen);
        }
    }
    // Context is display evidence, read from what is open now and shown only if the bytes still match.
    function contextFor(edit: ReviewEdit, current: ReviewScope | null): PatchContext | null {
        const snapshot = current?.snapshots.find(s => s.path === edit.path) ?? scope?.snapshots.find(s => s.path === edit.path);
        if (!snapshot)
            return null;
        const shift = lineageDelta(result?.edits ?? [], edit);
        return patchContext(snapshot.source, edit.fromUtf8 + shift, edit.toUtf8 + shift, edit.original);
    }
    /** One line of manuscript text: the removed words struck through, the added words highlighted. */
    function inlineDiff(edit: ReviewEdit, context: PatchContext | null, around: number) {
        const part = changedSpan(edit.original, edit.replacement);
        const near = trimmed((context?.before ?? '') + part.prefix, part.suffix + (context?.after ?? ''), around);
        const line = el('p', '', 'review-inline-diff');
        if (context?.cutBefore || near.cutBefore)
            line.append(el('span', '', 'review-cut'));
        line.append(near.before);
        if (part.removed)
            line.append(el('del', part.removed));
        if (part.added)
            line.append(el('ins', part.added));
        if (!part.removed && !part.added)
            line.append(el('span', '', 'review-point'));
        line.append(near.after);
        if (context?.cutAfter || near.cutAfter)
            line.append(el('span', '', 'review-cut'));
        return line;
    }
    function diffNotes(edit: ReviewEdit, context: PatchContext | null) {
        const nodes: HTMLElement[] = [];
        const note = invisibleChangeNote(edit.original, edit.replacement);
        if (note)
            nodes.push(el('p', note, 'review-guidance'));
        else if (!edit.original || !edit.replacement)
            nodes.push(el('p', edit.original ? 'Removal: this deletes the struck text and adds nothing.' : 'Insertion: this adds the highlighted text and removes nothing.', 'review-guidance'));
        if (!context)
            nodes.push(el('p', 'Surrounding text is not shown because the open source no longer matches this position. The exact patch is unchanged.', 'review-guidance'));
        return nodes;
    }
    const reviewers = (edit: ReviewEdit) => [...new Set((edit.provenance ?? []).map(p => p.displayName))].join(', ');
    function meta(edit: ReviewEdit) {
        if (result!.schemaVersion !== 2)
            return `${edit.role === 'proofreader' ? 'Proofreader' : 'Editor'} · ${edit.path}`;
        const many = (result!.workflow?.sources.filter(s => !s.readOnly).length ?? 1) > 1;
        return [many || !edit.location ? edit.path : '', edit.location ? `Line ${edit.location.line}` : '', reviewers(edit) || 'Reviewer'].filter(Boolean).join(' · ');
    }
    function technical(edit: ReviewEdit) {
        const details = el('details', '', 'review-technical');
        details.append(el('summary', 'Exact patch details'), el('p', `${edit.path}${edit.location ? ` · Captured line ${edit.location.line}, column ${edit.location.column}` : ''} · UTF-8 bytes ${edit.fromUtf8}–${edit.toUtf8}. Byte ranges remain authority.`));
        for (const p of edit.provenance ?? [])
            details.append(el('p', `${p.displayName} · ${p.instanceId} · definition v${p.definitionVersion} · ${p.model}`));
        if (edit.patchHash)
            details.append(el('p', `Patch SHA-256: ${edit.patchHash}`));
        if (edit.patch)
            details.append(el('code', edit.patch));
        return details;
    }
    function cardHead(item: HTMLElement, text: string, chip: string, warn = false) {
        const heading = el('h4', text);
        heading.tabIndex = -1;
        heading.id = `review-card-${uid}-${generation}-${edits.querySelectorAll('.review-card').length + 1}`;
        item.setAttribute('aria-labelledby', heading.id);
        const top = el('div', '', 'review-card-meta');
        top.append(heading, el('span', chip, `review-chip${warn ? ' review-chip-warning' : ''}`));
        item.append(top);
        return heading;
    }
    function decision(accept: HTMLButtonElement, reject: HTMLButtonElement, heading: HTMLElement, reason: string) {
        accept.className = 'review-approve';
        accept.dataset.editAction = 'accept';
        reject.dataset.editAction = 'reject';
        reject.className = 'review-keep';
        accept.setAttribute('aria-describedby', heading.id);
        reject.setAttribute('aria-describedby', heading.id);
        const controls = el('div', '', 'review-decision');
        controls.append(accept, reject);
        const why = el('p', '', 'review-why');
        why.dataset.approveReason = reason;
        why.hidden = true;
        return [controls, why];
    }
    function card(edit: ReviewEdit, current: ReviewScope | null) {
        const item = el('article', '', 'review-card review-edit');
        item.dataset.findingId = edit.id;
        const heading = cardHead(item, meta(edit), edit.sourceStale ? 'Source changed' : 'Waiting', Boolean(edit.sourceStale));
        const context = contextFor(edit, current);
        item.append(inlineDiff(edit, context, 60), ...diffNotes(edit, context));
        for (const comment of edit.comments ?? [edit.reason])
            item.append(renderMarkdown(comment));
        if (edit.sourceStale)
            item.append(el('p', 'This source changed outside the accepted review lineage. Request a fresh review for this source; other files remain available.', 'drafting-warning'));
        const accept = button('Accept…', () => { void act([edit.id], true); });
        accept.dataset.unavailable = String(Boolean(edit.sourceStale));
        item.append(...decision(accept, button('Keep mine', () => { void act([edit.id], false); }), heading, edit.sourceStale ? 'Accept is off because this source changed. You can still keep your text.' : ''));
        if (result!.schemaVersion === 2)
            item.append(technical(edit));
        return item;
    }
    /** Competing alternatives for one span: one card, one choice, one decision. Nothing is chosen for the author. */
    function groupCard(members: ReviewEdit[], current: ReviewScope | null) {
        const item = el('article', '', 'review-card review-conflict');
        item.tabIndex = -1;
        item.dataset.conflictGroup = members[0].conflictGroup ?? '';
        const names = [...new Set(members.map(reviewers).filter(Boolean))].join(', ');
        const heading = cardHead(item, meta({...members[0], provenance: members.flatMap(m => m.provenance ?? [])}).replace(/[^·]*$/, ` ${names || 'Reviewer'}`).trim(), `${members.length} alternatives`);
        const comments = members.map(m => (m.comments ?? [m.reason]).join('\n\n'));
        const shared = comments.every(c => c === comments[0]);
        if (shared)
            for (const comment of members[0].comments ?? [members[0].reason])
                item.append(renderMarkdown(comment));
        const choices = el('fieldset', '', 'review-alternatives');
        choices.append(el('legend', 'Choose a replacement', 'review-label'));
        for (const [index, edit] of members.entries()) {
            const row = el('div', '', 'review-edit review-alt');
            row.dataset.findingId = edit.id;
            const label = el('label', '', 'review-choice');
            const choose = el('input');
            choose.type = 'radio';
            choose.name = `review-conflict-${uid}-${edit.conflictGroup}`;
            choose.checked = Boolean(edit.selected);
            choose.addEventListener('change', () => { void chooseAlternative(edit.id); });
            const context = contextFor(edit, current);
            label.append(choose, inlineDiff(edit, context, 32));
            row.append(label, ...diffNotes(edit, context));
            if (!shared)
                for (const comment of edit.comments ?? [edit.reason])
                    row.append(renderMarkdown(comment));
            if (edit.sourceStale)
                row.append(el('p', 'This source changed. This alternative cannot be accepted.', 'drafting-warning'));
            if (result!.schemaVersion === 2)
                row.append(technical(edit));
            row.dataset.index = String(index);
            choices.append(row);
        }
        item.append(choices);
        const chosen = members.find(m => m.selected);
        const accept = button(chosen ? (chosen.replacement ? `Accept “${clip(chosen.replacement.trim() || chosen.replacement, 28)}”…` : 'Accept removal…') : 'Choose an alternative first', () => { if (chosen) void act([chosen.id], true); });
        accept.dataset.unavailable = String(!chosen || Boolean(chosen.sourceStale));
        item.append(...decision(accept, button('Keep mine', () => { void act(members.map(m => m.id), false); }), heading, chosen?.sourceStale ? 'Accept is off because this source changed. You can still keep your text.' : ''));
        return item;
    }
    function publishMarks() {
        const shown = result, within = scope;
        delete markStatus.dataset.marked;
        markNote.hidden = true;
        if (!shown || !within) {
            hooks.marksChanged?.(null, () => { });
            update();
            return;
        }
        const open = shown.edits.filter(waiting).length;
        hooks.marksChanged?.({ repositoryId: within.repositoryId, projectKey: shown.projectKey ?? null, edits: shown.edits, baselineHash: path => shown.workflow?.sources.find(s => s.path === path)?.sourceHash ?? within.snapshots.find(s => s.path === path)?.sourceHash }, marked => {
            if (result !== shown)
                return;
            if (marked === null) delete markStatus.dataset.marked; else markStatus.dataset.marked = String(marked);
            legend.hidden = !marked;
            markNote.hidden = marked === null || marked >= open;
            markNote.textContent = marked ? `${marked} of ${open} waiting ${open === 1 ? 'suggestion is' : 'suggestions are'} marked in the open text. The others belong to another file or no longer match.` : 'None of these suggestions is marked in the open text. They belong to another file, or the open text no longer matches this review.';
            update();
        });
    }
    function render(preserveSuggestion = false) {
        if (preserveSuggestion) restoreSuggestionCard(); else closeSuggestion();
        edits.replaceChildren();
        historyHost.replaceChildren();
        aboutHost.replaceChildren();
        blob.textContent = result ? JSON.stringify(result, null, 2) : '';
        if ((result?.reviewId ?? null) !== shownReview) {
            shownReview = result?.reviewId ?? null;
            historyOpen = null;
        }
        view = result ? 'results' : 'setup';
        if(result&&scope)hooks.reviewChanged?.(result,scope);
        renderSaved();
        publishMarks();
        if (!result)
            return;
        const heading = el('h3', result.edits.length ? 'Suggestions for your decision' : 'Review result', 'sr-only');
        heading.tabIndex = -1;
        heading.dataset.resultsHeading = 'true';
        const blocked = el('p', '', 'drafting-warning review-blocked');
        blocked.dataset.blocked = 'true';
        blocked.hidden = true;
        edits.append(heading, blocked, readingFeedback(), diffList());
        const incomplete = result.workflow && !result.workflow.coverage.every(c => c.status === 'completed');
        if (!result.edits.length && incomplete)
            edits.append(el('p', 'No suggestions have been retained from this incomplete review.', 'review-guidance'));
        const rejected = result.edits.filter(edit => edit.status === 'rejected').length;
        if (rejected && result.schemaVersion !== 2)
            edits.append(el('p', `${rejected} suggestion(s) dismissed. Rejected · local receipt retained.`, 'review-guidance'));
        const w = result.workflow;
        if (w && incomplete) {
            edits.append(el('p', 'This review is incomplete. Failed or interrupted calls are never automatically retried.', 'drafting-warning'));
            w.coverage.forEach((call, index) => {
                if (['failed', 'cancelled', 'running', 'interrupted'].includes(call.status)) {
                    const reviewer = w.definitions[call.reviewer]?.definition.displayName ?? 'Consolidation';
                    edits.append(el('p', `${reviewer} · chunk ${index + 1} of ${w.coverage.length}: ${call.status === 'running' || call.status === 'interrupted' ? 'This call was interrupted.' : callFailure(call.error)}`, 'drafting-warning'));
                }
            });
        }
        const listed = result.edits.filter(edit => result!.schemaVersion === 2 ? waiting(edit) : edit.status !== 'rejected');
        if (result.edits.length && !listed.length)
            edits.append(el('p', 'Every suggestion is decided. Your choices are recorded under More review actions.', 'review-guidance'));
        const current = hooks.capture();
        const groups = new Set<string>();
        for (const edit of listed) {
            const group = edit.conflictGroup;
            if (!group) {
                edits.append(edit.status === 'accepted' ? decidedCard(edit) : card(edit, current));
                continue;
            }
            if (groups.has(group))
                continue;
            groups.add(group);
            edits.append(groupCard(listed.filter(e => e.conflictGroup === group), current));
        }
        if (w) {
            const decided = result.edits.filter(e => !waiting(e));
            const history = el('details', '', 'review-history');
            history.append(el('summary', `Review decisions and history (${decided.length})`));
            history.open = historyOpen ?? false;
            history.addEventListener('toggle', () => { if (history.isConnected)
                historyOpen = history.open; });
            if (!decided.length)
                history.append(el('p', 'No decisions recorded yet.'));
            for (const item of decided) {
                const entry = el('article', '', 'review-history-item');
                entry.append(el('h4', decisionLabel(item.status)), el('p', `${item.path}${item.location ? ` · Captured line ${item.location.line}, column ${item.location.column}` : ''}`, 'review-where'));
                for (const comment of item.comments ?? [item.reason])
                    entry.append(renderMarkdown(comment));
                entry.append(el('h5', 'Text before this suggestion'), el('pre', item.original, 'question-text'), el('h5', 'Suggested text'), el('pre', item.replacement, 'question-text'));
                if (item.status === 'accepted')
                    entry.append(el('p', `${receipts.has(item.id) ? `Local receipt ${receipts.get(item.id)}. ` : ''}Open Proposed revisions to see receipts and any available guarded revert.`, 'review-guidance'));
                if (item.status === 'rejected')
                    entry.append(el('p', 'Your source was not changed by this suggestion.', 'review-guidance'));
                if (item.status === 'supersededByAuthorChoice') {
                    const winner = result.edits.find(e => e.status === 'accepted' && e.conflictGroup && e.conflictGroup === item.conflictGroup);
                    if (winner)
                        entry.append(el('p', `Your approved alternative: ${winner.replacement}`, 'review-guidance'));
                }
                if (item.status === 'blockedByAppliedDecision')
                    entry.append(el('p', 'Request a fresh review if you still want this suggestion considered.', 'review-guidance'));
                history.append(entry);
            }
            historyHost.append(history);
        }
        const about = el('details', '', 'review-about');
        about.append(el('summary', 'About this review'), el('p', `OpenAI · ${result.model} · Request ${result.requestId}. Recorded provider metadata is not authenticated authorship.`));
        if (w) {
            const counts = new Map<string, number>();
            for (const c of w.coverage)
                counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
            about.append(el('p', w.contextNotice), el('p', `Coverage: ${[...counts].map(([s, n]) => `${n} ${s}`).join(', ')}. ${w.coverage.every(c => c.status === 'completed') ? 'All selected calls completed.' : 'This review is incomplete.'}`));
        }
        aboutHost.append(about);
        update();
    }
    // Schema 1 keeps accepted edits listed (they are not dismissed), shown as decided rather than actionable.
    function decidedCard(edit: ReviewEdit) {
        const item = el('article', '', 'review-card review-edit review-decided');
        item.dataset.findingId = edit.id;
        cardHead(item, meta(edit), decisionLabel(edit.status));
        item.append(inlineDiff(edit, null, 60));
        for (const comment of edit.comments ?? [edit.reason])
            item.append(renderMarkdown(comment));
        item.append(el('p', 'Accepted · local receipt retained. Guarded undo is available in Proposed revisions.', 'review-guidance'));
        return item;
    }
    function focusCard(index: number, note?: string, warning = false) {
        const rows = [...edits.querySelectorAll<HTMLElement>('.review-edit')];
        const item = rows[Math.min(index, rows.length - 1)];
        const box = item?.closest<HTMLElement>('.review-card');
        const heading = edits.querySelector<HTMLElement>('[data-results-heading]');
        const target = box?.querySelector<HTMLElement>('button[data-edit-action="accept"]:not(:disabled)') ?? item?.querySelector<HTMLElement>('input[type=radio]:not(:disabled)') ?? box?.querySelector<HTMLElement>('input[type=radio]:not(:disabled)') ?? box?.querySelector<HTMLElement>('h4') ?? heading ?? title;
        if (note)
            say(note, warning ? 'warning' : 'note');
        if (element.hidden) { hooks.focusEditor(); return; }
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: 'nearest' });
    }
    function openCard(box: HTMLElement) {
        edits.querySelectorAll('.review-opened').forEach(n => n.classList.remove('review-opened'));
        box.classList.add('review-opened');
        const group = box.classList.contains('review-conflict');
        const target = group ? box : box.querySelector<HTMLElement>('h4') ?? box;
        target.tabIndex = -1;
        say(group ? 'Opened the competing suggestions for this text. Nothing is chosen.' : `Opened ${box.querySelector('h4')?.textContent ?? 'this suggestion'}.`);
        updateStrip();
        target.focus({ preventScroll: true });
        box.scrollIntoView?.({ block: 'start' });
    }
    // The same opening the in-text marks use: it shows a card and never applies, rejects or chooses.
    function step(direction: 1 | -1) {
        const cards = [...edits.querySelectorAll<HTMLElement>('.review-card')];
        if (!cards.length) return;
        const at = cards.findIndex(c => c.classList.contains('review-opened'));
        openCard(cards[at < 0 ? (direction > 0 ? 0 : cards.length - 1) : (at + direction + cards.length) % cards.length]);
    }
    function returnToInlineSuggestions() {
        if (!hooks.rail || !hooks.closePane || element.hidden) return;
        hide();
        hooks.closePane();
        hooks.announce?.(`Review complete. Chats closed. ${plural(result?.edits.filter(waiting).length ?? 0, 'suggestion')} ready in the manuscript. Reopen Chats for the review assessment.`);
    }
    async function submit(continuing = false) {
        if (pending || busy || (!continuing && scopeProblem()) || !ready() || !scope || !core.requestReview)
            return;
        if (!globalThis.crypto?.randomUUID) {
            say('A secure request identifier is unavailable. Reopen Studio.');
            return;
        }
        const token = generation;
        if (!continuing && recaptureLibrary) {
            busy = true; update();
            try {
                const current = await recaptureLibrary();
                if (!live(token)) return;
                if (JSON.stringify(current.ordered) !== JSON.stringify(scope.snapshots)) {
                    say('A selected source changed. Close this review and prepare it again before sending.');
                    preparedRequest = null; return;
                }
            } catch (error) { if (live(token)) say(message(error), 'warning'); return; }
            finally { if (live(token)) { busy = false; update(); } }
        }
        const requestId = crypto.randomUUID();
        const oldResult = result;
        const request: ReviewRequest = workflowMode ? { ...preparedRequest!, requestId } : { requestId, repositoryId: scope.repositoryId, scope: scope.scope, snapshots: scope.snapshots.map(s => ({ ...s })) };
        if (workflowMode && !continuing && !preparedRequest)
            return;
        let completedSuccessfully = false;
        pending = requestId;
        background.start(requestId, scope.label, workflowMode ? coverage.length || null : 1);
        activityPhase = '';
        activityDetail.textContent = 'Preparing the selected review calls…';
        callProgress.removeAttribute('value');
        if (!continuing)
            result = null;
        render();
        retry.hidden = true;
        say(workflowMode ? 'Your selected reviewers are reviewing this captured scope. You can keep writing.' : 'Proofreader and editor are reviewing this snapshot. You can keep writing.');
        update();
        if (workflowMode) {
            activity.focus({preventScroll: true});
            activity.scrollIntoView?.({block: 'nearest'});
        }
        timer = setTimeout(() => { if (!live(token) || pending !== requestId)
            return; background.finish(requestId, 'attention', 'Review timed out. Open the review to retry; your text was not changed.'); cancelRequest(); say('Review timed out locally. Usage may count. Retry when ready; your manuscript was not changed.'); update(); }, workflowMode ? 8 * (3 * 185000 + 1000) + 5000 : 185000);
        try {
            const connection = { generation: config!.generation, accountId: config!.activeAccountId!, model: config!.model! };
            const onProgress = (event: ReviewProgress) => {
                if (!live(token) || pending !== requestId || event.requestId !== requestId || !scope || !event.totalCalls ||
                    ![event.completedCalls, event.totalCalls, event.reviewer, event.sourceIndex, event.chunkIndex, event.receivedBytes, event.suggestions].every(n => Number.isSafeInteger(n) && n >= 0) ||
                    event.completedCalls > event.totalCalls || event.chunkIndex < 1 || event.chunkIndex > event.totalCalls ||
                    !['running', 'receiving', 'completed', 'failed', 'cancelled'].includes(event.status)) return;
                const reviewerId = (continuing ? oldResult?.workflow?.definitions.map(d => d.definition.id) : preparedRequest?.workflow?.reviewers)?.[event.reviewer];
                const reviewer = definitions.find(d => d.id === reviewerId)?.displayName ?? 'Consolidation';
                const phase = event.status === 'running' ? 'waiting for response' : event.status === 'receiving' ? 'receiving response' : event.status === 'completed' ? 'call completed' : event.status === 'cancelled' ? 'call cancelled' : 'call failed';
                const detail = `${reviewer} · chunk ${event.chunkIndex} of ${event.totalCalls} · ${phase}${event.status === 'receiving' ? ` · ${size(event.receivedBytes)} received` : ''}. ${event.completedCalls} of ${event.totalCalls} calls completed · ${plural(event.suggestions, 'suggestion')} retained.`;
                background.progress(requestId, event.completedCalls, event.totalCalls);
                callProgress.max = event.totalCalls;
                callProgress.value = event.completedCalls;
                activityDetail.textContent = detail;
                const key = `${event.chunkIndex}:${event.status}`;
                if (key !== activityPhase) {
                    activityPhase = key;
                    say(`${reviewer} · chunk ${event.chunkIndex} of ${event.totalCalls} · ${phase}. ${event.completedCalls} of ${event.totalCalls} calls completed.`);
                }
            };
            const answer = continuing && oldResult && core.continueReview ? await core.continueReview(scope.repositoryId, oldResult.reviewId, requestId, connection, onProgress) : await core.requestReview(request, connection, onProgress);
            if (!live(token) || pending !== requestId)
                return;
            result = validate(answer, requestId);
            completedSuccessfully = !result.workflow || result.workflow.coverage.every(call => call.status === 'completed');
            const completed = result.workflow?.coverage.filter(c => c.status === 'completed').length;
            const total = result.workflow?.coverage.length;
            if (completed !== undefined && completed !== total)
                say(`Review incomplete. ${completed} of ${total} calls completed. ${plural(result.edits.filter(waiting).length, 'suggestion')} retained. Check the call details below.`, 'warning');
            else say(`Review ready. ${plural(result.edits.filter(waiting).length, 'suggestion')} to decide, one at a time.`);
            background.finish(requestId, completed !== undefined && completed !== total ? 'attention' : 'complete',
                completed !== undefined && completed !== total ? `Review incomplete. ${completed} of ${total} calls completed.` : `Review complete. ${plural(result.edits.filter(waiting).length, 'suggestion')} ready.`);
            render();
            // Earlier reviews comes from the host's saved records, so the new one appears there too.
            if (workflowMode)
                void savedReviews();
            return result;
        }
        catch (error) {
            if (live(token)) {
                background.finish(requestId, 'attention', 'Review could not be completed.');
                say(message(error), 'warning');
                retry.hidden = false;
            }
        }
        finally {
            if (live(token)) {
                clearTimeout(timer);
                pending = null;
                update();
                if (completedSuccessfully && !automaticRunning) returnToInlineSuggestions();
            }
        }
    }
    async function refreshResult() {
        if (!result || !scope || busy || pending || !core.getReview)
            return;
        const token = generation;
        const repositoryId = scope.repositoryId;
        const reviewId = result.reviewId;
        busy = true;
        update();
        try {
            const next = await core.getReview(repositoryId, reviewId);
            if (live(token)) {
                result = validate(next);
                render();
                say('Review decisions refreshed from the native host.');
            }
        }
        catch (error) {
            if (live(token))
                say(message(error), 'warning');
        }
        finally {
            if (live(token)) {
                busy = false;
                update();
            }
        }
    }
    async function act(editIds: string[], accept: boolean) {
        if (busy || pending || !result || !scope || !editIds.length)
            return;
        const modalDecision = suggestionDialog.open;
        const preferredIds = modalDecision ? [...dialogCards.slice(dialogIndex), ...dialogCards.slice(0, dialogIndex)].flatMap(suggestionIds) : [];
        const token = generation;
        const repositoryId = scope.repositoryId;
        const reviewId = result.reviewId;
        const editId = editIds[0];
        const guard = () => !live(token) ? 'Review scope changed. Start a new review.' : hooks.unavailable(true);
        const position = Math.max(0, [...edits.querySelectorAll<HTMLElement>('.review-edit')].findIndex(n => n.dataset.findingId === editId));
        let outcome: ProposalOutcome | null = null;
        let note: string | undefined;
        let failed = false;
        busy = true;
        update();
        try {
            if (accept) {
                const problem = hooks.unavailable(false);
                if (problem)
                    throw new Error(problem);
                if (result.schemaVersion === 2) {
                    if (!core.approveReviewEdit || !core.getReview)
                        throw new Error('Native review approval is unavailable.');
                    const run = () => core.approveReviewEdit!(repositoryId, reviewId, editId);
                    outcome = hooks.approveReview ? await hooks.approveReview(run, guard) : await run();
                    if (outcome?.receipt)
                        receipts.set(editId, outcome.receipt.id);
                    if (!live(token))
                        return;
                    result = validate(await core.getReview(repositoryId, reviewId));
                }
                else {
                    if (!core.prepareReviewEdit || !core.getReview)
                        throw new Error('Review acceptance is unavailable in this native host.');
                    const proposal = await core.prepareReviewEdit(repositoryId, reviewId, editId);
                    if (!live(token))
                        return;
                    const stale = guard();
                    if (stale)
                        throw new Error(stale);
                    await hooks.reviewProposal(proposal.proposalId, guard);
                    if (!live(token))
                        return;
                    const next = await core.getReview(repositoryId, reviewId);
                    if (!live(token))
                        return;
                    result = validate(next);
                }
            }
            else {
                if (!core.rejectReviewEdit)
                    throw new Error('Review rejection is unavailable in this native host.');
                // Keep mine on competing alternatives records each one as rejected, one durable call at a time.
                for (const id of editIds) {
                    if (result.edits.find(e => e.id === id && !waiting(e)))
                        continue;
                    const next = await core.rejectReviewEdit(repositoryId, reviewId, id);
                    if (!live(token))
                        return;
                    result = validate(next);
                }
            }
            if (live(token)) {
                render(modalDecision && suggestionDialog.open);
                const after = result.edits.find(e => e.id === editId);
                const replaced = result.edits.filter(e => e.status === 'supersededByAuthorChoice' && after?.conflictGroup && e.conflictGroup === after.conflictGroup).length;
                note = !accept ? `Kept your text. Your manuscript was not changed.${editIds.length > 1 ? ` ${editIds.length} alternatives were dismissed.` : ''} Other suggestions are unchanged.`
                    : after?.status === 'accepted' ? `Applied to ${after.path} after your confirmation.${receipts.has(editId) ? ` Local receipt ${receipts.get(editId)}.` : ''}${replaced ? ` ${replaced} competing ${replaced === 1 ? 'alternative was' : 'alternatives were'} dismissed.` : ''} Other suggestions are unchanged.`
                    : 'Not applied. This suggestion is still waiting for your decision, and your manuscript was not changed by it.';
                if (outcome?.warning)
                    note += ` ${outcome.warning}`;
                failed = Boolean(outcome?.warning);
            }
        }
        catch (error) {
            if (live(token)) {
                render(modalDecision && suggestionDialog.open);
                note = message(error);
                failed = true;
            }
        }
        finally {
            if (live(token)) {
                busy = false;
                update();
                if (!modalDecision || !resumeSuggestion(preferredIds, note, failed)) focusCard(position, note, failed);
            }
        }
    }
    function invalidatePreview() { editGeneration++; preparedRequest = null; coverage = []; batchPreview.replaceChildren(); update(); }
    function scopeCards_() {
        scopeCards.replaceChildren();
        targets.replaceChildren();
        if (!scope) return;
        const many = scope.snapshots.length > 1;
        const editable = scope.snapshots.filter(s => !workflowMode || selectedPaths.has(s.path));
        const words = plural(editable.reduce((n, s) => n + wordCount(s.source), 0), 'word');
        const name = scope.contextPaths ? 'Selected sheets' : scope.scope === 'chapter' ? 'This chapter' : 'This scene';
        const detail = scope.contextPaths ? `${plural(editable.length, 'sheet')} to edit · ${words}` : `${scope.scope === 'chapter' ? 'Mapped chapter' : 'Source file'} · ${scope.label} · ${words}`;
        const option = (heading: string, sub: string, checked: boolean, choose: (() => void) | null) => {
            const text = el('span', '', 'review-scope-text');
            text.append(el('span', heading, 'review-scope-name'), el('span', sub, 'review-scope-detail'));
            if (!choose) { const card = el('div', '', 'review-scope-card review-scope-only'); card.append(text); return card; }
            const label = el('label', '', 'review-scope-card');
            const radio = el('input');
            radio.type = 'radio';
            radio.name = `review-scope-${uid}`;
            radio.checked = checked;
            radio.onchange = () => { if (radio.checked) choose(); };
            label.append(radio, text);
            return label;
        };
        const range = workflowMode ? scope.selectedRange : undefined;
        if (range) {
            scopeCards.append(option(name, detail, !useSelection, () => { useSelection = false; invalidatePreview(); }));
            scopeCards.append(option('Selection only', `Rest of ${scope.contextPaths ? 'the sheet' : 'the scene'} sent as read-only context`, useSelection, () => { useSelection = true; invalidatePreview(); }));
        }
        else
            scopeCards.append(option(name, detail, true, null));
        const chapterLabel = hooks.chapterLabel?.();
        if (scope.scope === 'scene' && chapterLabel && hooks.captureChapter) {
            const chapter = button('', () => { void captureChapter(); }, 'review-scope-card review-scope-more');
            const text = el('span', '', 'review-scope-text');
            text.append(el('span', 'Entire chapter…', 'review-scope-name'), el('span', `${chapterLabel} · Review every source scene for targeted edits`, 'review-scope-detail'));
            chapter.append(text);
            chapter.disabled = busy || Boolean(pending);
            scopeCards.append(chapter);
        }
        if (workflowMode && (scope.scope === 'chapter' || (chapterLabel && hooks.captureChapter))) {
            const quick = button('Review chapter', () => { void reviewChapter(); }, 'review-scope-card primary');
            quick.title = 'Runs mechanical, story/clarity, and all saved custom agents, then consolidation. Sends this chapter to your selected ChatGPT account and model.';
            quick.disabled = busy || Boolean(pending) || automaticRunning;
            scopeCards.append(quick);
        }
        if (libraryEntry)
            scopeCards.append(libraryEntry);
        if (!workflowMode || !many)
            return;
        targets.append(el('p', scope.contextPaths ? 'Unchecked sheets stay read-only context.' : 'Unchecked scenes are sent as read-only context.', 'review-scope-detail'));
        for (const snapshot of scope.snapshots) {
            const label = el('label', '', 'review-target');
            const check = el('input');
            check.type = 'checkbox';
            check.checked = selectedPaths.has(snapshot.path);
            check.onchange = () => { if (scope?.targetPaths) useSelection = false; if (check.checked)
                selectedPaths.add(snapshot.path);
            else
                selectedPaths.delete(snapshot.path); invalidatePreview(); scopeCards_(); [...targets.querySelectorAll<HTMLInputElement>('input[data-path]')].find(n => n.dataset.path === snapshot.path)?.focus(); };
            check.dataset.path = snapshot.path;
            const unchecked = scope.contextPaths && !scope.contextPaths.includes(snapshot.path) ? 'excluded if unchecked' : 'context if unchecked';
            label.append(check, el('span', `Suggest edits in ${snapshot.path}`), el('span', ` · ${unchecked}`, 'review-scope-detail'));
            targets.append(label);
        }
    }
    async function captureChapter() {
        if (!hooks.captureChapter || busy || pending) return;
        const token = generation;
        busy = true;
        scopeCards_(); update(); say('Capturing chapter source scenes…');
        try {
            const captured = await hooks.captureChapter();
            if (!live(token)) return;
            scope = {...captured, snapshots: captured.snapshots.map(s => ({...s}))};
            selectedPaths = new Set(scope.snapshots.map(s => s.path));
            useSelection = false;
            recaptureLibrary = null;
            invalidatePreview();
            if (!workflowMode) {
                sources.replaceChildren();
                for (const snapshot of scope.snapshots) {
                    const text = el('pre', snapshot.source, 'question-text'); text.tabIndex = 0;
                    sources.append(el('h3', snapshot.path), text);
                }
            }
            say('Entire chapter captured. Review the source preview, then explicitly send for targeted edits.');
        } catch (error) {
            if (live(token)) say(message(error), 'warning');
        } finally {
            if (live(token)) {busy = false; scopeCards_(); update(); firstSetupControl()?.focus();}
        }
    }
    async function reloadReviewers(selectId?: string) {
        const token = generation;
        const custom = await core.listCustomReviewers?.() ?? [];
        const values = await core.reviewDefinitions!();
        if (!live(token))
            return;
        definitions = values;
        customReviewers = custom;
        reviewerIds = reviewerIds.filter(id => definitions.some(d => d.id === id));
        if (selectId && !reviewerIds.includes(selectId) && reviewerIds.length < MAX_REVIEWERS)
            reviewerIds = definitions.map(d => d.id).filter(id => id === selectId || reviewerIds.includes(id));
        if (!reviewerIds.length)
            reviewerIds = [definitions[0]?.id ?? ''];
        invalidatePreview();
    }
    function settings() {
        setup.replaceChildren();
        if (!workflowMode) return;
        const set = el('fieldset', '', 'review-reviewers');
        set.append(el('legend', 'Reviewers', 'review-label'));
        const chips = el('div', '', 'review-chips');
        for (const d of definitions) {
            const on = reviewerIds.includes(d.id);
            const chip = button('', () => {
                if (on && reviewerIds.length === 1) { say('Keep at least one reviewer.'); return; }
                reviewerIds = on ? reviewerIds.filter(id => id !== d.id) : definitions.map(x => x.id).filter(id => id === d.id || reviewerIds.includes(id));
                invalidatePreview(); settings(); update();
                [...setup.querySelectorAll<HTMLElement>('[data-reviewer]')].find(n => n.dataset.reviewer === d.id)?.focus();
            }, 'review-chip-toggle');
            chip.dataset.reviewer = d.id;
            chip.setAttribute('aria-pressed', String(on));
            chip.title = `${d.displayName} · version ${d.version}`;
            if (on) chip.append(icon('M3 7.5l2.5 2.5L11 4.5'));
            chip.append(document.createTextNode(d.displayName));
            if (!on && reviewerIds.length >= MAX_REVIEWERS) chip.dataset.full = 'true';
            chips.append(chip);
            const custom = customReviewers.find(c => c.id === d.id);
            if (custom && core.saveCustomReviewer) chips.append(iconButton(`Edit ${d.displayName}`, 'M2 12l1-3.5L9.5 2l2.5 2.5L5.5 11 2 12z', () => { editing = {...custom}; settings(); setup.querySelector<HTMLElement>('.review-agent-name')?.focus(); }, 'review-chip-edit'));
        }
        if (core.saveCustomReviewer && !editing) chips.append(button('+ New reviewer', () => { editing = blankReviewer(); settings(); setup.querySelector<HTMLElement>('.review-agent-name')?.focus(); }, 'review-chip-toggle review-chip-new'));
        set.append(chips);
        if (editing) set.append(reviewerEditorForm(core, editing, {
            saved: async saved => { await reloadReviewers(saved.id); editing = null; settings(); update(); },
            deleted: async () => { await reloadReviewers(); editing = null; settings(); update(); },
            cancel: () => { editing = null; settings(); update(); },
        }));
        if (definitions.length > 1) set.append(el('p', `Choose 1 to ${MAX_REVIEWERS}. Each reviewer is a separate advisory pass.`, 'review-scope-detail'));
        const noteToggle = button(noteOpen ? '− Note for reviewers' : '+ Note for reviewers', () => { noteOpen = !noteOpen; settings(); update(); (noteOpen ? setup.querySelector<HTMLElement>('textarea') : setup.querySelector<HTMLElement>('.review-note-toggle'))?.focus(); }, 'review-note-toggle');
        noteToggle.setAttribute('aria-expanded', String(noteOpen));
        set.append(noteToggle);
        if (noteOpen) {
            const label = el('label', 'Note for reviewers · read-only context, not edited', 'review-note');
            const area = el('textarea');
            area.value = contextNote;
            area.oninput = () => { contextNote = area.value; invalidatePreview(); };
            label.append(area);
            set.append(label);
        }
        setup.append(set);
    }
    async function configureWorkflow() { const token = generation; try {
        // Listing reloads saved custom definitions in the native host before reading its catalog.
        const custom = await core.listCustomReviewers?.() ?? [];
        const values = await core.reviewDefinitions!();
        if (!live(token))
            return false;
        definitions = values;
        customReviewers = custom;
        if (!definitions.some(d => d.id === reviewerIds[0]))
            reviewerIds = [definitions[0]?.id ?? ''];
        settings();
        await savedReviews();
        return true;
    }
    catch (error) {
        if (live(token))
            say('Reviewers could not be loaded. Close and reopen Whole scene to retry. If this continues, check for a Heinlein Studio update.', 'warning');
        return false;
    }
    finally {
        if (live(token))
            update();
    } }
    async function prepareBatch() {
        if (busy || pending || scopeProblem() || !scope || !core.previewReview)
            return;
        const token = generation, inputs = editGeneration;
        const ranges = useSelection && scope.selectedRange && selectedPaths.size === 1 && selectedPaths.has(scope.selectedRange.path) ? [scope.selectedRange] : [];
        const contextPaths = scope.contextPaths;
        const context = scope.snapshots.filter(s => !selectedPaths.has(s.path) && (!contextPaths || contextPaths.includes(s.path))).map(s => ({ ...s }));
        const includedPaths = new Set([...selectedPaths, ...context.map(s => s.path)]);
        const fullContextOrder = scope.contextPaths?.filter(path => includedPaths.has(path));
        const request: ReviewRequest = { requestId: crypto.randomUUID(), repositoryId: scope.repositoryId, scope: scope.scope, snapshots: scope.snapshots.filter(s => selectedPaths.has(s.path)).map(s => ({ ...s })), workflow: { consolidate: true, reviewers: [...reviewerIds], context, contextNote, ranges, ...(fullContextOrder ? {fullContextOrder} : {}) } };
        busy = true;
        update();
        try {
            const next = await core.previewReview(request);
            if (!live(token) || inputs !== editGeneration)
                return;
            preparedRequest = request;
            coverage = next;
            batchPreview.replaceChildren(el('h3', 'Exact batch preview'), el('p', `${reviewerIds.length} reviewer(s), ${new Set(next.filter(c => c.id !== 'consolidation').map(c => `${c.sourceIndex}:${c.fromUtf8}:${c.toUtf8}`)).size} editable chunks, ${next.length} selected calls including one final consolidation pass. This batch runs at most ${Math.min(8, next.length)} chunks. Interrupted chunks retry up to two times; additional plan usage may count.${automaticRunning ? ' Review chapter continues all remaining batches automatically.' : ' Remaining calls need Continue.'}`), el('p', fullContextOrder ? 'Each target call includes the complete selected context in library order.' : 'Each call has bounded neighboring context and the selected read-only context, not the whole work at once.'), el('p', 'Sent to OpenAI with your selected ChatGPT account and model. Plan usage may count.'));
            if (fullContextOrder) for (const path of fullContextOrder) { const snapshot = scope.snapshots.find(item => item.path === path)!; batchPreview.append(el('p', `Context: ${path} · ${bytes(snapshot.source).toLocaleString()} UTF-8 bytes`)); }
            const details = el('details');
            details.append(el('summary', 'Reviewer definitions and chunk coverage'));
            for (const id of reviewerIds) {
                const d = definitions.find(d => d.id === id)!;
                details.append(el('h4', `${d.displayName} · ${d.id} · v${d.version}`), el('p', d.instructions));
            }
            for (const c of next)
                details.append(el('p', `Reviewer ${c.reviewer + 1}: ${request.snapshots[c.sourceIndex]?.path}, editable UTF-8 bytes ${c.fromUtf8}–${c.toUtf8}; read-only neighbors ${c.windowFrom}–${c.windowTo}.`));
            for (const c of next)
                for (const range of c.contextRanges ?? [])
                    details.append(el('p', `Reviewer ${c.reviewer + 1}: read-only context ${request.workflow!.context[range.sourceIndex]?.path}, UTF-8 bytes ${range.fromUtf8}–${range.toUtf8}.`));
            batchPreview.append(details);
            preview.open = true;
            say(automaticRunning ? 'Running all chapter reviewers, including saved custom agents, then consolidation. Remaining batches continue automatically.' : `Ready to send ${plural(Math.min(8, next.length), 'call')}. Check the batch and text below, then choose Run review.`);
        }
        catch (error) {
            if (live(token))
                say(message(error), 'warning');
        }
        finally {
            if (live(token)) {
                busy = false;
                update();
            }
        }
    }
    async function savedReviews() { if (!core.listReviews || !scope)
        return; const token = generation; try {
        const records = await core.listReviews(scope.repositoryId);
        if (!live(token))
            return;
        savedRecords = records;
        renderSaved();
        update();
    }
    catch (error) {
        if (live(token))
            say(message(error), 'warning');
    } }
    async function reopenSaved(id: string) { if (busy || pending || !scope || !core.getReview)
        return; const token = generation; busy = true; update(); try {
        const next = await core.getReview(scope.repositoryId, id);
        if (live(token)) {
            result = validate(next);
            render();
            say('Saved review reopened without running reviewers.');
            title.focus();
        }
    }
    catch (error) {
        if (live(token))
            say(message(error), 'warning');
    }
    finally {
        if (live(token)) {
            busy = false;
            update();
        }
    } }
    async function chooseAlternative(id: string) { if (busy || pending || !scope || !result || !core.chooseReviewEdit)
        return; const modalChoice = suggestionDialog.open; const token = generation; const position = Math.max(0, [...edits.querySelectorAll<HTMLElement>('.review-edit')].findIndex(n => n.dataset.findingId === id)); let chosen: string | undefined; let failed = false; busy = true; update(); try {
        const next = await core.chooseReviewEdit(scope.repositoryId, result.reviewId, id);
        if (live(token)) {
            result = validate(next);
            render(modalChoice && suggestionDialog.open);
            chosen = 'Alternative selected, not applied. Accept it to apply it and dismiss the competing alternatives.';
        }
    }
    catch (error) {
        if (live(token)) { chosen = message(error); failed = true; }
    }
    finally {
        if (live(token)) {
            busy = false;
            update();
            if (!modalChoice || !resumeSuggestion([id], chosen, failed, !failed)) focusCard(position, chosen, failed);
        }
    } }
    function openScope(override?: ReviewScope, recapture?: () => Promise<CapturedLibraryScope>, automatic = false) {
            if (disposed)
                return;
            if (!element.hidden) {
                untuck();
                update();
                title.focus();
                return;
            }
            const captured = override ?? hooks.capture();
            scope = captured ? { ...captured, snapshots: captured.snapshots.map(s => ({ ...s })) } : null;
            recaptureLibrary = recapture ?? null;
            selectedPaths = new Set(scope?.targetPaths ?? scope?.snapshots.map(s => s.path) ?? []);
            useSelection = Boolean(scope?.selectedRange);
            preparedRequest = null;
            reviewerIds = ['contextual'];
            contextNote = '';
            noteOpen = false;
            coverage = [];
            view = 'setup';
            batchPreview.replaceChildren();
            savedRecords = [];
            renderSaved();
            suspended=false; element.hidden = false; hooks.visibilityChanged?.(true);
            retry.hidden = true;
            say('');
            sources.replaceChildren();
            sourceSignature = '';
            preview.open = false;
            if (!workflowMode)
                scope?.snapshots.forEach(s => { const text = el('pre', s.source, 'question-text'); text.tabIndex = 0; sources.append(el('h3', s.path), text); });
            if (!core.requestReview)
                say('Heinlein Review is unavailable in this native host.', 'warning');
            scopeCards_();
            settings();
            if (workflowMode && !automatic)
                void configureWorkflow();
            update();
            if (!automatic) void configure();
            title.focus({ preventScroll: true });
        }
    async function reviewChapter() {
        if (disposed || pending || busy || automaticRunning) { show(); return; }
        clear();
        // Avoid independent setup requests racing this single automatic run.
        openScope(undefined, undefined, true);
        automaticRunning = true;
        let completedSuccessfully = false;
        const token = generation;
        update();
        try {
            if (scope?.scope !== 'chapter') await captureChapter();
            if (!live(token)) return;
            if (scope?.scope !== 'chapter') { say('Open a chapter before running Review chapter. Nothing was sent.', 'warning'); return; }
            const [loaded] = await Promise.all([configureWorkflow(), configure()]);
            if (!live(token) || !loaded) return;
            if (!workflowMode || !core.continueReview) {
                say('Review chapter is unavailable in this native host. Update Heinlein Studio.', 'warning'); return;
            }
            if (!ready()) {
                say('Connect ChatGPT with a selected model to run Review chapter.', 'warning');
                return;
            }
            const allReviewers = [...new Set(['mechanical', 'contextual', ...customReviewers.map(r => r.id)])];
            if (allReviewers.some(id => !definitions.some(d => d.id === id))) {
                say('Chapter reviewers could not be loaded. Nothing was sent.', 'warning'); return;
            }
            reviewerIds = allReviewers;
            settings();
            if (scopeProblem()) { say(scopeProblem()!, 'warning'); return; }
            await prepareBatch();
            if (!live(token) || !preparedRequest) return;
            let answer = await submit();
            // Native dispatch already retries transient chunk failures up to three attempts.
            // Stop after exhaustion; explicit continuation can retry failed chunks.
            while (live(token) && answer?.workflow) {
                const calls = answer.workflow.coverage;
                if (calls.some(c => c.status === 'failed' || c.status === 'cancelled' || c.error)) break;
                const remaining = calls.filter(c => c.status !== 'completed');
                if (!remaining.length) break;
                const completed = calls.length - remaining.length;
                if (!remaining.every(c => c.status === 'queued' || c.status === 'notRun')) break;
                answer = await submit(true);
                if (!answer || !live(token)) return;
                if ((answer.workflow?.coverage.filter(c => c.status === 'completed').length ?? 0) <= completed) {
                    say('Chapter review stopped because the next batch made no progress. Completed passes are saved.', 'warning');
                    return;
                }
            }
            if (!live(token) || !answer) return;
            if (answer.workflow?.coverage.some(c => c.id === 'consolidation' && c.status === 'completed') &&
                answer.readingFeedback?.some(entry => entry.coverageId === 'consolidation')) {
                completedSuccessfully = answer.workflow.coverage.every(call => call.status === 'completed');
                if (!hooks.rail) {
                    show();
                    const feedback = edits.querySelector<HTMLElement>('.review-reading-feedback');
                    if (feedback) { feedback.tabIndex = -1; feedback.focus(); feedback.scrollIntoView?.({block: 'start'}); }
                }
                say('Chapter review complete. Consolidated feedback is open. Choose Review assessment for individual passes.');
            } else {
                say('Chapter review incomplete. Completed passes are saved. Check the call details before continuing.', 'warning');
            }
        } catch (error) {
            if (live(token)) say(message(error), 'warning');
        } finally {
            if (live(token)) { automaticRunning = false; update(); if (completedSuccessfully) returnToInlineSuggestions(); }
        }
    }
    function hide() { closeSuggestion(); suspended=Boolean(scope); element.hidden=true; toggleMenu(false); hooks.visibilityChanged?.(false); background.setVisible(false); }
    function show() { if (scope && element.hidden && !disposed) {suspended=false; element.hidden=false; element.classList.remove('review-tucked'); hooks.visibilityChanged?.(true); update(); if (!pending && !ready()) void configure(); title.focus({preventScroll:true});} else openScope(); }
    const keepWriting = button('Keep writing', () => { hide();hooks.closePane?.(); hooks.focusEditor(); });
    keepWriting.className = 'review-keep-writing';
    footActions.prepend(keepWriting);
    const outside = (event: PointerEvent) => {
        if (hooks.headerTabs && pending && !element.hidden && event.target instanceof Node && !element.contains(event.target)) { hide(); hooks.closePane?.(); hooks.focusEditor(); }
    };
    document.addEventListener('pointerdown', outside, true);
    return { element, async openSaved(id:string) { if(pending||busy){show();return;} if(!scope)openScope();if(!scope)return;show();await reopenSaved(id); }, activityElement: background.element, reviewChapter, show, hide,
        documentChanged() { if (pending || result) hide(); else clear(); }, visible:()=>!element.hidden&&!element.classList.contains('review-tucked'), open: () => openScope(), librarySupported: workflowMode, openLibrary: (captured: ReviewScope, recapture: () => Promise<CapturedLibraryScope>) => { if (pending) { show(); say('A review is already running. Wait for it or cancel it before starting another.'); return; } if (workflowMode) { clear(); openScope(captured, recapture); } }, clear, stateChanged: update,
        /** Places the host's library picker entry among the scope choices. Its own handler and guards stay with the host. */
        adoptLibraryEntry(node: HTMLElement) {
            libraryEntry = node;
            node.classList.add('review-scope-card', 'review-scope-more');
            const text = el('span', '', 'review-scope-text');
            text.append(el('span', 'Several sheets…', 'review-scope-name'), el('span', 'Pick from the library; unchecked sheets are context', 'review-scope-detail'));
            node.replaceChildren(text);
            scopeCards_();
        },
        // Only shows the card. It never applies, rejects or chooses, and a competing group stays unchosen.
        openSuggestion(id: string) {
            if (disposed || !result) return false;
            closeSuggestion();
            const item = [...edits.querySelectorAll<HTMLElement>('.review-edit')].find(n => n.dataset.findingId === id);
            const box = item?.closest<HTMLElement>('.review-card');
            if (!box) return false;
            dialogReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const selection = document.getSelection();
            dialogSelection = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
            dialogCards = pendingSuggestionCards();
            const index = dialogCards.indexOf(box);
            if (index < 0) return false;
            showSuggestionCard(index);
            document.body.append(suggestionDialog);
            suggestionDialog.showModal();
            dialogClose.focus({preventScroll: true});
            return true;
        },
        marksInvalidated() {
            if (result && result.edits.some(waiting)) {
                markStatus.dataset.marked = '0';
                legend.hidden = true;
                markNote.hidden = false;
                markNote.textContent = 'Highlights are off because the open text changed. Save your text, then choose Refresh review under More review actions to show the ones that still match.';
                update();
            }
        }, destroy() { clear(); disposed = true; document.removeEventListener('pointerdown', outside, true); background.destroy(); element.remove(); } };
}
