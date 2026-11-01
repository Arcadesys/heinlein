// Synthetic full-Studio host only; never imported by production. No files/providers/OS authority.
import { mountStudio } from '../../src/studio';
import type { LocalCore, ReviewRequest, ReviewResult, ReviewCoverage, ReviewerDefinition, ProposalOutcome, ProposalReceipt, RecoveryDraft } from '../../src/localCore';
import '../../src/fonts.bundle';
import '../../src/style.css';
const demo = new URLSearchParams(location.search).get('scenario') === 'demo';
const markers = new URLSearchParams(location.search).get('markers') === '1';
const key = markers ? 'heinlein-revision-synthetic-demo-markers-v1' : demo ? 'heinlein-revision-synthetic-demo-v1' : 'heinlein-revision-synthetic-v2';
const scenePath = demo ? 'lantern-street.md' : 'scene.md';
const baseline = demo ? '---\r\ntitle: "Lantern Street — invented example"\r\n---\r\nThe ferry 🐺 came in late — it always did.\r\n\r\nMarlo counted the crates twice. The manifest were wrong again, and the harbor clerk had stopped pretending otherwise.\r\n\r\nRain moved across the pier in long grey sheets. Nobody looked up.\r\n' : '🐺 bad / bad / keep — exactly.\r\n';
// The demo uses real SHA-256 so inline marks face the same whole-file lineage proof as the app.
const digestHex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const baselineHash = demo ? await digestHex(baseline) : 'a'.repeat(64);
const defs: ReviewerDefinition[] = [{ id: 'contextual', version: 1, displayName: 'Story and clarity review', instructions: 'Keep intentional voice. No findings is valid.' }, { id: 'mechanical', version: 1, displayName: 'Mechanical review', instructions: 'Only clear mechanical corrections, never normalize expressive style.' }];
let stored: {
    text: string;
    record: ReviewResult | null;
    receipts?: ProposalReceipt[];
} = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { text: baseline, record: null };
let recovery: RecoveryDraft | null = null;
let dirty = false;
const calls: {
    action: string;
    id?: string;
}[] = [];
const session = { id: 'synthetic-revision-session', name: demo ? 'Invented demo folder' : 'Synthetic review folder', manifests: [] };
const persist = () => { localStorage.setItem(key, JSON.stringify(stored)); guide?.refresh(); };
let guide: { refresh(): void } | null = null;
const origin = { kind: 'nativeOpenAi' as const, sessionId: '', clientLabel: '', identityAssurance: 'unverifiedProviderMetadata' as const, provider: 'openai' as const, model: 'synthetic-selected-model', requestId: 'synthetic-call' };
function receipt(id: string, kind: 'apply' | 'reject', status: ProposalReceipt['status']): ProposalReceipt {
    const entry: ProposalReceipt = { id: `receipt-${id}`, kind, proposalId: `proposal-${id}`, path: scenePath, baseHash: 'a'.repeat(64), replacementHash: 'b'.repeat(64), diffHash: 'c'.repeat(64), origin, parentReceiptId: null, status, message: null, createdAtMs: 1, revertAvailable: false };
    (stored.receipts ??= []).unshift(entry);
    return entry;
}
const utf8 = (text: string) => new TextEncoder().encode(text).length;
// Invented prose and an invented review. Every suggestion routes through the production panel.
function demoRecord(): ReviewResult {
    const suggest = (id: string, before: string, original: string, replacement: string, comment: string, group: string | null) => { const from = utf8(baseline.slice(0, baseline.indexOf(before) + before.indexOf(original))); return { id, path: scenePath, fromUtf8: from, toUtf8: from + utf8(original), original, replacement, reason: comment, role: 'editor' as const, status: 'pending' as const, proposalId: null, conflictGroup: group, selected: false, location: { line: baseline.slice(0, baseline.indexOf(before)).split('\n').length, column: [...baseline.slice(baseline.lastIndexOf('\n', baseline.indexOf(before)) + 1, baseline.indexOf(before) + before.indexOf(original))].length + 1 }, patch: JSON.stringify({ path: scenePath, fromUtf8: from, toUtf8: from + utf8(original), before: original, replacement }), patchHash: 'd'.repeat(64), comments: [comment], provenance: [{ instanceId: 'reviewer-1', definitionId: 'contextual', definitionVersion: 1, displayName: 'Story and clarity review', requestId: 'synthetic-call', model: 'synthetic-selected-model', accountId: 'synthetic-selected-account', accountGeneration: 1 }] }; };
    return { schemaVersion: 2, reviewId: 'demo-lantern-street', requestId: 'demo-prepared', revision: 1, projectKey: 'b'.repeat(64), scope: 'scene', model: 'synthetic-selected-model', workflow: { definitions: [{ instanceId: 'reviewer-1', definition: structuredClone(defs[0]), hash: 'c'.repeat(64) }], sources: [{ id: 'source-1', path: scenePath, sourceHash: baselineHash, readOnly: false, order: 0 }], coverage: [{ ...coverage[0], status: 'completed', requestId: 'synthetic-call' }], decisions: [], accountId: 'synthetic-selected-account', accountGeneration: 1, contextNotice: 'Simulated browser backend with invented text and prepared suggestions. No provider, filesystem or OS access.' }, edits: [
        suggest('example-approve', 'The manifest were wrong', 'were', 'was', 'Example 1 · Approve. "Manifest" is singular, so the verb looks like a slip.', null),
        suggest('example-dismiss', 'Nobody looked up.', 'Nobody looked up.', 'Nobody bothered to look up.', 'Example 2 · Dismiss. This softens a short closing sentence that may be deliberate. Your call.', null),
        suggest('example-overlap-spelling', 'long grey sheets', 'grey', 'gray', 'Example 3 · Overlap, alternative A. Changes one word to the US spelling.', 'overlap'),
        suggest('example-overlap-image', 'long grey sheets', 'long grey sheets', 'slanting sheets', 'Example 3 · Overlap, alternative B. Rewrites the whole phrase, including the same word.', 'overlap'),
        ...(markers ? [suggest('marker-delete', 'wrong again,', ' again', '', 'Marker check. A removal is marked with a line through.', null), suggest('marker-insert', ' came in late', '', ' quietly', 'Marker check. An insertion is marked with a small bar.', null), suggest('marker-comma', ', and the harbor', ',', ';', 'Marker check. This punctuation change starts where the removal ends.', null), suggest('marker-wolf', '🐺 came', '🐺', '🦊', 'Marker check. The insertion starts where this change ends.', null)] : []),
    ] };
}
// Stands in for the native macOS confirmation so the demo stays readable at large text in any browser panel.
function simulatedConfirmation(edit: ReviewResult['edits'][number]) {
    return new Promise<boolean>(resolve => {
        const box = document.createElement('dialog');
        box.className = 'fixture-confirm';
        box.setAttribute('aria-label', 'Simulated final confirmation');
        const line = (tag: 'h2' | 'p' | 'h3', text: string) => { const n = document.createElement(tag); n.textContent = text; box.append(n); };
        line('h2', 'Simulated final confirmation');
        line('p', `The real app shows a native dialog here. This one is part of the browser demo. Apply this exact patch to ${edit.path}?`);
        line('h3', 'Replace');
        line('p', edit.original);
        line('h3', 'With');
        line('p', edit.replacement);
        const finish = (yes: boolean) => { box.close(); box.remove(); resolve(yes); };
        for (const [label, yes] of [['Confirm and apply', true], ['Cancel', false]] as const) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = () => finish(yes); box.append(b); }
        box.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
        document.body.append(box);
        box.showModal();
        // Starts at the top on the wording, not on Confirm, so a repeated Enter cannot apply it.
        const title = box.querySelector('h2')!;
        title.tabIndex = -1;
        title.focus();
        box.scrollTop = 0;
    });
}
const doc = (path: string) => ({ path, text: stored.text, contentHash: !demo || stored.text === baseline ? baselineHash : 'e'.repeat(64), sizeBytes: new TextEncoder().encode(stored.text).length, frontmatter: null, generatedCompatibility: false });
const coverage: ReviewCoverage[] = [{ id: 'chunk-0', sourceIndex: 0, fromUtf8: 0, toUtf8: new TextEncoder().encode(baseline).length, windowFrom: 0, windowTo: new TextEncoder().encode(baseline).length, reviewer: 0, status: 'queued', requestId: null, error: null }];
function result(r: ReviewRequest): ReviewResult {
    return { schemaVersion: 2, reviewId: 'synthetic-review-stable', requestId: r.requestId, revision: 1, projectKey: 'b'.repeat(64), scope: r.scope, model: 'synthetic-selected-model', workflow: { definitions: r.workflow!.reviewers.map((id, i) => ({ instanceId: `reviewer-${i + 1}`, definition: structuredClone(defs.find(d => d.id === id)!), hash: 'c'.repeat(64) })), sources: [{ id: 'source-1', path: 'scene.md', sourceHash: 'a'.repeat(64), readOnly: false, order: 0 }], coverage: coverage.map(c => ({ ...c, status: 'completed', requestId: 'synthetic-call' })), decisions: [], accountId: 'synthetic-selected-account', accountGeneration: 1, contextNotice: 'Synthetic native host: no provider, filesystem or OS access. The production review uses bounded context per call, not the whole work at once.' }, edits: [['first', 5, 8, 'good', 'group-first'], ['alternative', 5, 8, 'fine', 'group-first'], ['unrelated', 11, 14, 'great', null]].map(([id, from, to, replacement, group]) => ({ id: String(id), location: {line:1,column:[...new TextDecoder().decode(new TextEncoder().encode(baseline).slice(0,Number(from)))].length+1}, path: 'scene.md', fromUtf8: Number(from), toUtf8: Number(to), original: 'bad', replacement: String(replacement), reason: `Synthetic comment for ${id}`, role: 'editor', status: 'pending', proposalId: null, conflictGroup: group as string | null, selected: false, patch: JSON.stringify({ path: 'scene.md', fromUtf8: from, toUtf8: to, before: 'bad', replacement }), patchHash: 'd'.repeat(64), comments: [`Synthetic comment for ${id}`], provenance: [{ instanceId: 'reviewer-1', definitionId: 'contextual', definitionVersion: 1, displayName: 'Story and clarity review', requestId: 'synthetic-call', model: 'synthetic-selected-model', accountId: 'synthetic-selected-account', accountGeneration: 1 }] })) };
}
const unavailable = async (): Promise<never> => { throw new Error('Synthetic host: no native filesystem, credentials or provider calls.'); };
const core: LocalCore = { available: () => true, pickRepository: async () => session, recentRepositories: async () => [], openRecentRepository: unavailable, listSystemFonts: async () => [], listDirectory: async () => [{ path: scenePath, name: scenePath, kind: 'file', sizeBytes: baseline.length }], loadManuscript: unavailable, readDocument: async (_id, path) => doc(path), saveDocument: async (_id, path, _hash, text) => { stored.text = text; persist(); return doc(path); }, readRecovery: async () => recovery, stageRecovery: async (_id, path, baseHash, text) => recovery = { id: 'recovery', path, baseHash, text, updatedAt: 1 }, discardRecovery: async () => { recovery = null; }, setUnsavedChanges: async (value) => { dirty = value; }, requestClose: async () => { }, onCloseRequested: async () => () => { },
    questionStatus: async () => ({ configured: true, model: 'synthetic-selected-model', selectedModel: 'synthetic-selected-model', models: [{ slug: 'synthetic-selected-model', displayName: 'Synthetic selected model' }], accounts: [{ id: 'synthetic-selected-account', label: 'Synthetic account', signedIn: true, planEnabled: true }], activeAccountId: 'synthetic-selected-account', generation: 1, usageLimited: false, signInPending: false, message: 'Synthetic only: no live account' }),
    reviewDefinitions: async () => structuredClone(defs), previewReview: async (r) => { calls.push({ action: 'preview' }); return coverage.flatMap(c => r.workflow!.reviewers.map((_, reviewer) => ({ ...c, id: `chunk-${reviewer}`, reviewer }))); }, listReviews: async () => stored.record ? [structuredClone(stored.record)] : [],
    requestReview: async (r) => { calls.push({ action: 'run' }); if (demo) throw new Error('This demo uses prepared suggestions and runs no reviewers. Use Reset demo to start again.'); stored.record = result(r); persist(); return structuredClone(stored.record); }, cancelQuestion: async () => true, getReview: async () => structuredClone(stored.record!),
    chooseReviewEdit: async (_repo, _review, id) => { calls.push({ action: 'choose', id }); const group = stored.record!.edits.find(e => e.id === id)!.conflictGroup; stored.record!.edits.forEach(e => { if (e.conflictGroup === group)
        e.selected = e.id === id; }); persist(); return structuredClone(stored.record!); },
    rejectReviewEdit: async (_repo, _review, id) => { calls.push({ action: 'reject', id }); stored.record!.edits.find(e => e.id === id)!.status = 'rejected'; receipt(id, 'reject', 'rejected'); persist(); return structuredClone(stored.record!); },
    approveReviewEdit: async (_repo, _review, id): Promise<ProposalOutcome | null> => {
        calls.push({ action: 'approve', id });
        if (dirty || recovery)
            throw new Error('Save matching synthetic writing and resolve recovery first');
        const edit = stored.record!.edits.find(e => e.id === id)!;
        if (edit.conflictGroup && !edit.selected)
            throw new Error('Choose a conflict alternative first');
        if (!(demo ? await simulatedConfirmation(edit) : window.confirm(`Synthetic final native confirmation: apply ${id} and dismiss its competing alternatives? No real files or GitHub.`)))
            return null;
        const delta = stored.record!.edits.filter(e => e.status === 'accepted' && e.toUtf8 <= edit.fromUtf8).reduce((n, e) => n + new TextEncoder().encode(e.replacement).length - new TextEncoder().encode(e.original).length, 0);
        const data = new TextEncoder().encode(stored.text), from = edit.fromUtf8 + delta, to = edit.toUtf8 + delta;
        if (new TextDecoder().decode(data.slice(from, to)) !== edit.original)
            throw new Error('Synthetic source changed');
        stored.text = new TextDecoder().decode(data.slice(0, from)) + edit.replacement + new TextDecoder().decode(data.slice(to));
        edit.status = 'accepted';
        stored.record!.edits.filter(e => e.id !== id && e.conflictGroup && e.conflictGroup === edit.conflictGroup && e.status === 'pending').forEach(e => e.status = 'supersededByAuthorChoice');
        const entry = receipt(id, 'apply', 'completed');
        persist();
        return { receipt: entry, warning: null };
    },
    listProposals: async () => ({ pending: [], receipts: structuredClone(stored.receipts ?? []) }), reviewProposal: unavailable, reviewProposalRevert: unavailable, applyProposalReview: unavailable, cancelProposalReview: async () => { },
};
if (demo && !stored.record) { stored.record = demoRecord(); localStorage.setItem(key, JSON.stringify(stored)); }
// Saved demo state from before real hashes keeps its decisions.
if (demo) stored.record!.workflow!.sources.forEach(source => { source.sourceHash = baselineHash; });
const app = mountStudio(document.querySelector<HTMLElement>('#app')!, core);
function mountGuide() {
    const style = document.createElement('style');
    style.textContent = '.fixture-demo{padding:.75rem .9rem;border:3px dashed var(--fg);border-radius:8px}.fixture-demo>*+*{margin-top:.5rem}.fixture-demo strong{display:block}.fixture-demo pre{white-space:pre-wrap}.fixture-confirm{width:min(36rem,calc(100vw - 1rem));max-width:100vw;max-height:100vh;padding:1rem;color:var(--fg);background:var(--surface);border:3px solid var(--fg);font-size:1.0625rem}.fixture-confirm>*+*{margin-top:.5rem}.fixture-confirm h2{font-size:1.3rem;font-weight:700}.fixture-confirm button{display:block;width:100%;min-height:48px;margin-top:.75rem;border:2px solid var(--fg);white-space:normal}.fixture-confirm::backdrop{background:#000b}';
    document.head.append(style);
    const box = document.createElement('section');
    box.className = 'fixture-demo';
    box.setAttribute('aria-label', 'Demo guide');
    const add = (parent: HTMLElement, tag: 'h3' | 'p', text: string) => { const n = document.createElement(tag); n.textContent = text; parent.append(n); return n; };
    add(box, 'p', 'Simulated browser demo with invented text: not native or provider acceptance.').style.fontWeight = '700';
    const state = add(box, 'p', '');
    const help = document.createElement('details');
    // Starts collapsed at every width so the first comparison is the landing content.
    const helpTitle = document.createElement('summary');
    helpTitle.textContent = 'Demo guide · the three examples';
    help.append(helpTitle);
    add(help, 'p', 'The underlined words in the manuscript are the same suggestions. Click one to open its card. Clicking never applies, rejects or chooses anything.');
    add(help, 'p', 'Marks after an approval appear only when the whole simulated file still matches the review, so they can take a moment.');
    add(help, 'p', 'Example 1 · Approve: on Suggestion 1, choose Approve this change…, then Confirm and apply. The other suggestions stay waiting.');
    add(help, 'p', 'Example 2 · Dismiss: on the Example 2 suggestion, choose Reject this change. The source stays the same and the rejection is recorded.');
    add(help, 'p', 'Example 3 · Overlap: choose one Example 3 alternative, then approve it. Approve stays off until you choose, and the other alternative is recorded as not applied.');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Simulated source file, exact text';
    const source = document.createElement('pre');
    source.tabIndex = 0;
    details.append(summary, source);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset demo';
    reset.onclick = () => { localStorage.removeItem(key); location.reload(); };
    box.append(help, details, reset);
    guide = { refresh() { source.textContent = stored.text; state.textContent = stored.text === baseline ? 'Simulated source file: unchanged since reset.' : 'Simulated source file: changed by an approved patch since reset.'; } };
    guide.refresh();
    document.querySelector('.heinlein-review-panel .review-head')?.after(box);
}
if (!demo) {
    const notice = document.createElement('p');
    notice.textContent = 'Synthetic revision acceptance: no real manuscripts, provider, native dialogs or credentials.';
    document.body.prepend(notice);
}
Object.assign(window, { reviewFixture: { calls, get text() { return stored.text; }, baseline, get record() { return stored.record; } } });
void app.selectRepository(async () => session).then(() => app.showDocument(scenePath)).then(async () => {
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Heinlein Review')?.click();
    if (!demo)
        return;
    mountGuide();
    const panel = document.querySelector<HTMLElement>('.heinlein-review-panel')!;
    await new Promise<void>(resolve => { const look = () => { if (panel.querySelector('.review-saved button')) resolve(); else setTimeout(look, 20); }; look(); });
    panel.querySelector<HTMLButtonElement>('.review-saved button')!.click();
});
