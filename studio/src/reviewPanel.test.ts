// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createReviewPanel, type ReviewScope} from './reviewPanel';
import type {LocalCore, QuestionStatus} from './localCore';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const ready: QuestionStatus = {configured: true, model: 'mock-model', message: 'Mock provider ready.', accounts: [{id: 'account-1', label: 'Writer', signedIn: true, planEnabled: true}], activeAccountId: 'account-1', models: [{slug: 'mock-model', displayName: 'Mock model'}], selectedModel: 'mock-model', signInPending: false, generation: 1, usageLimited: false};
type Request = {requestId: string; repositoryId: string; scope: 'scene' | 'chapter'; snapshots: {path: string; source: string; sourceHash: string}[]};
const source = 'A 🐺 passage.\r\nKeep the em dash — and fragments.';
const response = (request: Request) => ({reviewId: 'review-1', requestId: request.requestId, model: 'mock-model', schemaVersion: 1 as const, scope: request.scope, edits: [{id: 'edit-1', path: 'scene.md', fromUtf8: 7, toUtf8: 14, original: 'passage', replacement: 'paragraph', reason: 'Clarify the noun', role: 'editor' as const, status: 'pending' as const, proposalId: null}]});
type Result = ReturnType<typeof response>;
function bridge() {return {available: vi.fn(() => true), questionStatus: vi.fn(async () => ready), requestReview: vi.fn(async (request: Request) => response(request)), cancelQuestion: vi.fn(async (_id: string) => true), prepareReviewEdit: vi.fn(async (_repo: string, _review: string, _edit: string) => ({proposalId: 'proposal-1'})), rejectReviewEdit: vi.fn(async (_repo: string, _review: string, _edit: string) => ({...response({requestId: 'unused', scope: 'scene'} as Request), edits: []})), getReview: vi.fn(async (_repo: string, _review: string) => response({requestId: 'unused', scope: 'scene'} as Request)), saveDocument: vi.fn(), applyProposalReview: vi.fn()};}
let panel: ReturnType<typeof createReviewPanel> | undefined;
let scope: ReviewScope | null;
let unavailable: string | null;
const reviewProposal = vi.fn(async (_id: string, _guard: () => string | null) => {});
const openConnection = vi.fn(); const focusEditor = vi.fn();
function button(label: string) {const found = [...document.querySelectorAll('button')].find(node => node.textContent === label); if (!found) throw new Error(`Missing ${label}: ${document.body.textContent}`); return found;}
async function start(core = bridge(), extra: Partial<Parameters<typeof createReviewPanel>[1]> = {}) {panel = createReviewPanel(core as unknown as LocalCore, {capture: () => scope, unavailable: () => unavailable, reviewProposal, openConnection, focusEditor, ...extra}); document.body.append(panel.element); panel.open(); await vi.waitFor(() => expect(panel!.element.querySelector<HTMLElement>('.review-connection')!.dataset.state).not.toBe('checking')); return core;}
async function run() {button('Run review').click(); await vi.waitFor(() => expect(button('Accept…')).toBeTruthy());}
beforeEach(() => {vi.stubGlobal('crypto', webcrypto); document.body.replaceChildren(); localStorage.clear(); scope = {repositoryId: 'repo-1', scope: 'scene', snapshots: [{path: 'scene.md', source, sourceHash: 'a'.repeat(64)}], label: 'Current scene'}; unavailable = null; reviewProposal.mockClear(); openConnection.mockClear(); focusEditor.mockClear();});
afterEach(() => {panel?.destroy(); panel = undefined; vi.unstubAllGlobals();});
describe('Heinlein review panel author-controlled workflow', () => {
  it('previews exact raw snapshots without sending, saving, or applying on open', async () => {const core = await start(); expect(panel!.element.textContent).toContain(source); expect(core.requestReview).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.applyProposalReview).not.toHaveBeenCalled(); await run(); expect(core.requestReview.mock.calls[0][0]).toMatchObject({repositoryId: 'repo-1', scope: 'scene', snapshots: [{path: 'scene.md', source, sourceHash: 'a'.repeat(64)}]}); expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.applyProposalReview).not.toHaveBeenCalled();});
  it('keeps the captured snapshot frozen when the editor changes before an explicit send', async () => {const core = await start(); scope!.snapshots[0].source = 'Later unsaved changes'; panel!.stateChanged(); button('Run review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); expect(core.requestReview.mock.calls[0][0].snapshots[0].source).toBe(source); expect(core.saveDocument).not.toHaveBeenCalled();});
  it('does not duplicate a pending request, cancels it, and ignores its late result', async () => {const pending = deferred<Result>(); const core = bridge(); core.requestReview.mockReturnValueOnce(pending.promise); await start(core); button('Run review').click(); button('Run review').click(); expect(core.requestReview).toHaveBeenCalledTimes(1); const request = core.requestReview.mock.calls[0][0]; button('Cancel review').click(); expect(core.cancelQuestion).toHaveBeenCalledWith(request.requestId); pending.resolve(response(request)); await Promise.resolve(); expect([...document.querySelectorAll('button')].filter(node => node.textContent === 'Accept…')).toHaveLength(0); expect(core.saveDocument).not.toHaveBeenCalled();});
  it('retries only on explicit action with a new request identifier', async () => {const core = bridge(); core.requestReview.mockRejectedValueOnce({code: 'network', message: 'Review connection interrupted.'}); await start(core); button('Run review').click(); await vi.waitFor(() => expect(button('Retry review').hidden).toBe(false)); expect(core.requestReview).toHaveBeenCalledTimes(1); button('Retry review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledTimes(2)); expect(core.requestReview.mock.calls[0][0].requestId).not.toBe(core.requestReview.mock.calls[1][0].requestId); expect(core.saveDocument).not.toHaveBeenCalled();});
  it('routes individual acceptance through proposal authority without direct mutation', async () => {const core = await start(); await run(); expect(core.prepareReviewEdit).not.toHaveBeenCalled(); button('Accept…').click(); await vi.waitFor(() => expect(reviewProposal).toHaveBeenCalledTimes(1)); expect(core.prepareReviewEdit).toHaveBeenCalledWith('repo-1', 'review-1', 'edit-1'); expect(reviewProposal.mock.calls[0][0]).toBe('proposal-1'); expect(typeof reviewProposal.mock.calls[0][1]).toBe('function'); expect(core.applyProposalReview).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled();});
  it('rejects one edit without preparing or applying a proposal', async () => {const core = await start(); await run(); button('Keep mine').click(); await vi.waitFor(() => expect(core.rejectReviewEdit).toHaveBeenCalledWith('repo-1', 'review-1', 'edit-1')); expect(core.prepareReviewEdit).not.toHaveBeenCalled(); expect(reviewProposal).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled();});
  it('blocks acceptance when current author state becomes unavailable', async () => {const core = await start(); await run(); unavailable = 'Resolve the recovery draft first.'; panel!.stateChanged(); expect(button('Accept…').disabled).toBe(true); button('Accept…').click(); expect(core.prepareReviewEdit).not.toHaveBeenCalled(); expect(reviewProposal).not.toHaveBeenCalled();});
  it('rechecks the guard when preparation returns after author state changed', async () => {const prepared = deferred<{proposalId: string}>(); const core = bridge(); core.prepareReviewEdit.mockReturnValueOnce(prepared.promise); await start(core); await run(); button('Accept…').click(); unavailable = 'Save the current scene first.'; panel!.stateChanged(); prepared.resolve({proposalId: 'proposal-1'}); await Promise.resolve(); await Promise.resolve(); expect(reviewProposal).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled();});
  it.each(['clear', 'escape', 'destroy'] as const)('cancels and discards pending private snapshots on %s', async action => {const pending = deferred<Result>(); const core = bridge(); core.requestReview.mockReturnValueOnce(pending.promise); await start(core); button('Run review').click(); const request = core.requestReview.mock.calls[0][0]; if (action === 'escape') panel!.element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); else panel![action](); expect(core.cancelQuestion).toHaveBeenCalledWith(request.requestId); expect(panel!.element.textContent).not.toContain(source); pending.resolve(response(request)); await Promise.resolve(); expect(panel!.element.textContent).not.toContain('Clarify the noun');});
  it('offers the connection UI inline without sending or saving', async () => {const core = bridge(); core.questionStatus.mockResolvedValue({...ready, configured: false, message: 'Connect ChatGPT first.'}); await start(core); expect(panel!.element.querySelector<HTMLElement>('.review-connection')!.hidden).toBe(false); expect(panel!.element.textContent).toContain('Connect ChatGPT first.'); button('Connect ChatGPT').click(); expect(openConnection).toHaveBeenCalledOnce(); expect(core.requestReview).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled();});
  it('does not send while connection is unconfigured', async () => {const core = bridge(); core.questionStatus.mockResolvedValue({...ready, configured: false, message: 'Connect ChatGPT first.'}); await start(core); expect(button('Run review').disabled).toBe(true); button('Run review').click(); expect(core.requestReview).not.toHaveBeenCalled();});
  it.each([null, {reviewId: 'broken'}, {schemaVersion: 999, edits: []}])('rejects malformed results without exposing acceptance controls', async malformed => {const core = bridge(); core.requestReview.mockResolvedValueOnce(malformed as never); await start(core); button('Run review').click(); await vi.waitFor(() => expect(button('Retry review').hidden).toBe(false)); expect([...document.querySelectorAll('button')].filter(node => node.textContent === 'Accept…')).toHaveLength(0); expect(core.prepareReviewEdit).not.toHaveBeenCalled();});
  it('renders review provider strings as inert text', async () => {const core = bridge(); core.requestReview.mockImplementation(async request => ({...response(request), edits: [{...response(request).edits[0], reason: '<img src=x onerror=alert(1)><script>bad()</script>'}]})); await start(core); await run(); expect(document.querySelector('img,script')).toBeNull(); expect(panel!.element.textContent).toContain('<script>bad()</script>');});
  it.each([16001, 16004])('rejects raw snapshots over the aggregate UTF-8 limit (%i bytes)', async bytes => {scope!.snapshots[0].source = bytes === 16001 ? 'x'.repeat(bytes) : '🐺'.repeat(4001); const core = await start(); expect(button('Run review').disabled).toBe(true); button('Run review').click(); expect(core.requestReview).not.toHaveBeenCalled();});
  it('rejects chapters above 16 source scenes rather than silently truncating', async () => {scope!.scope = 'chapter'; scope!.snapshots = Array.from({length: 17}, (_, index) => ({path: `scene-${index}.md`, source: 'Text', sourceHash: 'a'.repeat(64)})); const core = await start(); expect(button('Run review').disabled).toBe(true); expect(core.requestReview).not.toHaveBeenCalled();});
  it('does not permit a mismatched request result to become an actionable review', async () => {const core = bridge(); core.requestReview.mockImplementation(async request => ({...response(request), requestId: 'other-request'})); await start(core); button('Run review').click(); await vi.waitFor(() => expect(button('Retry review').hidden).toBe(false)); expect([...document.querySelectorAll('button')].filter(node => node.textContent === 'Accept…')).toHaveLength(0);});

  it.each(['wrong original', 'split UTF-8', 'out of bounds', 'outside scope', 'overlap'] as const)('rejects unsafe edit targets: %s', async problem => {const core = bridge(); core.requestReview.mockImplementation(async request => {const value = response(request); const edit = value.edits[0]; if (problem === 'wrong original') edit.original = 'not this text'; else if (problem === 'split UTF-8') {edit.fromUtf8 = 3; edit.toUtf8 = 5; edit.original = '🐺';} else if (problem === 'out of bounds') edit.toUtf8 = 9999; else if (problem === 'outside scope') edit.path = 'other.md'; else value.edits.push({...edit, id: 'overlapping'}); return value;}); await start(core); button('Run review').click(); await vi.waitFor(() => expect(button('Retry review').hidden).toBe(false)); expect(panel!.element.querySelectorAll('button[data-edit-action="accept"]')).toHaveLength(0); expect(core.prepareReviewEdit).not.toHaveBeenCalled();});

  it('times out locally, cancels the native request, and requires explicit retry', async () => {const pending = deferred<Result>(); const core = bridge(); core.requestReview.mockReturnValueOnce(pending.promise); await start(core); vi.useFakeTimers(); try {button('Run review').click(); const request = core.requestReview.mock.calls[0][0]; await vi.advanceTimersByTimeAsync(185000); expect(core.cancelQuestion).toHaveBeenCalledWith(request.requestId); expect(button('Retry review').hidden).toBe(false); expect(core.requestReview).toHaveBeenCalledOnce(); pending.resolve(response(request)); await Promise.resolve(); expect(panel!.element.querySelectorAll('button[data-edit-action="accept"]')).toHaveLength(0); expect(core.saveDocument).not.toHaveBeenCalled();} finally {vi.useRealTimers();}});
  it('applies the byte limit to all chapter sources together', async () => {scope!.scope = 'chapter'; scope!.snapshots = [{path: 'one.md', source: 'x'.repeat(9000), sourceHash: 'a'}, {path: 'two.md', source: 'y'.repeat(9000), sourceHash: 'b'}]; const core = await start(); expect(button('Run review').disabled).toBe(true); expect(core.requestReview).not.toHaveBeenCalled();});

  it('refreshes individual decisions changed through the generic native proposals panel', async () => {const core = await start(); await run(); const request = core.requestReview.mock.calls[0][0]; core.getReview.mockResolvedValue({...response(request), edits: [{...response(request).edits[0], status: 'rejected'}]} as never); button('Refresh review').click(); await vi.waitFor(() => expect(panel!.element.textContent).toContain('Rejected · local receipt retained.')); expect(panel!.element.querySelectorAll('button[data-edit-action="accept"]')).toHaveLength(0); expect(core.requestReview).toHaveBeenCalledOnce(); expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.applyProposalReview).not.toHaveBeenCalled();});

});
it('dismisses a durably rejected suggestion from pending cards while retaining its JSON audit',async()=>{
 const core=bridge();
 core.rejectReviewEdit.mockImplementation(async()=>({...response({requestId:'run',scope:'scene'} as Request),edits:[{...response({requestId:'run',scope:'scene'} as Request).edits[0],status:'rejected'}]} as never));
 await start(core);await run();button('Keep mine').click();
 await vi.waitFor(()=>expect(panel!.element.querySelectorAll('.review-edit')).toHaveLength(0));
 expect(panel!.element.querySelector('pre')?.textContent).toBeTruthy();
 expect(panel!.element.textContent).toContain('"status": "rejected"');
 expect(core.applyProposalReview).not.toHaveBeenCalled();
});

const reading = {overview: 'The scene reads with a clear voice and growing tension.', strengths: ['A distinct voice.', 'A grounded setting.', 'A well paced turn.'], improvements: ['Consider the opening beat.', 'Clarify the immediate goal.', 'Explore the final image.'].map(text => ({text, editIds: ['edit-1']}))};
it('shows reading feedback with targeted diffs for all three improvements', async () => {
 const core = bridge(); core.requestReview.mockImplementation(async request => ({...response(request), readingFeedback: [{path: 'scene.md', reviewer: 'Editor', feedback: reading}]}));
 await start(core); button('Run review').click();
 await vi.waitFor(() => expect(panel!.element.textContent).toContain(reading.overview));
 expect(panel!.element.querySelectorAll('.review-feedback-list')).toHaveLength(2);
 expect([...panel!.element.querySelectorAll('.review-feedback-list')].map(list => list.children.length)).toEqual([3,3]);
 expect(panel!.element.querySelectorAll('[aria-hidden="true"].review-feedback-marker')).toHaveLength(6);
 expect(panel!.element.textContent).toContain('Strengths'); expect(panel!.element.textContent).toContain('Points for improvement');
 expect(panel!.element.querySelectorAll('.review-improvement-diffs')).toHaveLength(3); expect(core.saveDocument).not.toHaveBeenCalled();
});
it('jumps from the diff list without approving or changing the source', async () => {
 const core = bridge(), jumpToEdit = vi.fn(async () => true);
 panel = createReviewPanel(core as unknown as LocalCore, {capture: () => scope, unavailable: () => unavailable, reviewProposal, openConnection, focusEditor, jumpToEdit});
 document.body.append(panel.element); panel.open(); await vi.waitFor(() => expect(button('Run review').disabled).toBe(false)); await run();
 (panel.element.querySelector('.review-diff-jump') as HTMLButtonElement).click();
 await vi.waitFor(() => expect(jumpToEdit).toHaveBeenCalledOnce());
 expect(jumpToEdit.mock.calls[0]).toBeDefined(); expect(core.prepareReviewEdit).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.applyProposalReview).not.toHaveBeenCalled();
});
it('does not invent reading feedback for older saved results', async () => {
 await start(); await run(); expect(panel!.element.textContent).toContain('Reading feedback is unavailable'); expect(panel!.element.querySelectorAll('.review-feedback-list')).toHaveLength(0);
});
it('rejects malformed reading feedback before showing review actions', async () => {
 const core=bridge(); core.requestReview.mockImplementation(async request=>({...response(request), readingFeedback:[{path:'scene.md',reviewer:'Editor',feedback:{...reading,strengths:['']}}]}));
 await start(core); button('Run review').click(); await vi.waitFor(()=>expect(button('Retry review').hidden).toBe(false)); expect(panel!.element.querySelectorAll('[data-edit-action="accept"]')).toHaveLength(0);
});

it.each([{editIds: ['missing']}, {editIds: ['edit-1', 'edit-1']}])('rejects an improvement with invalid diff references: %j', async ({editIds}) => {
 const core=bridge(); core.requestReview.mockImplementation(async request=>({...response(request), readingFeedback:[{path:'scene.md',reviewer:'Editor',feedback:{...reading,improvements:[reading.improvements[0], {...reading.improvements[1], editIds}, reading.improvements[2]]}}]}));
 await start(core); button('Run review').click(); await vi.waitFor(()=>expect(button('Retry review').hidden).toBe(false));
 expect(panel!.element.textContent).toContain('An improvement point contains invalid diff references.'); expect(panel!.element.querySelectorAll('[data-edit-action="accept"]')).toHaveLength(0);
});


it.each([0, 1, 4])('accepts %i grounded improvements without requiring patches', async count => {
 const feedback={overview:'The scene reads clearly.',strengths:['A clear setting.'],improvements:Array.from({length:count},()=>({text:'Consider a later echo of the image.',evidence:'Bad fox.',editIds:[]}))};
 const core=bridge();core.requestReview.mockImplementation(async request=>({...response(request),edits:[],readingFeedback:[{path:'scene.md',reviewer:'Editor',feedback}]}));
 await start(core);button('Run review').click();await vi.waitFor(()=>expect(panel!.element.textContent).toContain(feedback.overview));
 expect(panel!.element.querySelectorAll('.review-improvement-diffs')).toHaveLength(0);
 expect(panel!.element.textContent).toContain(count ? 'Evidence: Bad fox.' : 'No improvements suggested.');
 expect(core.saveDocument).not.toHaveBeenCalled();
});

it('opens the consolidated pros and cons while retaining every individual pass', async () => {
 const core=bridge();
 const assessment={strengths:'The opening image anchors the scene.',improvements:'No change is warranted: the image is clear and the action stays focused.'};
 core.requestReview.mockImplementation(async request=>({...response(request),edits:[],readingFeedback:[
  {coverageId:'mechanical',path:'scene.md',reviewer:'Mechanical review',feedback:{overview:'No mechanical errors.',strengths:[],improvements:[]}},
  {coverageId:'contextual',path:'scene.md',reviewer:'Story and clarity review',feedback:reading},
  {coverageId:'consolidation',path:'Selected review scope',reviewer:'Consolidated review',feedback:{overview:'An overall assessment across both reviewers.',assessment,strengths:[],improvements:[]}}
 ].map(entry=>({...entry,feedback:{...entry.feedback,improvements:[]}}))}));
 await start(core);button('Run review').click();await vi.waitFor(()=>expect(panel!.element.textContent).toContain(assessment.strengths));
 expect(panel!.element.textContent).toContain(assessment.improvements);
 expect(panel!.element.textContent).not.toContain('No strengths listed.');
 const select=panel!.element.querySelector<HTMLSelectElement>('.review-feedback-picker select')!;
 expect(select.value).toBe('2');expect(select.options).toHaveLength(3);
 select.value='0';select.dispatchEvent(new Event('change'));
 expect(panel!.element.textContent).toContain('No mechanical errors.');
 select.value='1';select.dispatchEvent(new Event('change'));
 expect(panel!.element.textContent).toContain(reading.overview);
 expect(core.saveDocument).not.toHaveBeenCalled();expect(core.applyProposalReview).not.toHaveBeenCalled();
});
it.each([{strengths:'',improvements:'Clear.'},{strengths:'Clear.',improvements:' '},{strengths:'Clear.'},null])('rejects malformed explicit assessment %j', async assessment => {
 const core=bridge();core.requestReview.mockImplementation(async request=>({...response(request),readingFeedback:[{path:'scene.md',reviewer:'Editor',feedback:{...reading,assessment}}]} as never));
 await start(core);button('Run review').click();await vi.waitFor(()=>expect(button('Retry review').hidden).toBe(false));
 expect(panel!.element.querySelectorAll('[data-edit-action="accept"]')).toHaveLength(0);
});


describe('completed review returns to the manuscript', () => {
  it('closes the rail after success while retaining marks and the saved review', async () => {
    const closePane = vi.fn(), marksChanged = vi.fn(), announce = vi.fn();
    const core = await start(bridge(), {rail:true, closePane, marksChanged, announce});
    await run();
    await vi.waitFor(() => expect(closePane).toHaveBeenCalledTimes(1));
    expect(panel!.visible()).toBe(false);
    expect(marksChanged.mock.calls.at(-1)?.[0]?.edits[0].id).toBe('edit-1');
    panel!.show();
    expect(panel!.visible()).toBe(true);
    expect(button('Accept…')).toBeTruthy();
    expect(core.requestReview).toHaveBeenCalledTimes(1);
    expect(core.saveDocument).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('Chats closed'));
  });
  it('keeps errors visible instead of closing the rail', async () => {
    const closePane = vi.fn(), core = bridge();
    core.requestReview.mockRejectedValueOnce(new Error('Connection lost'));
    await start(core, {rail:true, closePane});
    button('Run review').click();
    await vi.waitFor(() => expect(panel!.element.textContent).toContain('Connection lost'));
    expect(panel!.visible()).toBe(true);
    expect(closePane).not.toHaveBeenCalled();
  });
});


