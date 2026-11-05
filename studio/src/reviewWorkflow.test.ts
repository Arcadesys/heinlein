// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReviewPanel, type ReviewScope } from './reviewPanel';
import type { LocalCore, ReviewResult, ReviewRequest, ReviewProgress, ReviewerDefinition, ProposalOutcome } from './localCore';
const defs: ReviewerDefinition[] = [{ id: 'contextual', version: 1, displayName: 'Story and clarity review', instructions: 'Keep intentional voice.' }, { id: 'mechanical', version: 1, displayName: 'Mechanical review', instructions: 'Clear mechanical issues only.' }];
const source = '🐺 bad / bad / keep — exactly.\r\n';
const scope = { repositoryId: 'repo', scope: 'scene' as const, label: 'scene.md', snapshots: [{ path: 'scene.md', source, sourceHash: 'a'.repeat(64) }] };
let panel: ReturnType<typeof createReviewPanel> | undefined;
const tick = () => new Promise(r => setTimeout(r, 0));
function fixture(captured:ReviewScope=scope, reviewerDefinitions:ReviewerDefinition[]=defs) {
    let record: ReviewResult | null = null;
    const coverage = [{ id: 'chunk', sourceIndex: 0, fromUtf8: 0, toUtf8: new TextEncoder().encode(source).length, windowFrom: 0, windowTo: new TextEncoder().encode(source).length, reviewer: 0, status: 'queued', requestId: null, error: null }];
    const make = (request: ReviewRequest): ReviewResult => ({ schemaVersion: 2, reviewId: 'review-stable', requestId: request.requestId, model: 'chosen-model', scope: 'scene', revision: 1, projectKey: 'b'.repeat(64), workflow: { definitions: request.workflow!.reviewers.map((id, i) => ({ instanceId: `reviewer-${i + 1}`, definition: structuredClone(reviewerDefinitions.find(d => d.id === id)!), hash: 'c'.repeat(64) })), sources: [{ id: 'source', path: 'scene.md', sourceHash: 'a'.repeat(64), readOnly: false, order: 0 }], coverage: coverage.map(c => ({ ...c, status: 'completed', requestId: 'call-1' })), decisions: [], accountId: 'selected-account', accountGeneration: 3, contextNotice: 'This call sees bounded context, not the whole work at once.' }, edits: [['first', 5, 8, 'good', 'group'], ['alternative', 5, 8, 'fine', 'group'], ['unrelated', 11, 14, 'great', null]].map(([id, from, to, replacement, group]) => ({ id: String(id), path: 'scene.md', fromUtf8: Number(from), toUtf8: Number(to), original: 'bad', replacement: String(replacement), reason: `Comment ${id}`, role: 'editor', status: 'pending', proposalId: null, conflictGroup: group as string | null, selected: false, patch: JSON.stringify({ path: 'scene.md', fromUtf8: from, toUtf8: to, before: 'bad', replacement }), patchHash: 'd'.repeat(64), comments: [`Comment ${id}`], provenance: [{ instanceId: 'reviewer-1', definitionId: 'contextual', definitionVersion: 1, displayName: 'Story and clarity review', requestId: 'call-1', model: 'chosen-model', accountId: 'selected-account', accountGeneration: 3 }] })) });
    const core = { available: () => true, questionStatus: vi.fn(async () => ({ configured: true, model: 'chosen-model', selectedModel: 'chosen-model', models: [{ slug: 'chosen-model', displayName: 'Chosen model' }], accounts: [{ id: 'selected-account', label: 'Writer', signedIn: true, planEnabled: true }], activeAccountId: 'selected-account', generation: 3, usageLimited: false, signInPending: false, message: 'Ready' })), reviewDefinitions: vi.fn(async () => structuredClone(reviewerDefinitions)), previewReview: vi.fn(async (_request: ReviewRequest) => structuredClone(coverage)), listReviews: vi.fn(async () => record ? [structuredClone(record)] : []), requestReview: vi.fn(async (r: ReviewRequest) => { record = make(r); return structuredClone(record); }), getReview: vi.fn(async () => structuredClone(record!)), chooseReviewEdit: vi.fn(async (_repo: string, _review: string, id: string) => { record!.edits.forEach(e => e.selected = e.id === id); return structuredClone(record!); }), rejectReviewEdit: vi.fn(async (_repo: string, _review: string, id: string) => { record!.edits.find(e => e.id === id)!.status = 'rejected'; return structuredClone(record!); }), approveReviewEdit: vi.fn(async (_repo: string, _review: string, id: string) => { const winner = record!.edits.find(e => e.id === id)!; winner.status = 'accepted'; record!.edits.filter(e => e.conflictGroup && e.conflictGroup === winner.conflictGroup && e.id !== id).forEach(e => e.status = 'supersededByAuthorChoice'); return null as ProposalOutcome | null; }), cancelQuestion: vi.fn(async () => true) };
    const hooks = { capture: () => captured, unavailable: () => null, reviewProposal: vi.fn(async () => { }), openConnection: vi.fn(), focusEditor: vi.fn() };
    panel = createReviewPanel(core as unknown as LocalCore, hooks);
    document.body.append(panel.element);
    const button = (name: string) => [...panel!.element.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === name)!;
    const click = async (name: string) => { button(name).click(); await tick(); };
    const start = async () => { panel!.open(); await vi.waitFor(() => expect(panel!.element.querySelector('.review-reviewers [aria-pressed="true"]')).toBeTruthy()); await click('Preview review'); await vi.waitFor(() => expect(button('Run review').disabled).toBe(false)); await click('Run review'); await vi.waitFor(() => expect(panel!.element.querySelectorAll('.review-edit')).toHaveLength(3)); };
    return { core, hooks, button, click, start, record: () => record! };
}
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); document.body.replaceChildren(); });
afterEach(() => { panel?.destroy(); panel = undefined; });
it('streams activity before completion, ignores stale events, and stops showing progress on cancellation', async () => {
    const f = fixture();
    let progress!: (event: ReviewProgress) => void;
    let request!: ReviewRequest;
    f.core.requestReview.mockImplementation((...args: unknown[]) => {
        request = args[0] as ReviewRequest;
        progress = args[2] as typeof progress;
        return new Promise<ReviewResult>(() => {});
    });
    panel!.open();
    await vi.waitFor(() => expect(f.button('Preview review').disabled).toBe(false));
    await f.click('Preview review'); await f.click('Run review');
    const event: ReviewProgress = {requestId:request.requestId,completedCalls:0,totalCalls:2,reviewer:0,sourceIndex:0,chunkIndex:1,status:'receiving',receivedBytes:1024,suggestions:0};
    progress({...event,requestId:'old-request'});
    expect(panel!.element.textContent).not.toContain('1.0 KB received');
    progress(event);
    expect(panel!.element.querySelector('.review-activity')!.textContent).toContain('Story and clarity review · chunk 1 of 2 · receiving response · 1.0 KB received');
    const announced = panel!.element.querySelector('[role=status]')!.textContent;
    progress({...event,receivedBytes:2048});
    expect(panel!.element.querySelector('[role=status]')!.textContent).toBe(announced);
    expect(panel!.element.querySelector('.review-activity')!.textContent).toContain('2.0 KB received');
    progress({...event,completedCalls:1,status:'completed',suggestions:2});
    expect(panel!.element.querySelector('progress')!.value).toBe(1);
    expect(panel!.element.querySelectorAll('.review-edit')).toHaveLength(0);
    await f.click('Cancel review');
    expect((panel!.element.querySelector('.review-activity') as HTMLElement).hidden).toBe(true);
    const cancelled = panel!.element.textContent;
    progress({...event,receivedBytes:4096});
    expect(panel!.element.textContent).toBe(cancelled);
});
it.each([['timeout', 'The response timed out.'], ['outputLimit', 'The model reached its response token limit before finishing the review.'], ['assessmentTooLong', 'A reading assessment exceeded the 2,000-character limit.'], ['invalidAssessment', 'A reading assessment was empty or contained unsupported characters.'], ['invalidConsolidation', 'The consolidated assessment did not match the required format.'], ['invalidConsolidationContext', 'The saved reviewer patch context could not be validated.'], ['responseTooLarge', 'The response exceeded the supported byte limit.']])('labels a failed empty result (%s) as incomplete with its reason', async (error, reason) => {
    const f = fixture();
    const original = f.core.requestReview.getMockImplementation()!;
    f.core.requestReview.mockImplementation(async request => {
        const result = await original(request);
        result.edits = [];
        result.workflow!.coverage[0].status = 'failed';
        result.workflow!.coverage[0].error = error;
        return result;
    });
    panel!.open();
    await vi.waitFor(() => expect(f.button('Preview review').disabled).toBe(false));
    await f.click('Preview review'); await f.click('Run review');
    expect(panel!.element.querySelector('[role=status]')!.textContent).toContain('Review incomplete. 0 of 1 calls completed.');
    expect(panel!.element.textContent).toContain(reason);
    expect(panel!.element.textContent).not.toContain('No targeted edits suggested.');
    expect(panel!.element.textContent).not.toContain('Review ready.');
    expect(f.core.requestReview).toHaveBeenCalledOnce();
});
it('streams a continued batch and ignores its late progress after final validation', async () => {
    const f = fixture();
    const original = f.core.requestReview.getMockImplementation()!;
    f.core.requestReview.mockImplementation(async request => {
        const result = await original(request);
        result.workflow!.coverage.push({...result.workflow!.coverage[0],id:'second',status:'notRun',requestId:null});
        return result;
    });
    let progress!: (event: ReviewProgress) => void;
    let finish!: (result: ReviewResult) => void;
    let requestId = '';
    (f.core as unknown as LocalCore).continueReview = vi.fn(async (_repo,_review,id,_connection,onProgress) => {
        progress = onProgress!; requestId = id;
        return new Promise<ReviewResult>(resolve => {finish=resolve;});
    });
    await f.start();
    await f.click('Continue next reviewer batch');
    const event: ReviewProgress = {requestId,completedCalls:1,totalCalls:2,reviewer:0,sourceIndex:0,chunkIndex:2,status:'receiving',receivedBytes:1024,suggestions:3};
    progress(event);
    expect(panel!.element.querySelector('.review-activity')!.textContent).toContain('1 of 2 calls completed');
    const result = structuredClone(f.record());
    result.requestId = requestId;
    result.workflow!.coverage = [{...result.workflow!.coverage[0],status:'completed'},{...result.workflow!.coverage[0],id:'second',status:'completed'}];
    finish(result);
    await vi.waitFor(() => expect(panel!.element.querySelector('[role=status]')!.textContent).toContain('Review ready.'));
    expect((panel!.element.querySelector('.review-activity') as HTMLElement).hidden).toBe(true);
    const ready = panel!.element.textContent;
    progress({...event,status:'failed'});
    expect(panel!.element.textContent).toBe(ready);
});
it('requires explicit scope/reviewer batch preview and uses only selected connection', async () => { const f = fixture(); panel!.open(); await vi.waitFor(() => expect(panel!.element.querySelector('.review-reviewers [aria-pressed="true"]')).toBeTruthy()); expect(f.button('Run review')).toBeUndefined(); expect(f.button('Preview review').disabled).toBe(false); f.button('Mechanical review').click(); expect(panel!.element.querySelector('[data-reviewer="mechanical"]')!.getAttribute('aria-pressed')).toBe('true'); await f.click('Preview review'); expect(f.core.requestReview).not.toHaveBeenCalled(); await f.click('Run review'); expect(f.core.requestReview.mock.calls[0][0].workflow!.reviewers).toEqual(['contextual', 'mechanical']); expect(f.core.requestReview.mock.calls[0][0].workflow!.consolidate).toBe(true); expect((f.core.requestReview.mock.calls[0] as unknown[])[1]).toMatchObject({ accountId: 'selected-account', model: 'chosen-model', generation: 3 }); });
it('explains a reviewer-loading failure without blaming the ChatGPT connection and recovers on reopen', async () => {
    const f = fixture();
    f.core.reviewDefinitions.mockRejectedValueOnce('review_definitions not allowed');
    panel!.open();
    await vi.waitFor(() => expect(panel!.element.textContent).toContain('Reviewers could not be loaded.'));
    expect(panel!.element.textContent).not.toContain('Retry when your connection is ready');
    expect(f.button('Preview review').disabled).toBe(true);
    expect(f.core.requestReview).not.toHaveBeenCalled();
    panel!.clear();
    panel!.open();
    await vi.waitFor(() => expect(f.button('Preview review').disabled).toBe(false));
    expect(panel!.element.querySelectorAll('[data-reviewer]')).toHaveLength(2);
});
it('requires explicit conflict choice and approves directly through native exact-patch route', async () => { const f = fixture(); await f.start(); const group = panel!.element.querySelector<HTMLElement>('.review-conflict')!; expect(group.querySelectorAll('[data-finding-id]')).toHaveLength(2); const accept = group.querySelector<HTMLButtonElement>('[data-edit-action="accept"]')!; expect(accept.disabled).toBe(true); expect(accept.textContent).toBe('Choose an alternative first'); expect(panel!.element.querySelectorAll('input[type=radio]:checked')).toHaveLength(0); group.querySelector<HTMLInputElement>('[data-finding-id="first"] input[type=radio]')!.click(); await tick(); expect(f.core.approveReviewEdit).not.toHaveBeenCalled(); group.remove(); const chosen = panel!.element.querySelector<HTMLElement>('.review-conflict')!; expect(chosen.querySelector<HTMLInputElement>('[data-finding-id="first"] input[type=radio]')!.checked).toBe(true); const approve = chosen.querySelector<HTMLButtonElement>('[data-edit-action="accept"]')!; expect(approve.textContent).toBe('Accept “good”…'); expect(approve.disabled).toBe(false); approve.click(); await tick(); expect(f.core.approveReviewEdit).toHaveBeenCalledWith('repo', 'review-stable', 'first'); expect(f.hooks.reviewProposal).not.toHaveBeenCalled(); expect(panel!.element.textContent).toContain('supersededByAuthorChoice');
 // After a confirmed Accept the next waiting suggestion's accept flow loads on its own; it is not applied without its own confirmation.
 await vi.waitFor(() => expect(f.core.approveReviewEdit).toHaveBeenLastCalledWith('repo', 'review-stable', 'unrelated')); });
