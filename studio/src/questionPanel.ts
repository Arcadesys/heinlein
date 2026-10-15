import type {LocalCore, QuestionAnswer, QuestionConnection, QuestionMessage, QuestionRequest, QuestionStatus} from './localCore';

/** These are UTF-8 byte limits, shared with the native provider boundary. */
export const QUESTION_LIMITS = Object.freeze({question: 4000, context: 16000, input: 32000, history: 8, answer: 32000, memory: 64000});
export const questionBytes = (text: string) => new TextEncoder().encode(text).length;
export interface QuestionScene {
  repositoryId: string; path: string; source: string; from: number; to: number;
  canCapture: boolean;
}
export interface QuestionPanelHooks {
  current(): QuestionScene | null;
  focusEditor(): void;
  visibilityChanged?(open: boolean): void;
}
interface Turn { question: string; answer: QuestionAnswer; contextBytes: number }
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
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'The request failed. Check your OpenAI connection and try again. Nothing was retried automatically.';
}
export function createQuestionPanel(core: LocalCore, hooks: QuestionPanelHooks) {
  const element = el('aside', '', 'question-panel'); element.hidden = true;
  element.setAttribute('aria-label', 'Drafting questions');
  let disposed = false; let session: string | null = null; let version = 0; let statusVersion = 0;
  let configuration: QuestionStatus | null = null; let checking = false;
  let authBusy: 'connect' | 'account' | 'model' | 'signout' | null = null;
  let seenConnection: string | null = null;
  let selectedAccountId: string | null = null; let reauthorizing = false; let addingAccount = false;
  let context = ''; let contextLabel = 'None. No manuscript text will be sent.';
  let contextVersion = 0;
  let turns: Turn[] = []; let forgotten = 0; let pending: QuestionRequest | null = null;
  const header = el('div', '', 'question-heading');
  header.append(el('h3', 'Questions'), button('Close questions', () => close(true)));
  const connection = el('p', '', 'question-connection'); connection.setAttribute('role', 'status');
  const refresh = button('Recheck OpenAI setup', () => { void checkStatus(true); });
  const auth = el('details', '', 'question-auth'); auth.setAttribute('aria-label', 'ChatGPT connection'); auth.open = true;
  auth.append(el('summary', 'ChatGPT account & model'));
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
    resetContents(); selectedAccountId = null; reauthorizing = true; addingAccount = true; consent.checked = false; accounts.value = '';
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
    if (!accountId) {resetContents(); selectedAccountId = null; reauthorizing = true; addingAccount = false; consent.checked = false; status.textContent = 'Choose a saved account or Add ChatGPT account before connecting.'; update(); return;}
    const account = configuration?.accounts.find(value => value.id === accountId);
    if (account && (!account.signedIn || !account.planEnabled)) {
      resetContents(); selectedAccountId = account.id; reauthorizing = true; addingAccount = false; consent.checked = false;
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
  const questionLabel = el('label', 'Your drafting question');
  const question = el('textarea'); question.rows = 4; question.setAttribute('aria-label', 'Your drafting question');
  question.placeholder = 'Ask about an idea, a detail, or where to go next…'; questionLabel.append(question);
  const count = el('p', '', 'muted');
  const contextHeading = el('h4', 'Context to send');
  const contextSource = el('p', contextLabel, 'muted');
  const contextText = preview('', 'Exact context to send'); contextText.hidden = true;
  const captureSelection = button('Capture selected text', () => capture('selection'));
  const captureScene = button('Capture current scene', () => capture('scene'));
  const removeContext = button('Remove context', () => {contextVersion++; context = ''; contextLabel = 'None. No manuscript text will be sent.'; update();});
  const contextActions = el('div', '', 'question-actions'); contextActions.append(captureSelection, captureScene, removeContext);
  const historyDetails = el('details', '', 'question-history-preview');
  const historySummary = el('summary', 'Conversation history to send');
  const historyText = el('div'); historyText.setAttribute('aria-label', 'Exact conversation history to send');
  const historyNote = el('p', '', 'muted'); historyDetails.append(historySummary, historyNote, historyText);
  const disclosure = el('p', 'Send shares your exact question, the context preview, and the history preview with OpenAI using the selected ChatGPT account and model. Requests consume that plan’s usage allowance; account limits apply. Each request allows up to 2,000 output tokens. Manage ChatGPT usage to review usage or revoke access.', 'drafting-warning');
  const guidance = el('p', 'Nothing is sent while you type or open this panel. Answers are read-only advice. To revise a passage, use Ask about selection and review its replacement separately.', 'muted');
  const status = el('p', '', 'question-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const send = button('Send to OpenAI', () => { void submit(); }, 'primary');
  const cancel = button('Cancel request', () => {
    if (!pending) return;
    cancelPending(); status.textContent = 'Canceled locally. OpenAI may already have processed the request; it can still count toward your plan usage.'; update();
  }); cancel.hidden = true;
  const reset = button('Clear conversation', () => {
    const wasPending = Boolean(pending); resetContents();
    status.textContent = wasPending ? 'Conversation cleared and request canceled locally. Previously sent text cannot be recalled from OpenAI.' : 'Conversation cleared from this window. Previously sent text cannot be recalled from OpenAI.';
    update(); question.focus({preventScroll: true});
  });
  const actions = el('div', '', 'question-actions'); actions.append(send, cancel, button('Return to writing', () => hooks.focusEditor()), reset);
  const transcript = el('section', '', 'question-transcript'); transcript.setAttribute('aria-label', 'Question conversation');
  const lifetime = el('p', 'Conversation stays only in this window, up to four turns and 64,000 UTF-8 bytes. Closing questions or changing scenes/folders clears it. Earlier context snapshots are not added to conversation history.', 'muted');
  element.append(header, connection, auth, guidance, questionLabel, count, contextHeading, contextSource, contextText, contextActions, historyDetails, disclosure, actions, status, transcript, lifetime);
  question.addEventListener('input', update);
  // Escape is scoped to this panel; the editor keeps all its own shortcuts.
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) {event.preventDefault(); event.stopPropagation(); close(true);}
  });
  function live() { return !disposed && !element.hidden && hooks.current()?.repositoryId === session; }
  function activeAccount() { return configuration?.accounts.find(account => account.id === configuration?.activeAccountId); }
  function connectionReady() {
    const account = activeAccount(); const current = configuration;
    return Boolean(!reauthorizing && current?.configured && !current.usageLimited && !current.signInPending && account?.signedIn && account.planEnabled &&
      Number.isSafeInteger(current.generation) && current.generation >= 0 && current.model && current.model === current.selectedModel &&
      accounts.value === current.activeAccountId && models.value === current.model &&
      current.models.some(model => model.slug === current.model));
  }
  function messages(): QuestionMessage[] { return turns.flatMap(turn => [{role: 'user' as const, text: turn.question}, {role: 'assistant' as const, text: turn.answer.text}]); }
  function outgoingHistory() { return questionHistory(messages(), Math.max(0, QUESTION_LIMITS.input - questionBytes(question.value) - questionBytes(context))); }
  function update() {
    const history = pending?.history ?? outgoingHistory();
    const questionSize = questionBytes(question.value);
    count.textContent = `${questionSize.toLocaleString()} / ${QUESTION_LIMITS.question.toLocaleString()} UTF-8 bytes${questionSize > QUESTION_LIMITS.question ? ' · Question is too long' : ''}`;
    contextSource.textContent = contextLabel; contextText.textContent = context; contextText.hidden = !context;
    const missing = messages().length - history.length;
    historySummary.textContent = `Conversation history ${pending ? 'sent' : 'to send'} · ${history.length} messages`;
    historyNote.textContent = `Only these previous questions and answers are ${pending ? 'included in this request' : 'sent with your next question'}. Previous context snapshots are not resent.${missing ? ` ${missing} older messages are omitted to fit the request limit.` : ''}${forgotten ? ` ${forgotten} earlier turns have been cleared from this window to keep memory bounded.` : ''}`;
    historyText.replaceChildren();
    if (!history.length) historyText.append(el('p', 'No previous messages included.', 'muted'));
    history.forEach((message, index) => historyText.append(el('h4', message.role === 'user' ? 'You' : 'OpenAI'), preview(message.text, `History message ${index + 1}`)));
    question.disabled = Boolean(pending) || Boolean(authBusy);
    captureSelection.disabled = captureScene.disabled = Boolean(pending) || Boolean(authBusy);
    removeContext.disabled = Boolean(pending) || Boolean(authBusy) || !context;
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
    send.disabled = !live() || checking || authPending || !connectionReady() || !core.askQuestion || Boolean(pending) || Boolean(questionProblem(question.value, context));
    send.title = questionProblem(question.value, context) ?? '';
    cancel.hidden = !pending;
    element.setAttribute('aria-busy', String(Boolean(pending) || checking || authPending));
  }
  function capture(kind: 'selection' | 'scene') {
    if (!live() || pending) return;
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
    contextVersion++; context = captured;
    contextLabel = `${kind === 'scene' ? 'Current scene' : 'Selected text'} snapshot · ${current.path} · ${questionBytes(captured).toLocaleString()} UTF-8 bytes. Later editor changes are not included unless you capture again.`;
    status.textContent = 'Context captured locally. Inspect the exact text before sending.'; update();
  }
  function applyConfiguration(next: QuestionStatus) {
    const first = seenConnection === null;
    const key = JSON.stringify([next.generation, next.activeAccountId, next.selectedModel, next.accounts.find(account => account.id === next.activeAccountId)?.planEnabled]);
    if (seenConnection !== null && seenConnection !== key) resetContents();
    seenConnection = key; configuration = next; selectedAccountId = next.activeAccountId; reauthorizing = false; addingAccount = false;
    const account = activeAccount();
    connection.textContent = `${account ? `ChatGPT · ${account.label}${next.model ? ` · ${next.model}` : ''}. ` : ''}${next.message}${next.usageLimited ? ' Plan usage is limited. Manage usage or explicitly recheck before trying again.' : ''}`;
    accounts.replaceChildren(); models.replaceChildren();
    const accountPlaceholder = el('option', 'Choose an account'); accountPlaceholder.value = ''; accountPlaceholder.disabled = true; accounts.append(accountPlaceholder);
    next.accounts.forEach(value => {const option = el('option', `${value.label}${!value.signedIn ? ' · signed out' : !value.planEnabled ? ' · plan use disabled' : ''}`); option.value = value.id; accounts.append(option);});
    accounts.value = next.activeAccountId ?? '';
    const modelPlaceholder = el('option', 'Choose a model'); modelPlaceholder.value = ''; modelPlaceholder.disabled = true; models.append(modelPlaceholder);
    next.models.forEach(value => {const option = el('option', value.displayName || value.slug); option.value = value.slug; models.append(option);});
    models.value = next.selectedModel ?? '';
    if (!connectionReady()) auth.open = true;
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
    const epoch = ++statusVersion; authBusy = kind; resetContents(); configuration = null; consent.checked = false;
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
  function cancelPending() {
    version++;
    const request = pending; pending = null;
    if (request && core.cancelQuestion) {
      try {void core.cancelQuestion(request.requestId).catch(() => {});} catch { /* local invalidation still wins */ }
    }
  }
  function resetContents() {
    contextVersion++; cancelPending(); turns = []; forgotten = 0; context = ''; contextLabel = 'None. No manuscript text will be sent.'; question.value = ''; transcript.replaceChildren();
    // Closing also removes private snapshots from hidden DOM, not just state.
    contextText.textContent = ''; contextText.hidden = true; contextSource.textContent = contextLabel;
    historyText.replaceChildren(); historyNote.textContent = ''; historySummary.textContent = 'Conversation history to send · 0 messages';
  }
  async function submit() {
    if (!live() || pending || checking || authBusy || !connectionReady() || !configuration || !core.askQuestion) return;
    const problem = questionProblem(question.value, context);
    if (problem) {status.textContent = problem; update(); return;}
    if (!globalThis.crypto?.randomUUID) {status.textContent = 'A secure request identifier is unavailable. Reopen Studio before sending.'; return;}
    const request: QuestionRequest = {requestId: crypto.randomUUID(), question: question.value, context, history: outgoingHistory()};
    const binding: QuestionConnection = {generation: configuration.generation, accountId: configuration.activeAccountId!, model: configuration.model!};
    pending = request; const epoch = ++version;
    status.textContent = 'Asking OpenAI… You can keep writing and saving your draft.'; update();
    try {
      const answer = await core.askQuestion(request, binding);
      if (!live() || version !== epoch || pending !== request) return;
      if (answer.requestId !== request.requestId) throw new Error('The response did not match this question. It was ignored.');
      if (!answer.text?.trim()) throw new Error('OpenAI returned no text. No retry was sent automatically.');
      if (questionBytes(answer.text) > QUESTION_LIMITS.answer || !plainUnicode(answer.text)) throw new Error('The answer exceeded the safe text limit or contained invalid text. It was not added to the conversation.');
      turns.push({question: request.question, answer, contextBytes: questionBytes(request.context)});
      while (turns.length > 4 || messages().reduce((sum, message) => sum + questionBytes(message.text), 0) > QUESTION_LIMITS.memory) {turns.shift(); forgotten++;}
      question.value = '';
      renderTranscript();
      status.textContent = answer.incomplete ? 'OpenAI returned an incomplete answer. It is marked below; nothing was retried automatically.' : 'Answer ready. Your manuscript has not been changed.';
    } catch (error) { if (live() && version === epoch && pending === request) {status.textContent = errorMessage(error); void checkStatus();} }
    finally { if (live() && version === epoch && pending === request) {pending = null; update();} }
  }
  function renderTranscript() {
    transcript.replaceChildren();
    turns.forEach((turn, index) => {
      const section = el('section', '', 'question-turn');
      const usage = [turn.answer.inputTokens == null ? null : `${turn.answer.inputTokens.toLocaleString()} input tokens`, turn.answer.outputTokens == null ? null : `${turn.answer.outputTokens.toLocaleString()} output tokens`].filter(Boolean).join(' · ');
      section.append(el('h4', 'You'), preview(turn.question, `Question ${index + 1}`), el('p', `${turn.contextBytes.toLocaleString()} UTF-8 bytes of context sent`, 'muted'), el('h4', `OpenAI · ${turn.answer.model}${turn.answer.incomplete ? ' · Incomplete answer' : ''}`), preview(turn.answer.text, `Answer ${index + 1}`), el('p', usage || 'Token usage was not returned.', 'muted'));
      transcript.append(section);
    });
  }
  function close(returnFocus = false) {
    if ((authBusy === 'connect' || configuration?.signInPending) && core.cancelQuestionSignIn) {
      try {void core.cancelQuestionSignIn().catch(() => {});} catch { /* UI invalidation still wins */ }
    }
    const wasOpen = !element.hidden; resetContents(); statusVersion++; checking = false; configuration = null;
    authBusy = null; seenConnection = null; selectedAccountId = null; reauthorizing = false; addingAccount = false; consent.checked = false; accounts.replaceChildren(); models.replaceChildren(); connection.textContent = '';
    element.hidden = true; session = null; status.textContent = ''; hooks.visibilityChanged?.(false);
    if (wasOpen && returnFocus) hooks.focusEditor();
  }
  function open() {
    if (disposed) return;
    if (!element.hidden) {question.focus({preventScroll: true}); return;}
    const current = hooks.current(); if (!current) return;
    session = current.repositoryId; element.hidden = false; hooks.visibilityChanged?.(true); update();
    question.focus({preventScroll: true}); void checkStatus();
  }
  return {element,
    open,
    selectionVersion: () => contextVersion,
    /** The caller captures and rechecks editor revision/selection before this synchronous boundary. */
    openSelection(expected: QuestionScene, expectedContextVersion = contextVersion) {
      const current = hooks.current();
      if (disposed || expectedContextVersion !== contextVersion || !current?.canCapture || current.repositoryId !== expected.repositoryId || current.path !== expected.path ||
        current.source !== expected.source || current.from !== expected.from || current.to !== expected.to) return false;
      const text = current.source.slice(current.from, current.to);
      if (!Number.isSafeInteger(current.from) || !Number.isSafeInteger(current.to) || current.from < 0 || current.to > current.source.length || current.to <= current.from || !plainUnicode(text) || questionBytes(text) > QUESTION_LIMITS.context) {
        status.textContent = `Select a nonempty passage of complete characters, up to ${QUESTION_LIMITS.context.toLocaleString()} UTF-8 bytes. Nothing was sent.`; return false;
      }
      open();
      if (authBusy || configuration?.signInPending) {status.textContent = 'Finish or cancel the account connection before capturing a selection.'; return false;}
      const canceled = Boolean(pending); if (canceled) cancelPending();
      capture('selection'); question.focus({preventScroll: true});
      if (canceled) status.textContent = 'Previous request canceled locally; it may still count toward plan usage. Selection captured. Write your question, then explicitly choose Send.';
      return true;
    },
    clear: () => close(), destroy: () => {close(); disposed = true; element.remove();},
  };
}
