import {captureSelectionQuestion, selectionQuestionAvailability, selectionQuestionProblem, type SelectionQuestionSnapshot, type SelectionQuestionState} from './selectionQuestion';
import {createQuestionComparison} from './questionDiff';
import type {ProposalReview} from './localCore';
import type {LocalCore, QuestionRevisionAnswer, QuestionAnswer, QuestionConnection, QuestionMessage, QuestionRequest, QuestionStatus} from './localCore';

/** These are UTF-8 byte limits, shared with the native provider boundary. */
export const QUESTION_LIMITS = Object.freeze({question: 4000, context: 16000, input: 32000, history: 8, answer: 32000, memory: 64000});
export const questionBytes = (text: string) => new TextEncoder().encode(text).length;
export interface QuestionScene {
  repositoryId: string; path: string; source: string; from: number; to: number;
  canCapture: boolean;
}
export interface PassageItem {id: string; from: number; to: number; label: string; active: boolean; stale: boolean}
export interface QuestionPanelHooks {
  passages?: {select(from: number, to: number): void; changed(items: PassageItem[]): void};
  current(): QuestionScene | null;
  focusEditor(): void;
  selectionState?(reviewing?: boolean): SelectionQuestionState | null;
  revisionUnavailable?(reviewing?: boolean): string | null;
  prepareRevision?(snapshot: SelectionQuestionSnapshot): Promise<void>;
  reviewRevision?(proposalId: string, snapshot: SelectionQuestionSnapshot, guard: () => string | null, presenter?: (view: ProposalReview) => Promise<boolean>): Promise<void>;
  visibilityChanged?(open: boolean): void;
  /** Integrated pane only: tabs shown beside the heading, and a manual copy/paste prompt. */
  headerTabs?: HTMLElement;
  copyPrompt?(): void;
}
interface Revision {snapshot: SelectionQuestionSnapshot; contextVersion: number; proposalId: string; replacementText: string; rejected: boolean; busy: boolean}
interface Turn { question: string; answer: QuestionAnswer; contextBytes: number; savedContext?: string; revision?: Revision }
function plainUnicode(text: string) {
  return new TextDecoder('utf-8', {ignoreBOM: true}).decode(new TextEncoder().encode(text)) === text;
}
export function questionProblem(question: string, context: string): string | null {
  if (!question.trim()) return 'Write a question before sending.';
  if (questionBytes(question) > QUESTION_LIMITS.question) return `The question exceeds ${QUESTION_LIMITS.question.toLocaleString()} UTF-8 bytes. Shorten it before sending.`;
  if (questionBytes(context) > QUESTION_LIMITS.context) return 'The context is too large. Capture a shorter selection.';
  if (!plainUnicode(question) || !plainUnicode(context)) return 'The question or context contains an incomplete Unicode character.';
  return null;
}
/** Only complete, recent turns are included; never silently trim a message. */
export function questionHistory(messages: QuestionMessage[], availableBytes: number): QuestionMessage[] {
  const result: QuestionMessage[] = []; let bytes = 0;
  for (let end = messages.length; end >= 2 && result.length < QUESTION_LIMITS.history; end -= 2) {
    const pair = messages.slice(end - 2, end);
    const size = pair.reduce((sum, message) => sum + questionBytes(message.text), 0);
    if (pair[0].role !== 'user' || pair[1].role !== 'assistant' || bytes + size > availableBytes) break;
    result.unshift(...pair.map(message => ({...message}))); bytes += size;
  }
  return result;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function button(label: string, action: () => void, className = '') {
  const node = el('button', label, className); node.type = 'button'; node.addEventListener('click', action); return node;
}
function preview(text: string, label: string) {
  const node = el('pre', text, 'question-text'); node.tabIndex = 0; node.setAttribute('aria-label', label); return node;
}
function errorMessage(error: unknown): string {
  // Native errors are sanitized and never contain response bodies or credentials.
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    const detail = error as {diagnostic?: unknown; httpStatus?: unknown; providerRequestId?: unknown};
    const labels: Record<string, string> = {contentType: 'HTTP content type', streamFraming: 'stream framing', eventJson: 'event JSON', terminalStatus: 'terminal status', responseSchema: 'response schema', answerContent: 'answer content'};
    const parts: string[] = [];
    if (typeof detail.diagnostic === 'string' && Object.hasOwn(labels, detail.diagnostic)) parts.push(labels[detail.diagnostic]);
    if (typeof detail.httpStatus === 'number' && Number.isInteger(detail.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599) parts.push(`HTTP ${detail.httpStatus}`);
    if (typeof detail.providerRequestId === 'string' && /^req_[a-zA-Z0-9_-]{1,124}$/.test(detail.providerRequestId)) parts.push(detail.providerRequestId);
    return error.message + (parts.length ? ` Details: ${parts.join(' · ')}.` : '');
  }
  return 'The request failed. Check your OpenAI connection and try again. Nothing was retried automatically.';
}
export function createQuestionPanel(core: LocalCore, hooks: QuestionPanelHooks) {
  const integrated = Boolean(hooks.passages);
  const element: HTMLElement = el(integrated ? 'div' : 'aside', '', 'question-panel'); element.hidden = true;
  element.setAttribute('aria-label', 'Drafting questions');
  if (integrated) element.classList.add('question-panel-integrated');
  let disposed = false; let session: string | null = null; let version = 0; let statusVersion = 0;
  let configuration: QuestionStatus | null = null; let checking = false;
  let authBusy: 'connect' | 'account' | 'model' | 'signout' | null = null;
  let seenConnection: string | null = null; let seenChatIdentity: string | null = null;
  let selectedAccountId: string | null = null; let reauthorizing = false; let addingAccount = false;
  let context = ''; let contextLabel = 'None. No manuscript text will be sent.';
  let defaultContext = true;
  let contextVersion = 0; let preparing = false;
  let target: SelectionQuestionState | null = null;
  const revisionActions: (() => void)[] = [];
  const durable = Boolean(core.listChatThreads && core.createChatThread && core.readChatThread);
  let chatId: string | null = null; let chatVersion = 0; let chatBusy = false; let chatError = false;
  let chatRepository: string | null = null;
  let turns: Turn[] = []; let forgotten = 0; let pending: QuestionRequest | null = null; let pendingRevision = false;
  interface Passage {id: string; scene: QuestionScene; binding: SelectionQuestionState | null; turns: Turn[]; context: string; contextLabel: string; contextVersion: number; target: SelectionQuestionState | null; mode: string; draft: string; chatId: string | null; title: string; status: string; stale: boolean}
  const passages: Passage[] = []; let passageId = 0; let activePassage: Passage | null = null; let sessionPath: string | null = null;
  let notifying = false; let fullReviewCancel: (() => void) | null = null;
  const passagePicker = el('details', '', 'question-passage-picker'); passagePicker.hidden = !integrated;
  const passageSummary = el('summary', 'Passages'); const passageButtons = el('div', '', 'question-passage-list'); passagePicker.append(passageSummary, passageButtons);
  const fullReview = el('section', '', 'question-full-review'); fullReview.hidden = true; fullReview.setAttribute('aria-label', 'Review whole-scene revision');
  const header = el('div', '', 'question-heading');
  const currentTitle = el('p', durable ? 'New chat' : 'Current conversation', 'question-current-title');
  const closeButton = button(integrated ? 'Collapse' : 'Close questions', () => integrated ? collapse() : close(true));
  const savedChats = button('Saved chats', () => { threadControls.hidden = !threadControls.hidden; savedChats.setAttribute('aria-expanded', String(!threadControls.hidden)); if (!threadControls.hidden) {if (integrated && !threadSelect.childElementCount) void refreshChats(false); threadSelect.focus();} }); savedChats.hidden = !durable; savedChats.setAttribute('aria-expanded', 'false');
  const threadLabel = el('label', 'Saved chat thread'); const threadSelect = el('select'); threadSelect.setAttribute('aria-label', 'Saved chat thread'); threadLabel.append(threadSelect);
  const threadNote = el('p', '', 'muted'); threadNote.setAttribute('role', 'status');
  const chatAttempts = el('section'); chatAttempts.setAttribute('aria-label', 'Unanswered saved messages');
  const threadControls = el('section', '', 'question-thread-controls'); threadControls.setAttribute('aria-label', 'Repository chat threads'); threadControls.hidden = true;
  const reloadChats = button('Reload chats', () => { void refreshChats(false); });
  threadControls.append(threadLabel, reloadChats, threadNote);
  threadSelect.addEventListener('change', () => {
    if (!live() || pending || preparing) return;
    if (!threadSelect.value) { resetContents(); update(); threadNote.textContent = 'New chat. Your first message creates a repository thread.'; return; }
    void loadChat(threadSelect.value, true);
  });
  const connection = el('p', '', 'question-connection'); connection.setAttribute('role', 'status');
  const refresh = button('Recheck OpenAI setup', () => { void checkStatus(true); });
  const auth = el('details', '', 'question-auth'); auth.setAttribute('aria-label', 'ChatGPT connection');
  auth.append(el('summary', 'Connection settings'));
  const consentLabel = el('label', '', 'question-consent'); const consent = el('input'); consent.type = 'checkbox';
  consent.setAttribute('aria-label', 'Allow Heinlein to use my ChatGPT plan');
  consentLabel.append(consent, document.createTextNode(' Allow Heinlein to use my ChatGPT plan allowance for questions.'));
  const connect = button('Continue with ChatGPT', () => {
    if (!consent.checked || !core.connectQuestionAccount) return;
    if (!selectedAccountId && !addingAccount && configuration?.accounts.length) return;
    const accountId = selectedAccountId;
    void changeConnection('connect', () => core.connectQuestionAccount!({allowChatgptPlan: true, ...(accountId ? {accountId} : {})}), 'Complete sign-in and plan-use consent in your browser. You can keep drafting here.');
  });
  const addAccount = button('Add ChatGPT account', () => {
    if (!live() || checking || authBusy || configuration?.signInPending) return;
    resetContents(true); selectedAccountId = null; reauthorizing = true; addingAccount = true; consent.checked = false; accounts.value = '';
    status.textContent = 'New account selected. Allow plan use, then Continue with ChatGPT to add it.'; connection.textContent = status.textContent; update();
  });
  const cancelSignIn = button('Cancel connection', () => {void cancelConnection();}); cancelSignIn.hidden = true;
  const accountLabel = el('label', 'ChatGPT account'); const accounts = el('select'); accounts.setAttribute('aria-label', 'ChatGPT account'); accountLabel.append(accounts);
  const modelLabel = el('label', 'Question model'); const models = el('select'); models.setAttribute('aria-label', 'Question model'); modelLabel.append(models);
  const signOut = button('Sign out of selected account', () => {
    const accountId = selectedAccountId;
    if (accountId && core.signOutQuestionAccount) void changeConnection('signout', () => core.signOutQuestionAccount!(accountId), 'Signing out of the selected ChatGPT account…');
  });
  const usage = button('Manage ChatGPT usage', () => {
    if (!live() || !core.openQuestionUsage || !core.available()) return;
    const epoch = statusVersion;
    void core.openQuestionUsage().catch(() => {if (live() && statusVersion === epoch) status.textContent = 'The native host could not open ChatGPT usage settings.';});
  });
  accounts.addEventListener('change', () => {
    const accountId = accounts.value;
    if (!live() || checking || authBusy || configuration?.signInPending) return;
    if (!accountId) {resetContents(true); selectedAccountId = null; reauthorizing = true; addingAccount = false; consent.checked = false; status.textContent = 'Choose a saved account or Add ChatGPT account before connecting.'; update(); return;}
    const account = configuration?.accounts.find(value => value.id === accountId);
    if (account && (!account.signedIn || !account.planEnabled)) {
      resetContents(true); selectedAccountId = account.id; reauthorizing = true; addingAccount = false; consent.checked = false;
      status.textContent = `${account.label} needs sign-in or plan-use consent. Allow plan use, then Continue with ChatGPT to reconnect this saved account.`; connection.textContent = status.textContent; update(); return;
    }
    if (accountId === configuration?.activeAccountId) {applyConfiguration(configuration); status.textContent = 'Using the selected saved account.'; update(); return;}
    if (accountId && accountId !== configuration?.activeAccountId && core.selectQuestionAccount) void changeConnection('account', () => core.selectQuestionAccount!(accountId), 'Switching ChatGPT account. The previous conversation and context have been cleared.');
  });
  models.addEventListener('change', () => {
    const slug = models.value;
    if (slug && slug !== configuration?.selectedModel && core.selectQuestionModel) void changeConnection('model', () => core.selectQuestionModel!(slug), 'Switching question model. The previous conversation and context have been cleared.');
  });
  consent.addEventListener('change', update);
  const connectActions = el('div', '', 'question-actions'); connectActions.append(connect, cancelSignIn, addAccount);
  const accountActions = el('div', '', 'question-actions'); accountActions.append(signOut, usage);
  auth.append(el('p', 'Continue opens ChatGPT sign-in in your browser. Sign-in tokens stay in the native host and are never exposed here. Choose an account and model below before sending; requests use that account’s plan allowance.', 'muted'), consentLabel, connectActions, accountLabel, modelLabel, accountActions);
  const modeLabel = el('label', 'Response mode'); const mode = el('select'); mode.setAttribute('aria-label', 'Response mode');
  for (const [value, label] of [['ask', 'Ask'], ['revision', 'Suggest revision']]) {const option = el('option', label); option.value = value; mode.append(option);}
  modeLabel.append(mode);
  const targetSection = el('section', '', 'question-revision-target'); targetSection.setAttribute('aria-label', 'Revision target'); targetSection.hidden = true;
  const targetText = preview('', 'Exact revision target'); const targetNote = el('p', '', 'muted');
  targetSection.append(el('h4', 'Selected passage to revise'), targetText, targetNote);
  const questionLabel = el('label', 'Your message');
  const question = el('textarea'); question.rows = 2; question.setAttribute('aria-label', 'Your message');
  question.placeholder = 'Ask or continue the conversation…'; questionLabel.append(question);
  const count = el('p', '', 'muted'); const requestNote = el('p', '', 'question-request-note'); requestNote.setAttribute('role', 'status');
  const contextHeading = el('h4', 'Context to send');
  const contextSource = el('p', contextLabel, 'muted');
  const contextText = preview('', 'Exact context to send'); contextText.hidden = true;
  const captureSelection = button('Capture selected text', () => capture('selection'));
  const captureScene = button('Capture current scene', () => capture('scene'));
  const removeContext = button('Remove context', () => {defaultContext = false; contextVersion++; context = ''; contextLabel = mode.value === 'revision' ? 'None. No additional manuscript context will be sent.' : 'None. No manuscript text will be sent.'; update();});
  const contextActions = el('div', '', 'question-actions'); contextActions.append(captureSelection, captureScene, removeContext);
  const historyDetails = el('details', '', 'question-history-preview');
  const historySummary = el('summary', 'Conversation history to send');
  const historyText = el('div'); historyText.setAttribute('aria-label', 'Exact conversation history to send');
  const historyNote = el('p', '', 'muted'); historyDetails.append(historySummary, historyNote, historyText);
  const disclosure = el('p', 'Send shares your exact question, any revision target, the context preview, and the history preview with OpenAI using the selected ChatGPT account and model. Requests consume that plan’s usage allowance; account limits apply. Each request allows up to 2,000 output tokens. Manage ChatGPT usage to review usage or revoke access.', 'drafting-warning');
  const guidance = el('p', 'Nothing is sent while you type or open this panel. Ask returns attributed advice. Suggest revision prepares a saved proposal for your review, followed by a separate native author confirmation. It never applies an answer automatically.', 'muted');
  const status = el('p', '', 'question-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const send = button('Send to OpenAI', () => { void submit(); }, 'primary');
  const cancel = button('Cancel request', () => {
    if (!pending && !preparing) return;
    const wasSent = Boolean(pending); const wasRevision = pendingRevision; cancelPending(true);
    status.textContent = !wasSent ? 'Local preparation canceled. No request was sent.' : wasRevision ? 'Stopped locally. A pending suggestion may already have been recorded; check Proposed revisions. OpenAI usage may still count. Your manuscript was not changed.' : 'Canceled locally. OpenAI may already have processed the request; it can still count toward your plan usage.'; update();
  }); cancel.hidden = true;
  const reset = button('Clear conversation', () => {
    fullReviewCancel?.();
    const wasPending = Boolean(pending); const wasRevision = pendingRevision; resetContents();
    status.textContent = wasPending ? 'Conversation cleared and request canceled locally. Previously sent text cannot be recalled from OpenAI.' : 'Conversation cleared from this window. Previously sent text cannot be recalled from OpenAI.';
    if (wasRevision) status.textContent += ' A pending suggestion may already have been recorded; check Proposed revisions.';
    if (durable) { threadNote.textContent = 'New chat. Earlier threads remain saved in the repository.'; status.textContent = wasPending ? 'New chat started. The previous request was canceled locally; saved messages remain in its thread.' : 'New chat started. Earlier threads remain saved.'; }
    update(); question.focus({preventScroll: true});
  });
  if (durable) reset.textContent = 'New chat';
  const returnToWriting = button('Return to writing', () => hooks.focusEditor(), 'question-return');
  const actions = el('div', '', 'question-actions'); actions.append(send, cancel, returnToWriting);
  const headerActions = el('div', '', 'question-header-actions');
  const replyButton = button('Reply', () => { element.scrollTop = Math.max(0, composer.offsetTop - header.offsetHeight - 16); question.focus({preventScroll: true}); }); replyButton.setAttribute('aria-label', 'Reply'); headerActions.append(savedChats, reset, replyButton, closeButton);
  header.append(el('h3', 'Questions'), headerActions, currentTitle);
  if (integrated) {headerActions.replaceChildren(closeButton); currentTitle.remove();}
  const transcript = el('section', '', 'question-transcript'); transcript.setAttribute('aria-label', 'Question conversation');
  const streaming = el('section', '', 'question-stream-preview'); streaming.hidden = true;
  const streamingLabel = el('h4', 'OpenAI · Streaming answer');
  const streamingText = preview('', 'Live answer preview');
  streaming.setAttribute('aria-busy', 'false');
  streaming.append(streamingLabel, streamingText);
  const lifetime = el('p', 'Conversation text stays only in this window, up to four turns and 64,000 UTF-8 bytes. Closing questions or changing scenes/folders clears it. Earlier context snapshots and revision replacements are not added to conversation history. Revision source snapshots stay local until this panel is cleared; saved proposal records remain available in Proposed revisions. Stopping a request may leave an already-recorded pending suggestion.', 'muted');
  if (integrated) lifetime.textContent = 'Collapse keeps passage questions in this window. Changing documents clears passage sessions. Up to four turns and 64,000 UTF-8 bytes are retained across passage sessions; saved chats and proposals remain in the repository. Cancel request stops pending work locally.';
  if (durable) lifetime.textContent = 'Ask threads are saved in .heinlein/chats/ inside this repository. Your sent questions, explicit context, selected history, answers and model names can be tracked and shared with Git; credentials are never stored there. The full transcript is retained. Only the history preview is sent with a follow-up. New chat keeps earlier threads. Revision suggestions keep their separate proposal and author-confirmation flow.';
  const sendPreview = el('details', '', 'question-send-preview'); sendPreview.setAttribute('aria-label', 'What will be sent');
  const sendSummary = el('p', '', 'question-send-summary');
  sendPreview.append(el('summary', 'What will be sent'), count, contextHeading, contextSource, contextText, contextActions, historyDetails, disclosure);
  const storage = el('details', '', 'question-storage'); storage.append(el('summary', 'Storage and revision safety'), guidance, lifetime);
  const emptyChat = el('p', durable ? 'Start a chat. Sent messages are saved in this repository; Git can share them.' : 'Start a conversation. Review the active-sheet context before sending.', 'muted');
  const composer = el('section', '', 'question-composer'); composer.setAttribute('aria-label', 'Write a message');
  composer.append(modeLabel, targetSection, questionLabel, requestNote, sendSummary, sendPreview, actions, status);
  const connectionArea = el('section', '', 'question-connection-area'); connectionArea.setAttribute('aria-label', 'Account and storage'); connectionArea.append(connection, refresh, auth, storage);
  if (integrated) {const secondary = el('div', '', 'question-actions'); secondary.append(savedChats, reset); connectionArea.prepend(secondary);}
  // The integrated pane quotes its passage and offers both responses as explicit sends.
  const passageQuote = el('blockquote', '', 'question-passage-quote'); passageQuote.setAttribute('aria-label', 'Selected passage'); passageQuote.hidden = true;
  const passageNote = el('p', '', 'question-request-note'); passageNote.hidden = true;
  const askButton = button('Ask', () => submitAs('ask'), 'primary');
  const suggestButton = button('Suggest rewrite', () => submitAs('revision'));
  let showSettings = false;
  const settingsToggle = button('', () => { showSettings = !showSettings; update(); if (showSettings) connectionArea.querySelector<HTMLElement>('button, summary')?.focus({preventScroll: true}); }, 'question-settings-toggle');
  element.append(header, ...(integrated ? [passageQuote, passageNote] : []), fullReview, passagePicker, threadControls, emptyChat, transcript, chatAttempts, streaming, composer, connectionArea);
  if (integrated) {
    header.querySelector('h3')!.textContent = 'Heinlein';
    if (hooks.headerTabs) header.insertBefore(hooks.headerTabs, headerActions);
    headerActions.prepend(settingsToggle);
    question.placeholder = 'What would you like to know or change?';
    modeLabel.remove(); sendPreview.prepend(targetSection); actions.replaceChildren(askButton, suggestButton, cancel);
    composer.append(questionLabel, requestNote, actions, status, sendSummary, sendPreview);
    if (hooks.copyPrompt) composer.append(button('Copy as prompt…', () => hooks.copyPrompt!(), 'question-copy-prompt'));
    emptyChat.remove();
  }
  // One scroll surface. Reopening goes to the latest exchange, never on every token.
  function revealLatest(focusLatest = false) {
    const latest = transcript.lastElementChild as HTMLElement | null;
    element.scrollTop = Math.max(0, (latest?.offsetTop ?? composer.offsetTop) - header.offsetHeight - 16);
    if (focusLatest) latest?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({preventScroll: true});
  }
  const layoutQuery = window.matchMedia?.('(max-width: 1399px)');
  let dedicated = false;
  function presentation() {
    // Media-query rem units use the browser's initial font size, not app text zoom.
    const textSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    dedicated = Boolean(layoutQuery?.matches) || (integrated && window.innerWidth < 64 * textSize);
    element.dataset.presentation = dedicated ? 'dedicated' : 'docked';
    element.setAttribute('role', dedicated ? 'dialog' : 'complementary');
    if (dedicated) element.setAttribute('aria-modal', 'true'); else element.removeAttribute('aria-modal');
    if (dedicated && !element.hidden && !element.contains(document.activeElement)) closeButton.focus({preventScroll: true});
  }
  layoutQuery?.addEventListener?.('change', presentation); window.addEventListener('resize', presentation); presentation();
  const textObserver = new MutationObserver(presentation);
  textObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['style', 'data-zoom']});
  const headerObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { element.style.setProperty('--question-header-height', `${header.offsetHeight + 16}px`); }); headerObserver?.observe(header);
  element.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !dedicated) return;
    const focusable = [...element.querySelectorAll<HTMLElement>('button, select, textarea, input, summary, [tabindex="0"]')].filter(node => !node.closest('[hidden]') && !node.matches(':disabled') && node.getClientRects().length && !node.closest('details:not([open]) :not(summary)'));
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  question.addEventListener('input', update);
  mode.addEventListener('change', () => {
    if (!live() || pending || preparing || authBusy) return;
    if (integrated && !activePassage) {const scene = hooks.current(); const requested = mode.value; if (scene && !selectionQuestionAvailability(hooks.selectionState?.() ?? null)) activateSelection(scene); mode.value = requested;}
    sendPreview.open = !integrated && mode.value === 'revision';
    contextVersion++; target = null; defaultContext = !integrated; context = ''; contextLabel = 'None. No additional manuscript context will be sent.';
    if (mode.value === 'revision') {
      const selected = hooks.selectionState?.();
      if (selected && !selectionQuestionAvailability(selected)) target = {...selected};
      status.textContent = 'Revision mode uses only the exact selected target below, plus any context you explicitly capture. Save first, inspect the preview, then Send.';
    } else {if (integrated && activePassage) {context = activePassage.scene.source.slice(activePassage.scene.from, activePassage.scene.to); contextLabel = 'Selected passage only';} status.textContent = 'Ask mode returns advice only. No revision proposal will be created.';}
    update();
  });
  // Escape is scoped to this panel; the editor keeps all its own shortcuts.
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) {event.preventDefault(); event.stopPropagation(); (integrated ? collapse() : close(true));}
  });
  function live() { return !disposed && (integrated || !element.hidden) && hooks.current()?.repositoryId === session && (!integrated || hooks.current()?.path === sessionPath); }
  function activeAccount() { return configuration?.accounts.find(account => account.id === configuration?.activeAccountId); }
  function connectionReady() {
    const account = activeAccount(); const current = configuration;
    return Boolean(!reauthorizing && current?.configured && !current.usageLimited && !current.signInPending && account?.signedIn && account.planEnabled &&
      Number.isSafeInteger(current.generation) && current.generation >= 0 && current.model && current.model === current.selectedModel &&
      accounts.value === current.activeAccountId && models.value === current.model &&
      current.models.some(model => model.slug === current.model));
  }
  function messages(): QuestionMessage[] { return turns.flatMap(turn => [{role: 'user' as const, text: turn.question}, {role: 'assistant' as const, text: turn.answer.text}]); }
  function targetBytes() {return mode.value === 'revision' && target ? questionBytes(target.source.slice(target.from, target.to)) : 0;}
  function outgoingHistory() { if (mode.value === 'revision') return []; return questionHistory(messages(), Math.max(0, QUESTION_LIMITS.input - questionBytes(question.value) - questionBytes(context) - targetBytes())); }
  function revisionProblem(snapshot?: SelectionQuestionSnapshot, reviewing = false) {
    if (!core.suggestQuestionRevision || !hooks.reviewRevision || !core.rejectProposal) return 'Revision review is unavailable in this native host.';
    const unavailable = hooks.revisionUnavailable?.(reviewing); if (unavailable) return unavailable;
    let current = hooks.selectionState?.(reviewing) ?? null;
    if (integrated && current && (snapshot || target)) {const bound = snapshot ?? target!; current = {...current, from: bound.from, to: bound.to};}
    if (integrated && activePassage && passageStale(activePassage)) return 'Source changed. Select the passage again to request a revision.';
    if (snapshot) return selectionQuestionProblem(snapshot, current) ?? (snapshot.sourceHash !== current?.sourceHash ? 'The saved source changed. Capture the selection again.' : null);
    const captured = target; const problem = selectionQuestionAvailability(captured); if (problem) return problem;
    if (!captured || !current || ['repositoryId', 'path', 'sceneId', 'documentEpoch', 'revision', 'source', 'sourceHash', 'from', 'to'].some(key => captured[key as keyof SelectionQuestionState] !== current[key as keyof SelectionQuestionState])) return 'The scene or selection changed. Capture the selected passage again before requesting a revision.';
    if (targetBytes() > QUESTION_LIMITS.context) return 'The revision target exceeds 16,000 UTF-8 bytes. Select a shorter passage.';
    return selectionQuestionAvailability(current);
  }
  function outgoingProblem() {return questionProblem(question.value, context) ?? (mode.value === 'revision' ? revisionProblem() : null) ?? (questionBytes(question.value) + questionBytes(context) + targetBytes() > QUESTION_LIMITS.input ? 'The question, target, and context exceed 32,000 UTF-8 bytes. Remove context or shorten the selection.' : null);}
  function refreshDefaultContext() {
    if (!defaultContext || pending || preparing || element.hidden) return;
    const current = hooks.current(); if (!current?.canCapture) return;
    if (context !== current.source) { context = current.source; contextVersion++; }
    contextLabel = `Active sheet · ${current.path} · ${questionBytes(context).toLocaleString()} UTF-8 bytes. The current editor text is captured when you send.`;
  }
  function update() {
    refreshDefaultContext();
    const history = pending?.history ?? outgoingHistory();
    const revising = mode.value === 'revision';
    targetSection.hidden = !revising; targetText.textContent = revising && target ? target.source.slice(target.from, target.to) : '';
    targetNote.textContent = revising ? (revisionProblem() ?? `${target!.path} · ${targetBytes().toLocaleString()} UTF-8 bytes. Only this target is replaced; saved source is rechecked before review.`) : '';
    captureSelection.textContent = revising ? 'Capture revision selection' : 'Capture selected text';
    mode.disabled = Boolean(pending) || preparing || Boolean(authBusy);
    const questionSize = questionBytes(question.value);
    count.textContent = `${questionSize.toLocaleString()} / ${QUESTION_LIMITS.question.toLocaleString()} UTF-8 bytes${questionSize > QUESTION_LIMITS.question ? ' · Question is too long' : ''}`;
    contextSource.textContent = contextLabel; contextText.textContent = context; contextText.hidden = !context;
    const missing = messages().length - history.length;
    emptyChat.hidden = turns.length > 0 || !streaming.hidden || chatBusy || Boolean(chatAttempts.childElementCount);
    replyButton.hidden = integrated || turns.length === 0; replyButton.disabled = Boolean(pending) || preparing;
    sendSummary.textContent = `${context ? `${questionBytes(context).toLocaleString()} bytes of chosen context` : 'No manuscript context'} · ${history.length} history messages${missing ? ` · ${missing} older messages omitted` : ''}. Uses your ChatGPT plan.`;
    if (integrated) {
      const chosen = revising ? 'Selected passage' : contextLabel === 'Selected passage only' && context ? 'Selected passage' : context ? `${questionBytes(context).toLocaleString()} bytes of context` : 'No manuscript context';
      sendSummary.textContent = `${chosen}${revising && context ? ` + ${questionBytes(context).toLocaleString()} bytes of additional context` : ''}${history.length ? ` + ${history.length} history messages` : ''}. Uses your ChatGPT plan.`;
    }
    if (chatError) { threadControls.hidden = false; savedChats.setAttribute('aria-expanded', 'true'); }
    const signedIn = activeAccount();
    const needsConsent = !signedIn?.signedIn || !signedIn.planEnabled || reauthorizing || addingAccount;
    consentLabel.hidden = !needsConsent; connect.hidden = !needsConsent && !configuration?.signInPending;
    refresh.hidden = connectionReady();
    historySummary.textContent = `Conversation history ${pending ? 'sent' : 'to send'} · ${history.length} messages`;
    historyNote.textContent = mode.value === 'revision' ? 'Revision requests include no conversation history. Only the question, exact target, and optional context preview are sent.' : `Only these previous questions and answers are ${pending ? 'included in this request' : 'sent with your next question'}. Previous context snapshots are not resent.${missing ? ` ${missing} older messages are omitted to fit the request limit.` : ''}${forgotten ? ` ${forgotten} earlier turns have been cleared from this window to keep memory bounded.` : ''}`;
    historyText.replaceChildren();
    if (!history.length) historyText.append(el('p', 'No previous messages included.', 'muted'));
    history.forEach((message, index) => historyText.append(el('h4', message.role === 'user' ? 'You' : 'OpenAI'), preview(message.text, `History message ${index + 1}`)));
    question.disabled = Boolean(pending) || preparing || Boolean(authBusy);
    captureSelection.disabled = captureScene.disabled = Boolean(pending) || preparing || Boolean(authBusy);
    removeContext.disabled = Boolean(pending) || preparing || Boolean(authBusy) || !context;
    const authPending = Boolean(authBusy) || Boolean(configuration?.signInPending);
    threadSelect.disabled = Boolean(pending) || preparing || chatBusy;
    reloadChats.disabled = Boolean(pending) || preparing || chatBusy;
    refresh.disabled = chatBusy || Boolean(pending) || checking || authPending;
    accounts.disabled = checking || authPending || !core.selectQuestionAccount || !configuration?.accounts.length;
    models.disabled = checking || authPending || reauthorizing || !core.selectQuestionModel || !configuration?.models.length || !activeAccount()?.planEnabled;
    consent.disabled = checking || authPending || !core.available();
    connect.disabled = !live() || checking || authPending || !core.available() || !core.connectQuestionAccount || !core.cancelQuestionSignIn || !consent.checked || (!selectedAccountId && !addingAccount && Boolean(configuration?.accounts.length));
    addAccount.disabled = !live() || checking || authPending || !core.available() || !core.connectQuestionAccount;
    signOut.disabled = checking || authPending || !configuration?.accounts.find(account => account.id === selectedAccountId)?.signedIn || !core.signOutQuestionAccount;
    usage.disabled = !core.available() || !core.openQuestionUsage;
    cancelSignIn.hidden = authBusy !== 'connect' && !configuration?.signInPending;
    cancelSignIn.disabled = !core.cancelQuestionSignIn;
    if (integrated) {
      const passage = activePassage; const stale = Boolean(passage && passageStale(passage));
      passageQuote.hidden = !passage; passageQuote.textContent = passage ? passage.scene.source.slice(passage.scene.from, passage.scene.to) : '';
      passageNote.hidden = !stale; passageNote.textContent = stale ? 'This passage changed after you asked. Earlier suggestions can no longer be applied. Select the text again to ask about the new version.' : '';
      const ready = connectionReady();
      settingsToggle.textContent = ready ? `ChatGPT · ${configuration!.model}` : checking ? 'Checking ChatGPT…' : 'Connect ChatGPT';
      connectionArea.hidden = ready && !showSettings;
      settingsToggle.setAttribute('aria-expanded', String(!connectionArea.hidden));
      settingsToggle.title = ready ? 'Account, model and storage settings' : 'Connect a ChatGPT account before asking';
    }
    updateRevisionState();
    cancel.hidden = !pending && !preparing;
    element.setAttribute('aria-busy', String(Boolean(pending) || preparing || checking || authPending));
    notifyPassages();
  }
  function updateRevisionState() {
    const problem = outgoingProblem();
    send.disabled = !live() || (durable && (chatBusy || chatError)) || checking || Boolean(authBusy) || Boolean(configuration?.signInPending) || !connectionReady() || !core.askQuestion || Boolean(pending) || preparing || Boolean(problem);
    send.title = problem ?? ''; requestNote.textContent = question.value.trim() ? send.title : ''; requestNote.hidden = !requestNote.textContent;
    if (integrated && mode.value === 'revision' && activePassage?.stale) {send.disabled = true; send.title = 'Source changed. Select the passage again to start a new question.';}
    if (integrated) {
      // Mode-specific problems are reported when the author picks a response, not hidden in a tooltip.
      const blocked = !live() || (durable && (chatBusy || chatError)) || checking || Boolean(authBusy) || Boolean(configuration?.signInPending) || !connectionReady() || !core.askQuestion || Boolean(pending) || preparing || !question.value.trim();
      const stale = Boolean(activePassage && passageStale(activePassage));
      askButton.disabled = blocked; suggestButton.disabled = blocked || stale || !core.suggestQuestionRevision;
      const lengthProblem = questionProblem(question.value, '');
      requestNote.textContent = question.value.trim() && lengthProblem ? lengthProblem : ''; requestNote.hidden = !requestNote.textContent;
      askButton.hidden = suggestButton.hidden = Boolean(pending) || preparing;
    }
    if (mode.value === 'revision') targetNote.textContent = revisionProblem() ?? `${target!.path} · ${targetBytes().toLocaleString()} UTF-8 bytes. Only this target is replaced; saved source is rechecked before review.`;
    for (const refreshAction of revisionActions) refreshAction();
    notifyPassages();
  }
  /** Both responses remain explicit sends; choosing one only fixes what the request asks for. */
  function submitAs(kind: 'ask' | 'revision') {
    if (!live() || pending || preparing || authBusy) return;
    if (mode.value !== kind) {
      if (kind === 'revision' && activePassage && !passageStale(activePassage)) hooks.passages?.select(activePassage.scene.from, activePassage.scene.to);
      mode.value = kind; mode.dispatchEvent(new Event('change'));
    }
    void submit();
  }
  function capture(kind: 'selection' | 'scene') {
    sendPreview.open = !integrated;
    if (!live() || pending || preparing) return;
    const current = hooks.current();
    if (!current?.canCapture) {status.textContent = 'Open an editable scene and resolve any recovery decision before capturing context.'; return;}
    let captured = current.source;
    if (kind === 'selection') {
      if (!Number.isInteger(current.from) || !Number.isInteger(current.to) || current.from < 0 || current.to > captured.length || current.to <= current.from) {status.textContent = 'Highlight one nonempty passage in the editor, then capture it.'; return;}
      captured = captured.slice(current.from, current.to);
    }
    if (!captured || !plainUnicode(captured)) {status.textContent = 'Select complete Unicode characters from a nonempty scene.'; return;}
    if (questionBytes(captured) > QUESTION_LIMITS.context) {
      status.textContent = `This ${kind === 'scene' ? 'scene' : 'selection'} exceeds ${QUESTION_LIMITS.context.toLocaleString()} UTF-8 bytes. Select a shorter passage. The context preview has not changed.`; return;
    }
    if (kind === 'selection' && mode.value === 'revision') {
      const selected = hooks.selectionState?.();
      if (!selected || selected.repositoryId !== current.repositoryId || selected.path !== current.path || selected.source !== current.source || selected.from !== current.from || selected.to !== current.to) {status.textContent = 'The selection changed. Highlight it again.'; return;}
      contextVersion++; target = {...selected}; status.textContent = 'Revision target captured locally. Save the scene, inspect the exact target, then Send.'; update(); return;
    }
    defaultContext = false; contextVersion++; context = captured;
    contextLabel = `${kind === 'scene' ? 'Current scene' : 'Selected text'} snapshot · ${current.path} · ${questionBytes(captured).toLocaleString()} UTF-8 bytes. Later editor changes are not included unless you capture again.`;
    status.textContent = 'Context captured locally. Inspect the exact text before sending.'; update();
  }
  function applyConfiguration(next: QuestionStatus) {
    const first = seenConnection === null;
    const key = JSON.stringify([next.generation, next.activeAccountId, next.selectedModel, next.accounts.find(account => account.id === next.activeAccountId)?.planEnabled]);
    const chatIdentity = JSON.stringify([next.activeAccountId, next.selectedModel, next.accounts.find(account => account.id === next.activeAccountId)?.planEnabled]);
    if (seenConnection !== null && seenConnection !== key) {
      const resumeChat = durable && seenChatIdentity === chatIdentity ? chatId : null;
      resetContents(true);
      if (resumeChat) void loadChat(resumeChat);
    }
    seenChatIdentity = chatIdentity;
    seenConnection = key; configuration = next; selectedAccountId = next.activeAccountId; reauthorizing = false; addingAccount = false;
    const account = activeAccount();
    const accountLabelText = account?.label.replace(/\s*\(oaiapp_[A-Za-z0-9_-]+\)$/, '');
    connection.textContent = `${account ? `${accountLabelText}${next.model ? ` · ${next.model}` : ''}. ` : ''}${next.configured ? 'Connected to ChatGPT.' : next.message}${next.usageLimited ? ' Plan usage is limited. Manage usage or explicitly recheck before trying again.' : ''}`;
    accounts.replaceChildren(); models.replaceChildren();
    const accountPlaceholder = el('option', 'Choose an account'); accountPlaceholder.value = ''; accountPlaceholder.disabled = true; accounts.append(accountPlaceholder);
    next.accounts.forEach(value => {const option = el('option', `${value.label}${!value.signedIn ? ' · signed out' : !value.planEnabled ? ' · plan use disabled' : ''}`); option.value = value.id; accounts.append(option);});
    accounts.value = next.activeAccountId ?? '';
    const modelPlaceholder = el('option', 'Choose a model'); modelPlaceholder.value = ''; modelPlaceholder.disabled = true; models.append(modelPlaceholder);
    next.models.forEach(value => {const option = el('option', value.displayName || value.slug); option.value = value.slug; models.append(option);});
    models.value = next.selectedModel ?? '';
    if (!account?.signedIn || !account.planEnabled || next.signInPending || (next.models.length > 0 && !next.selectedModel)) auth.open = true;
    else if (first || authBusy === 'connect') auth.open = false;
  }
  async function checkStatus(remote = false) {
    if (!live() || authBusy) return;
    const request = ++statusVersion; checking = true; configuration = null;
    connection.textContent = remote ? 'Rechecking ChatGPT account and available models…' : 'Checking local OpenAI setup…'; update();
    try {
      if (!core.available() || !core.questionStatus || !core.askQuestion || !core.cancelQuestion) {
        applyConfiguration({configured: false, model: null, message: 'OpenAI questions need a configured native Heinlein host. Local drafting remains available.', accounts: [], activeAccountId: null, models: [], selectedModel: null, signInPending: false, generation: 0, usageLimited: false});
      } else {
        const result = await (remote && core.refreshQuestionConnection ? core.refreshQuestionConnection() : core.questionStatus());
        if (!live() || request !== statusVersion) return;
        applyConfiguration(result);
      }
    } catch {
      if (!live() || request !== statusVersion) return;
      configuration = null; connection.textContent = 'OpenAI setup could not be checked. Recheck when the native host is available. You can keep drafting locally.';
    } finally { if (live() && request === statusVersion) {checking = false; update();} }
  }
  async function changeConnection(kind: NonNullable<typeof authBusy>, action: () => Promise<QuestionStatus>, message: string) {
    if (!live() || checking || authBusy || configuration?.signInPending) return;
    const epoch = ++statusVersion; authBusy = kind; resetContents(true); configuration = null; consent.checked = false;
    status.textContent = message; connection.textContent = message; update();
    try {
      const next = await action();
      if (!live() || statusVersion !== epoch) return;
      applyConfiguration(next);
      status.textContent = kind === 'signout' ? 'Signed out of the selected account. Its conversation and context have been cleared.' : 'Connection updated. Review the selected account and model before sending.';
    } catch (error) {
      if (!live() || statusVersion !== epoch) return;
      configuration = null; connection.textContent = 'Connection change was not confirmed. Recheck OpenAI setup before sending.'; status.textContent = errorMessage(error);
    } finally {if (live() && statusVersion === epoch) {authBusy = null; update();}}
  }
  async function cancelConnection() {
    if (!live() || (authBusy !== 'connect' && !configuration?.signInPending) || !core.cancelQuestionSignIn) return;
    const epoch = ++statusVersion; authBusy = null; checking = true; resetContents(true); configuration = null; consent.checked = false;
    status.textContent = 'Canceling ChatGPT connection…'; update();
    try {
      await core.cancelQuestionSignIn();
      if (!live() || statusVersion !== epoch) return;
      status.textContent = 'Connection canceled. No question was sent.'; checking = false; await checkStatus();
    } catch {
      if (!live() || statusVersion !== epoch) return;
      checking = false; connection.textContent = 'Connection cancellation could not be confirmed. Recheck before sending.'; update();
    }
  }
  function cancelPending(reportOutcome = false) {
    const epoch = ++version; preparing = false;
    if (!streaming.hidden) { streamingLabel.textContent = 'OpenAI · Interrupted preview · Not added to history'; streaming.setAttribute('aria-busy', 'false'); }
    const request = pending; const wasRevision = pendingRevision; pending = null; pendingRevision = false;
    if (request && core.cancelQuestion) {
      try {void core.cancelQuestion(request.requestId).then(accepted => {
        if (reportOutcome && wasRevision && !accepted && live() && epoch === version) status.textContent = 'This revision request is already finishing. Its pending suggestion may have been recorded; check Proposed revisions. Your manuscript was not changed.';
      }).catch(() => {
        if (reportOutcome && wasRevision && live() && epoch === version) status.textContent = 'Stopped locally, but cancellation could not be confirmed. Check Proposed revisions for a pending suggestion. Your manuscript was not changed.';
      });} catch { /* local invalidation still wins */ }
    }
  }
  function resetContents(suppressDefault = false) {
    if (integrated) {passages.length = 0; activePassage = null;}
    chatVersion++; chatBusy = false; chatError = false; chatId = null; currentTitle.textContent = durable ? 'New chat' : 'Current conversation'; threadSelect.value = ''; chatAttempts.replaceChildren();
    contextVersion++; cancelPending(); mode.value = 'ask'; target = null; defaultContext = !suppressDefault; targetText.textContent = ''; targetNote.textContent = ''; targetSection.hidden = true; revisionActions.length = 0; turns = []; forgotten = 0; context = ''; contextLabel = 'None. No manuscript text will be sent.'; question.value = ''; transcript.replaceChildren(); streaming.hidden = true; streamingText.textContent = '';
    // Closing also removes private snapshots from hidden DOM, not just state.
    contextText.textContent = ''; contextText.hidden = true; contextSource.textContent = contextLabel;
    historyText.replaceChildren(); historyNote.textContent = ''; historySummary.textContent = 'Conversation history to send · 0 messages';
  }
  async function submit() {
    if (!live() || (durable && (chatBusy || chatError)) || pending || preparing || checking || authBusy || !connectionReady() || !configuration || !core.askQuestion) return;
    refreshDefaultContext();
    const problem = outgoingProblem();
    if (problem) {status.textContent = problem; update(); return;}
    if (!globalThis.crypto?.randomUUID) {status.textContent = 'A secure request identifier is unavailable. Reopen Studio before sending.'; return;}
    const focusWasInComposer = Boolean(!element.hidden && dedicated && composer.contains(document.activeElement));
    const revising = mode.value === 'revision'; const capturedContext = contextVersion;
    const request: QuestionRequest = {requestId: crypto.randomUUID(), question: question.value, context, history: outgoingHistory()};
    const binding: QuestionConnection = {generation: configuration.generation, accountId: configuration.activeAccountId!, model: configuration.model!};
    const epoch = ++version; let snapshot: SelectionQuestionSnapshot | undefined;
    preparing = revising;
    preparing = true;
    status.textContent = revising ? 'Checking the exact saved revision target… You can keep writing.' : 'Asking OpenAI… You can keep writing and saving your draft.'; update();
    try {
      if (revising) {
        snapshot = await captureSelectionQuestion(target!);
        if (!live() || version !== epoch || contextVersion !== capturedContext) return;
        await hooks.prepareRevision?.(snapshot);
        if (!live() || version !== epoch || contextVersion !== capturedContext) return;
        const stale = revisionProblem(snapshot); if (stale) throw new Error(stale);
        if (snapshot.sourceHash !== snapshot.sourceSha256) throw new Error('The selected source does not match its saved hash. Save and capture the selection again.');
      }
      if (durable && !snapshot) {
        if (!chatId) {
          preparing = true; update();
          const created = await core.createChatThread!(session!, request.question);
          if (!live() || version !== epoch) return;
          chatId = created.id; currentTitle.textContent = created.title; threadNote.textContent = `Saved chat: ${created.title}`;
          const option = el('option', created.title); option.value = created.id; threadSelect.append(option); threadSelect.value = created.id;
        }
      }
      preparing = false; pending = request; pendingRevision = Boolean(snapshot); update();
      if (focusWasInComposer && !element.hidden) cancel.focus({preventScroll: true});
      streaming.hidden = true; streamingText.textContent = ''; streamingLabel.textContent = 'OpenAI · Streaming answer';
      const answer = snapshot
        ? await core.suggestQuestionRevision!(request, binding, {repositoryId: snapshot.repositoryId, path: snapshot.path, sourceHash: snapshot.sourceHash, fromUtf8: snapshot.fromUtf8, toUtf8: snapshot.toUtf8, selectedText: snapshot.selectedText})
        : await core.askQuestion(request, binding, text => {
          if (!live() || version !== epoch || pending !== request || typeof text !== 'string' || !plainUnicode(text) || questionBytes(text) > QUESTION_LIMITS.answer) return;
          const first = streaming.hidden;
          streamingText.textContent = text; streaming.hidden = !text; streaming.setAttribute('aria-busy', 'true');
          if (first && text) status.textContent = 'Receiving OpenAI answer… Preview is incomplete until the request finishes.';
        }, durable ? {repositoryId: session!, threadId: chatId!, sourcePath: hooks.current()!.path} : undefined);
      if (!live() || version !== epoch || pending !== request) return;
      if (answer.requestId !== request.requestId) throw new Error('The response did not match this question. It was ignored.');
      if (!answer.text?.trim()) throw new Error('OpenAI returned no text. No retry was sent automatically.');
      if (questionBytes(answer.text) > QUESTION_LIMITS.answer || !plainUnicode(answer.text)) throw new Error('The answer exceeded the safe text limit or contained invalid text. It was not added to the conversation.');
      let revision: Revision | undefined;
      if (snapshot) {
        const result = answer as QuestionRevisionAnswer;
        if (!result.proposalId || result.incomplete || typeof result.replacementText !== 'string' || !plainUnicode(result.replacementText) || questionBytes(result.replacementText) + questionBytes(result.text) > QUESTION_LIMITS.answer) throw new Error('The revision response was incomplete or invalid. No review was opened.');
        revision = {snapshot, contextVersion: capturedContext, proposalId: result.proposalId, replacementText: result.replacementText, rejected: false, busy: false};
      }
      turns.push({question: request.question, answer, contextBytes: questionBytes(request.context), savedContext: durable ? request.context : undefined, revision});
      while ((integrated || !durable) && (turns.length > 4 || turns.reduce((sum, turn) => sum + questionBytes(turn.question) + questionBytes(turn.answer.text) + questionBytes(turn.revision?.replacementText ?? '') + questionBytes(turn.revision?.snapshot.selectedText ?? ''), 0) > QUESTION_LIMITS.memory)) {turns.shift(); forgotten++;}
      question.value = '';
      if (integrated) questionLabel.firstChild!.textContent = 'Ask a follow-up';
      streaming.hidden = true; streamingText.textContent = ''; streaming.setAttribute('aria-busy', 'false');
      renderTranscript();
      status.textContent = revision ? (integrated ? 'Suggestion ready. Nothing changes until you apply it.' : 'Suggested revision recorded. Review it or reject it below. Your manuscript has not been changed.') : answer.incomplete ? 'OpenAI returned an incomplete answer. It is marked below; nothing was retried automatically.' : 'Answer ready. Your manuscript has not been changed.';
    } catch (error) { if (live() && version === epoch) {status.textContent = durable && !revising && !pending ? 'The repository chat could not be saved. No question was sent. Your draft remains here.' : errorMessage(error); if (!streaming.hidden) { streamingLabel.textContent = 'OpenAI · Interrupted preview · Not added to history'; streaming.setAttribute('aria-busy', 'false'); } void checkStatus();} }
    finally { if (live() && version === epoch) {const returnToComposer = !element.hidden && document.activeElement === cancel; preparing = false; pending = null; pendingRevision = false; update(); if (returnToComposer) question.focus({preventScroll: true});} }
  }
  function revisionGuard(revision: Revision, reviewing = false) {
    if (!live() || revision.contextVersion !== contextVersion) return 'The captured context changed. Request a new revision for the current selection.';
    return revisionProblem(revision.snapshot, reviewing);
  }
  function renderTranscript() {
    transcript.replaceChildren(); revisionActions.length = 0;
    (integrated ? [...turns].reverse() : turns).forEach((turn, index) => {
      const section = el('section', '', 'question-turn');
      const usage = [turn.answer.inputTokens == null ? null : `${turn.answer.inputTokens.toLocaleString()} input tokens`, turn.answer.outputTokens == null ? null : `${turn.answer.outputTokens.toLocaleString()} output tokens`].filter(Boolean).join(' · ');
      if (integrated) {section.append(preview(turn.question, `Question ${index + 1}`), preview(turn.answer.text, `Answer ${index + 1}`)); if (turn.answer.incomplete) section.append(el('p', 'Incomplete answer', 'drafting-warning'));}
      else section.append(el('h4', 'You'), preview(turn.question, `Question ${index + 1}`), el('h4', `OpenAI · ${turn.answer.model}${turn.answer.incomplete ? ' · Incomplete answer' : ''}`), preview(turn.answer.text, `Answer ${index + 1}`));
      const messageDetails = el('details', '', 'question-message-details'); messageDetails.append(el('summary', 'Message details'), el('p', `${turn.contextBytes.toLocaleString()} UTF-8 bytes of context sent`, 'muted'), el('p', usage || 'Token usage was not returned.', 'muted'));
      if (turn.savedContext) {
        const savedContext = el('details'); savedContext.append(el('summary', 'Saved context for this message'), preview(turn.savedContext, `Saved context ${index + 1}`)); (integrated ? messageDetails : section).append(savedContext);
      }
      const origin = el('p', `Recorded origin: native OpenAI · Model: ${turn.answer.model} · Request: ${turn.answer.requestId}. Provider metadata is not authenticated authorship.`, 'muted'); messageDetails.append(origin); section.append(messageDetails);
      const revision = turn.revision;
      if (revision) {
        const note = el('p', '', 'question-revision-status'); note.setAttribute('role', 'status');
        const openReview = (full: boolean) => {
          if (revision.busy || revision.rejected) return;
          const stale = revisionGuard(revision); if (stale) {note.textContent = stale; review.disabled = true; return;}
          revision.busy = true; refreshAction();
          // Apply skips the in-pane step only when the authoritative change is exactly the diff already shown.
          const presenter = integrated ? (view: ProposalReview) => presentReview(view, full ? undefined : revision) : undefined;
          void hooks.reviewRevision!(revision.proposalId, revision.snapshot, () => revisionGuard(revision, true), presenter).catch(() => {
            if (live() && turns.includes(turn)) status.textContent = 'Revision review could not be opened. Check the local proposals and receipts.';
          }).finally(() => {revision.busy = false; if (live() && turns.includes(turn)) {refreshAction(); notifyPassages();}});
        };
        const review = button(integrated ? 'Apply…' : 'Review proposed revision', () => openReview(false));
        if (integrated) review.classList.add('primary');
        const reject = button(integrated ? 'Dismiss' : 'Reject proposed revision', () => {
          if (!live() || revision.busy || revision.rejected || !core.rejectProposal) return;
          revision.busy = true; refreshAction(); const epoch = version;
          void core.rejectProposal(revision.snapshot.repositoryId, revision.proposalId).then(receipt => {
            if (!live() || version !== epoch || !turns.includes(turn)) return;
            if (receipt.kind !== 'reject' || receipt.status !== 'rejected' || receipt.proposalId !== revision.proposalId) throw new Error('Rejection was not confirmed');
            revision.rejected = true; status.textContent = integrated ? 'Dismissed. Your manuscript was not changed.' : `Suggestion rejected. Local immutable rejection receipt: ${receipt.id}. The manuscript was not changed.`;
          }).catch(() => {
            if (live() && version === epoch && turns.includes(turn)) status.textContent = 'Rejection could not be confirmed. Check the local receipts before retrying.';
          }).finally(() => {revision.busy = false; if (live() && turns.includes(turn)) {refreshAction(); notifyPassages();}});
        });
        function refreshAction() {
          const stale = revisionGuard(revision!);
          review.disabled = revision!.busy || revision!.rejected || Boolean(stale); reject.disabled = revision!.busy || revision!.rejected;
          note.textContent = revision!.rejected ? (integrated ? 'Dismissed.' : 'Rejected. The local decision receipt is retained.') : revision!.busy ? (integrated ? 'Waiting for your confirmation…' : 'Opening the requested revision action…') : stale ?? (integrated ? '' : 'Review opens the exact whole-scene before/after comparison, then a separate native author confirmation.');
        }
        if (integrated) {
          section.append(createQuestionComparison(revision.snapshot.selectedText, revision.replacementText));
          const full = button('Show full scene comparison', () => openReview(true), 'question-full-comparison');
          full.disabled = review.disabled; section.append(full, note, review, reject);
          revisionActions.push(() => {full.disabled = review.disabled;});
        } else section.append(el('h4', 'Original selected passage'), preview(revision.snapshot.selectedText, `Original target ${index + 1}`), el('h4', 'Proposed selected-passage replacement'), preview(revision.replacementText, `Suggested replacement ${index + 1}`), el('p', `Proposal: ${revision.proposalId}`, 'muted'), note, review, reject);
        if (!revision.replacementText) section.append(el('p', 'The replacement is empty. Accepting after review will delete the selected passage.', 'drafting-warning'));
        revisionActions.push(refreshAction); refreshAction();
      }
      if (integrated) section.append(messageDetails);
      transcript.append(section);
    });
  }
  async function loadChat(id: string, fromPicker = false) {
    if (!live() || !durable) return;
    const repositoryId = session!; resetContents(); const epoch = ++chatVersion;
    chatBusy = true; threadNote.textContent = 'Loading saved chat…'; update();
    try {
      const saved = await core.readChatThread!(repositoryId, id);
      if (!live() || session !== repositoryId || chatVersion !== epoch) return;
      if (saved.thread.id !== id || saved.thread.schemaVersion !== 1 || !Array.isArray(saved.events)) throw new Error('Invalid saved chat');
      const answers = new Map(saved.events.filter(event => event.kind === 'answer').map(event => [event.requestId, event.data as QuestionAnswer]));
      const failures = new Set(saved.events.filter(event => event.kind === 'error').map(event => event.requestId));
      for (const event of saved.events.filter(event => event.kind === 'question')) {
        const data = event.data as {question?: unknown; context?: unknown; sourcePath?: unknown};
        if (event.schemaVersion !== 1 || typeof data?.question !== 'string' || !plainUnicode(data.question) || questionBytes(data.question) > QUESTION_LIMITS.question || typeof data.context !== 'string' || questionBytes(data.context) > QUESTION_LIMITS.context) throw new Error('Invalid saved message');
        const answer = answers.get(event.requestId);
        if (answer) {
          if (answer.requestId !== event.requestId || typeof answer.text !== 'string' || !plainUnicode(answer.text) || questionBytes(answer.text) > QUESTION_LIMITS.answer || typeof answer.model !== 'string' || typeof answer.incomplete !== 'boolean') throw new Error('Invalid saved answer');
          turns.push({question:data.question, answer, contextBytes:questionBytes(data.context), savedContext:data.context});
        } else {
          const section = el('section'); section.append(el('h4', failures.has(event.requestId) ? 'Message saved · Request failed or canceled' : 'Message saved · No completed answer recorded'), preview(data.question, 'Unanswered message'), el('p', 'This message is kept on disk and is not included in follow-up history. No request is retried automatically.', 'muted')); chatAttempts.append(section);
        }
      }
      chatId = id; currentTitle.textContent = saved.thread.title; threadSelect.value = id; renderTranscript();
      const leavingThreadPicker = fromPicker || threadControls.contains(document.activeElement);
      threadControls.hidden = true; savedChats.setAttribute('aria-expanded', 'false');
      if (leavingThreadPicker) savedChats.focus({preventScroll: true});
      requestAnimationFrame(() => { if (live() && chatId === id) { if (leavingThreadPicker) savedChats.focus({preventScroll: true}); if (document.activeElement === question && question.value) { element.scrollTop = Math.max(0, composer.offsetTop - header.offsetHeight - 16); } else revealLatest(document.activeElement === question); } });
      threadNote.textContent = `Saved chat: ${saved.thread.title} · ${turns.length} answered ${turns.length === 1 ? 'message' : 'messages'} loaded.`;
      status.textContent = 'Chat reopened from the repository. Write a follow-up or start a new chat.';
    } catch {
      if (live() && session === repositoryId && chatVersion === epoch) { chatError = true; turns = []; transcript.replaceChildren(); chatAttempts.replaceChildren(); threadNote.textContent = 'This chat could not be loaded. Files were preserved. Reload chats or start a new chat.'; }
    } finally { if (live() && chatVersion === epoch) { chatBusy = false; update(); } }
  }
  async function refreshChats(resumeLatest: boolean) {
    if (!live() || !durable) return;
    const repositoryId = session!; const selected = chatId; const epoch = ++chatVersion;
    chatBusy = true; chatError = false; threadNote.textContent = 'Reading repository chats…'; update();
    try {
      const threads = await core.listChatThreads!(repositoryId);
      if (!live() || session !== repositoryId || chatVersion !== epoch || chatRepository !== repositoryId) return;
      threadSelect.replaceChildren(); const fresh = el('option', 'New chat'); fresh.value = ''; threadSelect.append(fresh);
      for (const thread of threads) { const option = el('option', `${thread.title} · ${new Date(thread.createdAt).toLocaleDateString()}`); option.value = thread.id; threadSelect.append(option); }
      threadSelect.value = selected ?? '';
      const resume = integrated ? null : selected ?? (resumeLatest ? threads[0]?.id : null);
      if (resume) { await loadChat(resume); return; }
      threadNote.textContent = 'New chat. Your first message creates a thread in .heinlein/chats/.';
    } catch {
      if (live() && chatVersion === epoch) { chatError = true; threadNote.textContent = 'Repository chats could not be read. No files were changed. Reload chats before sending.'; }
    } finally { if (live() && chatVersion === epoch) { chatBusy = false; update(); } }
  }
  function passageStale(passage: Passage) {
    const current = hooks.current(); const binding = hooks.selectionState?.();
    return passage.stale ||= !current || current.repositoryId !== passage.scene.repositoryId || current.path !== passage.scene.path || current.source !== passage.scene.source || Boolean(passage.binding && (!binding || binding.documentEpoch !== passage.binding.documentEpoch || binding.revision !== passage.binding.revision));
  }
  function stashPassage() {
    if (!activePassage) return;
    Object.assign(activePassage, {turns, context, contextLabel, contextVersion, target, mode: mode.value, draft: question.value, chatId, title: currentTitle.textContent ?? '', status: status.textContent ?? ''});
  }
  function passageItems(): PassageItem[] {
    return passages.map(p => ({id: p.id, from: p.scene.from, to: p.scene.to, active: p === activePassage && !element.hidden, stale: passageStale(p), label: passageStale(p) ? 'Source changed' : p === activePassage && (pending || preparing) ? 'Asking…' : p.turns.some(t => t.revision && !t.revision.rejected) ? `${p.turns.filter(t => t.revision && !t.revision.rejected).length} suggestion${p.turns.filter(t => t.revision && !t.revision.rejected).length === 1 ? '' : 's'}` : p.turns.length ? 'Answer ready' : 'Ask about passage'}));
  }
  function notifyPassages() {
    if (!integrated || notifying) return; notifying = true;
    queueMicrotask(() => {
      notifying = false; if (disposed) return; stashPassage();
      // One shared session budget, including inactive drafts, context, and replacements.
      const size = (p: Passage) => questionBytes(p.context) + questionBytes(p.draft) + questionBytes(p.scene.source.slice(p.scene.from, p.scene.to)) + p.turns.reduce((n,t) => n + questionBytes(t.question) + questionBytes(t.answer.text) + questionBytes(t.savedContext ?? '') + questionBytes(t.revision?.replacementText ?? '') + questionBytes(t.revision?.snapshot.selectedText ?? ''), 0);
      while (passages.length > 1 && (passages.reduce((n,p) => n + size(p), 0) > QUESTION_LIMITS.memory || passages.reduce((n,p) => n + p.turns.length, 0) > 4 || passages.length > 4)) {const index = passages.findIndex(p => p !== activePassage); if (index < 0) break; passages.splice(index, 1);}
      let trimmed = false;
      while (activePassage && size(activePassage) > QUESTION_LIMITS.memory && turns.length) {turns.shift(); forgotten++; trimmed = true;}
      if (trimmed) {renderTranscript(); status.textContent = 'Earlier passage responses were released to keep this window within its memory limit. Saved proposals remain in Proposed revisions.';}
      const items = passageItems(); passagePicker.hidden = items.length < 2 && !items.some(item => item.stale); passageSummary.textContent = `Passages · ${items.length}`;
      passageButtons.replaceChildren();
      items.forEach((item, index) => {const pick = button(`Passage ${index + 1} · ${item.label}`, () => activatePassage(item.id)); pick.setAttribute('aria-pressed', String(item.active)); passageButtons.append(pick);});
      hooks.passages?.changed(items);
    });
  }
  function activatePassage(id: string) {
    const passage = passages.find(p => p.id === id); if (!passage || disposed || fullReviewCancel) return;
    if ((pending || preparing || authBusy || chatBusy || turns.some(t => t.revision?.busy)) && passage !== activePassage) {open(); status.textContent = 'Wait for the current request or choose Cancel request before opening another passage.'; return;}
    stashPassage();
    activePassage = passage;
    ({turns, context, contextLabel, contextVersion, target, chatId} = passage); mode.value = passage.mode; question.value = passage.draft; questionLabel.firstChild!.textContent = turns.length ? 'Ask a follow-up' : 'Your message'; currentTitle.textContent = passage.title; status.textContent = passage.status;
    defaultContext = false;
    if (!passageStale(passage)) hooks.passages?.select(passage.scene.from, passage.scene.to);
    renderTranscript(); open(); passagePicker.open = passages.length > 1; update();
  }
  function activateSelection(scene: QuestionScene) {
    if (fullReviewCancel) return false;
    const existing = passages.find(p => !passageStale(p) && p.scene.from === scene.from && p.scene.to === scene.to);
    if (existing) {activatePassage(existing.id); return true;}
    if (pending || preparing || authBusy || chatBusy || turns.some(t => t.revision?.busy)) {open(); status.textContent = 'Wait for the current request or choose Cancel request before starting another passage.'; return false;}
    stashPassage(); open();
    const passage: Passage = {id: `passage-${++passageId}`, scene: {...scene}, binding: hooks.selectionState?.() ?? null, turns: [], context: scene.source.slice(scene.from, scene.to), contextLabel: 'Selected passage only', contextVersion: contextVersion + 1, target: null, mode: 'ask', draft: '', chatId: null, title: 'Selected passage', status: '', stale: false};
    passages.push(passage); activatePassage(passage.id); sendPreview.open = false; return true;
  }
  function collapse() {
    if (disposed) return;
    fullReviewCancel?.(); stashPassage(); element.hidden = true; hooks.visibilityChanged?.(false); notifyPassages(); hooks.focusEditor();
  }
  function presentReview(view: ProposalReview, shown?: Revision): Promise<boolean> {
    fullReviewCancel?.();
    if (shown && view.kind !== 'revert') {
      const {source, from, to} = shown.snapshot;
      if (view.baseText === source && view.replacementText === source.slice(0, from) + shown.replacementText + source.slice(to)) return Promise.resolve(true);
    }
    return new Promise(resolve => {
      const prior = [...element.children].filter(child => child !== header && child !== fullReview).map(child => [child as HTMLElement, (child as HTMLElement).hidden] as const);
      prior.forEach(([child]) => {child.hidden = true;}); fullReview.hidden = false;
      const title = el('h3', 'Review whole-scene revision'); title.tabIndex = -1;
      fullReview.replaceChildren(title, el('p', view.path), createQuestionComparison(view.baseText, view.replacementText, true));
      let done = false;
      const finish = (accepted: boolean) => {if (done) return; done = true; fullReviewCancel = null; fullReview.hidden = true; fullReview.replaceChildren(); prior.forEach(([child, hidden]) => {child.hidden = hidden;}); resolve(accepted); if (!element.hidden) question.focus({preventScroll: true});};
      const bindings = el('details', '', 'question-review-bindings');
      const attribution = view.origin.kind === 'nativeOpenAi' ? `Native OpenAI suggestion · ${view.origin.model} · ${view.origin.requestId}. Provider metadata is not authenticated authorship.` : `Unverified local MCP client: ${view.origin.clientLabel} · ${view.origin.sessionId}`;
      bindings.append(el('summary', 'Review details'), el('p', attribution), el('p', `Proposal: ${view.proposalId} · Base: ${view.baseHash} · Replacement: ${view.replacementHash} · Diff: ${view.diffHash}`, 'path')); fullReview.append(bindings);
      fullReviewCancel = () => finish(false);
      fullReview.append(button('Back', () => finish(false)), button('Apply…', () => finish(true), 'primary'));
      title.focus({preventScroll: true}); element.scrollTop = 0;
    });
  }
  function close(returnFocus = false) {
    if ((authBusy === 'connect' || configuration?.signInPending) && core.cancelQuestionSignIn) {
      try {void core.cancelQuestionSignIn().catch(() => {});} catch { /* UI invalidation still wins */ }
    }
    fullReviewCancel?.(); passages.length = 0; activePassage = null;
    const wasOpen = !element.hidden; resetContents(); statusVersion++; checking = false; configuration = null;
    threadControls.hidden = true; savedChats.setAttribute('aria-expanded', 'false');
    authBusy = null; seenConnection = null; seenChatIdentity = null; selectedAccountId = null; reauthorizing = false; addingAccount = false; consent.checked = false; accounts.replaceChildren(); models.replaceChildren(); connection.textContent = '';
    element.hidden = true; session = null; sessionPath = null; status.textContent = ''; hooks.visibilityChanged?.(false); notifyPassages();
    if (wasOpen && returnFocus) hooks.focusEditor();
  }
  function open() {
    if (disposed) return;
    if (!element.hidden) {question.focus({preventScroll: true}); return;}
    const current = hooks.current(); if (!current) return;
    if (integrated && session === current.repositoryId && sessionPath === current.path) {element.hidden = false; hooks.visibilityChanged?.(true); presentation(); update(); if (!fullReviewCancel) question.focus({preventScroll: true}); return;}
    if (integrated && session) close();
    session = current.repositoryId; sessionPath = current.path; element.hidden = false;
    if (durable) { chatRepository = session; if (!integrated) void refreshChats(true); } hooks.visibilityChanged?.(true); update();
    question.focus({preventScroll: true}); void checkStatus();
  }
  return {element,
    open,
    selectionVersion: () => contextVersion,
    stateChanged() {notifyPassages(); if (integrated && session && !live()) {close(); return;} if (live()) { refreshDefaultContext(); if (defaultContext || integrated) update(); else if (mode.value === 'revision' || revisionActions.length) updateRevisionState(); }},
    /** The caller captures and rechecks editor revision/selection before this synchronous boundary. */
    openSelection(expected: QuestionScene, expectedContextVersion = contextVersion) {
      const current = hooks.current();
      if (disposed || expectedContextVersion !== contextVersion || !current?.canCapture || current.repositoryId !== expected.repositoryId || current.path !== expected.path ||
        current.source !== expected.source || current.from !== expected.from || current.to !== expected.to) return false;
      const text = current.source.slice(current.from, current.to);
      if (!Number.isSafeInteger(current.from) || !Number.isSafeInteger(current.to) || current.from < 0 || current.to > current.source.length || current.to <= current.from || !plainUnicode(text) || questionBytes(text) > QUESTION_LIMITS.context) {
        status.textContent = `Select a nonempty passage of complete characters, up to ${QUESTION_LIMITS.context.toLocaleString()} UTF-8 bytes. Nothing was sent.`; return false;
      }
      if (integrated) return activateSelection(expected);
      open();
      if (authBusy || configuration?.signInPending) {status.textContent = 'Finish or cancel the account connection before capturing a selection.'; return false;}
      const canceled = Boolean(pending) || preparing; const wasRevision = pendingRevision; if (canceled) cancelPending(true);
      capture('selection'); question.focus({preventScroll: true});
      if (canceled) status.textContent = `Previous request stopped locally; it may still count toward plan usage.${wasRevision ? ' A pending suggestion may already exist; check Proposed revisions.' : ''} Selection captured. Write your question, then explicitly choose Send.`;
      return true;
    },
    visible: () => !element.hidden,
    close: () => integrated ? collapse() : close(true),
    activatePassage,
    passageItems,
    activity: () => pending || preparing ? 'Asking…' : turns.length ? 'Answer ready' : '',
    presentReview,
    /** Switches Ask / Suggest revision exactly as choosing it from the Response mode menu. */
    setMode(value: 'ask' | 'revision') { if (mode.value !== value && !mode.disabled) { mode.value = value; mode.dispatchEvent(new Event('change')); } },
    clear: () => close(), destroy: () => {close(); headerObserver?.disconnect(); textObserver.disconnect(); window.removeEventListener('resize', presentation); layoutQuery?.removeEventListener?.('change', presentation); disposed = true; element.remove();},
  };
}