it('waits for durable rejection before hiding, keeps errors visible, then reopens dismissed state without rerun', async () => {
    const f = fixture();
    await f.start();
    let resolve!: (v: ReviewResult) => void;
    f.core.rejectReviewEdit.mockImplementationOnce(() => new Promise(r => resolve = r));
    const card = panel!.element.querySelector<HTMLElement>('[data-finding-id="unrelated"]')!;
    card.querySelector<HTMLButtonElement>('[data-edit-action="reject"]')!.click();
    await tick();
    expect(panel!.element.querySelectorAll('.review-edit')).toHaveLength(3);
    f.record().edits.find(e => e.id === 'unrelated')!.status = 'rejected';
    resolve(structuredClone(f.record()));
    await tick();
    expect(panel!.element.querySelectorAll('.review-edit')).toHaveLength(2);
    expect(document.activeElement).toBe(panel!.element.querySelector('[data-finding-id="alternative"] input[type=radio]'));
    await f.click('Discard review');
    panel!.open();
    await vi.waitFor(() => expect(f.button('Reopen saved review review-stable')).toBeTruthy());
    await f.click('Reopen saved review review-stable');
    expect(panel!.element.querySelector('[data-finding-id="unrelated"]')).toBeNull();
    expect(f.core.requestReview).toHaveBeenCalledOnce();
    expect(panel!.element.textContent).toContain('"status": "rejected"');
    f.core.rejectReviewEdit.mockRejectedValueOnce(new Error('Storage did not confirm rejection'));
    panel!.element.querySelector<HTMLButtonElement>('.review-conflict [data-edit-action="reject"]')!.click();
    await tick();
    expect(panel!.element.querySelector('[data-finding-id="first"]')).toBeTruthy();
    expect(panel!.element.textContent).toContain('Storage did not confirm rejection');
});
it('discards a preview returned after panel closes without submitting inference', async () => { const f = fixture(); let resolve!: (v: ReturnType<typeof f.core.previewReview> extends Promise<infer T> ? T : never) => void; f.core.previewReview.mockImplementationOnce(() => new Promise(r => resolve = r)); panel!.open(); await vi.waitFor(() => expect(panel!.element.querySelector('.review-reviewers [aria-pressed="true"]')).toBeTruthy()); f.button('Preview review').click(); await tick(); panel!.clear(); resolve([]); await tick(); expect(panel!.element.hidden).toBe(true); expect(f.core.requestReview).not.toHaveBeenCalled(); });
it('keeps library context separate from targets and refuses a changed snapshot before sending', async () => {
    const f = fixture();
    const context = {path:'context.md',source:'Synthetic context',sourceHash:'b'.repeat(64),sceneId:'context'};
    const target = {...scope.snapshots[0],sceneId:'target'};
    let current = {ordered:[context,target],context:[context],targets:[target],bytes:100};
    panel!.openLibrary({...scope,label:'Library sheets',snapshots:[context,target],targetPaths:['scene.md'],contextPaths:['context.md','scene.md']}, async () => structuredClone(current));
    await vi.waitFor(() => expect(panel!.element.querySelector('.review-reviewers [aria-pressed="true"]')).toBeTruthy());
    await f.click('Preview review');
    expect(f.core.previewReview.mock.calls[0][0].snapshots.map(s=>s.path)).toEqual(['scene.md']);
    expect(f.core.previewReview.mock.calls[0][0].workflow!.context.map(s=>s.path)).toEqual(['context.md']);
    expect(f.core.previewReview.mock.calls[0][0].workflow!.fullContextOrder).toEqual(['context.md','scene.md']);
    current = {...current,ordered:[{...context,source:'Changed'},target]};
    await f.click('Run review');
    expect(f.core.requestReview).not.toHaveBeenCalled();
    expect(panel!.element.textContent).toContain('selected source changed');
});
it('submits the ordered reviewed library snapshot with explicit target and complete context', async () => {
    const f = fixture();
    const context = {path:'context.md',source:'Synthetic context',sourceHash:'b'.repeat(64),sceneId:'context'};
    const target = {...scope.snapshots[0],sceneId:'target'};
    const capture = {ordered:[context,target],context:[context,target],targets:[target],bytes:100};
    panel!.openLibrary({...scope,label:'Library sheets',snapshots:capture.ordered,targetPaths:['scene.md'],contextPaths:['context.md','scene.md']}, async () => structuredClone(capture));
    await vi.waitFor(() => expect(panel!.element.querySelector('.review-reviewers [aria-pressed="true"]')).toBeTruthy());
    await f.click('Preview review'); await vi.waitFor(()=>expect(f.button('Run review').disabled).toBe(false));
    await f.click('Run review'); await vi.waitFor(()=>expect(f.core.requestReview).toHaveBeenCalledOnce());
    const request=f.core.requestReview.mock.calls[0][0];
    expect(request.snapshots.map(item=>item.path)).toEqual(['scene.md']);
    expect(request.workflow!.context.map(item=>item.path)).toEqual(['context.md']);
    expect(request.workflow!.fullContextOrder).toEqual(['context.md','scene.md']);
});
it('uses the selected passage by default and a full sheet for an explicit target choice',async()=>{
 const f=fixture(); const target={...scope.snapshots[0],sceneId:'target'}; const capture={ordered:[target],context:[target],targets:[target],bytes:source.length};
 panel!.openLibrary({...scope,snapshots:[target],targetPaths:['scene.md'],contextPaths:['scene.md'],selectedRange:{path:'scene.md',fromUtf8:5,toUtf8:8}},async()=>structuredClone(capture));
 await vi.waitFor(()=>expect(panel!.element.querySelector('.review-reviewers [aria-pressed="true"]')).toBeTruthy());
 await f.click('Preview review'); expect(f.core.previewReview.mock.calls[0][0].workflow!.ranges).toEqual([{path:'scene.md',fromUtf8:5,toUtf8:8}]);
 const check=panel!.element.querySelector<HTMLInputElement>('.review-targets input[type=checkbox], .review-scope input[type=radio]:not(:checked)')!; check.click(); check.click();
 await f.click('Preview review'); expect(f.core.previewReview.mock.calls[1][0].workflow!.ranges).toEqual([]);
 const selection=panel!.element.querySelector<HTMLInputElement>('.review-scope input[type=radio]:not(:checked)')!; selection.click();
 await f.click('Preview review'); expect(f.core.previewReview.mock.calls[2][0].workflow!.ranges).toEqual([{path:'scene.md',fromUtf8:5,toUtf8:8}]);
});
it('summarizes where reviewers landed and shows the stage without deciding anything', async () => {
 const f=fixture(); await f.start();
 const summary=panel!.element.querySelector('.review-consensus')!;
 expect(summary.textContent).toContain('2 suggestions');
 expect(summary.textContent).toContain('1 span with alternatives to choose');
 expect(summary.textContent).toContain('Nothing changes until you choose Accept.');
 expect(panel!.element.querySelector('.stage-strip [aria-current="step"]')!.textContent).toContain('Decide · 2 waiting');
 expect(f.core.approveReviewEdit).not.toHaveBeenCalled(); expect(f.core.rejectReviewEdit).not.toHaveBeenCalled();
});
it('groups competing alternatives into one card, and Keep mine records each alternative as rejected without applying', async () => {
 const f=fixture(); await f.start();
 const group=panel!.element.querySelector<HTMLElement>('.review-conflict')!;
 expect(panel!.element.querySelectorAll('.review-card')).toHaveLength(2);
 expect(group.querySelector('legend')!.textContent).toBe('Choose a replacement');
 expect([...group.querySelectorAll('.review-inline-diff del')].map(n=>n.textContent)).toEqual(['bad','bad']);
 expect([...group.querySelectorAll('.review-inline-diff ins')].map(n=>n.textContent)).toEqual(['good','fine']);
 group.querySelector<HTMLButtonElement>('[data-edit-action="reject"]')!.click(); await tick(); await tick();
 expect(f.core.rejectReviewEdit.mock.calls.map(c=>c[2])).toEqual(['first','alternative']);
 expect(f.core.approveReviewEdit).not.toHaveBeenCalled(); expect(f.core.chooseReviewEdit).not.toHaveBeenCalled();
 expect(panel!.element.querySelector('.review-conflict')).toBeNull();
 expect(panel!.element.querySelector('.review-status')!.textContent).toContain('Your manuscript was not changed');
 expect(panel!.element.querySelector('.review-progress')!.textContent).toBe('3 suggestions · 2 decided');
});
it('steps between cards from the progress strip without choosing, applying or rejecting anything', async () => {
 const f=fixture(); await f.start();
 const counter=panel!.element.querySelector('.review-counter')!;
 expect(counter.textContent).toBe('– / 2');
 f.button('Next suggestion').click();
 expect(counter.textContent).toBe('1 / 2');
 expect(panel!.element.querySelector('.review-conflict')!.classList.contains('review-opened')).toBe(true);
 expect(document.activeElement).toBe(panel!.element.querySelector('.review-conflict'));
 f.button('Next suggestion').click();
 expect(counter.textContent).toBe('2 / 2');
 expect(document.activeElement).toBe(panel!.element.querySelector('[data-finding-id="unrelated"] h4'));
 f.button('Previous suggestion').click();
 expect(counter.textContent).toBe('1 / 2');
 expect(panel!.element.querySelectorAll('.review-opened')).toHaveLength(1);
 expect(f.core.chooseReviewEdit).not.toHaveBeenCalled(); expect(f.core.approveReviewEdit).not.toHaveBeenCalled(); expect(f.core.rejectReviewEdit).not.toHaveBeenCalled();
 expect(panel!.element.querySelectorAll('input[type=radio]:checked')).toHaveLength(0);
});
it('keeps results when closed with the header button, and Discard review clears them', async () => {
 const f=fixture(); await f.start();
 f.button('Close Heinlein').click();
 expect(panel!.element.classList.contains('review-tucked')).toBe(true);
 expect(panel!.element.querySelectorAll('.review-edit')).toHaveLength(3);
 expect(f.hooks.focusEditor).toHaveBeenCalled();
 f.button('More review actions').click();
 expect(f.button('More review actions').getAttribute('aria-expanded')).toBe('true');
 f.button('Discard review').click();
 expect(panel!.element.hidden).toBe(true);
 expect(panel!.element.querySelectorAll('.review-edit')).toHaveLength(0);
});
it('starts a new review from results and lists earlier reviews as compact rows', async () => {
 const f=fixture(); await f.start();
 expect(panel!.element.querySelector('.review-strip')!.contains(f.button('Start a new review'))).toBe(true);
 expect(panel!.element.querySelector<HTMLElement>('.review-more-menu')!.hidden).toBe(true);
 f.button('Start a new review').click();
 expect(panel!.element.querySelector<HTMLElement>('.review-setup-view')!.hidden).toBe(false);
 expect(panel!.element.querySelector<HTMLElement>('.review-results')!.hidden).toBe(true);
 await vi.waitFor(()=>expect(f.button('Reopen saved review review-stable')).toBeTruthy());
 const row=f.button('Reopen saved review review-stable');
 expect(row.textContent).toContain('0 of 3 decided');
 expect(row.getAttribute('aria-current')).toBe('true');
 await f.click('Reopen saved review review-stable');
 expect(panel!.element.querySelector<HTMLElement>('.review-results')!.hidden).toBe(false);
 expect(f.core.requestReview).toHaveBeenCalledOnce();
});
it('creates a custom reviewer from a template and selects it', async () => {
    const f = fixture();
    const saved: import('./localCore').CustomReviewer[] = [];
    const core = f.core as unknown as Record<string, unknown>;
    core.listCustomReviewers = vi.fn(async () => [...saved]);
    core.saveCustomReviewer = vi.fn(async (r: import('./localCore').CustomReviewer) => { const s = {...r, id: 'custom-abc'}; saved.push(s); (core.reviewDefinitions as ReturnType<typeof vi.fn>).mockImplementation(async () => [...defs, {id: s.id, version: 1, displayName: s.displayName, instructions: s.instructions}]); return s; });
    panel!.open();
    await vi.waitFor(() => expect(f.button('+ New reviewer')).toBeTruthy());
    await f.click('+ New reviewer');
    const select = panel!.element.querySelector('.review-agent-editor select') as HTMLSelectElement;
    select.value = '0'; select.dispatchEvent(new Event('change'));
    expect((panel!.element.querySelector('.review-agent-name') as HTMLInputElement).value).toBe('Emotional punch');
    await f.click('Save reviewer');
    await vi.waitFor(() => expect(panel!.element.querySelector('[data-reviewer="custom-abc"][aria-pressed="true"]')).toBeTruthy());
    expect(panel!.element.querySelector('.review-agent-editor')).toBeNull();
    expect(f.button('Edit Emotional punch')).toBeTruthy();
});

