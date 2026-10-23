// Synthetic full-Studio host only; never imported by production. No files/providers/OS authority.
import { mountStudio } from '../../src/studio';
import type { LocalCore, ReviewRequest, ReviewResult, ReviewCoverage, ReviewerDefinition, ProposalOutcome, RecoveryDraft } from '../../src/localCore';
import '../../src/fonts.bundle';
import '../../src/style.css';
const key = 'heinlein-revision-synthetic-v2';
const baseline = '🐺 bad / bad / keep — exactly.\r\n';
const defs: ReviewerDefinition[] = [{ id: 'contextual', version: 1, displayName: 'Story and clarity review', instructions: 'Keep intentional voice. No findings is valid.' }, { id: 'mechanical', version: 1, displayName: 'Mechanical review', instructions: 'Only clear mechanical corrections, never normalize expressive style.' }];
let stored: {
    text: string;
    record: ReviewResult | null;
} = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { text: baseline, record: null };
let recovery: RecoveryDraft | null = null;
let dirty = false;
const calls: {
    action: string;
    id?: string;
}[] = [];
const session = { id: 'synthetic-revision-session', name: 'Synthetic review folder', manifests: [] };
const persist = () => localStorage.setItem(key, JSON.stringify(stored));
const doc = (path: string) => ({ path, text: stored.text, contentHash: 'a'.repeat(64), sizeBytes: new TextEncoder().encode(stored.text).length, frontmatter: null, generatedCompatibility: false });
const coverage: ReviewCoverage[] = [{ id: 'chunk-0', sourceIndex: 0, fromUtf8: 0, toUtf8: new TextEncoder().encode(baseline).length, windowFrom: 0, windowTo: new TextEncoder().encode(baseline).length, reviewer: 0, status: 'queued', requestId: null, error: null }];
function result(r: ReviewRequest): ReviewResult {
    return { schemaVersion: 2, reviewId: 'synthetic-review-stable', requestId: r.requestId, revision: 1, projectKey: 'b'.repeat(64), scope: r.scope, model: 'synthetic-selected-model', workflow: { definitions: r.workflow!.reviewers.map((id, i) => ({ instanceId: `reviewer-${i + 1}`, definition: structuredClone(defs.find(d => d.id === id)!), hash: 'c'.repeat(64) })), sources: [{ id: 'source-1', path: 'scene.md', sourceHash: 'a'.repeat(64), readOnly: false, order: 0 }], coverage: coverage.map(c => ({ ...c, status: 'completed', requestId: 'synthetic-call' })), decisions: [], accountId: 'synthetic-selected-account', accountGeneration: 1, contextNotice: 'Synthetic native host: no provider, filesystem or OS access. The production review uses bounded context per call, not the whole work at once.' }, edits: [['first', 5, 8, 'good', 'group-first'], ['alternative', 5, 8, 'fine', 'group-first'], ['unrelated', 11, 14, 'great', null]].map(([id, from, to, replacement, group]) => ({ id: String(id), location: {line:1,column:[...new TextDecoder().decode(new TextEncoder().encode(baseline).slice(0,Number(from)))].length+1}, path: 'scene.md', fromUtf8: Number(from), toUtf8: Number(to), original: 'bad', replacement: String(replacement), reason: `Synthetic comment for ${id}`, role: 'editor', status: 'pending', proposalId: null, conflictGroup: group as string | null, selected: false, patch: JSON.stringify({ path: 'scene.md', fromUtf8: from, toUtf8: to, before: 'bad', replacement }), patchHash: 'd'.repeat(64), comments: [`Synthetic comment for ${id}`], provenance: [{ instanceId: 'reviewer-1', definitionId: 'contextual', definitionVersion: 1, displayName: 'Story and clarity review', requestId: 'synthetic-call', model: 'synthetic-selected-model', accountId: 'synthetic-selected-account', accountGeneration: 1 }] })) };
}
const unavailable = async (): Promise<never> => { throw new Error('Synthetic host: no native filesystem, credentials or provider calls.'); };
const core: LocalCore = { available: () => true, pickRepository: async () => session, recentRepositories: async () => [], openRecentRepository: unavailable, listSystemFonts: async () => [], listDirectory: async () => [{ path: 'scene.md', name: 'scene.md', kind: 'file', sizeBytes: baseline.length }], loadManuscript: unavailable, readDocument: async (_id, path) => doc(path), saveDocument: async (_id, path, _hash, text) => { stored.text = text; persist(); return doc(path); }, readRecovery: async () => recovery, stageRecovery: async (_id, path, baseHash, text) => recovery = { id: 'recovery', path, baseHash, text, updatedAt: 1 }, discardRecovery: async () => { recovery = null; }, setUnsavedChanges: async (value) => { dirty = value; }, requestClose: async () => { }, onCloseRequested: async () => () => { },
    questionStatus: async () => ({ configured: true, model: 'synthetic-selected-model', selectedModel: 'synthetic-selected-model', models: [{ slug: 'synthetic-selected-model', displayName: 'Synthetic selected model' }], accounts: [{ id: 'synthetic-selected-account', label: 'Synthetic account', signedIn: true, planEnabled: true }], activeAccountId: 'synthetic-selected-account', generation: 1, usageLimited: false, signInPending: false, message: 'Synthetic only: no live account' }),
    reviewDefinitions: async () => structuredClone(defs), previewReview: async (r) => { calls.push({ action: 'preview' }); return coverage.flatMap(c => r.workflow!.reviewers.map((_, reviewer) => ({ ...c, id: `chunk-${reviewer}`, reviewer }))); }, listReviews: async () => stored.record ? [structuredClone(stored.record)] : [],
    requestReview: async (r) => { calls.push({ action: 'run' }); stored.record = result(r); persist(); return structuredClone(stored.record); }, cancelQuestion: async () => true, getReview: async () => structuredClone(stored.record!),
    chooseReviewEdit: async (_repo, _review, id) => { calls.push({ action: 'choose', id }); stored.record!.edits.forEach(e => { if (e.conflictGroup === 'group-first')
        e.selected = e.id === id; }); persist(); return structuredClone(stored.record!); },
    rejectReviewEdit: async (_repo, _review, id) => { calls.push({ action: 'reject', id }); stored.record!.edits.find(e => e.id === id)!.status = 'rejected'; persist(); return structuredClone(stored.record!); },
    approveReviewEdit: async (_repo, _review, id): Promise<ProposalOutcome | null> => {
        calls.push({ action: 'approve', id });
        if (dirty || recovery)
            throw new Error('Save matching synthetic writing and resolve recovery first');
        const edit = stored.record!.edits.find(e => e.id === id)!;
        if (edit.conflictGroup && !edit.selected)
            throw new Error('Choose a conflict alternative first');
        if (!window.confirm(`Synthetic final native confirmation: apply ${id} and dismiss its competing alternatives? No real files or GitHub.`))
            return null;
        const delta = stored.record!.edits.filter(e => e.status === 'accepted' && e.toUtf8 <= edit.fromUtf8).reduce((n, e) => n + new TextEncoder().encode(e.replacement).length - new TextEncoder().encode(e.original).length, 0);
        const data = new TextEncoder().encode(stored.text), from = edit.fromUtf8 + delta, to = edit.toUtf8 + delta;
        if (new TextDecoder().decode(data.slice(from, to)) !== edit.original)
            throw new Error('Synthetic source changed');
        stored.text = new TextDecoder().decode(data.slice(0, from)) + edit.replacement + new TextDecoder().decode(data.slice(to));
        edit.status = 'accepted';
        stored.record!.edits.filter(e => e.id !== id && e.conflictGroup && e.conflictGroup === edit.conflictGroup && e.status === 'pending').forEach(e => e.status = 'supersededByAuthorChoice');
        persist();
        return { receipt: { id: `receipt-${id}`, kind: 'apply', proposalId: `proposal-${id}`, path: 'scene.md', baseHash: 'a'.repeat(64), replacementHash: 'b'.repeat(64), diffHash: 'c'.repeat(64), origin: { kind: 'nativeOpenAi', sessionId: '', clientLabel: '', identityAssurance: 'unverifiedProviderMetadata', provider: 'openai', model: 'synthetic-selected-model', requestId: 'synthetic-call' }, parentReceiptId: null, status: 'completed', message: null, createdAtMs: 1, revertAvailable: false }, warning: null };
    },
    listProposals: async () => ({ pending: [], receipts: [] }), reviewProposal: unavailable, reviewProposalRevert: unavailable, applyProposalReview: unavailable, cancelProposalReview: async () => { },
};
const app = mountStudio(document.querySelector<HTMLElement>('#app')!, core);
const notice = document.createElement('p');
notice.textContent = 'Synthetic revision acceptance: no real manuscripts, provider, native dialogs or credentials.';
document.body.prepend(notice);
Object.assign(window, { reviewFixture: { calls, get text() { return stored.text; }, baseline, get record() { return stored.record; } } });
void app.selectRepository(async () => session).then(() => app.showDocument('scene.md')).then(() => { [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Heinlein Review')?.click(); });