it.each(['x', 'é', '🐺'])('accepts 2,000 Unicode characters of advisory feedback (%s)', async character => {
 const text=character.repeat(2000), feedback={overview:text,assessment:{strengths:text,improvements:text},strengths:[text],improvements:[{text,evidence:text,editIds:[]}]};
 const core=bridge();core.requestReview.mockImplementation(async request=>({...response(request),edits:[],readingFeedback:[{coverageId:'consolidation',path:'Selected review scope',reviewer:'Consolidated review',feedback}]}));
 await start(core);button('Run review').click();await vi.waitFor(()=>expect(panel!.element.textContent).toContain(text));
 expect(panel!.element.textContent).not.toContain('Invalid reading feedback');
 expect(core.saveDocument).not.toHaveBeenCalled();expect(core.applyProposalReview).not.toHaveBeenCalled();
});
it.each(['x', 'é', '🐺'])('rejects 2,001 Unicode characters of advisory feedback (%s)', async character => {
 const core=bridge();core.requestReview.mockImplementation(async request=>({...response(request),readingFeedback:[{path:'scene.md',reviewer:'Editor',feedback:{...reading,assessment:{strengths:'Clear.',improvements:character.repeat(2001)}}}]}));
 await start(core);button('Run review').click();await vi.waitFor(()=>expect(button('Retry review').hidden).toBe(false));
 expect(panel!.element.textContent).toContain('Invalid reading feedback');expect(panel!.element.querySelectorAll('[data-edit-action="accept"]')).toHaveLength(0);
});