it('accepts the final consolidation at the maximum 384 individual-call capacity', async () => {
 const f=fixture();const original=f.core.requestReview.getMockImplementation()!;
 f.core.requestReview.mockImplementation(async request=>{const result=await original(request);const first=result.workflow!.coverage[0];result.workflow!.coverage=Array.from({length:384},(_,i)=>({...first,id:`chunk-${i}`,status:'completed'}));result.workflow!.coverage.push({...first,id:'consolidation',reviewer:result.workflow!.definitions.length,status:'completed'});result.readingFeedback=[{coverageId:'consolidation',path:'Selected review scope',reviewer:'Consolidated review',feedback:{overview:'All individual assessments were consolidated.',assessment:{strengths:'The opening establishes voice.',improvements:'No further change is warranted in the supplied scope.'},strengths:[],improvements:[]}}];return result;});
 await f.start();expect(panel!.element.textContent).toContain('All individual assessments were consolidated.');expect(panel!.element.textContent).not.toContain('Invalid consolidated review.');
});

function automaticFixture(custom:ReviewerDefinition[]=[]) {
 const f=fixture({...scope,scope:'chapter'},[...defs,...custom]);
 Object.assign(f.core,{listCustomReviewers:vi.fn(async()=>custom.map(d=>({...d,description:'',output:'notes' as const})))});
 let saved:ReviewResult;
 f.core.getReview.mockImplementation(async()=>structuredClone(saved));
 const original=f.core.requestReview.getMockImplementation()!;
 const make=async (request:ReviewRequest, completed:number) => {
  const value=await original(request);value.scope='chapter';value.edits=[];
  const first=value.workflow!.coverage[0];
  value.workflow!.coverage=Array.from({length:10},(_,i)=>({...first,id:i===9?'consolidation':`pass-${i}`,status:i<completed?'completed':'queued',reviewer:i===9?value.workflow!.definitions.length:i%value.workflow!.definitions.length}));
  value.readingFeedback=[{coverageId:'pass-0',path:'scene.md',reviewer:'Mechanical review',feedback:{overview:'Individual mechanics assessment.',strengths:[],improvements:[]}}];
  for(const [index,d] of custom.entries())value.readingFeedback.push({coverageId:`pass-${index+2}`,path:'scene.md',reviewer:d.displayName,feedback:{overview:`${d.displayName} individual assessment.`,strengths:[],improvements:[]}});
  if(completed===10)value.readingFeedback.push({coverageId:'consolidation',path:'Selected review scope',reviewer:'Consolidated review',feedback:{overview:'Combined chapter assessment.',strengths:[],improvements:[]}});
  saved=structuredClone(value);return value;
 };
 f.core.requestReview.mockImplementation(r=>make(r,8));
 const continuation=vi.fn(async (_repo:string,_review:string,id:string)=>make({...f.core.requestReview.mock.calls[0][0],requestId:id},10));
 (f.core as unknown as LocalCore).continueReview=continuation;
 return {...f,make,continuation};
}
it('Review chapter automatically runs both built-ins and subsequent batches, opens consolidation, and saves individual passes',async()=>{
 const f=automaticFixture();await panel!.reviewChapter();
 expect(f.core.previewReview).toHaveBeenCalledOnce();expect(f.core.requestReview).toHaveBeenCalledOnce();expect(f.continuation).toHaveBeenCalledOnce();
 expect(f.core.requestReview.mock.calls[0][0]).toMatchObject({scope:'chapter',workflow:{reviewers:['mechanical','contextual'],consolidate:true}});
 expect(panel!.element.textContent).toContain('Chapter review complete.');
 const select=panel!.element.querySelector('.review-feedback-picker select') as HTMLSelectElement;
 expect(select.selectedOptions[0].textContent).toBe('Consolidated review · all reviewers');
 expect(document.activeElement).toBe(panel!.element.querySelector('.review-reading-feedback'));
 select.value='0';select.dispatchEvent(new Event('change'));expect(panel!.element.textContent).toContain('Individual mechanics assessment.');
 await panel!.openSaved('review-stable');expect((panel!.element.querySelector('.review-feedback-picker select') as HTMLSelectElement).selectedOptions[0].textContent).toContain('Consolidated');
 expect(f.core.requestReview).toHaveBeenCalledOnce();
});
it('automatic chapter review stops on failed calls and retains individual results without retrying',async()=>{
 const f=automaticFixture();f.core.requestReview.mockImplementation(async r=>{const value=await f.make(r,1);value.workflow!.coverage[1].status='failed';value.workflow!.coverage[1].error='timeout';return value;});
 await panel!.reviewChapter();expect(f.continuation).not.toHaveBeenCalled();expect(panel!.element.textContent).toContain('Chapter review incomplete. Completed passes are saved.');expect(panel!.element.textContent).toContain('Individual mechanics assessment.');
});
it('automatic chapter review stops when continuation makes no progress',async()=>{
 const f=automaticFixture();f.continuation.mockImplementation(async(_repo,_review,id)=>f.make({...f.core.requestReview.mock.calls[0][0],requestId:id},8));
 await panel!.reviewChapter();expect(f.continuation).toHaveBeenCalledOnce();expect(panel!.element.textContent).toContain('next batch made no progress');
});
it('cancelling automatic chapter review prevents continuation and ignores the late response',async()=>{
 const f=automaticFixture();let finish!:(value:ReviewResult)=>void;
 f.core.requestReview.mockImplementation(()=>new Promise<ReviewResult>(resolve=>{finish=resolve;}));
 const run=panel!.reviewChapter();await vi.waitFor(()=>expect(f.core.requestReview).toHaveBeenCalledOnce());
 await f.click('Cancel review');finish(await f.make(f.core.requestReview.mock.calls[0][0],8));await run;
 expect(f.continuation).not.toHaveBeenCalled();expect(panel!.element.textContent).toContain('Review canceled locally.');expect(panel!.element.textContent).not.toContain('Chapter review complete.');
});
it('automatic chapter review leaves connection setup available and sends nothing without a ready account',async()=>{
 const f=automaticFixture();f.core.questionStatus.mockRejectedValue(new Error('offline'));
 await panel!.reviewChapter();expect(f.core.requestReview).not.toHaveBeenCalled();expect(f.core.previewReview).not.toHaveBeenCalled();expect(f.button('Connect ChatGPT').hidden).toBe(false);
});
it('Review chapter captures the complete mapped chapter when launched from a scene',async()=>{
 const f=automaticFixture();f.hooks.capture=()=>scope;
 const capture=vi.fn(async()=>({...scope,scope:'chapter' as const,label:'Chapter 9',snapshots:[...scope.snapshots,{...scope.snapshots[0],path:'second.md'}]}));Object.assign(f.hooks,{captureChapter:capture});
 await panel!.reviewChapter();expect(capture).toHaveBeenCalledOnce();expect(f.core.requestReview.mock.calls[0][0].snapshots.map(s=>s.path)).toEqual(['scene.md','second.md']);
});
it('repeated Review chapter activation shares the running request',async()=>{
 const f=automaticFixture();let finish!:(value:ReviewResult)=>void;f.core.requestReview.mockImplementation(()=>new Promise<ReviewResult>(resolve=>{finish=resolve;}));
 const run=panel!.reviewChapter();await vi.waitFor(()=>expect(f.core.requestReview).toHaveBeenCalledOnce());await panel!.reviewChapter();
 finish(await f.make(f.core.requestReview.mock.calls[0][0],8));await run;expect(f.core.requestReview).toHaveBeenCalledOnce();expect(f.continuation).toHaveBeenCalledOnce();
});
it('a continuation exception stops the automatic run and preserves the completed first batch',async()=>{
 const f=automaticFixture();f.continuation.mockRejectedValue(new Error('Connection changed.'));
 await panel!.reviewChapter();expect(f.continuation).toHaveBeenCalledOnce();expect(panel!.element.textContent).toContain('Connection changed.');expect(panel!.element.textContent).toContain('Individual mechanics assessment.');expect(panel!.element.textContent).not.toContain('Chapter review complete.');
});

