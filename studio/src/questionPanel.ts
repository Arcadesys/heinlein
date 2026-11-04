import {readThreads,putThread,removeThread,type WriterThread,type ThreadScope} from './threadStore';
import {conversationKey,loadConversation,saveConversation} from './questionHistoryStore';
import {createQuestionComparison, createQuestionDiffChips} from './questionDiff';
import type {ProposalReview} from './localCore';
import {renderQuestionAnswer} from './questionAnswer';
import {createHeinleinHeader, setHeinleinStatus} from './heinleinHeader';
import './heinleinPane.css';
import {captureSelectionQuestion, selectionQuestionAvailability, selectionQuestionProblem, type SelectionQuestionSnapshot, type SelectionQuestionState} from './selectionQuestion';
import type {LocalCore, QuestionRevisionAnswer, QuestionAnswer, QuestionConnection, QuestionMessage, QuestionRequest, QuestionStatus} from './localCore';

/** These are UTF-8 byte limits, shared with the native provider boundary. */
export const QUESTION_LIMITS = Object.freeze({question: 4000, context: 16000, input: 32000, scene: 64000, sceneInput: 96000, history: 8, answer: 32000, memory: 64000});
export const questionBytes = (text: string) => new TextEncoder().encode(text).length;
export interface QuestionScene {
  repositoryId: string; projectKey?: string; path: string; source: string; from: number; to: number;
  canCapture: boolean;contextLabel?:string;
}
export interface PassageItem {id: string; from: number; to: number; label: string; active: boolean; stale: boolean}
export interface QuestionPanelHooks {
  rail?:boolean;
  closePane?():void;
  threadScope?(): ThreadScope | null;
  threadsChanged?(): void;
  passages?: {select(from: number, to: number): void; changed(items: PassageItem[]): void};
  current(): QuestionScene | null;
  focusEditor(): void;
  selectionState?(reviewing?: boolean): SelectionQuestionState | null;
  revisionUnavailable?(reviewing?: boolean): string | null;
  prepareRevision?(snapshot: SelectionQuestionSnapshot): Promise<void>;
  reviewRevision?(proposalId: string, snapshot: SelectionQuestionSnapshot, guard: () => string | null, presenter?: (view: ProposalReview) => Promise<boolean>): Promise<void>;
  visibilityChanged?(open: boolean): void;
  headerTabs?: HTMLElement;
  copyPrompt?(): void;
}
interface Revision {snapshot: SelectionQuestionSnapshot; contextVersion: number; proposalId: string; replacementText: string; rejected: boolean; busy: boolean}
interface Turn { question: string; answer: QuestionAnswer; contextBytes: number; scenePath?: string; proposalId?: string; revision?: Revision }
function plainUnicode(text: string) {
  return new TextDecoder('utf-8', {ignoreBOM: true}).decode(new TextEncoder().encode(text)) === text;
}
export function questionProblem(question: string, context: string, contextLimit: number = QUESTION_LIMITS.context): string | null {
  if (!question.trim()) return 'Write a question before sending.';
  if (questionBytes(question) > QUESTION_LIMITS.question) return `The question exceeds ${QUESTION_LIMITS.question.toLocaleString()} UTF-8 bytes. Shorten it before sending.`;
  if (questionBytes(context) > contextLimit) return 'The context is too large. Capture a shorter selection.';
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
  const unified = Boolean(hooks.headerTabs);
  const element: HTMLElement = el(integrated ? 'div' : 'aside', '', 'question-panel'); element.hidden = true;
  element.setAttribute('aria-label', 'Drafting questions');
  if (integrated) element.classList.add('question-panel-integrated');
  let disposed = false; let session: string | null = null; let version = 0; let statusVersion = 0;
  let configuration: QuestionStatus | null = null; let checking = false;
  let authBusy: 'connect' | 'account' | 'model' | 'signout' | null = null;
  let seenConnection: string | null = null;
  let selectedAccountId: string | null = null; let reauthorizing = false; let addingAccount = false;
  let storedKey: string | null = null; let storageFailed = false;
  let selectedThread: WriterThread | null = null; let threadProject: string | null = null; let forceNewThread = false;let reopenThread = false;
  let contextMode: 'scene' | 'snapshot' | 'none' = 'scene';
  let context = ''; let contextLabel = 'None. No manuscript text will be sent.';
  let contextVersion = 0; let preparing = false;
  let target: SelectionQuestionState | null = null;
  const revisionActions: (() => void)[] = [];
  let turns: Turn[] = []; let forgotten = 0; let pending: QuestionRequest | null = null; let pendingRevision = false;
  interface Passage {thread?:WriterThread; id: string; scene: QuestionScene; binding: SelectionQuestionState | null; turns: Turn[]; context: string; contextLabel: string; contextVersion: number; contextMode: 'scene' | 'snapshot' | 'none'; target: SelectionQuestionState | null; mode: string; draft: string; title: string; status: string; stale: boolean}
  const passages: Passage[] = []; let passageId = 0; let activePassage: Passage | null = null; let sessionPath: string | null = null;
  let notifying = false; let fullReviewCancel: (() => void) | null = null;
  const passagePicker = el('details', '', 'question-passage-picker'); passagePicker.hidden = !integrated;
  const passageSummary = el('summary', 'Passages'); const passageButtons = el('div', '', 'question-passage-list'); passagePicker.append(passageSummary, passageButtons);
  const fullReview = el('section', '', 'question-full-review'); fullReview.hidden = true; fullReview.setAttribute('aria-label', 'Review whole-scene revision');
  let projectTurns: Turn[] = [];
  const currentTitle = el('p', 'Selected passage', 'question-current-title');
  let showSettings = false;
  const connectionArea = el('section', '', 'question-connection-area'); connectionArea.setAttribute('aria-label', 'Account and storage');
  const body = el('div', '', 'heinlein-body');
  const threadBanner=el('p','','question-thread-scope');threadBanner.hidden=!hooks.threadScope;
  const settingsToggle = button(unified ? '' : 'Connect ChatGPT', () => {showSettings = !showSettings; update(); if (showSettings) {body.scrollTop = 0; connectionArea.querySelector<HTMLElement>('button, summary')?.focus({preventScroll:true});}}, 'question-settings-toggle');
  // The unified pane shares one compact header with Heinlein Review.
  const header = unified ? createHeinleinHeader({tabs: hooks.headerTabs!, status: settingsToggle, close: () => {collapse();hooks.closePane?.();}}) : el('div', '', 'question-heading');
  const heading = el('div'); heading.append(el('h3', 'Writing conversation'), el('p', hooks.threadScope ? 'Conversation attached to this scene or chapter.' : 'Project conversation · shared across scenes.', 'muted'));
  const closeButton = unified ? header.querySelector<HTMLButtonElement>('.heinlein-close')! : button(integrated ? 'Collapse' : 'Close questions', () => integrated ? collapse() : close(true));
  if (unified) {setHeinleinStatus(settingsToggle, 'checking', 'Checking connection');} else if (integrated) header.append(el('h3', 'Questions'), closeButton); else header.append(heading, closeButton);
  const connection = el('p', '', 'question-connection'); connection.setAttribute('role', 'status');
  // The unified pane shows who and which model at a glance, then setup as numbered steps.
  const accountCard = el('div', '', 'heinlein-account'); const accountAvatar = el('span', '', 'heinlein-account-avatar'); accountAvatar.setAttribute('aria-hidden', 'true');
  const accountName = el('span', '', 'heinlein-account-name'); const accountModel = el('span', '', 'heinlein-account-model'); const accountState = el('span', '', 'heinlein-account-state');
  const accountText = el('div', '', 'heinlein-account-text'); accountText.append(accountName, accountModel); accountCard.append(accountAvatar, accountText, accountState);
  let setupSteps: HTMLElement[] = [];
  const refresh = button('Recheck OpenAI setup', () => { void checkStatus(true); });
  const auth = el('details', '', 'question-auth'); auth.setAttribute('aria-label', 'ChatGPT connection'); auth.open = true;
  auth.append(el('summary', integrated ? 'Connection settings' : 'ChatGPT account & model'));
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
    persist(); storedKey=null; resetContents(); selectedAccountId = null; reauthorizing = true; addingAccount = true; consent.checked = false; accounts.value = '';
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
    if (!accountId) {persist(); storedKey=null; resetContents(); selectedAccountId = null; reauthorizing = true; addingAccount = false; consent.checked = false; status.textContent = 'Choose a saved account or Add ChatGPT account before connecting.'; update(); return;}
    const account = configuration?.accounts.find(value => value.id === accountId);
    if (account && (!account.signedIn || !account.planEnabled)) {
      persist(); storedKey=null; resetContents(); selectedAccountId = account.id; reauthorizing = true; addingAccount = false; consent.checked = false;
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
  const accountActions = el('div', '', 'question-actions'); accountActions.append(refresh, signOut, usage);
  auth.append(el('p', 'Continue opens ChatGPT sign-in in your browser. Sign-in tokens stay in the native host and are never exposed here. Choose an account and model below before sending; requests use that account’s plan allowance.', 'muted'), consentLabel, connectActions, accountLabel, modelLabel, accountActions);
  const modeLabel = el('label', 'Response mode'); const mode = el('select'); mode.setAttribute('aria-label', 'Response mode');
  for (const [value, label] of [['ask', 'Ask'], ['revision', 'Suggest revision']]) {const option = el('option', label); option.value = value; mode.append(option);}
  modeLabel.append(mode);
  const targetSection = el('section', '', 'question-revision-target'); targetSection.setAttribute('aria-label', 'Revision target'); targetSection.hidden = true;
  const targetText = preview('', 'Exact revision target'); const targetNote = el('p', '', 'muted');
  targetSection.append(el('h4', 'Selected passage to revise'), targetText, targetNote);
  const questionLabel = el('label'); questionLabel.append(el('span', 'Message', unified ? 'sr-only' : ''));
  const question = el('textarea'); question.rows = 2; question.setAttribute('aria-label', 'Your drafting question');
  question.placeholder = 'Ask about an idea, a detail, or where to go next…'; questionLabel.append(question);
  const count = el('p', '', 'muted'); const requestNote = el('p', '', 'question-request-note'); requestNote.setAttribute('role', 'status');
  const contextHeading = el('summary', 'Add writing context');
  const contextDetails = el('details', '', 'question-context');
  const contextSource = el('p', contextLabel, 'muted');
  const contextText = preview('', 'Exact context to send'); contextText.hidden = true;
  const captureSelection = button('Capture selected text', () => capture('selection'));
  const captureScene = button('Capture current scene', () => capture('scene'));
  const removeContext = button('Remove context', () => {contextMode = 'none'; contextVersion++; context = ''; contextLabel = mode.value === 'revision' ? 'None. No additional manuscript context will be sent.' : 'None. No manuscript text will be sent.'; update();});
  const followScene = button('Use current scene automatically', () => {if(pending||preparing||authBusy)return;contextMode = 'scene'; contextVersion++; update();});
  const contextActions = el('div', '', 'question-actions'); contextActions.append(followScene, captureSelection, captureScene, removeContext);
  const historyDetails = el('details', '', 'question-history-preview');
  const historySummary = el('summary', 'Conversation history to send');
  const historyText = el('div'); historyText.setAttribute('aria-label', 'Exact conversation history to send');
  const historyNote = el('p', '', 'muted'); historyDetails.append(historySummary, historyNote, historyText);
  const disclosure = el('p', 'Send shares your exact question, any revision target, the context preview, and the history preview with OpenAI using the selected ChatGPT account and model. Requests consume that plan’s usage allowance; account limits apply. Each request allows up to 2,000 output tokens. Manage ChatGPT usage to review usage or revoke access.', 'drafting-warning');
  const guidance = el('p', 'Nothing is sent while you type or open this panel. Ask returns structured advice, quoted evidence and optional wording changes shown as diff chips. Suggest revision prepares exact-text patches in a saved proposal for your review, followed by a separate native author confirmation. It never applies an answer automatically.', 'muted');
  const status = el('p', '', 'question-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const send = button('Send to OpenAI', () => { void submit(); }, 'primary');
  const cancel = button('Cancel request', () => {
    if (!pending && !preparing) return;
    const wasSent = Boolean(pending); const wasRevision = pendingRevision; cancelPending(true);
    status.textContent = !wasSent ? 'Local preparation canceled. No request was sent.' : wasRevision ? 'Stopped locally. A pending suggestion may already have been recorded; check Proposed revisions. OpenAI usage may still count. Your manuscript was not changed.' : 'Canceled locally. OpenAI may already have processed the request; it can still count toward your plan usage.'; update();
  }); cancel.hidden = true;
  const reset = button('Clear conversation', () => {
    if (storedKey) {try {localStorage.removeItem(storedKey);if(selectedThread&&threadProject){removeThread(threadProject,selectedThread.id);hooks.threadsChanged?.();}storageFailed=false;persistence.textContent='Saved conversation cleared.';} catch {storageFailed=true;persistence.textContent='Saved conversation could not be cleared. Try again before closing.';return;}}
    fullReviewCancel?.();
    const wasPending = Boolean(pending); const wasRevision = pendingRevision; resetContents();
    if(hooks.threadScope){storedKey=null;if(configuration)restoreConversation(configuration);}
    update();
    status.textContent = wasPending ? 'Conversation cleared and request canceled locally. Previously sent text cannot be recalled from OpenAI.' : 'Conversation cleared from this project’s saved chat. Previously sent text cannot be recalled from OpenAI.';
    if (wasRevision) status.textContent += ' A pending suggestion may already have been recorded; check Proposed revisions.';
    update(); question.focus({preventScroll: true});
  });
  const latestReply = button('Read latest reply', () => (integrated ? transcript.firstElementChild : transcript.lastElementChild)?.scrollIntoView({block: 'start'})); latestReply.hidden = true;
  const actions = el('div', '', 'question-actions question-send-actions'); actions.append(send, cancel, button('Return to writing', () => hooks.focusEditor()), latestReply);
  const transcript = el('section', '', 'question-transcript'); transcript.setAttribute('aria-label', 'Question conversation');
  const streaming = el('section', '', 'question-stream-preview'); streaming.hidden = true;
  const streamingLabel = el('h4', 'OpenAI · Streaming answer');
  const streamingText = preview('', 'Live answer preview');
  streaming.setAttribute('aria-busy', 'false'); streaming.append(streamingLabel, streamingText);
  const lifetime = el('p', 'Questions and answers are saved on this Mac for this project, account and model, including across scene changes and app restarts. The latest 100 turns are retained within 512 KB. Only recent messages that fit the request limit are sent. Exact scene snapshots and revision targets are not stored in chat history; saved revision proposals remain in Proposed revisions. Clear conversation removes this saved chat.', 'muted');
  const settings = el('details', '', 'question-settings'); settings.append(el('summary', 'Connection & conversation details'), connection, auth, guidance, count, historyDetails, disclosure, lifetime, reset);
  const welcome = el('section', '', 'question-welcome'); welcome.append(el('h4', 'A second pair of eyes'), el('p', 'Explore an idea, work through a scene, or ask what a reader might notice.'));
  const starters = el('div', '', 'question-starters');
  for (const [label, prompt] of [['Explore an idea', 'Help me think through this idea: '], ['Find the tension', 'Where could the tension be stronger in this passage?'], ['Talk through a scene', 'Help me work out what should happen next in this scene.']]) {
    starters.append(button(label, () => { question.value = prompt; update(); question.focus({preventScroll: true}); }));
  }
  welcome.append(starters, el('p', 'Add context below when you want to discuss your writing. Nothing is sent until you choose Send.', 'muted'));
  const waiting = el('div', '', 'question-waiting'); waiting.hidden = true; waiting.setAttribute('role', 'status');
  const conversation = el('div', '', 'question-conversation'); conversation.tabIndex = 0; conversation.setAttribute('aria-label', 'Conversation'); conversation.append(welcome, transcript, waiting, streaming);
  contextDetails.append(contextHeading, contextSource, contextActions, contextText);
  const composer = el('section', '', 'question-composer'); composer.setAttribute('aria-label', 'Write a message');
  const composerTop = el('div', '', 'question-composer-top'); composerTop.append(modeLabel);
  const contextSummary = el('p', '', 'question-context-summary');
  composer.append(contextDetails, targetSection, questionLabel, composerTop, requestNote, contextSummary, actions, status);
  const askButton = button('Ask', () => submitAs('ask'), 'primary heinlein-ask');
  const suggestButton = button('Suggest edits', () => submitAs('revision'));
  const passageQuote = el('blockquote', '', 'question-passage-quote'); passageQuote.setAttribute('aria-label', 'Selected passage'); passageQuote.hidden = true;
  const passageNote = el('p', '', 'question-request-note'); passageNote.hidden = true;
  const persistence = el('p', '', 'question-persistence'); persistence.setAttribute('role', 'status');
  // Context chips summarize what Ask sends; each reuses an existing capture or remove control.
  const chips = el('div', '', 'heinlein-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Context to send');
  function chip(remove: HTMLButtonElement, label: string) {const node = el('span', '', 'heinlein-chip'); const text = el('span'); const x = button('', () => remove.click(), 'heinlein-chip-remove'); x.setAttribute('aria-label', label); x.append(chipIcon()); node.append(text, x); return {node, text, x};}
  function chipIcon() {const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 10 10'); svg.setAttribute('aria-hidden', 'true'); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M1 1l8 8M9 1L1 9'); svg.append(path); return svg;}
  function addChip(label: string, action: () => void) {const node = button('', action, 'heinlein-chip-add'); const plus = el('span', '+ '); plus.setAttribute('aria-hidden', 'true'); node.append(plus, el('span', 'Add ', 'sr-only'), document.createTextNode(label)); return node;}
  const passageChip = chip(removeContext, 'Remove passage'); const sceneChip = chip(removeContext, 'Remove whole scene');
  const addScene = addChip('Whole scene', () => captureScene.click());
  const addPassage = addChip('Passage', () => {
    if (!live() || pending || preparing || authBusy || !activePassage || passageStale(activePassage)) return;
    contextMode = 'snapshot'; contextVersion++; context = activePassage.scene.source.slice(activePassage.scene.from, activePassage.scene.to); contextLabel = 'Selected passage only'; update();
  });
  const sendNote = el('div', '', 'heinlein-send-note'); const sendNoteText = el('span');
  composer.append(persistence);
  if (integrated) {
    welcome.hidden = true; contextHeading.textContent = 'What will be sent';
    contextDetails.classList.add('question-send-preview'); contextDetails.append(targetSection, historyDetails, disclosure);
    connectionArea.append(connection, auth, settings); if(unified) settings.append(reset);
    settings.querySelector('summary')!.textContent = 'Storage and revision safety'; settings.append(persistence);
    const copyPrompt = hooks.copyPrompt ? button('Copy as prompt…', () => hooks.copyPrompt!(), 'question-copy-prompt') : null;
    question.placeholder = 'What would you like to know or change?';
    if (unified) {
      // Conversation scrolls; the composer and what it will send stay pinned below it.
      element.classList.add('heinlein-pane'); connectionArea.classList.add('heinlein-settings');
      const summary = auth.querySelector('summary')!; summary.textContent = 'Account & model';
      consentLabel.lastChild!.textContent = ' Use my ChatGPT plan allowance';
      const step = (n: number, title: string, ...content: HTMLElement[]) => {
        const item = el('li', '', 'heinlein-step'); const marker = el('span', String(n), 'heinlein-step-marker'); marker.setAttribute('aria-hidden', 'true');
        const main = el('div', '', 'heinlein-step-body'); main.append(el('span', title, 'heinlein-step-title'), ...content); item.append(marker, main); return item;
      };
      const steps = el('ol', '', 'heinlein-steps'); steps.setAttribute('aria-label', 'ChatGPT setup');
      setupSteps = [step(1, 'Allow plan use', consentLabel), step(2, 'Sign in', accountLabel, connectActions), step(3, 'Choose a model', modelLabel)];
      steps.append(...setupSteps);
      for (const [control, label] of [[addAccount, '+ Add account'], [refresh, 'Recheck'], [signOut, 'Sign out'], [usage, 'Usage']] as const) {control.setAttribute('aria-label', control.textContent!); control.textContent = label; control.classList.add('ghost');}
      accountActions.classList.add('heinlein-account-actions'); accountActions.prepend(addAccount);
      const privacy = el('p', 'Sign-in stays on this Mac. Questions use your ChatGPT plan allowance.', 'heinlein-privacy');
      auth.replaceChildren(summary, steps, accountActions, privacy);
      connectionArea.prepend(accountCard);
      const shortcut = el('kbd', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↵' : 'Ctrl+↵', 'heinlein-shortcut'); shortcut.setAttribute('aria-hidden', 'true'); askButton.append(shortcut);
      askButton.setAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter'); askButton.title = 'Ask (Cmd/Ctrl+Enter)';
      if (copyPrompt) copyPrompt.classList.add('ghost');
      actions.classList.add('heinlein-send-row'); actions.replaceChildren(askButton, suggestButton, cancel, ...(copyPrompt ? [copyPrompt] : []));
      chips.append(passageChip.node, sceneChip.node, addPassage, addScene);
      sendNote.append(sendNoteText, contextDetails);
      composer.classList.add('heinlein-composer'); composer.replaceChildren(passageQuote, passageNote, chips, questionLabel, requestNote, actions, sendNote, status);
      body.append(el('h3', 'Conversation', 'sr-only'), threadBanner, connectionArea, passagePicker, fullReview, transcript, waiting, streaming);
      element.append(header, body, composer);
    } else {
      composer.replaceChildren(modeLabel, questionLabel, requestNote, actions, contextSummary, contextDetails, status);
      if (copyPrompt) composer.append(copyPrompt);
      element.append(header, passageQuote, passageNote, fullReview, passagePicker, transcript, waiting, streaming, composer, connectionArea);
    }
  } else element.append(header, settings, conversation, composer);

  const layoutQuery = window.matchMedia?.('(max-width: 1399px)');
  let dedicated = false;
  function presentation() {
    // Media-query rem units use the browser's initial font size, not app text zoom.
    const textSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    dedicated = integrated && (Boolean(layoutQuery?.matches) || window.innerWidth < 64 * textSize);
    element.dataset.presentation = dedicated ? 'dedicated' : 'overlay';
    element.setAttribute('role', hooks.rail?'region':integrated ? 'dialog' : 'complementary');
    if (integrated&&!hooks.rail) element.setAttribute('aria-modal', 'true'); else element.removeAttribute('aria-modal');
    if (integrated && !element.hidden && !element.contains(document.activeElement)) closeButton.focus({preventScroll: true});
  }
  layoutQuery?.addEventListener?.('change', presentation); window.addEventListener('resize', presentation); presentation();
  const textObserver = new MutationObserver(presentation);
  textObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['style', 'data-zoom']});
  const headerObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { element.style.setProperty('--question-header-height', `${header.offsetHeight + 16}px`); }); headerObserver?.observe(header);
  element.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !integrated || hooks.rail) return;
    const focusable = [...element.querySelectorAll<HTMLElement>('button, select, textarea, input, summary, [tabindex="0"]')].filter(node => !node.closest('[hidden]') && !node.matches(':disabled') && node.getClientRects().length && !node.closest('details:not([open]) :not(summary)'));
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  question.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && !event.isComposing) {event.preventDefault(); if (unified) {if (!askButton.disabled) submitAs('ask');} else if (!send.disabled) void submit();}
  });
  send.setAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter');
  send.title = 'Send (Cmd/Ctrl+Enter)';
  question.addEventListener('input', () => {update(); persist();});
  mode.addEventListener('change', () => {
    if (!live() || pending || preparing || authBusy) return;
    if (integrated && !activePassage) {const scene = hooks.current(); const requested = mode.value; if (scene && !selectionQuestionAvailability(hooks.selectionState?.() ?? null)) activateSelection(scene); mode.value = requested;}
    contextMode = mode.value === 'revision' ? 'none' : integrated && activePassage ? 'snapshot' : 'scene'; contextVersion++; target = null; context = ''; contextLabel = 'None. No additional manuscript context will be sent.';
    if (mode.value === 'revision') {
      const selected = hooks.selectionState?.();
      if (selected && !selectionQuestionAvailability(selected)) target = {...selected};
      status.textContent = 'Revision mode uses only the exact selected target below, plus any context you explicitly capture. Save first, inspect the preview, then Send.';
    } else {if (integrated && activePassage) {context = activePassage.scene.source.slice(activePassage.scene.from, activePassage.scene.to); contextLabel = 'Selected passage only';} status.textContent = 'Ask mode returns advice only. No revision proposal will be created.';}
    update();
  });
  // Escape is scoped to this panel; the editor keeps all its own shortcuts.
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) {event.preventDefault();event.stopPropagation();if(integrated){collapse();hooks.closePane?.();}else close(true);}
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
  function outgoingHistory() { if (mode.value === 'revision') return []; return questionHistory(messages(), Math.max(0, (mode.value === 'revision' ? QUESTION_LIMITS.input : QUESTION_LIMITS.sceneInput) - questionBytes(question.value) - questionBytes(context) - targetBytes())); }
  function revisionProblem(snapshot?: SelectionQuestionSnapshot, reviewing = false) {
    if(hooks.threadScope?.()?.kind==='chapter')return 'Open a source scene to request a passage revision. Chapter conversations provide advice only.';
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
  function outgoingProblem() {return (selectedThread && configuration && (selectedThread.accountId !== configuration.activeAccountId || selectedThread.model !== configuration.selectedModel) ? 'This saved thread is read-only with the current connection. Switch to its account and model, or start a new conversation.' : null) ?? (contextMode === 'scene' && mode.value !== 'revision' && !hooks.current()?.canCapture ? 'The current scene is unavailable. Open an editable scene or choose Remove context.' : null) ?? questionProblem(question.value, context, contextMode === 'scene' && mode.value !== 'revision' ? QUESTION_LIMITS.scene : QUESTION_LIMITS.context) ?? (mode.value === 'revision' ? revisionProblem() : null) ?? (questionBytes(question.value) + questionBytes(context) + targetBytes() > (mode.value === 'revision' ? QUESTION_LIMITS.input : QUESTION_LIMITS.sceneInput) ? 'The question, target, and context exceed 32,000 UTF-8 bytes. Remove context or shorten the selection.' : null);}
  function refreshSceneContext() {
    if (contextMode !== 'scene' || mode.value === 'revision') return;
    const current = hooks.current();
    context = current?.canCapture ? current.source : '';
    contextLabel = current?.canCapture ? current.contextLabel??`Current scene · ${current.path} · refreshed for each message` : 'Current scene unavailable. Open an editable scene to include it.';
  }
  function persist() {
    if (integrated) projectTurns = activePassage ? [...projectTurns, ...turns.filter(turn => !projectTurns.includes(turn))] : turns;
    if (!storedKey || storageFailed) return;
    try {
      const saved=saveConversation(storedKey,{draft:question.value,forgotten,turns:(integrated ? projectTurns : turns).map(t=>({question:t.question,answer:{requestId:t.answer.requestId,text:t.answer.text,model:t.answer.model,incomplete:t.answer.incomplete,inputTokens:t.answer.inputTokens,outputTokens:t.answer.outputTokens},contextBytes:t.contextBytes,scenePath:t.scenePath,proposalId:t.revision?.proposalId??t.proposalId}))});
      forgotten=saved.forgotten;
      if(integrated) {projectTurns=projectTurns.slice(-saved.turns.length); if(!activePassage)turns=projectTurns;} else if(saved.turns.length<turns.length){turns=turns.slice(-saved.turns.length);renderTranscript();}
      if (selectedThread && threadProject && (saved.turns.length || saved.draft)) {
        const prior=readThreads(threadProject).find(t=>t.id===selectedThread!.id);
        const currentScope=hooks.threadScope?.();const ownedScope=currentScope?.kind===selectedThread.scope.kind&&currentScope.id===selectedThread.scope.id?currentScope:prior?.scope??selectedThread.scope;
        selectedThread={...selectedThread,scope: ownedScope,status:reopenThread?'open':prior?.status??selectedThread.status,title:(saved.turns[0]?.question||saved.draft).slice(0,100)||'Writing conversation',updatedAt:Date.now()};
        putThread(threadProject,selectedThread);reopenThread=false;hooks.threadsChanged?.();
      }
      persistence.textContent='Saved on this Mac.';
    } catch {storageFailed=true;persistence.textContent='Chat could not be saved on this Mac. Keep this panel open and copy any replies you need.';}
  }
  function restoreConversation(next: QuestionStatus) {
    const current=hooks.current();
    if(!current||!next.activeAccountId||!next.selectedModel||!next.accounts.find(a=>a.id===next.activeAccountId)?.signedIn)return;
    const project=current.projectKey??current.repositoryId;
    let key=conversationKey(project,next.activeAccountId,next.selectedModel);
    const scope=hooks.threadScope?.();
    if(scope){
      try {
        const index=readThreads(project);
        const legacy=loadConversation(key);
        if((legacy.turns.length||legacy.draft)&&!index.some(t=>t.storageKey===key))putThread(project,{id:`legacy:${next.activeAccountId}:${next.selectedModel}`,kind:'conversation',title:'Earlier project conversation',scope:{kind:'project',id:'project',label:'Project'},status:'open',updatedAt:0,storageKey:key,accountId:next.activeAccountId,model:next.selectedModel});
        if(!selectedThread||threadProject!==project){
          selectedThread=(!forceNewThread?index.filter(t=>t.kind==='conversation'&&t.status==='open'&&t.scope.kind===scope.kind&&t.scope.id===scope.id&&t.accountId===next.activeAccountId&&t.model===next.selectedModel).sort((a,b)=>b.updatedAt-a.updatedAt)[0]:undefined)??{id:crypto.randomUUID(),kind:'conversation',title:'Writing conversation',scope,status:'open',updatedAt:Date.now(),accountId:next.activeAccountId,model:next.selectedModel};
          selectedThread.storageKey??=key+':thread:'+selectedThread.id;
          threadProject=project;forceNewThread=false;
        }
        key=selectedThread.storageKey!;
      }catch{storageFailed=true;persistence.textContent='Saved threads could not be read. They have not been overwritten.';return;}
    }
    if(storedKey===key)return;
    storedKey=key;storageFailed=false;
    try {const saved=loadConversation(key);projectTurns=saved.turns;if(!integrated||!activePassage)turns=projectTurns;forgotten=saved.forgotten;if(!question.value && (!integrated||!activePassage))question.value=saved.draft;renderTranscript();persistence.textContent='Saved on this Mac.';}
    catch {storageFailed=true;persistence.textContent='Saved chat could not be read. It has not been overwritten. Clear conversation to start again.';}
  }
  function update() {
    if(hooks.threadScope)lifetime.textContent='Each conversation is saved on this Mac with its scene or chapter and account/model. Each thread retains up to 100 turns within 512 KB. Other threads are not sent as history. Exact manuscript snapshots and revision authority are not restored from saved chat.';
    threadBanner.textContent=selectedThread?`${selectedThread.scope.label} · ${selectedThread.title}`:hooks.threadScope?.()?.label??'';
    refreshSceneContext();
    const history = pending?.history ?? outgoingHistory();
    latestReply.hidden = turns.length === 0;
    welcome.hidden = integrated || turns.length > 0 || Boolean(pending) || preparing;
    waiting.hidden = !pending && !preparing;
    waiting.textContent = waiting.hidden ? '' : preparing ? 'Preparing your revision…' : `${pending?.question ?? ''}\n\nThinking… You can keep writing.`;
    contextSummary.textContent = context ? contextMode === 'scene' ? contextLabel : `${contextLabel.split(' snapshot')[0]} attached.` : 'No manuscript text attached.';
    contextHeading.textContent = contextMode === 'scene' ? 'Current scene · inspect or change' : context ? 'Writing context attached · inspect or change' : 'Add writing context';
    settings.open = Boolean(configuration && !connectionReady()) || Boolean(authBusy) || Boolean(configuration?.signInPending) ? true : settings.open;
    const revising = mode.value === 'revision';
    targetSection.hidden = !revising; targetText.textContent = revising && target ? target.source.slice(target.from, target.to) : '';
    targetNote.textContent = revising ? (revisionProblem() ?? `${target!.path} · ${targetBytes().toLocaleString()} UTF-8 bytes. Only this target is replaced; saved source is rechecked before review.`) : '';
    captureSelection.textContent = revising ? 'Capture revision selection' : 'Capture selected text';
    mode.disabled = Boolean(pending) || preparing || Boolean(authBusy);
    const questionSize = questionBytes(question.value);
    count.textContent = `${questionSize.toLocaleString()} / ${QUESTION_LIMITS.question.toLocaleString()} UTF-8 bytes${questionSize > QUESTION_LIMITS.question ? ' · Question is too long' : ''}`;
    contextSource.textContent = contextLabel; contextText.textContent = context; contextText.hidden = !context;
    const missing = messages().length - history.length;
    historySummary.textContent = `Conversation history ${pending ? 'sent' : 'to send'} · ${history.length} messages`;
    historyNote.textContent = mode.value === 'revision' ? 'Revision requests include no conversation history. Only the question, exact target, and optional context preview are sent.' : `Only these previous questions and answers are ${pending ? 'included in this request' : 'sent with your next question'}. Previous context snapshots are not resent.${missing ? ` ${missing} older messages are omitted to fit the request limit.` : ''}${forgotten ? ` ${forgotten} earlier turns were removed from saved history at its storage limit.` : ''}`;
    historyText.replaceChildren();
    if (!history.length) historyText.append(el('p', 'No previous messages included.', 'muted'));
    history.forEach((message, index) => historyText.append(el('h4', message.role === 'user' ? 'You' : 'OpenAI'), preview(message.text, `History message ${index + 1}`)));
    question.disabled = Boolean(pending) || preparing || Boolean(authBusy);
    followScene.disabled = captureSelection.disabled = captureScene.disabled = Boolean(pending) || preparing || Boolean(authBusy);
    removeContext.disabled = Boolean(pending) || preparing || Boolean(authBusy) || (!context && contextMode === 'none');
    const authPending = Boolean(authBusy) || Boolean(configuration?.signInPending);
    refresh.disabled = Boolean(pending) || checking || authPending;
    accounts.disabled = checking || authPending || !core.selectQuestionAccount || !configuration?.accounts.length;
    models.disabled = checking || authPending || reauthorizing || !core.selectQuestionModel || !configuration?.models.length || !activeAccount()?.planEnabled;
    consent.disabled = checking || authPending || !core.available();
    connect.disabled = !live() || checking || authPending || !core.available() || !core.connectQuestionAccount || !core.cancelQuestionSignIn || !consent.checked || (!selectedAccountId && !addingAccount && Boolean(configuration?.accounts.length));
    addAccount.disabled = !live() || checking || authPending || !core.available() || !core.connectQuestionAccount;
    signOut.disabled = checking || authPending || !configuration?.accounts.find(account => account.id === selectedAccountId)?.signedIn || !core.signOutQuestionAccount;
    usage.disabled = !core.available() || !core.openQuestionUsage;
    cancelSignIn.hidden = authBusy !== 'connect' && !configuration?.signInPending;
    cancelSignIn.disabled = !core.cancelQuestionSignIn;
    updateRevisionState();
    cancel.hidden = !pending && !preparing;
    element.setAttribute('aria-busy', String(Boolean(pending) || preparing || checking || authPending));
    if (unified) {
      contextHeading.textContent = 'What will be sent';
      const passage = activePassage;
      passageQuote.hidden = !passage; passageQuote.textContent = passage ? passage.scene.source.slice(passage.scene.from,passage.scene.to) : '';
      passageNote.hidden = !passage || !passageStale(passage);
      passageNote.textContent = passageNote.hidden ? '' : 'This passage changed. Select it again before requesting a rewrite.';
      const ready = connectionReady();
      setHeinleinStatus(settingsToggle, ready ? 'ready' : checking ? 'checking' : 'attention', ready ? `Ready · ${configuration!.model}` : checking ? 'Checking connection' : configuration?.usageLimited ? 'Usage limited' : 'Not connected');
      connectionArea.hidden = ready && !showSettings;
      const account = activeAccount(); const signedIn = Boolean(account?.signedIn && account.planEnabled) && !reauthorizing;
      const name = account && !reauthorizing ? account.label.replace(/\s*\([^)]*\)$/, '') : addingAccount ? 'New account' : 'No account connected';
      accountAvatar.textContent = account && !reauthorizing ? name.charAt(0).toUpperCase() : '?'; accountName.textContent = name; accountName.title = account?.label ?? '';
      accountModel.textContent = configuration?.model ?? ''; accountModel.hidden = !signedIn || !configuration?.model;
      accountLabel.hidden = signedIn && (configuration?.accounts.length ?? 0) < 2;
      accountCard.dataset.state = ready ? 'ready' : checking ? 'checking' : 'attention';
      accountState.textContent = ready ? 'Ready' : checking ? 'Checking…' : configuration?.usageLimited ? 'Usage limited' : 'Setup needed';
      connection.hidden = ready;
      const done = [signedIn || consent.checked, signedIn, ready]; const current = done.indexOf(false);
      setupSteps.forEach((item, index) => {item.dataset.state = done[index] ? 'done' : index === current ? 'current' : 'todo'; item.firstElementChild!.textContent = done[index] ? '✓' : String(index + 1);});
      consentLabel.hidden = connect.hidden = signedIn;
      const snapshotScene = contextMode === 'snapshot' && contextLabel.startsWith('Current scene');
      const passageText = revising ? (target ? target.source.slice(target.from, target.to) : '') : contextMode === 'snapshot' && !snapshotScene ? context : '';
      const sceneAttached = !revising && (contextMode === 'scene' || snapshotScene);
      const words = (text: string) => {const n = text.trim() ? text.trim().split(/\s+/).length : 0; return `${n.toLocaleString()} word${n === 1 ? '' : 's'}`;};
      passageChip.node.hidden = !passageText; passageChip.text.textContent = `Passage · ${words(passageText)}`; passageChip.x.hidden = revising; passageChip.x.disabled = removeContext.disabled;
      const contextName=hooks.current()?.contextLabel??'Whole scene';
      sceneChip.node.hidden = !sceneAttached; sceneChip.text.textContent = context ? `${contextName} · ${words(context)}` : `${contextName} · unavailable`; sceneChip.x.disabled = removeContext.disabled;
      addScene.hidden = revising || contextMode === 'scene'; addScene.disabled = captureScene.disabled;
      addPassage.hidden = revising || contextMode !== 'none' || !passage || passageStale(passage); addPassage.disabled = captureScene.disabled;
      sendNoteText.textContent = `Sends your message${passageText ? ' + the passage' : sceneAttached && context ? hooks.current()?.contextLabel ? ` + ${hooks.current()?.contextLabel}` : ' + the whole scene' : ''} to ChatGPT. `;
      settingsToggle.setAttribute('aria-expanded', String(!connectionArea.hidden));
    }
    notifyPassages();
  }
  function updateRevisionState() {
    const problem = outgoingProblem();
    send.disabled = !live() || checking || Boolean(authBusy) || Boolean(configuration?.signInPending) || !connectionReady() || !core.askQuestion || Boolean(pending) || preparing || Boolean(problem);
    send.title = problem ?? 'Send (Cmd/Ctrl+Enter)'; requestNote.textContent = question.value.trim() ? send.title : ''; requestNote.hidden = !requestNote.textContent;
    if (unified) {
      const blocked = !live() || checking || Boolean(authBusy) || Boolean(configuration?.signInPending) || !connectionReady() || !core.askQuestion || Boolean(pending) || preparing || !question.value.trim();
      askButton.disabled = blocked; suggestButton.disabled = blocked || Boolean(activePassage && passageStale(activePassage)) || !core.suggestQuestionRevision;
      askButton.hidden = suggestButton.hidden = Boolean(pending) || preparing;
      const lengthProblem = questionProblem(question.value, '');
      requestNote.textContent = question.value.trim() && lengthProblem ? lengthProblem : ''; requestNote.hidden = !requestNote.textContent;
    }
    if (mode.value === 'revision') targetNote.textContent = revisionProblem() ?? `${target!.path} · ${targetBytes().toLocaleString()} UTF-8 bytes. Only this target is replaced; saved source is rechecked before review.`;
    for (const refreshAction of revisionActions) refreshAction();
    notifyPassages();
  }
  function submitAs(kind: 'ask' | 'revision') {
    if (!live() || pending || preparing || authBusy) return;
    if (mode.value !== kind) {
      if (kind === 'revision' && activePassage && !passageStale(activePassage)) hooks.passages?.select(activePassage.scene.from, activePassage.scene.to);
      mode.value = kind; mode.dispatchEvent(new Event('change'));
    }
    void submit();
  }
  function capture(kind: 'selection' | 'scene') {
    if (!live() || pending || preparing) return;
    const current = hooks.current();
    if (!current?.canCapture) {status.textContent = 'Open an editable scene and resolve any recovery decision before capturing context.'; return;}
    let captured = current.source;
    if (kind === 'selection') {
      if (!Number.isInteger(current.from) || !Number.isInteger(current.to) || current.from < 0 || current.to > captured.length || current.to <= current.from) {status.textContent = 'Highlight one nonempty passage in the editor, then capture it.'; return;}
      captured = captured.slice(current.from, current.to);
    }
    if (kind === 'scene' && mode.value !== 'revision') {contextMode='scene'; contextVersion++; update(); return;}
    if (!captured || !plainUnicode(captured)) {status.textContent = 'Select complete Unicode characters from a nonempty scene.'; return;}
    if (questionBytes(captured) > QUESTION_LIMITS.context) {
      status.textContent = `This ${kind === 'scene' ? 'scene' : 'selection'} exceeds ${QUESTION_LIMITS.context.toLocaleString()} UTF-8 bytes. Select a shorter passage. The context preview has not changed.`; return;
    }
    if (kind === 'selection' && mode.value === 'revision') {
      const selected = hooks.selectionState?.();
      if (!selected || selected.repositoryId !== current.repositoryId || selected.path !== current.path || selected.source !== current.source || selected.from !== current.from || selected.to !== current.to) {status.textContent = 'The selection changed. Highlight it again.'; return;}
      contextVersion++; target = {...selected}; status.textContent = 'Revision target captured locally. Save the scene, inspect the exact target, then Send.'; update(); return;
    }
    contextMode = 'snapshot'; contextVersion++; context = captured;
    contextLabel = `${kind === 'scene' ? 'Current scene' : 'Selected text'} snapshot · ${current.path} · ${questionBytes(captured).toLocaleString()} UTF-8 bytes. Later editor changes are not included unless you capture again.`;
    status.textContent = 'Context captured locally. Inspect the exact text before sending.'; update();
  }
  function applyConfiguration(next: QuestionStatus) {
    const first = seenConnection === null;
    const key = JSON.stringify([next.generation, next.activeAccountId, next.selectedModel, next.accounts.find(account => account.id === next.activeAccountId)?.planEnabled]);
    if (seenConnection !== null && seenConnection !== key) {persist(); resetContents(); storedKey=null;}
    seenConnection = key; configuration = next; selectedAccountId = next.activeAccountId; reauthorizing = false; addingAccount = false;
    restoreConversation(next);
    const account = activeAccount();
    connection.textContent = `${account && !unified ? `ChatGPT · ${account.label}${next.model ? ` · ${next.model}` : ''}. ` : ''}${next.message}${next.usageLimited ? ' Plan usage is limited. Manage usage or explicitly recheck before trying again.' : ''}`;
    accounts.replaceChildren(); models.replaceChildren();
    const accountPlaceholder = el('option', 'Choose an account'); accountPlaceholder.value = ''; accountPlaceholder.disabled = true; accounts.append(accountPlaceholder);
    next.accounts.forEach(value => {const option = el('option', `${value.label}${!value.signedIn ? ' · signed out' : !value.planEnabled ? ' · plan use disabled' : ''}`); option.value = value.id; accounts.append(option);});
    accounts.value = next.activeAccountId ?? '';
    const modelPlaceholder = el('option', 'Choose a model'); modelPlaceholder.value = ''; modelPlaceholder.disabled = true; models.append(modelPlaceholder);
    next.models.forEach(value => {const option = el('option', value.displayName || value.slug); option.value = value.slug; models.append(option);});
    models.value = next.selectedModel ?? '';
    if (!connectionReady()) { auth.open = true; settings.open = true; }
    else if (first || authBusy === 'connect') { auth.open = false; settings.open = false; }
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
    const epoch = ++statusVersion; authBusy = kind; persist(); resetContents(); storedKey=null; configuration = null; consent.checked = false;
    status.textContent = message; connection.textContent = message; update();
    try {
      const next = await action();
      if (!live() || statusVersion !== epoch) return;
      applyConfiguration(next);
      status.textContent = kind === 'signout' ? 'Signed out of the selected account. Its chat stays saved on this Mac and returns when you sign in.' : 'Connection updated. Review the selected account and model before sending.';
    } catch (error) {
      if (!live() || statusVersion !== epoch) return;
      configuration = null; connection.textContent = 'Connection change was not confirmed. Recheck OpenAI setup before sending.'; status.textContent = errorMessage(error);
    } finally {if (live() && statusVersion === epoch) {authBusy = null; update();}}
  }
  async function cancelConnection() {
    if (!live() || (authBusy !== 'connect' && !configuration?.signInPending) || !core.cancelQuestionSignIn) return;
    const epoch = ++statusVersion; authBusy = null; checking = true; resetContents(); configuration = null; consent.checked = false;
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
  function resetContents() {
    selectedThread=null;threadProject=null;reopenThread=false;forceNewThread=false;threadBanner.textContent='';
    if (integrated) {passages.length = 0; activePassage = null; projectTurns = [];}

    contextMode='scene'; contextVersion++; cancelPending(); mode.value = 'ask'; target = null; targetText.textContent = ''; targetNote.textContent = ''; targetSection.hidden = true; revisionActions.length = 0; turns = []; forgotten = 0; context = ''; contextLabel = 'None. No manuscript text will be sent.'; question.value = ''; question.placeholder = 'Ask about an idea, a detail, or where to go next…'; transcript.replaceChildren(); contextDetails.open = false;
    waiting.textContent = ''; waiting.hidden = true; contextSummary.textContent = ''; streaming.hidden = true; streamingText.textContent = '';
    // Closing also removes private snapshots from hidden DOM, not just state.
    contextText.textContent = ''; contextText.hidden = true; contextSource.textContent = contextLabel;
    historyText.replaceChildren(); historyNote.textContent = ''; historySummary.textContent = 'Conversation history to send · 0 messages';
  }
  async function submit() {
    if (!live() || pending || preparing || checking || authBusy || !connectionReady() || !configuration || !core.askQuestion) return;
    refreshSceneContext();
    const problem = outgoingProblem();
    if (problem) {status.textContent = problem; update(); return;}
    if (!globalThis.crypto?.randomUUID) {status.textContent = 'A secure request identifier is unavailable. Reopen Studio before sending.'; return;}
    const revising = mode.value === 'revision'; const capturedContext = contextVersion;
    const request: QuestionRequest = {requestId: crypto.randomUUID(), question: question.value, context, history: outgoingHistory()};
    const binding: QuestionConnection = {generation: configuration.generation, accountId: configuration.activeAccountId!, model: configuration.model!};
    const epoch = ++version; let snapshot: SelectionQuestionSnapshot | undefined;
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
      preparing = false; pending = request; pendingRevision = Boolean(snapshot); reopenThread=true;persist(); update(); if (unified) body.scrollTop = body.scrollHeight;
      streaming.hidden = true; streamingText.textContent = ''; streamingLabel.textContent = 'OpenAI · Streaming answer';
      const answer = snapshot
        ? await core.suggestQuestionRevision!(request, binding, {repositoryId: snapshot.repositoryId, path: snapshot.path, sourceHash: snapshot.sourceHash, fromUtf8: snapshot.fromUtf8, toUtf8: snapshot.toUtf8, selectedText: snapshot.selectedText})
        : await core.askQuestion(request, binding, text => {
          if (!live() || version !== epoch || pending !== request || typeof text !== 'string' || !plainUnicode(text) || questionBytes(text) > QUESTION_LIMITS.answer) return;
          const first = streaming.hidden;
          streamingText.textContent = text; streaming.hidden = !text; streaming.setAttribute('aria-busy', 'true');
          if (first && text) status.textContent = 'Receiving OpenAI answer… Preview is incomplete until the request finishes.';
        });
      if (!live() || version !== epoch || pending !== request) return;
      if (answer.requestId !== request.requestId) throw new Error('The response did not match this question. It was ignored.');
      if (!answer.text?.trim()) throw new Error('OpenAI returned no text. No retry was sent automatically.');
      if (questionBytes(answer.text) > QUESTION_LIMITS.answer || !plainUnicode(answer.text)) throw new Error('The answer exceeded the safe text limit or contained invalid text. It was not added to the conversation.');
      let revision: Revision | undefined;
      if (snapshot) {
        const result = answer as QuestionRevisionAnswer;
        if (result.incomplete || typeof result.replacementText !== 'string' || !plainUnicode(result.replacementText) || questionBytes(result.replacementText) + questionBytes(result.text) > QUESTION_LIMITS.answer) throw new Error('The revision response was incomplete or invalid. No review was opened.');
        if (result.replacementText !== snapshot.selectedText) {
          if (!result.proposalId) throw new Error('The revision response has no saved proposal.');
          revision = {snapshot, contextVersion: capturedContext, proposalId: result.proposalId, replacementText: result.replacementText, rejected: false, busy: false};
        }
      }
      turns.push({question: request.question, answer, contextBytes: questionBytes(request.context), scenePath: hooks.current()?.path, revision});

      while(turns.reduce((n,t)=>n+(t.revision?questionBytes(t.revision.snapshot.selectedText)+questionBytes(t.revision.replacementText)+questionBytes(t.answer.text):0),0)>QUESTION_LIMITS.memory){const old=turns.find(t=>t.revision);if(!old)break;old.proposalId=old.revision!.proposalId;delete old.revision;}
      question.value = ''; if (integrated) questionLabel.firstChild!.textContent = 'Ask a follow-up'; question.placeholder = 'Ask a follow-up…';
      streaming.hidden = true; streamingText.textContent = ''; streaming.setAttribute('aria-busy', 'false');
      persist(); renderTranscript(); if (unified) body.scrollTop = body.scrollHeight;
      const latest = transcript.lastElementChild as HTMLElement | null;
      if (latest && !integrated && !element.hidden) conversation.scrollTop += latest.getBoundingClientRect().top - conversation.getBoundingClientRect().top - 20;
      status.textContent = revision ? 'Suggested revision recorded. Review it or reject it below. Your manuscript has not been changed.' : answer.incomplete ? 'OpenAI returned an incomplete answer. It is marked below; nothing was retried automatically.' : 'Answer ready. Your manuscript has not been changed.';
    } catch (error) { if (live() && version === epoch) {status.textContent = errorMessage(error); if (!streaming.hidden) { streamingLabel.textContent = 'OpenAI · Interrupted preview · Not added to history'; streaming.setAttribute('aria-busy', 'false'); } void checkStatus();} }
    finally { if (live() && version === epoch) {preparing = false; pending = null; pendingRevision = false; update();} }
  }
  function revisionGuard(revision: Revision, reviewing = false) {
    if (!live() || revision.contextVersion !== contextVersion) return 'The captured context changed. Request a new revision for the current selection.';
    return revisionProblem(revision.snapshot, reviewing);
  }
  function renderTranscript() {
    transcript.replaceChildren(); revisionActions.length = 0;
    (integrated && !unified ? [...turns].reverse() : turns).forEach((turn, index) => {
      const section = el('section', '', 'question-turn');
      const usage = [turn.answer.inputTokens == null ? null : `${turn.answer.inputTokens.toLocaleString()} input tokens`, turn.answer.outputTokens == null ? null : `${turn.answer.outputTokens.toLocaleString()} output tokens`].filter(Boolean).join(' · ');
      const message = preview(turn.question, `Question ${index + 1}`); message.classList.add('question-user-message');
      if (integrated) {section.append(message, ...(unified ? [el('p', 'Heinlein', 'heinlein-answer-label')] : []), renderQuestionAnswer(turn.answer.text, `Answer ${index + 1}`)); if (turn.answer.incomplete) section.append(el('p', 'Incomplete answer', 'drafting-warning'));}
      else section.append(el('h4', 'You'), message, el('h4', turn.answer.incomplete ? 'Heinlein · Incomplete answer' : 'Heinlein'), renderQuestionAnswer(turn.answer.text, `Answer ${index + 1}`));
      const details = el('details', '', 'question-response-details'); details.append(el('summary', 'Response details'), el('p', `${turn.contextBytes.toLocaleString()} UTF-8 bytes of context sent`, 'muted'), el('p', usage || 'Token usage was not returned.', 'muted'));
      const origin = el('p', `Recorded origin: native OpenAI · Model: ${turn.answer.model} · Request: ${turn.answer.requestId}. Provider metadata is not authenticated authorship.`, 'muted'); details.append(origin); section.append(details);
      if(turn.scenePath)section.append(el('p', `Scene: ${turn.scenePath}`, 'muted'));
      if(turn.proposalId&&!turn.revision)section.append(el('p', 'Saved revision suggestion. Open Proposed revisions to review its current status.', 'muted'));
      const revision = turn.revision;
      if (revision) {
        const note = el('p', '', 'question-revision-status'); note.setAttribute('role', 'status');
        const review = button(integrated ? 'Review changes…' : 'Review proposed revision', () => {
          if (revision.busy || revision.rejected) return;
          const stale = revisionGuard(revision); if (stale) {note.textContent = stale; review.disabled = true; return;}
          revision.busy = true; refreshAction();
          void hooks.reviewRevision!(revision.proposalId, revision.snapshot, () => revisionGuard(revision, true), integrated ? presentReview : undefined).catch(() => {
            if (live() && turns.includes(turn)) status.textContent = 'Revision review could not be opened. Check the local proposals and receipts.';
          }).finally(() => {revision.busy = false; if (live() && turns.includes(turn)) {refreshAction(); notifyPassages();}});
        });
        if (integrated) review.classList.add('primary');
        const reject = button(integrated ? 'Dismiss' : 'Reject proposed revision', () => {
          if (!live() || revision.busy || revision.rejected || !core.rejectProposal) return;
          revision.busy = true; refreshAction(); const epoch = version;
          void core.rejectProposal(revision.snapshot.repositoryId, revision.proposalId).then(receipt => {
            if (!live() || version !== epoch || !turns.includes(turn)) return;
            if (receipt.kind !== 'reject' || receipt.status !== 'rejected' || receipt.proposalId !== revision.proposalId) throw new Error('Rejection was not confirmed');
            revision.rejected = true; status.textContent = `Suggestion rejected. Local immutable rejection receipt: ${receipt.id}. The manuscript was not changed.`;
          }).catch(() => {
            if (live() && version === epoch && turns.includes(turn)) status.textContent = 'Rejection could not be confirmed. Check the local receipts before retrying.';
          }).finally(() => {revision.busy = false; if (live() && turns.includes(turn)) {refreshAction(); notifyPassages();}});
        });
        function refreshAction() {
          const stale = revisionGuard(revision!);
          review.disabled = revision!.busy || revision!.rejected || Boolean(stale); reject.disabled = revision!.busy || revision!.rejected;
          note.textContent = revision!.rejected ? 'Rejected. The local decision receipt is retained.' : revision!.busy ? 'Opening the requested revision action…' : stale ?? (integrated ? '' : 'Review opens the exact whole-scene before/after comparison, then a separate native author confirmation.');
        }
        if (integrated) {
          section.append(createQuestionDiffChips(revision.snapshot.selectedText, revision.replacementText));
          const full = button('Review all changes in full scene', () => review.click(), 'question-full-comparison');
          revisionActions.push(() => {full.disabled = review.disabled;}); section.append(full, note, review, reject, el('p', 'Requires author confirmation', 'muted'));
        } else section.append(createQuestionDiffChips(revision.snapshot.selectedText, revision.replacementText), el('p', `Proposal: ${revision.proposalId}`, 'muted'), note, review, reject);
        if (!revision.replacementText) section.append(el('p', 'The replacement is empty. Accepting after review will delete the selected passage.', 'drafting-warning'));
        revisionActions.push(refreshAction); refreshAction();
      }
      if (integrated) section.append(details);
      transcript.append(section);
    });
  }
  function passageStale(passage: Passage) {
    const current = hooks.current(); const binding = hooks.selectionState?.();
    return passage.stale ||= !current || current.repositoryId !== passage.scene.repositoryId || current.path !== passage.scene.path || current.source !== passage.scene.source || Boolean(passage.binding && (!binding || binding.documentEpoch !== passage.binding.documentEpoch || binding.revision !== passage.binding.revision));
  }
  function stashPassage() {
    if (!activePassage) return;
    Object.assign(activePassage, {thread:selectedThread??undefined,turns, context, contextLabel, contextVersion, target, mode: mode.value, draft: question.value, contextMode, title: currentTitle.textContent ?? '', status: status.textContent ?? ''});
  }
  function passageItems(): PassageItem[] {
    return passages.map(p => ({id: p.id, from: p.scene.from, to: p.scene.to, active: p === activePassage && !element.hidden, stale: passageStale(p), label: passageStale(p) ? 'Source changed' : p === activePassage && (pending || preparing) ? 'Asking…' : p.turns.some(t => t.revision && !t.revision.rejected) ? `${p.turns.filter(t => t.revision && !t.revision.rejected).length} suggestion${p.turns.filter(t => t.revision && !t.revision.rejected).length === 1 ? '' : 's'}` : p.turns.length ? 'Answer ready' : 'Ask about passage'}));
  }
  function notifyPassages() {
    if (!integrated || notifying) return; notifying = true;
    queueMicrotask(() => {
      notifying = false; if (disposed) return; stashPassage();
      // One shared session budget, including inactive drafts, context, and replacements.
      const size = (p: Passage) => questionBytes(p.context) + questionBytes(p.draft) + questionBytes(p.scene.source.slice(p.scene.from, p.scene.to)) + p.turns.reduce((n,t) => n + questionBytes(t.question) + questionBytes(t.answer.text) + questionBytes(t.revision?.replacementText ?? '') + questionBytes(t.revision?.snapshot.selectedText ?? ''), 0);
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
    if ((pending || preparing || authBusy || turns.some(t => t.revision?.busy)) && passage !== activePassage) {open(); status.textContent = 'Wait for the current request or choose Cancel request before opening another passage.'; return;}
    stashPassage();
    if (passage !== activePassage) { streaming.hidden = true; streamingText.textContent = ''; }
    activePassage = passage;
    if(hooks.threadScope && passage.thread){selectedThread=passage.thread;storedKey=selectedThread.storageKey??null;projectTurns=passage.turns;}
    ({turns, context, contextLabel, contextVersion, target, contextMode} = passage); mode.value = passage.mode; question.value = passage.draft; questionLabel.firstChild!.textContent = turns.length ? 'Ask a follow-up' : 'Your message'; currentTitle.textContent = passage.title; status.textContent = passage.status;
    contextMode = passage.contextMode;
    if (!passageStale(passage)) hooks.passages?.select(passage.scene.from, passage.scene.to);
    renderTranscript(); open(); passagePicker.open = passages.length > 1; update(); if (unified) body.scrollTop = body.scrollHeight;
  }
  function activateSelection(scene: QuestionScene) {
    if (fullReviewCancel) return false;
    const existing = passages.find(p => !passageStale(p) && p.scene.from === scene.from && p.scene.to === scene.to);
    if (existing) {activatePassage(existing.id); return true;}
    if (pending || preparing || authBusy || turns.some(t => t.revision?.busy)) {open(); status.textContent = 'Wait for the current request or choose Cancel request before starting another passage.'; return false;}
    stashPassage(); open();
    const passage: Passage = {id: `passage-${++passageId}`, scene: {...scene}, binding: hooks.selectionState?.() ?? null, turns: [], context: scene.source.slice(scene.from, scene.to), contextLabel: 'Selected passage only', contextVersion: contextVersion + 1, target: null, mode: 'ask', draft: '', contextMode: 'snapshot', title: 'Selected passage', status: '', stale: false};
    if(hooks.threadScope && configuration){persist();activePassage=null;selectedThread=null;storedKey=null;forceNewThread=true;restoreConversation(configuration);passage.thread=selectedThread??undefined;}
    passages.push(passage); activatePassage(passage.id); contextDetails.open = false; return true;
  }
  function collapse() {
    if (disposed) return;
    fullReviewCancel?.(); stashPassage(); element.hidden = true; hooks.visibilityChanged?.(false); notifyPassages(); hooks.focusEditor();
  }
  function presentReview(view: ProposalReview): Promise<boolean> {
    fullReviewCancel?.();
    return new Promise(resolve => {
      const prior = [...element.children, ...body.children].filter(child => child !== header && child !== fullReview && child !== body).map(child => [child as HTMLElement, (child as HTMLElement).hidden] as const);
      prior.forEach(([child]) => {child.hidden = true;}); fullReview.hidden = false;
      const title = el('h3', 'Review whole-scene revision'); title.tabIndex = -1;
      fullReview.replaceChildren(title, el('p', view.path), createQuestionComparison(view.baseText, view.replacementText, true), el('p', 'Review expires after five minutes. Continue to native author confirmation to apply this exact replacement.', 'muted'));
      let done = false;
      const finish = (accepted: boolean) => {if (done) return; done = true; fullReviewCancel = null; fullReview.hidden = true; fullReview.replaceChildren(); prior.forEach(([child, hidden]) => {child.hidden = hidden;}); resolve(accepted); if (!element.hidden) question.focus({preventScroll: true});};
      const bindings = el('details', '', 'question-review-bindings');
      const attribution = view.origin.kind === 'nativeOpenAi' ? `Native OpenAI suggestion · ${view.origin.model} · ${view.origin.requestId}. Provider metadata is not authenticated authorship.` : `Unverified local MCP client: ${view.origin.clientLabel} · ${view.origin.sessionId}`;
      bindings.append(el('summary', 'Review details'), el('p', attribution), el('p', `Proposal: ${view.proposalId} · Base: ${view.baseHash} · Replacement: ${view.replacementHash} · Diff: ${view.diffHash}`, 'path')); fullReview.append(bindings);
      fullReviewCancel = () => finish(false);
      fullReview.append(button('Cancel review', () => finish(false)), button('Continue to native confirmation', () => finish(true), 'primary'));
      title.focus({preventScroll: true}); element.scrollTop = 0;
    });
  }
  function close(returnFocus = false) {
    if ((authBusy === 'connect' || configuration?.signInPending) && core.cancelQuestionSignIn) {
      try {void core.cancelQuestionSignIn().catch(() => {});} catch { /* UI invalidation still wins */ }
    }
    fullReviewCancel?.(); persist(); passages.length = 0; activePassage = null;
    const wasOpen = !element.hidden; storedKey=null; resetContents(); statusVersion++; checking = false; configuration = null;
    authBusy = null; seenConnection = null; selectedAccountId = null; reauthorizing = false; addingAccount = false; consent.checked = false; accounts.replaceChildren(); models.replaceChildren(); connection.textContent = '';
    element.hidden = true; session = null; sessionPath = null; status.textContent = ''; hooks.visibilityChanged?.(false); notifyPassages();
    if (wasOpen && returnFocus) hooks.focusEditor();
  }
  function open() {
    if (disposed) return;
    if (!element.hidden) {question.focus({preventScroll: true}); return;}
    const current = hooks.current(); if (!current) return;
    if (integrated && session === current.repositoryId && sessionPath === current.path) {element.hidden = false; hooks.visibilityChanged?.(true); presentation(); update(); if (!fullReviewCancel) question.focus({preventScroll: true}); return;}
    if (integrated && session) close();
    session = current.repositoryId; sessionPath = current.path; element.hidden = false; hooks.visibilityChanged?.(true); update();
    question.focus({preventScroll: true}); void checkStatus();
  }
  return {element,
    openConversation(thread?:WriterThread) {
      if(pending||preparing||authBusy||turns.some(t=>t.revision?.busy)){open();status.textContent='Wait for the current request or cancel it before switching threads.';return false;}
      persist();resetContents();storedKey=null;storageFailed=false;
      if(thread){
        const current=hooks.current();if(!current||!thread.storageKey)return false;
        const saved=loadConversation(thread.storageKey);selectedThread=thread;threadProject=current.projectKey??current.repositoryId;storedKey=thread.storageKey;
        turns=saved.turns;projectTurns=turns;forgotten=saved.forgotten;question.value=saved.draft;renderTranscript();
      }else forceNewThread=true;
      if(!hooks.current()?.canCapture)contextMode='none';
      open();if(configuration)restoreConversation(configuration);update();return true;
    },
    open,
    selectionVersion: () => contextVersion,
    stateChanged() {notifyPassages(); if (integrated && session && !live()) {close(); return;} if(live()&&!pending&&!preparing) update(); if (live() && (mode.value === 'revision' || revisionActions.length)) updateRevisionState();},
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
    activatePassage, passageItems, presentReview, collapse,
    activity: () => pending || preparing ? 'Asking…' : turns.length ? 'Answer ready' : '',
    /** Switches Ask / Suggest revision exactly as choosing it from the Response mode menu. */
    setMode(value: 'ask' | 'revision') { if (mode.value !== value && !mode.disabled) { mode.value = value; mode.dispatchEvent(new Event('change')); } },
    clear: () => close(), destroy: () => {close(); headerObserver?.disconnect(); textObserver.disconnect(); window.removeEventListener('resize', presentation); layoutQuery?.removeEventListener?.('change', presentation); disposed = true; element.remove();},
  };
}
