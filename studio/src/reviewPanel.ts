import type { LocalCore, QuestionStatus, ReviewEdit, ReviewResult, ReviewRequest, ReviewerDefinition, ReviewCoverage, ProposalOutcome } from './localCore';
import { changedSpan, decisionLabel, invisibleChangeNote, lineageDelta, patchContext, pendingLabel, reviewProgress, waiting, type PatchContext } from './reviewComparison';
import type { ReviewMarkInput } from './reviewMarks';
import { formatKeys } from './shortcuts';
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
    announce?(text: string): void;
    marksChanged?(input: ReviewMarkInput | null, report: (count: number | null) => void): void;
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
    let savedRecords: ReviewResult[] = [];
    let shownReview: string | null = null;
    let historyOpen: boolean | null = null;
    const receipts = new Map<string, string>();
    const setup = el('div', '', 'review-setup'), batchPreview = el('div', '', 'review-batch-preview'), saved = el('div', '', 'review-saved');
    const previewBatch = button('Preview reviewer batch', () => { void prepareBatch(); });
    previewBatch.hidden = !workflowMode;
    const continueBatch = button('Continue next reviewer batch', () => { void submit(true); });
    continueBatch.hidden = true;
    const reload = button('Reload saved reviews', () => { void savedReviews(); });
    reload.hidden = !core.listReviews;
    const approvalStatus = el('p', '', 'review-guidance');
    approvalStatus.hidden = true;
    const markStatus = el('div', '', 'review-mark-status'), markLine = el('p', '', 'review-guidance'), markHelp = el('details');
    markHelp.append(el('summary', 'How to read and open the marks'), el('p', `A solid underline is a change, a line through is a removal, a wavy underline is competing alternatives and a small bar is an insertion. Click one to open it here, or use ${formatKeys('⌘⌥]')} and ${formatKeys('⌘⌥[')} to move between them and ${formatKeys('⌘⌥O')} to open one. Marks never apply or choose anything.`));
    markStatus.append(markLine, markHelp);
    markStatus.hidden = true;
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
    actions.append(run, retry, cancel, connect, refresh);
    const refreshReview = button('Refresh review', () => { void refreshResult(); });
    refreshReview.hidden = true;
    const continueNote = el('p', 'Continue sends the next selected calls to OpenAI through your selected account and model. Plan usage may count.', 'review-guidance');
    continueNote.hidden = true;
    const resultActions = el('div', '', 'review-result-actions');
    resultActions.append(continueNote, continueBatch, refreshReview);
    const head = el('header', '', 'review-head'), nav = el('div', '', 'review-nav');
    nav.append(button('Return to writing', tuck), button('Close review', clear));
    head.append(title, nav);
    const savedSection = el('section', '', 'review-saved-section');
    savedSection.setAttribute('aria-label', 'Saved reviews');
    savedSection.hidden = true;
    savedSection.append(el('h3', 'Saved reviews'), el('p', 'Reopening a saved review shows your recorded decisions. It does not run reviewers again.', 'review-guidance'), saved, reload);
    const newReview = el('details', '', 'review-new');
    newReview.open = true;
    newReview.append(el('summary', 'Start a new review'), disclosure, usage, setup, preview, connection, previewBatch, batchPreview, actions);
    const edits = el('div', '', 'review-edits');
    const json = el('details');
    json.append(el('summary', 'Versioned review JSON'));
    const blob = el('pre', '', 'question-text');
    blob.tabIndex = 0;
    json.append(blob);
    json.hidden = true;
    element.append(head, summary, status, approvalStatus, markStatus, edits, resultActions, json, savedSection, newReview);
    element.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        clear();
        hooks.focusEditor();
    } });
    function live(token: number) { return !disposed && !element.hidden && token === generation; }
    function scopeProblem() {
        if (!scope)
            return 'Open an editable source file or a mapped assembled chapter.';
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
        const decisionsWaiting = Boolean(result?.edits.some(waiting));
        const approvalBlocked = decisionsWaiting ? (hooks.unavailable(false) ?? (pending ? 'Wait for the active reviewer batch to settle before approval.' : null)) : null;
        approvalStatus.hidden = !decisionsWaiting;
        approvalStatus.className = approvalBlocked ? 'drafting-warning' : 'review-guidance';
        approvalStatus.textContent = decisionsWaiting ? (approvalBlocked ?? (result!.schemaVersion === 2 ? 'Approve opens the final native confirmation for this exact patch. Nothing changes until you confirm. Each suggestion is separate.' : 'Accept opens the exact before/after proposal and a separate native confirmation. Save matching unsaved text first.')) : '';
        summary.textContent = scope ? `${scope.scope === 'chapter' ? 'Mapped chapter' : 'Source file'} · ${scope.label} · ${scope.snapshots.length} source snapshot(s) · ${scope.snapshots.reduce((n, s) => n + bytes(s.source), 0).toLocaleString()} UTF-8 bytes. Includes unsaved text captured when opened; later typing is never added to this request.` : problem;
        if (result?.schemaVersion === 2)
            summary.textContent = `Saved review ${result.reviewId} · ${result.workflow?.sources.filter(s => !s.readOnly).map(s => s.path).join(', ')}`;
        connection.textContent = ready() ? `ChatGPT · ${config!.model}` : config?.message ?? 'Checking ChatGPT connection…';
        run.disabled = retry.disabled = Boolean(problem || pending || busy || checking || !ready() || !core.requestReview || (workflowMode && !preparedRequest));
        previewBatch.disabled = Boolean(problem || pending || busy || checking || !definitions.length);
        continueBatch.hidden = !result?.workflow?.coverage.some(c => (c.status === 'queued' || c.status === 'notRun') && c.error !== 'findingLimit');
        continueNote.hidden = continueBatch.hidden;
        if (pending || !retry.hidden || !result)
            newReview.open = true;
        continueBatch.disabled = Boolean(pending || busy || checking || !ready());
        setup.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(e => e.disabled = Boolean(pending || busy));
        refreshReview.hidden = !result;
        refreshReview.disabled = Boolean(busy || pending);
        cancel.hidden = !pending;
        refresh.disabled = Boolean(pending || busy || checking);
        connect.disabled = Boolean(pending || busy);
        if (problem && !element.hidden && !result)
            status.textContent = problem;
        edits.querySelectorAll<HTMLButtonElement>('button[data-edit-action]').forEach(n => { n.disabled = Boolean(busy || pending || (n.dataset.editAction === 'accept' && (hooks.unavailable(false) || n.dataset.unavailable === 'true'))); });
        edits.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach(n => { n.disabled = Boolean(busy || pending); });
        edits.querySelectorAll<HTMLElement>('[data-approve-reason]').forEach(n => { const why = n.dataset.approveReason || (busy || pending ? 'Wait for the current review action to finish.' : hooks.unavailable(false)) || ''; n.textContent = why; n.hidden = !why; });
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
    function clear() { cancelRequest(); element.hidden = true; element.classList.remove('review-tucked'); scope = null; result = null; config = null; savedRecords = []; shownReview = null; historyOpen = null; receipts.clear(); publishMarks(); saved.replaceChildren(); savedSection.hidden = true; edits.replaceChildren(); sources.replaceChildren(); blob.textContent = ''; json.hidden = true; refreshReview.hidden = true; newReview.open = true; }
    function untuck() {
        if (element.classList.contains('review-tucked')) {
            element.classList.remove('review-tucked');
            hooks.announce?.('');
        }
    }
    // Keeps the review and any running request while giving the whole window back to writing.
    function tuck() {
        element.classList.add('review-tucked');
        const count = result?.edits.filter(waiting).length ?? 0;
        hooks.announce?.(`Heinlein Review stays open${count ? ` with ${count} ${count === 1 ? 'suggestion' : 'suggestions'} waiting` : ''}. Choose Heinlein Review to come back.`);
        hooks.focusEditor();
    }
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
    function renderSaved() {
        saved.replaceChildren();
        savedRecords = savedRecords.map(record => record.reviewId === result?.reviewId ? result : record);
        savedSection.hidden = !savedRecords.length;
        for (const record of savedRecords) {
            const row = el('div', '', 'review-saved-item');
            const reopen = button(`Reopen saved review ${record.reviewId}`, () => { void reopenSaved(record.reviewId); });
            const paths = (record.workflow?.sources ?? []).filter(s => !s.readOnly).map(s => s.path).join(', ');
            if (record.reviewId === result?.reviewId) {
                reopen.setAttribute('aria-current', 'true');
                row.append(el('p', 'Open below', 'review-chip'));
            }
            row.append(reopen, el('p', [paths, reviewProgress(Array.isArray(record.edits) ? record.edits : [])].filter(Boolean).join(' · ')));
            saved.append(row);
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
    function exactText(edit: ReviewEdit, context: PatchContext | null, side: 'current' | 'proposed') {
        const part = changedSpan(edit.original, edit.replacement);
        const pre = el('pre', '', 'question-text review-diff');
        pre.dataset.side = side;
        if (context?.cutBefore)
            pre.append(el('span', '', 'review-cut'));
        pre.append((context?.before ?? '') + part.prefix);
        const change = side === 'current' ? part.removed : part.added;
        if (change)
            pre.append(el(side === 'current' ? 'del' : 'ins', change));
        else if (part.removed || part.added)
            pre.append(el('span', '', 'review-point'));
        pre.append(part.suffix + (context?.after ?? ''));
        if (context?.cutAfter)
            pre.append(el('span', '', 'review-cut'));
        return pre;
    }
    function comparison(edit: ReviewEdit, context: PatchContext | null) {
        const nodes: HTMLElement[] = [];
        const note = invisibleChangeNote(edit.original, edit.replacement);
        if (note)
            nodes.push(el('p', note, 'review-guidance'));
        else if (!edit.original || !edit.replacement)
            nodes.push(el('p', edit.original ? 'Deletion: this removes text and adds nothing.' : 'Insertion: this adds text and removes nothing.', 'review-guidance'));
        nodes.push(el('h5', 'Current text'), exactText(edit, context, 'current'), el('h5', 'Proposed text'), exactText(edit, context, 'proposed'));
        if (!context)
            nodes.push(el('p', 'Surrounding text is not shown because the open source no longer matches this position. The exact patch above is unchanged.', 'review-guidance'));
        return nodes;
    }
    function card(edit: ReviewEdit, number: number, total: number, current: ReviewScope | null) {
        const v2 = result!.schemaVersion === 2;
        const item = el('article', '', 'review-edit');
        item.dataset.findingId = edit.id;
        const heading = el('h4', `Suggestion ${number} of ${total}`);
        heading.tabIndex = -1;
        heading.id = `review-suggestion-${generation}-${number}`;
        item.setAttribute('aria-labelledby', heading.id);
        const decided = edit.status === 'accepted' || edit.status === 'rejected';
        item.append(heading, el('p', decided ? decisionLabel(edit.status) : pendingLabel(edit), `review-chip${edit.sourceStale ? ' review-chip-warning' : ''}`));
        if (v2) {
            const by = [...new Set((edit.provenance ?? []).map(p => p.displayName))].join(', ');
            item.append(el('p', `${edit.path}${edit.location ? ` · Captured line ${edit.location.line}, column ${edit.location.column}` : ''}`, 'review-where'));
            if (by)
                item.append(el('p', `Suggested by ${by}`, 'review-where'));
        }
        else
            item.append(el('p', `${edit.role === 'proofreader' ? 'Proofreader' : 'Editor'} · ${edit.path}`, 'review-where'));
        for (const comment of edit.comments ?? [edit.reason])
            item.append(el('p', comment, 'review-comment'));
        if (edit.sourceStale)
            item.append(el('p', 'This source changed outside the accepted review lineage. Request a fresh review for this source; other files remain available.', 'drafting-warning'));
        item.append(...comparison(edit, contextFor(edit, current)));
        if (decided)
            item.append(el('p', edit.status === 'accepted' ? 'Accepted · local receipt retained. Guarded undo is available in Proposed revisions.' : 'Rejected · local receipt retained.'));
        else {
            if (edit.conflictGroup) {
                const label = el('label', '', 'review-choice');
                const choose = el('input');
                choose.type = 'radio';
                choose.name = `review-conflict-${edit.conflictGroup}`;
                choose.checked = Boolean(edit.selected);
                choose.addEventListener('change', () => { void chooseAlternative(edit.id); });
                label.append(choose, document.createTextNode(edit.selected ? 'Selected · not applied yet' : 'Choose this alternative · not applied yet'));
                item.append(label);
            }
            const controls = el('div', '', 'review-decision');
            const accept = button(v2 ? 'Approve this change…' : 'Accept edit', () => { void act(edit.id, true); });
            accept.className = 'review-approve';
            accept.dataset.editAction = 'accept';
            accept.dataset.unavailable = String(Boolean(edit.sourceStale || (edit.conflictGroup && !edit.selected)));
            const reject = button(v2 ? 'Reject this change' : 'Reject edit', () => { void act(edit.id, false); });
            reject.dataset.editAction = 'reject';
            accept.setAttribute('aria-describedby', heading.id);
            reject.setAttribute('aria-describedby', heading.id);
            const why = el('p', '', 'review-why');
            why.dataset.approveReason = edit.sourceStale ? 'Approval is off because this source changed. You can still reject this suggestion.' : edit.conflictGroup && !edit.selected ? 'Choose this alternative above before approving it.' : '';
            why.hidden = true;
            controls.append(accept, reject);
            item.append(controls, why);
        }
        if (v2) {
            const technical = el('details', '', 'review-technical');
            technical.append(el('summary', 'Exact patch details'), el('p', `UTF-8 bytes ${edit.fromUtf8}–${edit.toUtf8}. Byte ranges remain authority.`));
            for (const p of edit.provenance ?? [])
                technical.append(el('p', `${p.displayName} · ${p.instanceId} · definition v${p.definitionVersion} · ${p.model}`));
            if (edit.patchHash)
                technical.append(el('p', `Patch SHA-256: ${edit.patchHash}`));
            if (edit.patch)
                technical.append(el('code', edit.patch));
            item.append(technical);
        }
        return item;
    }
    function publishMarks() {
        const shown = result, within = scope;
        if (!shown || !within) {
            hooks.marksChanged?.(null, () => { });
            markStatus.hidden = true;
            return;
        }
        markStatus.hidden = true;
        const open = shown.edits.filter(waiting).length;
        hooks.marksChanged?.({ repositoryId: within.repositoryId, projectKey: shown.projectKey ?? null, edits: shown.edits, baselineHash: path => shown.workflow?.sources.find(s => s.path === path)?.sourceHash ?? within.snapshots.find(s => s.path === path)?.sourceHash }, marked => {
            if (result !== shown)
                return;
            markStatus.hidden = marked === null || !open;
            markHelp.hidden = !marked;
            markLine.textContent = marked ? `${marked} of ${open} waiting ${open === 1 ? 'suggestion is' : 'suggestions are'} marked in the open text.` : 'None of these suggestions is marked in the open text. They belong to another file, or the open text no longer matches this review.';
        });
    }
    function render() {
        edits.replaceChildren();
        json.hidden = !result;
        blob.textContent = result ? JSON.stringify(result, null, 2) : '';
        if ((result?.reviewId ?? null) !== shownReview) {
            shownReview = result?.reviewId ?? null;
            historyOpen = null;
            newReview.open = !result;
        }
        renderSaved();
        publishMarks();
        if (!result)
            return;
        const heading = el('h3', result.edits.length ? 'Suggestions for your decision' : 'Review result');
        heading.tabIndex = -1;
        heading.dataset.resultsHeading = 'true';
        edits.append(heading, el('p', reviewProgress(result.edits), 'review-progress'));
        if (!result.edits.length)
            edits.append(el('p', 'No targeted edits suggested. This is advisory feedback, not a publication approval.'));
        const rejected = result.edits.filter(edit => edit.status === 'rejected').length;
        if (rejected && result.schemaVersion !== 2)
            edits.append(el('p', `${rejected} suggestion(s) dismissed. Rejected · local receipt retained.`));
        const w = result.workflow;
        if (w && !w.coverage.every(c => c.status === 'completed'))
            edits.append(el('p', 'This review is incomplete. A running call may be interrupted; it is never automatically retried.', 'drafting-warning'));
        const listed = result.edits.filter(edit => result!.schemaVersion === 2 ? waiting(edit) : edit.status !== 'rejected');
        const current = hooks.capture();
        const groups = new Set<string>();
        let number = 0;
        for (const edit of listed) {
            const group = edit.conflictGroup;
            if (!group) {
                edits.append(card(edit, ++number, listed.length, current));
                continue;
            }
            if (groups.has(group))
                continue;
            groups.add(group);
            const set = el('fieldset', '', 'review-conflict');
            set.append(el('legend', 'Competing suggestions for the same text'), el('p', 'Nothing is chosen for you. Choose one, then approve it separately. Approving it dismisses the others listed here and keeps their audit. You can also reject any of them.', 'review-guidance'));
            for (const member of listed.filter(e => e.conflictGroup === group))
                set.append(card(member, ++number, listed.length, current));
            edits.append(set);
        }
        if (w) {
            const decided = result.edits.filter(e => !waiting(e));
            const history = el('details', '', 'review-history');
            history.append(el('summary', `Review decisions and history (${decided.length})`));
            history.open = historyOpen ?? decided.length > 0;
            history.addEventListener('toggle', () => { if (history.isConnected)
                historyOpen = history.open; });
            if (!decided.length)
                history.append(el('p', 'No decisions recorded yet.'));
            for (const item of decided) {
                const entry = el('article', '', 'review-history-item');
                entry.append(el('h4', decisionLabel(item.status)), el('p', `${item.path}${item.location ? ` · Captured line ${item.location.line}, column ${item.location.column}` : ''}`, 'review-where'));
                for (const comment of item.comments ?? [item.reason])
                    entry.append(el('p', comment, 'review-comment'));
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
            edits.append(history);
        }
        const about = el('details', '', 'review-about');
        about.append(el('summary', 'About this review'), el('p', `OpenAI · ${result.model} · Request ${result.requestId}. Recorded provider metadata is not authenticated authorship.`));
        if (w) {
            const counts = new Map<string, number>();
            for (const c of w.coverage)
                counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
            about.append(el('p', w.contextNotice), el('p', `Coverage: ${[...counts].map(([s, n]) => `${n} ${s}`).join(', ')}. ${w.coverage.every(c => c.status === 'completed') ? 'All selected calls completed.' : 'This review is incomplete.'}`));
        }
        edits.append(about);
        update();
    }
    function focusCard(index: number, note?: string, warning = false) {
        const cards = [...edits.querySelectorAll<HTMLElement>('.review-edit')];
        const item = cards[Math.min(index, cards.length - 1)];
        const heading = edits.querySelector<HTMLElement>('[data-results-heading]');
        const target = item?.querySelector<HTMLElement>('button[data-edit-action="accept"]:not(:disabled)') ?? item?.querySelector<HTMLElement>('input[type=radio]:not(:disabled)') ?? item?.querySelector<HTMLElement>('h4') ?? heading ?? title;
        const shown = note ? el('p', note, warning ? 'drafting-warning' : 'review-decision-note') : null;
        if (shown) {
            if (item)
                (item.closest('fieldset') ?? item).before(shown);
            else if (heading?.nextElementSibling)
                heading.nextElementSibling.after(shown);
        }
        target.focus({ preventScroll: true });
        shown?.scrollIntoView?.({ block: 'nearest' });
        target.scrollIntoView?.({ block: 'nearest' });
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
            status.textContent = 'Review ready. Inspect each suggestion and decide it individually.';
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
                if (result && retry.hidden)
                    newReview.open = false;
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
                const next = await core.rejectReviewEdit(repositoryId, reviewId, editId);
                if (!live(token))
                    return;
                result = validate(next);
            }
            if (live(token)) {
                render();
                const after = result.edits.find(e => e.id === editId);
                const replaced = result.edits.filter(e => e.status === 'supersededByAuthorChoice' && after?.conflictGroup && e.conflictGroup === after.conflictGroup).length;
                note = !accept ? 'Edit rejected. Your manuscript was not changed. Other suggestions are unchanged.'
                    : after?.status === 'accepted' ? `Applied to ${after.path} after your confirmation.${receipts.has(editId) ? ` Local receipt ${receipts.get(editId)}.` : ''}${replaced ? ` ${replaced} competing ${replaced === 1 ? 'alternative was' : 'alternatives were'} dismissed.` : ''} Other suggestions are unchanged.`
                    : 'Not applied. This suggestion is still waiting for your decision, and your manuscript was not changed by it.';
                if (outcome?.warning)
                    note += ` ${outcome.warning}`;
                failed = Boolean(outcome?.warning);
                status.textContent = note;
            }
        }
        catch (error) {
            if (live(token)) {
                note = message(error);
                failed = true;
                status.textContent = note;
            }
        }
        finally {
            if (live(token)) {
                busy = false;
                update();
                focusCard(position, note, failed);
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
        savedRecords = records;
        renderSaved();
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
        return; const token = generation; const position = Math.max(0, [...edits.querySelectorAll<HTMLElement>('.review-edit')].findIndex(n => n.dataset.findingId === id)); let chosen: string | undefined; busy = true; update(); try {
        const next = await core.chooseReviewEdit(scope.repositoryId, result.reviewId, id);
        if (live(token)) {
            result = validate(next);
            render();
            chosen = 'Alternative selected, not applied. Approve separately to apply it and dismiss the competing alternatives.';
            status.textContent = chosen;
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
            focusCard(position, chosen);
        }
    } }
    return { element, open() {
            if (disposed)
                return;
            if (!element.hidden) {
                untuck();
                update();
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
            savedRecords = [];
            renderSaved();
            element.hidden = false;
            retry.hidden = true;
            status.textContent = '';
            sources.replaceChildren();
            scope?.snapshots.forEach(s => { const text = el('pre', s.source, 'question-text'); text.tabIndex = 0; sources.append(el('h3', s.path), text); });
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
        }, clear, stateChanged: update,
        // Only shows the card. It never applies, rejects or chooses, and a competing group stays unchosen.
        openSuggestion(id: string) {
            if (disposed || element.hidden || !result)
                return false;
            const item = [...edits.querySelectorAll<HTMLElement>('.review-edit')].find(n => n.dataset.findingId === id);
            if (!item)
                return false;
            untuck();
            update();
            edits.querySelectorAll('.review-opened').forEach(n => n.classList.remove('review-opened'));
            const group = item.closest<HTMLElement>('fieldset');
            const shown = group ?? item;
            shown.classList.add('review-opened');
            const target = group ?? item.querySelector<HTMLElement>('h4') ?? item;
            target.tabIndex = -1;
            status.textContent = group ? 'Opened the competing suggestions for this text. Nothing is chosen.' : `Opened ${item.querySelector('h4')?.textContent ?? 'this suggestion'}.`;
            target.focus({ preventScroll: true });
            shown.scrollIntoView?.({ block: 'start' });
            return true;
        },
        marksInvalidated() {
            if (result && result.edits.some(waiting)) {
                markStatus.hidden = false;
                markHelp.hidden = true;
                markLine.textContent = 'Highlights are off because the open text changed. Save your text, then choose Refresh review to show the ones that still match.';
            }
        }, destroy() { clear(); disposed = true; element.remove(); } };
}