it('Review chapter refreshes and includes every saved custom agent before consolidation',async()=>{
 const custom=Array.from({length:4},(_,i)=>({id:`custom-${i}`,version:1,displayName:`Custom agent ${i}`,instructions:'Advice only.'}));
 const f=automaticFixture(custom);await panel!.reviewChapter();
 expect(f.core.requestReview.mock.calls[0][0].workflow!.reviewers).toEqual(['mechanical','contextual',...custom.map(d=>d.id)]);
 const load=(f.core as unknown as LocalCore).listCustomReviewers as ReturnType<typeof vi.fn>;
 expect(load.mock.invocationCallOrder[0]).toBeLessThan(f.core.reviewDefinitions.mock.invocationCallOrder[0]);
 expect(f.continuation).toHaveBeenCalledOnce();expect(panel!.element.textContent).toContain('Chapter review complete.');
 const picker=panel!.element.querySelector('.review-feedback-picker select') as HTMLSelectElement;
 expect(picker.options).toHaveLength(6);expect(picker.selectedOptions[0].textContent).toContain('Consolidated');
 picker.value='4';picker.dispatchEvent(new Event('change'));expect(panel!.element.textContent).toContain('Custom agent 3 individual assessment.');
 await panel!.openSaved('review-stable');expect((panel!.element.querySelector('.review-feedback-picker select') as HTMLSelectElement).options).toHaveLength(6);
});
it('a saved custom-agent loading error sends no review rather than running a subset',async()=>{
 const f=automaticFixture();(f.core as unknown as LocalCore).listCustomReviewers=vi.fn(async()=>{throw new Error('Catalog unavailable');});
 await panel!.reviewChapter();expect(f.core.requestReview).not.toHaveBeenCalled();expect(f.core.reviewDefinitions).not.toHaveBeenCalled();expect(panel!.element.textContent).toContain('Reviewers could not be loaded.');
});
it('a saved custom agent missing from the host catalog stops the full chapter run',async()=>{
 const f=automaticFixture([{id:'custom-missing',version:1,displayName:'Missing',instructions:'Advice.'}]);f.core.reviewDefinitions.mockResolvedValue(structuredClone(defs));
 await panel!.reviewChapter();expect(f.core.requestReview).not.toHaveBeenCalled();expect(panel!.element.textContent).toContain('Chapter reviewers could not be loaded.');
});

