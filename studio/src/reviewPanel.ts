import type {LocalCore, QuestionStatus, ReviewResult, ReviewRequest} from './localCore';
export interface ReviewScope {repositoryId: string; scope: 'scene' | 'chapter'; snapshots: ReviewRequest['snapshots']; label: string}
interface Hooks {capture(): ReviewScope | null; unavailable(reviewing?: boolean): string | null; reviewProposal(id: string, guard: () => string | null): Promise<void>; openConnection(): void; focusEditor(): void}
const bytes = (s: string) => new TextEncoder().encode(s).length;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {const n = document.createElement(tag); n.textContent = text; n.className = cls; return n;}
function button(text: string, action: () => void) {const n = el('button', text); n.type = 'button'; n.onclick = action; return n;}
function message(error: unknown) {return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'The review could not be completed. Retry when your connection is ready.';}
export function createReviewPanel(core: LocalCore, hooks: Hooks) {
  const element = el('section', '', 'heinlein-review-panel'); element.hidden = true; element.setAttribute('aria-label', 'Heinlein Review');
  let scope: ReviewScope | null = null; let result: ReviewResult | null = null; let config: QuestionStatus | null = null;
  let generation = 0; let pending: string | null = null; let busy = false; let disposed = false; let checking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = el('p', '', 'review-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const title = el('h2', 'Heinlein Review'); title.tabIndex = -1;
  const summary = el('p');
  const disclosure = el('p', 'Proofreader + editor: one advisory pass for spelling, grammar, clarity and continuity within this snapshot. Your voice and em dashes are protected. No tools or automatic manuscript changes.');
  const usage = el('p', 'Run sends the exact source snapshots below to OpenAI using your selected ChatGPT account and model. Plan usage may count. Up to 16 scenes / 16,000 UTF-8 bytes; requests stop locally after 65 seconds.', 'drafting-warning');
  const preview = el('details'); preview.append(el('summary', 'Exact source snapshots to send')); const sources = el('div'); preview.append(sources);
  const connection = el('p'); const connect = button('ChatGPT connection', hooks.openConnection);
  const refresh = button('Refresh connection', () => {void configure();});
  const run = button('Run Heinlein Review', () => {void submit();});
  const retry = button('Retry review', () => {void submit();}); retry.hidden = true;
  const cancel = button('Cancel review', () => {cancelRequest(); status.textContent = 'Review canceled locally. Already-sent text cannot be recalled and usage may count. Your manuscript was not changed.'; update();});
  const actions = el('div', '', 'question-actions'); actions.append(run, retry, cancel, connect, refresh, button('Return to writing', hooks.focusEditor), button('Close review', clear));
  const refreshReview = button('Refresh review', () => {void refreshResult();}); refreshReview.hidden = true; actions.append(refreshReview);
  const edits = el('div', '', 'review-edits'); const json = el('details'); json.append(el('summary', 'Versioned review JSON')); const blob = el('pre', '', 'question-text'); blob.tabIndex = 0; json.append(blob); json.hidden = true;
  element.append(title, summary, disclosure, usage, preview, connection, actions, status, edits, json);
  element.addEventListener('keydown', event => {if (event.key === 'Escape' && !event.isComposing) {event.preventDefault(); event.stopPropagation(); clear(); hooks.focusEditor();}});
  function live(token: number) {return !disposed && !element.hidden && token === generation;}
  function scopeProblem() {
    if (!scope) return 'Open an editable source scene or a mapped assembled chapter.';
    if (!scope.snapshots.length || scope.snapshots.length > 16 || scope.snapshots.reduce((n, s) => n + bytes(s.source), 0) > 16000) return 'This review exceeds 16 scenes or 16,000 UTF-8 bytes. Open a smaller source scene. Nothing was sent.';
    if (new Set(scope.snapshots.map(s => s.path)).size !== scope.snapshots.length) return 'This scope repeats a source scene. Open that source scene to review it.';
    return null;
  }
  function ready() {const c = config; if (!c) return false; const account = c.accounts.find(a => a.id === c.activeAccountId); return Boolean(c.configured && !c.usageLimited && !c.signInPending && account?.signedIn && account.planEnabled && c.model && c.model === c.selectedModel && c.models.some(m => m.slug === c.model) && Number.isSafeInteger(c.generation));}
  function update() {
    const problem = scopeProblem();
    summary.textContent = scope ? `${scope.scope === 'chapter' ? 'Mapped chapter' : 'Source scene'} · ${scope.label} · ${scope.snapshots.length} source snapshot(s) · ${scope.snapshots.reduce((n, s) => n + bytes(s.source), 0).toLocaleString()} UTF-8 bytes. Includes unsaved text captured when opened; later typing is never added to this request.` : problem;
    connection.textContent = ready() ? `ChatGPT · ${config!.model}` : config?.message ?? 'Checking ChatGPT connection…';
    run.disabled = retry.disabled = Boolean(problem || pending || busy || checking || !ready() || !core.requestReview);
    refreshReview.hidden = !result; refreshReview.disabled = Boolean(busy || pending);
    cancel.hidden = !pending; refresh.disabled = Boolean(pending || busy || checking); connect.disabled = Boolean(pending || busy);
    if (problem && !element.hidden) status.textContent = problem;
    edits.querySelectorAll<HTMLButtonElement>('button[data-edit-action]').forEach(n => {n.disabled = Boolean(busy || pending || (n.dataset.editAction === 'accept' && hooks.unavailable(false)));});
  }
  async function configure() {if (checking) return; const token = generation; checking = true; update(); try {const next = await core.questionStatus?.(); if (live(token)) config = next ?? null;} catch {if (live(token)) status.textContent = 'ChatGPT connection could not be checked. Open ChatGPT connection or refresh to retry.';} finally {if (live(token)) {checking = false; update();}}}
  function cancelRequest() {const id = pending; pending = null; clearTimeout(timer); generation++; checking = false; busy = false; if (id) {void core.cancelQuestion?.(id).catch(() => {}); retry.hidden = false;}}
  function clear() {cancelRequest(); element.hidden = true; scope = null; result = null; config = null; edits.replaceChildren(); sources.replaceChildren(); blob.textContent = ''; json.hidden = true; refreshReview.hidden = true;}
  function validate(value: ReviewResult, requestId?: string) {
    if (!value || value.schemaVersion !== 1 || !value.reviewId || (requestId && value.requestId !== requestId) || value.scope !== scope?.scope || !Array.isArray(value.edits) || value.edits.length > 32 || new Set(value.edits.map(e => e.id)).size !== value.edits.length) throw new Error('The review response did not match this request. It was ignored.');
    const ranges = new Map<string, {from: number; to: number}[]>();
    for (const edit of value.edits) {
      if (!edit.id || !scope?.snapshots.some(s => s.path === edit.path) || !['proofreader', 'editor'].includes(edit.role) || !['pending', 'prepared', 'accepted', 'rejected'].includes(edit.status) || ![edit.original, edit.replacement, edit.reason].every(s => typeof s === 'string') || !Number.isSafeInteger(edit.fromUtf8) || !Number.isSafeInteger(edit.toUtf8) || edit.fromUtf8 < 0 || edit.toUtf8 <= edit.fromUtf8) throw new Error('The review contained an invalid or out-of-scope edit. It was ignored.');
      const source = new TextEncoder().encode(scope!.snapshots.find(s => s.path === edit.path)!.source);
      let original: string;
      try {original = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(source.slice(edit.fromUtf8, edit.toUtf8));} catch {throw new Error('The review split a source character. It was ignored.');}
      const prior = ranges.get(edit.path) ?? [];
      if (edit.toUtf8 > source.length || original !== edit.original || prior.some(r => edit.fromUtf8 < r.to && edit.toUtf8 > r.from)) throw new Error('The review contained an invalid or overlapping target. It was ignored.');
      prior.push({from: edit.fromUtf8, to: edit.toUtf8}); ranges.set(edit.path, prior);
    }
    return value;
  }
  function render() {
    edits.replaceChildren(); json.hidden = !result; blob.textContent = result ? JSON.stringify(result, null, 2) : ''; if (!result) return;
    edits.append(el('p', `OpenAI · ${result.model} · Request ${result.requestId}. Recorded provider metadata is not authenticated authorship.`, 'muted'));
    if (!result.edits.length) edits.append(el('p', 'No targeted edits suggested. This is advisory feedback, not a publication approval.'));
    for (const edit of result.edits) {
      const item = el('article', '', 'review-edit'); item.append(el('h3', `${edit.role === 'proofreader' ? 'Proofreader' : 'Editor'} · ${edit.path}`), el('p', edit.reason), el('h4', 'Original'), el('pre', edit.original, 'question-text'), el('h4', 'Suggested replacement'), el('pre', edit.replacement, 'question-text'));
      if (edit.status === 'accepted' || edit.status === 'rejected') item.append(el('p', edit.status === 'accepted' ? 'Accepted · local receipt retained. Guarded undo is available in Proposed revisions.' : 'Rejected · local receipt retained.'));
      else {
        const accept = button('Accept edit', () => {void act(edit.id, true);}); accept.dataset.editAction = 'accept';
        const reject = button('Reject edit', () => {void act(edit.id, false);}); reject.dataset.editAction = 'reject';
        item.append(accept, reject, el('p', 'Accept opens the exact before/after proposal and separate native confirmation. Save matching unsaved text first.', 'muted'));
      }
      edits.append(item);
    }
    update();
  }
  async function submit() {
    if (pending || busy || scopeProblem() || !ready() || !scope || !core.requestReview) return;
    if (!globalThis.crypto?.randomUUID) {status.textContent = 'A secure request identifier is unavailable. Reopen Studio.'; return;}
    const token = generation; const requestId = crypto.randomUUID(); const request: ReviewRequest = {requestId, repositoryId: scope.repositoryId, scope: scope.scope, snapshots: scope.snapshots.map(s => ({...s}))};
    pending = requestId; result = null; render(); retry.hidden = true; status.textContent = 'Proofreader and editor are reviewing this snapshot. You can keep writing.'; update();
    timer = setTimeout(() => {if (!live(token) || pending !== requestId) return; cancelRequest(); status.textContent = 'Review timed out locally. Usage may count. Retry when ready; your manuscript was not changed.'; update();}, 65000);
    try {
      const answer = await core.requestReview(request, {generation: config!.generation, accountId: config!.activeAccountId!, model: config!.model!});
      if (!live(token) || pending !== requestId) return;
      result = validate(answer, requestId); status.textContent = 'Review ready. Inspect each proposed edit and accept or reject it individually.'; render();
    } catch (error) {if (live(token)) {status.textContent = message(error); retry.hidden = false;}}
    finally {if (live(token)) {clearTimeout(timer); pending = null; update();}}
  }
  async function refreshResult() {
    if (!result || !scope || busy || pending || !core.getReview) return;
    const token = generation; const repositoryId = scope.repositoryId; const reviewId = result.reviewId;
    busy = true; update();
    try {const next = await core.getReview(repositoryId, reviewId); if (live(token)) {result = validate(next); render(); status.textContent = 'Review decisions refreshed from the native host.';}}
    catch (error) {if (live(token)) status.textContent = message(error);}
    finally {if (live(token)) {busy = false; update();}}
  }
  async function act(editId: string, accept: boolean) {
    if (busy || pending || !result || !scope) return;
    const token = generation; const repositoryId = scope.repositoryId; const reviewId = result.reviewId;
    const guard = () => !live(token) ? 'Review scope changed. Start a new review.' : hooks.unavailable(true);
    busy = true; update();
    try {
      if (accept) {
        const problem = hooks.unavailable(false); if (problem) throw new Error(problem);
        if (!core.prepareReviewEdit || !core.getReview) throw new Error('Review acceptance is unavailable in this native host.');
        const proposal = await core.prepareReviewEdit(repositoryId, reviewId, editId);
        if (!live(token)) return;
        const stale = guard(); if (stale) throw new Error(stale);
        await hooks.reviewProposal(proposal.proposalId, guard);
        if (!live(token)) return;
        const next = await core.getReview(repositoryId, reviewId); if (!live(token)) return; result = validate(next);
      } else {
        if (!core.rejectReviewEdit) throw new Error('Review rejection is unavailable in this native host.');
        const next = await core.rejectReviewEdit(repositoryId, reviewId, editId); if (!live(token)) return; result = validate(next);
      }
      if (live(token)) {render(); status.textContent = accept ? 'Review state refreshed. Only a completed native confirmation applies an edit.' : 'Edit rejected. Your manuscript was not changed.';}
    } catch (error) {if (live(token)) status.textContent = message(error);}
    finally {if (live(token)) {busy = false; update();}}
  }
  return {element, open() {
    if (disposed) return;
    if (!element.hidden) {title.focus(); return;}
    const captured = hooks.capture(); scope = captured ? {...captured, snapshots: captured.snapshots.map(s => ({...s}))} : null;
    element.hidden = false; retry.hidden = true; status.textContent = ''; sources.replaceChildren(); scope?.snapshots.forEach(s => sources.append(el('h3', s.path), el('pre', s.source, 'question-text')));
    if (!core.requestReview) status.textContent = 'Heinlein Review is unavailable in this native host.';
    update(); void configure(); title.focus({preventScroll: true});
  }, clear, stateChanged: update, destroy() {clear(); disposed = true; element.remove();}};
}
