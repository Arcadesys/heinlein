import type { LocalCore, QuestionStatus, ReviewResult, ReviewRequest, ReviewerDefinition, ReviewCoverage, ProposalOutcome } from './localCore';
export interface ReviewScope {
    repositoryId: string;
    scope: 'scene' | 'chapter';
    snapshots: ReviewRequest['snapshots'];
    label: string;
}
interface Hooks {
    capture(): ReviewScope | null;
    unavailable(reviewing?: boolean): string | null;
    reviewProposal(id: string, guard: () => string | null): Promise<void>;
    openConnection(): void;
    focusEditor(): void;
    approveReview?(run: () => Promise<ProposalOutcome | null>, guard: () => string | null): Promise<ProposalOutcome | null>;
}
const bytes = (s: string) => new TextEncoder().encode(s).length;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; }
function button(text: string, action: () => void) { const n = el('button', text); n.type = 'button'; n.onclick = action; return n; }
function message(error: unknown) { return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'The review could not be completed. Retry when your connection is ready.'; }
export function createReviewPanel(core: LocalCore, hooks: Hooks) {
    const element = el('section', '', 'heinlein-review-panel');
    element.hidden = true;
    element.setAttribute('aria-label', 'Heinlein Review');
    let scope: ReviewScope | null = null;
    let result: ReviewResult | null = null;
    let config: QuestionStatus | null = null;
    let generation = 0;
    let pending: string | null = null;
    let busy = false;
    let disposed = false;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const workflowMode = Boolean(core.reviewDefinitions && core.previewReview);
    let definitions: ReviewerDefinition[] = [];
    let reviewerIds = ['contextual'];
    let selectedPaths = new Set<string>();
    let contextNote = '';
    let preparedRequest: ReviewRequest | null = null;
    let coverage: ReviewCoverage[] = [];
    let editGeneration = 0;
    const setup = el('div', '', 'review-setup'), batchPreview = el('div', '', 'review-batch-preview'), saved = el('div', '', 'review-saved');
    const previewBatch = button('Preview reviewer batch', () => { void prepareBatch(); });
    previewBatch.hidden = !workflowMode;
    const continueBatch = button('Continue next reviewer batch', () => { void submit(true); });
    continueBatch.hidden = true;
    const reload = button('Reload saved reviews', () => { void savedReviews(); });
    reload.hidden = !core.listReviews;
    const approvalStatus = el('p', '', 'drafting-warning');
    const status = el('p', '', 'review-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const title = el('h2', 'Heinlein Review');
    title.tabIndex = -1;
    const summary = el('p');
    const disclosure = el('p', 'Proofreader + editor: one advisory pass for spelling, grammar, clarity and continuity within this snapshot. Your voice and em dashes are protected. No tools or automatic manuscript changes.');
    const usage = el('p', 'Run sends the exact source snapshots below to OpenAI using your selected ChatGPT account and model. Plan usage may count. Up to 16 scenes / 16,000 UTF-8 bytes; requests stop locally after 65 seconds.', 'drafting-warning');
    const preview = el('details');
    preview.append(el('summary', 'Exact source snapshots to send'));
    const sources = el('div');
    preview.append(sources);
    const connection = el('p');
    const connect = button('ChatGPT connection', hooks.openConnection);
    const refresh = button('Refresh connection', () => { void configure(); });
    const run = button('Run Heinlein Review', () => { void submit(); });
    const retry = button('Retry review', () => { void submit(); });
    retry.hidden = true;
    const cancel = button('Cancel review', () => { cancelRequest(); status.textContent = 'Review canceled locally. Already-sent text cannot be recalled and usage may count. Your manuscript was not changed.'; update(); });
    const actions = el('div', '', 'question-actions');
    actions.append(run, retry, cancel, connect, refresh, button('Return to writing', hooks.focusEditor), button('Close review', clear));
    const refreshReview = button('Refresh review', () => { void refreshResult(); });
    refreshReview.hidden = true;
    actions.append(refreshReview);
    const edits = el('div', '', 'review-edits');
    const json = el('details');
    json.append(el('summary', 'Versioned review JSON'));
    const blob = el('pre', '', 'question-text');
    blob.tabIndex = 0;
    json.append(blob);
    json.hidden = true;
    element.append(title, summary, disclosure, usage, setup, preview, connection, previewBatch, batchPreview, actions, continueBatch, reload, saved, status, approvalStatus, edits, json);
    element.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        clear();
        hooks.focusEditor();
    } });
    function live(token: number) { return !disposed && !element.hidden && token === generation; }
    function scopeProblem() {
        if (!scope)
            return 'Open an editable source scene or a mapped assembled chapter.';
        if (workflowMode) {
            const total = scope.snapshots.reduce((n, s) => n + bytes(s.source), 0) + bytes(contextNote);
            if (!selectedPaths.size)
                return 'Choose at least one editable source. Unchecked sources are read-only context.';
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
    function update() {
        const problem = scopeProblem();
        approvalStatus.textContent = result ? (hooks.unavailable(false) ?? (pending ? 'Wait for the active reviewer batch to settle before approval.' : 'Approve… opens the final native confirmation for this exact patch.')) : '';
        summary.textContent = scope ? `${scope.scope === 'chapter' ? 'Mapped chapter' : 'Source scene'} · ${scope.label} · ${scope.snapshots.length} source snapshot(s) · ${scope.snapshots.reduce((n, s) => n + bytes(s.source), 0).toLocaleString()} UTF-8 bytes. Includes unsaved text captured when opened; later typing is never added to this request.` : problem;
        if (result?.schemaVersion === 2)
            summary.textContent = `Saved review ${result.reviewId} · ${result.workflow?.sources.filter(s => !s.readOnly).map(s => s.path).join(', ')}. New review settings below use the source captured when this panel opened.`;
        connection.textContent = ready() ? `ChatGPT · ${config!.model}` : config?.message ?? 'Checking ChatGPT connection…';
        run.disabled = retry.disabled = Boolean(problem || pending || busy || checking || !ready() || !core.requestReview || (workflowMode && !preparedRequest));
        previewBatch.disabled = Boolean(problem || pending || busy || checking || !definitions.length);
        continueBatch.hidden = !result?.workflow?.coverage.some(c => (c.status === 'queued' || c.status === 'notRun') && c.error !== 'findingLimit');
        continueBatch.disabled = Boolean(pending || busy || checking || !ready());
        setup.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(e => e.disabled = Boolean(pending || busy));
        refreshReview.hidden = !result;
        refreshReview.disabled = Boolean(busy || pending);
        cancel.hidden = !pending;
        refresh.disabled = Boolean(pending || busy || checking);
        connect.disabled = Boolean(pending || busy);
        if (problem && !element.hidden)
            status.textContent = problem;
        edits.querySelectorAll<HTMLButtonElement>('button[data-edit-action]').forEach(n => { n.disabled = Boolean(busy || pending || (n.dataset.editAction === 'accept' && (hooks.unavailable(false) || n.dataset.unavailable === 'true'))); });
    }
    async function configure() { if (checking)
        return; const token = generation; checking = true; update(); try {
        const next = await core.questionStatus?.();
        if (live(token))
            config = next ?? null;
    }
    catch {
        if (live(token))
            status.textContent = 'ChatGPT connection could not be checked. Open ChatGPT connection or refresh to retry.';
    }
    finally {
        if (live(token)) {
            checking = false;
            update();
        }
    } }
    function cancelRequest() { const id = pending; pending = null; clearTimeout(timer); generation++; checking = false; busy = false; if (id) {
        void core.cancelQuestion?.(id).catch(() => { });
        retry.hidden = false;
    } }
    function clear() { cancelRequest(); element.hidden = true; scope = null; result = null; config = null; edits.replaceChildren(); sources.replaceChildren(); blob.textContent = ''; json.hidden = true; refreshReview.hidden = true; }
    function validate(value: ReviewResult, requestId?: string) {
        if (value?.schemaVersion === 2) {
            if (!value.reviewId || !value.workflow || !Array.isArray(value.edits) || value.edits.length > 1024 || !Array.isArray(value.workflow.coverage) || value.workflow.coverage.length > 384 || (requestId && value.requestId !== requestId) || new Set(value.edits.map(e => e.id)).size !== value.edits.length)
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
    function render() {
        edits.replaceChildren();
        json.hidden = !result;
        blob.textContent = result ? JSON.stringify(result, null, 2) : '';
        if (!result)
            return;
        edits.append(el('p', `OpenAI · ${result.model} · Request ${result.requestId}. Recorded provider metadata is not authenticated authorship.`, 'muted'));
        if (!result.edits.length)
            edits.append(el('p', 'No targeted edits suggested. This is advisory feedback, not a publication approval.'));
        const rejected = result.edits.filter(edit => edit.status === 'rejected').length;
        if (rejected)
            edits.append(el('p', `${rejected} suggestion(s) dismissed. Rejected · local receipt retained.`));
        if (result.workflow) {
            const w = result.workflow;
            edits.append(el('p', w.contextNotice));
            const counts = new Map<string, number>();
            for (const c of w.coverage)
                counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
            edits.append(el('p', `Coverage: ${[...counts].map(([s, n]) => `${n} ${s}`).join(', ')}. ${w.coverage.every(c => c.status === 'completed') ? 'All selected calls completed.' : 'This review is incomplete. A running call may be interrupted; it is never automatically retried.'}`));
            const history = el('details');
            history.append(el('summary', 'Review decisions and history'));
            for (const item of result.edits.filter(e => !['pending', 'prepared'].includes(e.status))) {
                history.append(el('h3', `${item.path} · ${item.status}`), el('p', (item.comments ?? [item.reason]).join('\n')), el('pre', `${item.original}\n→ ${item.replacement}`, 'question-text'));
            }
            edits.append(history);
        }
        const groups = new Set<string>();
        for (const edit of result.edits.filter(edit => result!.schemaVersion === 2 ? ['pending', 'prepared'].includes(edit.status) : edit.status !== 'rejected')) {
            if (edit.conflictGroup && !groups.has(edit.conflictGroup)) {
                groups.add(edit.conflictGroup);
                edits.append(el('h3', 'Conflict alternatives · choose one, then approve separately'), el('p', 'No winner is selected automatically. Approval of your chosen alternative will dismiss the other listed alternatives; their audit remains.'));
            }
            const item = el('article', '', 'review-edit');
            item.dataset.findingId = edit.id;
            if (result.schemaVersion === 2) {
                item.append(el('h3', `${edit.path} · ${edit.location ? `Captured line ${edit.location.line}, column ${edit.location.column} · ` : ''}UTF-8 bytes ${edit.fromUtf8}–${edit.toUtf8}`), el('p', (edit.provenance ?? []).map(p => `${p.displayName} · ${p.instanceId} · definition v${p.definitionVersion} · ${p.model}`).join('\n')), el('p', (edit.comments ?? [edit.reason]).join('\n')));
                if (edit.sourceStale)
                    item.append(el('p', 'This source changed outside the accepted review lineage. Request a fresh review for this source; other files remain available.', 'drafting-warning'));
            }
            item.append(...(result.schemaVersion === 1 ? [el('h3', `${edit.role === 'proofreader' ? 'Proofreader' : 'Editor'} · ${edit.path}`)] : []), el('p', edit.reason), el('h4', 'Original'), el('pre', edit.original, 'question-text'), el('h4', 'Suggested replacement'), el('pre', edit.replacement, 'question-text'));
            if (edit.status === 'accepted' || edit.status === 'rejected')
                item.append(el('p', edit.status === 'accepted' ? 'Accepted · local receipt retained. Guarded undo is available in Proposed revisions.' : 'Rejected · local receipt retained.'));
            else {
                if (edit.conflictGroup) {
                    const label = el('label');
                    const choose = el('input');
                    choose.type = 'radio';
                    choose.name = `review-conflict-${edit.conflictGroup}`;
                    choose.checked = Boolean(edit.selected);
                    choose.setAttribute('aria-label', `Choose alternative ${edit.id}`);
                    choose.addEventListener('change', () => { void chooseAlternative(edit.id); });
                    label.append(choose, document.createTextNode(edit.selected ? 'Selected alternative · not applied' : 'Choose this alternative · not applied'));
                    item.append(label);
                }
                const accept = button(result.schemaVersion === 2 ? 'Approve…' : 'Accept edit', () => { void act(edit.id, true); });
                accept.dataset.editAction = 'accept';
                accept.dataset.unavailable = String(Boolean(edit.sourceStale || (edit.conflictGroup && !edit.selected)));
                const reject = button('Reject edit', () => { void act(edit.id, false); });
                reject.dataset.editAction = 'reject';
                item.append(accept, reject, el('p', result.schemaVersion === 2 ? 'Approve applies this prepared patch only after the existing final native confirmation. No extra comparison or copying is needed. Save matching text first.' : 'Accept opens the exact before/after proposal and separate native confirmation. Save matching unsaved text first.', 'muted'));
            }
            edits.append(item);
        }
        update();
    }
    async function submit(continuing = false) {
        if (pending || busy || (!continuing && scopeProblem()) || !ready() || !scope || !core.requestReview)
            return;
        if (!globalThis.crypto?.randomUUID) {
            status.textContent = 'A secure request identifier is unavailable. Reopen Studio.';
            return;
        }
        const token = generation;
        const requestId = crypto.randomUUID();
        const oldResult = result;
        const request: ReviewRequest = workflowMode ? { ...preparedRequest!, requestId } : { requestId, repositoryId: scope.repositoryId, scope: scope.scope, snapshots: scope.snapshots.map(s => ({ ...s })) };
        if (workflowMode && !continuing && !preparedRequest)
            return;
        pending = requestId;
        if (!continuing)
            result = null;
        render();
        retry.hidden = true;
        status.textContent = workflowMode ? 'Your selected reviewers are reviewing this captured scope. You can keep writing.' : 'Proofreader and editor are reviewing this snapshot. You can keep writing.';
        update();
        timer = setTimeout(() => { if (!live(token) || pending !== requestId)
            return; cancelRequest(); status.textContent = 'Review timed out locally. Usage may count. Retry when ready; your manuscript was not changed.'; update(); }, workflowMode ? 530000 : 65000);
        try {
            const connection = { generation: config!.generation, accountId: config!.activeAccountId!, model: config!.model! };
            const answer = continuing && oldResult && core.continueReview ? await core.continueReview(scope.repositoryId, oldResult.reviewId, requestId, connection) : await core.requestReview(request, connection);
            if (!live(token) || pending !== requestId)
                return;
            result = validate(answer, requestId);
            status.textContent = 'Review ready. Inspect each proposed edit and accept or reject it individually.';
            render();
        }
        catch (error) {
            if (live(token)) {
                status.textContent = message(error);
                retry.hidden = false;
            }
        }
        finally {
            if (live(token)) {
                clearTimeout(timer);
                pending = null;
                update();
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
                status.textContent = 'Review decisions refreshed from the native host.';
            }
        }
        catch (error) {
            if (live(token))
                status.textContent = message(error);
        }
        finally {
            if (live(token)) {
                busy = false;
                update();
            }
        }
    }
    async function act(editId: string, accept: boolean) {
        if (busy || pending || !result || !scope)
            return;
        const token = generation;
        const repositoryId = scope.repositoryId;
        const reviewId = result.reviewId;
        const guard = () => !live(token) ? 'Review scope changed. Start a new review.' : hooks.unavailable(true);
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
                    if (hooks.approveReview)
                        await hooks.approveReview(run, guard);
                    else
                        await run();
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
                const next = await core.rejectReviewEdit(repositoryId, reviewId, editId);
                if (!live(token))
                    return;
                result = validate(next);
            }
            if (live(token)) {
                render();
                status.textContent = accept ? 'Review state refreshed. Only a completed native confirmation applies an edit.' : 'Edit rejected. Your manuscript was not changed.';
            }
        }
        catch (error) {
            if (live(token))
                status.textContent = message(error);
        }
        finally {
            if (live(token)) {
                busy = false;
                update();
                (edits.querySelector<HTMLButtonElement>('button[data-edit-action]:not(:disabled)') ?? title).focus({ preventScroll: true });
            }
        }
    }
    function invalidatePreview() { editGeneration++; preparedRequest = null; coverage = []; batchPreview.replaceChildren(); update(); }
    function selector(labelText: string, values: {
        value: string;
        label: string;
    }[], value: string, change: (v: string) => void) { const label = el('label', labelText); const select = el('select'); select.setAttribute('aria-label', labelText); for (const v of values) {
        const option = el('option', v.label);
        option.value = v.value;
        select.append(option);
    } select.value = value; select.onchange = () => { change(select.value); invalidatePreview(); }; label.append(select); return label; }
    function settings() {
        setup.replaceChildren();
        setup.append(el('h3', 'New review · reviewer selection'));
        setup.append(selector('Number of reviewers', [1, 2, 3].map(n => ({ value: String(n), label: String(n) })), String(reviewerIds.length), v => { reviewerIds = Array.from({ length: Number(v) }, (_, i) => reviewerIds[i] ?? definitions[0]?.id ?? 'contextual'); settings(); }));
        reviewerIds.forEach((id, i) => setup.append(selector(`Reviewer ${i + 1} definition`, definitions.map(d => ({ value: d.id, label: `${d.displayName} · version ${d.version}` })), id, v => reviewerIds[i] = v)));
        setup.append(el('h3', 'Editable source and read-only context'));
        for (const snapshot of scope?.snapshots ?? []) {
            const label = el('label');
            const check = el('input');
            check.type = 'checkbox';
            check.checked = selectedPaths.has(snapshot.path);
            check.onchange = () => { if (check.checked)
                selectedPaths.add(snapshot.path);
            else
                selectedPaths.delete(snapshot.path); invalidatePreview(); };
            label.append(check, document.createTextNode(`Allow prepared edits in ${snapshot.path} (unchecked = read-only context)`));
            setup.append(label);
        }
        const label = el('label', 'Additional read-only author context');
        const area = el('textarea');
        area.value = contextNote;
        area.oninput = () => { contextNote = area.value; invalidatePreview(); };
        label.append(area);
        setup.append(label);
    }
    async function configureWorkflow() { const token = generation; try {
        const values = await core.reviewDefinitions!();
        if (!live(token))
            return;
        definitions = values;
        if (!definitions.some(d => d.id === reviewerIds[0]))
            reviewerIds = [definitions[0]?.id ?? ''];
        settings();
        await savedReviews();
    }
    catch (error) {
        if (live(token))
            status.textContent = message(error);
    }
    finally {
        if (live(token))
            update();
    } }
    async function prepareBatch() {
        if (busy || pending || scopeProblem() || !scope || !core.previewReview)
            return;
        const token = generation, inputs = editGeneration;
        const request: ReviewRequest = { requestId: crypto.randomUUID(), repositoryId: scope.repositoryId, scope: scope.scope, snapshots: scope.snapshots.filter(s => selectedPaths.has(s.path)).map(s => ({ ...s })), workflow: { reviewers: [...reviewerIds], context: scope.snapshots.filter(s => !selectedPaths.has(s.path)).map(s => ({ ...s })), contextNote, ranges: [] } };
        busy = true;
        update();
        try {
            const next = await core.previewReview(request);
            if (!live(token) || inputs !== editGeneration)
                return;
            preparedRequest = request;
            coverage = next;
            batchPreview.replaceChildren(el('h3', 'Exact batch preview'), el('p', `${reviewerIds.length} reviewer(s), ${new Set(next.map(c => `${c.sourceIndex}:${c.fromUtf8}:${c.toUtf8}`)).size} editable chunks, ${next.length} selected calls. This batch sends at most ${Math.min(8, next.length)} calls. Remaining calls need Continue.`), el('p', 'Each call has bounded neighboring context and the selected read-only context, not the whole work at once.'));
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
            status.textContent = 'Inspect this exact batch, then choose Run Heinlein Review.';
        }
        catch (error) {
            if (live(token))
                status.textContent = message(error);
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
        saved.replaceChildren();
        for (const record of records) {
            saved.append(button(`Reopen saved review ${record.reviewId}`, () => { void reopenSaved(record.reviewId); }));
        }
    }
    catch (error) {
        if (live(token))
            status.textContent = message(error);
    } }
    async function reopenSaved(id: string) { if (busy || pending || !scope || !core.getReview)
        return; const token = generation; busy = true; update(); try {
        const next = await core.getReview(scope.repositoryId, id);
        if (live(token)) {
            result = validate(next);
            render();
            status.textContent = 'Saved review reopened without running reviewers.';
            title.focus();
        }
    }
    catch (error) {
        if (live(token))
            status.textContent = message(error);
    }
    finally {
        if (live(token)) {
            busy = false;
            update();
        }
    } }
    async function chooseAlternative(id: string) { if (busy || pending || !scope || !result || !core.chooseReviewEdit)
        return; const token = generation; busy = true; update(); try {
        const next = await core.chooseReviewEdit(scope.repositoryId, result.reviewId, id);
        if (live(token)) {
            result = validate(next);
            render();
            status.textContent = 'Alternative selected, not applied. Approve separately to apply it and dismiss the competing alternatives.';
        }
    }
    catch (error) {
        if (live(token))
            status.textContent = message(error);
    }
    finally {
        if (live(token)) {
            busy = false;
            update();
            edits.querySelector<HTMLElement>(`[data-finding-id="${id}"] button`)?.focus();
        }
    } }
    return { element, open() {
            if (disposed)
                return;
            if (!element.hidden) {
                title.focus();
                return;
            }
            const captured = hooks.capture();
            scope = captured ? { ...captured, snapshots: captured.snapshots.map(s => ({ ...s })) } : null;
            selectedPaths = new Set(scope?.snapshots.map(s => s.path) ?? []);
            preparedRequest = null;
            reviewerIds = ['contextual'];
            contextNote = '';
            coverage = [];
            batchPreview.replaceChildren();
            saved.replaceChildren();
            element.hidden = false;
            retry.hidden = true;
            status.textContent = '';
            sources.replaceChildren();
            scope?.snapshots.forEach(s => sources.append(el('h3', s.path), el('pre', s.source, 'question-text')));
            if (!core.requestReview)
                status.textContent = 'Heinlein Review is unavailable in this native host.';
            if (workflowMode) {
                disclosure.textContent = 'Choose editable source and read-only context, then 1–3 reviewers. Definitions are advisory data; no tools, automatic edits or extra accounts are authorized.';
                usage.textContent = 'Up to 1 MiB selected source, 128 chunk/context windows and 4,000 UTF-8 bytes of author notes. Calls keep the existing 16,000-byte bound and selected account/model. At most 8 serial calls per explicit batch; plan usage may count. Nothing is silently truncated.';
                void configureWorkflow();
            }
            update();
            void configure();
            title.focus({ preventScroll: true });
        }, clear, stateChanged: update, destroy() { clear(); disposed = true; element.remove(); } };
}