it('explicitly resumes failed chunks in the same saved review and retains completed results',async()=>{
 const f=automaticFixture();f.core.requestReview.mockImplementation(async r=>{const value=await f.make(r,1);value.workflow!.coverage[1].status='failed';value.workflow!.coverage[1].error='retryExhaustedTimeout';return value;});
 await panel!.reviewChapter();expect(f.continuation).not.toHaveBeenCalled();
 expect(panel!.element.textContent).toContain('timed out after three attempts');
 expect(f.button('Retry failed chunks').hidden).toBe(false);await f.click('Retry failed chunks');
 expect(f.core.requestReview).toHaveBeenCalledOnce();expect(f.continuation).toHaveBeenCalledOnce();
 expect(f.continuation.mock.calls[0].slice(0,2)).toEqual(['repo','review-stable']);
 expect(panel!.element.textContent).toContain('Individual mechanics assessment.');
});


it.each(['running','cancelled'])('explicitly resumes a saved %s chunk without starting a new review',async status=>{
 const f=automaticFixture();f.core.requestReview.mockImplementation(async r=>{const value=await f.make(r,1);value.workflow!.coverage[1].status=status;return value;});
 await panel!.reviewChapter();expect(f.continuation).not.toHaveBeenCalled();
 await f.click('Resume interrupted chunks');expect(f.core.requestReview).toHaveBeenCalledOnce();expect(f.continuation).toHaveBeenCalledOnce();
 expect(f.continuation.mock.calls[0].slice(0,2)).toEqual(['repo','review-stable']);
});


async function recoveryFixture(completed = 2) {
 const f = automaticFixture();
 const request: ReviewRequest = {...scope, requestId: 'old-request', workflow: {reviewers: ['mechanical', 'contextual'], context: [], contextNote: '', ranges: [], consolidate: true}};
 const saved = await f.make(request, completed);
 saved.workflow!.coverage[completed].status = 'running';
 f.core.listReviews.mockImplementation(async () => [structuredClone(saved)]);
 f.continuation.mockImplementation(async (_repo, _review, id) => f.make({...request, requestId: id}, 10));
 return {...f, saved, request};
}
it('automatically recovers the same saved review while staying hidden and preserving focus', async () => {
 const f = await recoveryFixture();
 const writer = document.createElement('textarea'); document.body.append(writer); writer.focus();
 await panel!.recoverOutstanding('repo', 'project');
 expect(f.continuation).toHaveBeenCalledOnce();
 expect(f.continuation.mock.calls[0].slice(0,2)).toEqual(['repo','review-stable']);
 expect(f.core.requestReview).not.toHaveBeenCalled(); expect(f.core.previewReview).not.toHaveBeenCalled();
 expect(panel!.element.hidden).toBe(true); expect(document.activeElement).toBe(writer);
 expect(panel!.element.textContent).toContain('1 interrupted review finished');
 expect(panel!.element.textContent).toContain('Individual mechanics assessment.');
 await panel!.recoverOutstanding('repo', 'project'); expect(f.continuation).toHaveBeenCalledOnce();
});
it('finishes every remaining batch without rerunning successful calls or creating a new review', async () => {
 const f = await recoveryFixture();
 f.continuation.mockImplementationOnce(async (_repo,_review,id) => f.make({...f.request,requestId:id},8));
 await panel!.recoverOutstanding('repo');
 expect(f.continuation).toHaveBeenCalledTimes(2);
 expect(f.continuation.mock.calls.every(call => call[1] === f.saved.reviewId)).toBe(true);
 expect(f.core.requestReview).not.toHaveBeenCalled();
});
it.each(['cancelled','outputLimit','invalidResponse','protocol','invalidConsolidation','usageLimit','invalidReviewOrModel','findingLimit'])('does not automatically restart a stopped or nonretryable job (%s)',async reason=>{
 const f=await recoveryFixture();const call=f.saved.workflow!.coverage[2];call.status=reason==='cancelled'?'cancelled':'failed';call.error=reason;
 await panel!.recoverOutstanding('repo');expect(f.continuation).not.toHaveBeenCalled();expect(f.core.questionStatus).not.toHaveBeenCalled();
});
it('tries transient saved failures once and stops if retries are exhausted again',async()=>{
 const f=await recoveryFixture();f.saved.workflow!.coverage[2].status='failed';f.saved.workflow!.coverage[2].error='retryExhaustedTimeout';
 f.continuation.mockImplementation(async(_repo,_review,id)=>({...structuredClone(f.saved),requestId:id}));
 await panel!.recoverOutstanding('repo');await panel!.recoverOutstanding('repo');
 expect(f.continuation).toHaveBeenCalledOnce();expect(panel!.element.textContent).toContain('1 needs attention');
 expect(panel!.element.textContent).toContain('Individual mechanics assessment.');
});
it('stops recovery when a successful continuation makes no progress',async()=>{
 const f=await recoveryFixture();f.saved.workflow!.coverage[2].status='queued';
 f.continuation.mockImplementation(async(_repo,_review,id)=>({...structuredClone(f.saved),requestId:id}));
 await panel!.recoverOutstanding('repo');expect(f.continuation).toHaveBeenCalledOnce();expect(panel!.element.textContent).toContain('1 needs attention');
});
it.each(['account','model','disconnected','usage','draft'])('preserves saved results without sending when recovery is blocked by %s',async kind=>{
 const f=await recoveryFixture();
 if(kind==='account')f.saved.workflow!.accountId='other-account';
 if(kind==='model')f.saved.model='other-model';
 if(kind==='draft')Object.assign(f.hooks,{recoveryUnavailable:()=> 'Resolve draft recovery first.'});
 if(kind==='disconnected'||kind==='usage')f.core.questionStatus.mockResolvedValue({...await f.core.questionStatus(),configured:kind!=='disconnected',usageLimited:kind==='usage'});
 await panel!.recoverOutstanding('repo');expect(f.continuation).not.toHaveBeenCalled();expect(f.core.requestReview).not.toHaveBeenCalled();expect(panel!.element.textContent).toContain('1 needs attention');
});
it('restores an existing saved connection before recovery without changing account or model',async()=>{
 const f=await recoveryFixture(),ready=await f.core.questionStatus();f.core.questionStatus.mockResolvedValue({...ready,configured:false,models:[]});
 const restore=vi.fn(async()=>ready);Object.assign(f.core,{restoreQuestionConnection:restore});
 await panel!.recoverOutstanding('repo');expect(restore).toHaveBeenCalledOnce();expect(f.continuation).toHaveBeenCalledOnce();
});
it('ignores duplicate startup triggers and stops later batches after project change',async()=>{
 const f=await recoveryFixture();let finish!:(result:ReviewResult)=>void;
 f.continuation.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const first=panel!.recoverOutstanding('repo');await vi.waitFor(()=>expect(f.continuation).toHaveBeenCalledOnce());
 await panel!.recoverOutstanding('repo');panel!.clear();finish(await f.make({...f.request,requestId:f.continuation.mock.calls[0][2]},8));await first;
 expect(f.continuation).toHaveBeenCalledOnce();expect(f.core.cancelQuestion).toHaveBeenCalledWith(f.continuation.mock.calls[0][2]);expect(panel!.element.textContent).not.toContain('interrupted review finished');
});
it('a native stale-source refusal keeps individual results and does not start a replacement review',async()=>{
 const f=await recoveryFixture();f.continuation.mockRejectedValue(new Error('The captured source or context changed.'));
 await panel!.recoverOutstanding('repo');expect(f.continuation).toHaveBeenCalledOnce();expect(f.core.requestReview).not.toHaveBeenCalled();expect(panel!.element.textContent).toContain('Individual mechanics assessment.');expect(panel!.element.textContent).toContain('1 needs attention');
});
it('continues independent outstanding jobs after one needs attention',async()=>{
 const f=await recoveryFixture(),second={...structuredClone(f.saved),reviewId:'review-second'};
 f.core.listReviews.mockResolvedValue([f.saved,second]);
 f.continuation.mockImplementation(async(_repo,reviewId,id)=>{if(reviewId===f.saved.reviewId)throw Error('Captured text changed');return {...await f.make({...f.request,requestId:id},10),reviewId};});
 await panel!.recoverOutstanding('repo');expect(f.continuation).toHaveBeenCalledTimes(2);expect(panel!.element.textContent).toContain('1 saved review finished; 1 needs attention');expect(panel!.element.textContent).toContain('Captured text changed');
 panel!.show();expect(panel!.element.querySelector('[aria-current=true].review-saved-item')?.getAttribute('aria-label')).toBe(`Reopen saved review ${f.saved.reviewId}`);
});

it('hiding or navigating during startup discovery does not strand recovery in a busy state',async()=>{
 const f=await recoveryFixture();let loaded!:(records:ReviewResult[])=>void;
 f.core.listReviews.mockImplementationOnce(()=>new Promise(resolve=>{loaded=resolve;}));
 const recovery=panel!.recoverOutstanding('repo');panel!.hide();panel!.documentChanged();loaded([f.saved]);await recovery;
 expect(f.continuation).toHaveBeenCalledOnce();expect(panel!.element.textContent).toContain('1 interrupted review finished');
 panel!.show();await vi.waitFor(()=>expect(f.button('Start a new review').disabled).toBe(false));
});
it('opening or refreshing a different saved review during connection restoration cannot replace the recovery job',async()=>{
 const f=await recoveryFixture(),ready=await f.core.questionStatus();let configure!:(value:typeof ready)=>void;
 f.core.questionStatus.mockImplementationOnce(()=>new Promise(resolve=>{configure=resolve;}));
 const recovery=panel!.recoverOutstanding('repo');await tick();
 await panel!.openSaved('different-review');panel!.show();configure(ready);await recovery;
 expect(f.core.getReview).not.toHaveBeenCalled();expect(f.continuation).toHaveBeenCalledOnce();expect(f.continuation.mock.calls[0][1]).toBe(f.saved.reviewId);
});

it('saved review rows become available again after startup recovery settles',async()=>{
 const f=await recoveryFixture();await panel!.recoverOutstanding('repo');panel!.show();
 await vi.waitFor(()=>expect(f.button(`Reopen saved review ${f.saved.reviewId}`).disabled).toBe(false));const saved=f.button(`Reopen saved review ${f.saved.reviewId}`);saved.click();await tick();expect(f.core.getReview).toHaveBeenCalledTimes(2);
});

it.each(['invalidResponse','protocol','outputLimit','responseTooLarge','invalidAssessment','assessmentTooLong','invalidConsolidation'])('offers an explicit retry for %s without sending on reopen',async error=>{
 const f=fixture(); await f.start(); Object.assign(f.record().workflow!.coverage[0],{status:'failed',error});
 const continuation=vi.fn<NonNullable<LocalCore['continueReview']>>(async(_repo,_review,requestId)=>({...structuredClone(f.record()),requestId})); Object.assign(f.core,{continueReview:continuation});
 panel!.hide();panel!.show();await vi.waitFor(()=>expect(f.button('Retry failed chunks').disabled).toBe(false));
 expect(continuation).not.toHaveBeenCalled();expect(panel!.element.textContent).toContain('Invalid responses need another explicit retry');
 await f.click('Retry failed chunks');await tick();expect(continuation).toHaveBeenCalledOnce();expect(f.core.requestReview).toHaveBeenCalledOnce();expect(f.button('Retry failed chunks').hidden).toBe(false);
});
it.each(['usageLimit','staleConnection','invalidReviewOrModel','invalidConsolidationContext','invalidReview'])('does not offer retry for terminal %s',async error=>{
 const f=fixture();await f.start();Object.assign(f.core,{continueReview:vi.fn()});Object.assign(f.record().workflow!.coverage[0],{status:'failed',error});
 panel!.hide();panel!.show();await vi.waitFor(()=>expect(f.core.getReview).toHaveBeenCalled());await tick();expect(f.button('Continue next reviewer batch').hidden).toBe(true);
});
it('captures current text, preserves reviewers and decisions, and invalidates the previous preview',async()=>{
 const f=fixture();await f.start();f.record().edits[0].status='accepted';f.record().revision=2;
 const snapshots=[{...scope.snapshots[0],source:'Current author-approved text.',sourceHash:'f'.repeat(64)}];
 const recapture=vi.fn(async(previous:ReviewScope)=>({...previous,snapshots}));Object.assign(f.hooks,{recapture});
 await f.click('Start a new review');expect(recapture).toHaveBeenCalledOnce();expect(f.button('Preview review').disabled).toBe(false);expect(f.record().edits[0].status).toBe('accepted');
 expect(panel!.element.querySelector('.review-sources')!.textContent).toContain('Current author-approved text.');
 await f.click('Preview review');const request=f.core.previewReview.mock.calls.at(-1)![0];expect(request.snapshots).toEqual(snapshots);expect(request.workflow!.reviewers).toEqual(['contextual']);expect(f.core.requestReview).toHaveBeenCalledOnce();
});
it('recaptures saved paths and target/context roles rather than a different open scene',async()=>{
 const f=fixture();await f.start();f.record().scope='chapter';f.record().workflow!.sources.push({...f.record().workflow!.sources[0],id:'context',path:'context.md',readOnly:true,order:1});await panel!.openSaved('review-stable');
 const recapture=vi.fn(async(previous:ReviewScope)=>({...previous,snapshots:previous.snapshots.map(s=>({...s,source:`Current ${s.path}`}))}));Object.assign(f.hooks,{recapture});
 await f.click('Start a new review');await f.click('Preview review');expect(recapture.mock.calls[0][0].snapshots.map(s=>s.path)).toEqual(['scene.md','context.md']);
 const request=f.core.previewReview.mock.calls.at(-1)![0];expect(request.scope).toBe('chapter');expect(request.snapshots.map(s=>s.path)).toEqual(['scene.md']);expect(request.workflow!.context.map(s=>s.path)).toEqual(['context.md']);
});
it('preserves the saved review on failed capture and ignores late completion after closing',async()=>{
 const f=fixture();await f.start();const recapture=vi.fn<(scope:ReviewScope)=>Promise<ReviewScope>>().mockRejectedValueOnce(new Error('Save your writing first.'));Object.assign(f.hooks,{recapture});
 await f.click('Start a new review');expect(panel!.element.textContent).toContain('Save your writing first.');expect(panel!.element.querySelector<HTMLElement>('.review-results')!.hidden).toBe(false);
 let finish!:(scope:ReviewScope)=>void;recapture.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));f.button('Start a new review').click();f.button('Start a new review').click();await tick();expect(recapture).toHaveBeenCalledTimes(2);
 panel!.clear();finish(scope);await tick();expect(panel!.element.hidden).toBe(true);expect(f.core.requestReview).toHaveBeenCalledOnce();
});
it('refreshes decisions when showing a hidden pane without replaying reviewers',async()=>{
 const f=fixture();await f.start();panel!.hide();f.record().edits[0].status='accepted';f.record().edits[1].status='supersededByAuthorChoice';f.record().revision=8;panel!.show();panel!.show();
 await vi.waitFor(()=>expect(panel!.element.querySelector('.review-progress')!.textContent).toBe('3 suggestions · 2 decided'));expect(f.core.getReview).toHaveBeenCalledOnce();expect(f.core.requestReview).toHaveBeenCalledOnce();expect(f.core.approveReviewEdit).not.toHaveBeenCalled();
});
it('opens another saved review without a refresh race and ignores late refresh after clear',async()=>{
 const f=fixture();await f.start();panel!.hide();const other={...structuredClone(f.record()),reviewId:'other'};f.core.getReview.mockResolvedValueOnce(other);
 await panel!.openSaved('other');expect(f.core.getReview).toHaveBeenCalledOnce();expect(panel!.element.querySelector('.review-json')!.textContent).toContain('"reviewId": "other"');
 panel!.hide();let finish!:(result:ReviewResult)=>void;f.core.getReview.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));panel!.show();panel!.clear();finish(other);await tick();expect(panel!.element.hidden).toBe(true);expect(panel!.element.querySelector('.review-json')!.textContent).not.toContain('"reviewId": "other"');
});
it('does not reuse another library picker or its context filter for a reopened saved review',async()=>{
 const f=fixture();await f.start();
 const other={path:'other.md',source:'Other library',sourceHash:'e'.repeat(64)};
 const libraryCapture=vi.fn(async()=>({ordered:[other],targets:[other],context:[other],bytes:13}));
 panel!.openLibrary({...scope,snapshots:[other],targetPaths:['other.md'],contextPaths:['other.md']},libraryCapture);
 await vi.waitFor(()=>expect(f.button('Preview review').disabled).toBe(false));
 f.record().workflow!.sources.push({...f.record().workflow!.sources[0],id:'ctx',path:'context.md',readOnly:true,order:1});
 await panel!.openSaved('review-stable');
 Object.assign(f.hooks,{recapture:async(previous:ReviewScope)=>({...previous,snapshots:previous.snapshots.map(s=>({...s,source:`Fresh ${s.path}`}))})});
 await f.click('Start a new review');await f.click('Preview review');expect(libraryCapture).not.toHaveBeenCalled();
 const request=f.core.previewReview.mock.calls.at(-1)![0];expect(request.snapshots.map(s=>s.path)).toEqual(['scene.md']);expect(request.workflow!.context.map(s=>s.path)).toEqual(['context.md']);
});
it('does not substitute another reviewer when all saved reviewers are unavailable',async()=>{
 const f=fixture();await f.start();f.record().workflow!.definitions[0].definition.id='deleted-reviewer';await panel!.openSaved('review-stable');await f.click('Start a new review');
 expect(panel!.element.textContent).toContain('Unavailable saved reviewers: deleted-reviewer');expect(f.button('Preview review').disabled).toBe(true);expect(panel!.element.querySelectorAll('[data-reviewer][aria-pressed=true]')).toHaveLength(0);
 f.button('Mechanical review').click();expect(f.button('Preview review').disabled).toBe(false);await f.click('Preview review');expect(f.core.previewReview.mock.calls.at(-1)![0].workflow!.reviewers).toEqual(['mechanical']);
});
it('a refused continuation never exposes a full resubmission of the old capture',async()=>{
 const f=fixture();await f.start();Object.assign(f.record().workflow!.coverage[0],{status:'failed',error:'invalidResponse'});
 const continuation=vi.fn().mockRejectedValue(new Error('The captured source or context changed. Start a fresh review.'));
 Object.assign(f.core,{continueReview:continuation});panel!.hide();panel!.show();await vi.waitFor(()=>expect(f.button('Retry failed chunks').disabled).toBe(false));await f.click('Retry failed chunks');
 expect(f.button('Retry review').hidden).toBe(true);expect(panel!.element.textContent).toContain('Start a fresh review');expect(f.core.requestReview).toHaveBeenCalledOnce();
});
it('fresh library review keeps excluded targets excluded and validates only the retained capture before sending',async()=>{
 const f=fixture();const other={path:'other.md',source:'Excluded source',sourceHash:'b'.repeat(64)};
 const captured={ordered:[scope.snapshots[0],other],targets:[scope.snapshots[0],other],context:[scope.snapshots[0]],bytes:100};
 panel!.openLibrary({...scope,snapshots:captured.ordered,targetPaths:['scene.md','other.md'],contextPaths:['scene.md']},async()=>structuredClone(captured));
 await vi.waitFor(()=>expect(f.button('Preview review').disabled).toBe(false));
 panel!.element.querySelector<HTMLInputElement>('.review-target input[data-path="other.md"]')!.click();
 await f.click('Preview review');await f.click('Run review');await f.click('Start a new review');await f.click('Preview review');await f.click('Run review');
 expect(f.core.requestReview).toHaveBeenCalledTimes(2);expect(f.core.requestReview.mock.calls[1][0].snapshots.map(s=>s.path)).toEqual(['scene.md']);expect(f.core.requestReview.mock.calls[1][0].workflow!.context).toEqual([]);
});
it('quiet decision refresh preserves highlights invalidated by typing until explicit refresh',async()=>{
 const f=fixture();const marksChanged=vi.fn((input:unknown,report:(count:number|null)=>void)=>report(input?2:null));Object.assign(f.hooks,{marksChanged});await f.start();
 panel!.marksInvalidated();panel!.hide();f.record().edits[0].status='accepted';f.record().revision=2;panel!.show();
 await vi.waitFor(()=>expect(panel!.element.querySelector('.review-progress')!.textContent).toBe('3 suggestions · 1 decided'));
 expect(panel!.element.querySelector('.review-mark-status')!.textContent).toContain('Highlights are off because the open text changed');expect(marksChanged.mock.calls.at(-1)![0]).toBeNull();
 await f.click('Refresh review');expect(marksChanged.mock.calls.at(-1)![0]).not.toBeNull();expect(panel!.element.querySelector('.review-mark-status')!.textContent).not.toContain('Highlights are off because the open text changed');
});
