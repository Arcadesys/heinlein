// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import type {LocalCore, Manuscript, ReviewRequest, ReviewResult, ProposalReview, ProposalBinding, ProposalOutcome} from './localCore';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
const original = '---\r\ntitle: Exact\r\n---\r\nA 🐺 passage.\r\nLast line';
const session = {id: 'session', name: 'Synthetic', manifests: ['scene-manifest.json']};
const manuscript: Manuscript = {path: 'scene-manifest.json', project: 'Synthetic', schemaVersion: 1, volumes: [{number: 1, title: 'Volume', path: '', chapters: [{number: 1, title: 'Chapter', path: '', source: 'chapter.md', scenes: [{path: 'scene.md'}, {path: 'other.md'}]}]}]};
let app: ReturnType<typeof mountStudio> | undefined;
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
function result(request: ReviewRequest): ReviewResult {return {reviewId: 'review-1', requestId: request.requestId, model: 'mock-model', schemaVersion: 1, scope: request.scope, edits: []};}
function bridge() {const doc = (path: string, text = original) => ({path, text, contentHash: 'a'.repeat(64), sizeBytes: new TextEncoder().encode(text).length, frontmatter: null, generatedCompatibility: false}); return {
  available: () => true, recentRepositories: vi.fn(async () => []), pickRepository: vi.fn(async () => session), openRecentRepository: vi.fn(async () => session), listDirectory: vi.fn(async () => []), listSystemFonts: vi.fn(async () => []), loadManuscript: vi.fn(async () => manuscript), readDocument: vi.fn(async (_id: string, path: string) => doc(path)),
  readRecovery: vi.fn(async () => null), stageRecovery: vi.fn(async (_id: string, path: string, baseHash: string, text: string) => ({id: 'draft', path, baseHash, text, updatedAt: 0})), discardRecovery: vi.fn(async () => {}), saveDocument: vi.fn(async (_id: string, path: string, _hash: string, text: string) => doc(path, text)), setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
  questionStatus: vi.fn(async () => ({configured: true, model: 'mock-model', message: 'Mock provider ready.', accounts: [{id: 'account-1', label: 'Writer', signedIn: true, planEnabled: true}], activeAccountId: 'account-1', models: [{slug: 'mock-model', displayName: 'Mock model'}], selectedModel: 'mock-model', signInPending: false, generation: 1, usageLimited: false})), askQuestion: vi.fn(), cancelQuestion: vi.fn(async (_requestId: string) => true), requestReview: vi.fn(async (request: ReviewRequest): Promise<ReviewResult> => result(request)), prepareReviewEdit: vi.fn(async () => ({proposalId: 'proposal-1'})), getReview: vi.fn(), rejectReviewEdit: vi.fn(), applyProposalReview: vi.fn(),
} satisfies LocalCore;}
const button = (label: string) => {const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label); if (!found) throw new Error(`Missing ${label}`); return found;};
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
const panel = () => document.querySelector<HTMLElement>('[aria-label="Heinlein Review"]')!;
async function start(core: LocalCore) {app = mountStudio(document.body, core); await app.selectRepository(async () => session); await app.showDocument('scene.md');}
async function open() {button('Heinlein Review').click(); await vi.waitFor(() => expect(button('Refresh connection').disabled).toBe(false));}
beforeEach(() => {vi.stubGlobal('crypto', webcrypto); localStorage.clear(); document.body.replaceChildren(); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();});
afterEach(() => {app?.destroy(); app = undefined; vi.unstubAllGlobals();});
describe('Studio Heinlein Review integration', () => {
  it('reviews an unmapped Markdown source with explicit batch consent and reopens the saved review without rerunning', async () => {
    const raw = '---\r\ntitle: "Écriture 🦊"\nvoice: "Keep — interruptions."\r\n---\nA deliberately short fragment.\r\n尾声 — exact.\n';
    const path = 'chapters/unmapped.markdown';
    const generic = {...session, manifests: [], projectKey: 'b'.repeat(64)};
    const core = bridge();
    core.readDocument.mockImplementation(async (_id, name) => ({path: name, text: raw, contentHash: 'a'.repeat(64), sizeBytes: new TextEncoder().encode(raw).length, frontmatter: null, generatedCompatibility: false}));
    const definition = {id: 'mechanical', version: 1, displayName: 'Mechanical review', instructions: 'Keep deliberate source choices.'};
    const coverage = [{id: 'chunk-1', sourceIndex: 0, fromUtf8: 0, toUtf8: new TextEncoder().encode(raw).length, windowFrom: 0, windowTo: new TextEncoder().encode(raw).length, reviewer: 0, status: 'queued', requestId: null, error: null}];
    let stored: ReviewResult | null = null;
    const native = {...core,
      reviewDefinitions: vi.fn(async () => [definition]),
      previewReview: vi.fn(async (_request: ReviewRequest) => structuredClone(coverage)),
      listReviews: vi.fn(async () => stored ? [structuredClone(stored)] : []),
    };
    core.requestReview.mockImplementation(async request => {
      stored = {...result(request), schemaVersion: 2, reviewId: 'unmapped-review', revision: 1, projectKey: generic.projectKey,
        workflow: {definitions: [{instanceId: 'reviewer-1', definition, hash: 'c'.repeat(64)}], sources: [{id: 'source-1', path, sourceHash: 'a'.repeat(64), readOnly: false, order: 0}], coverage: coverage.map(c => ({...c, status: 'completed', requestId: 'mock-call'})), decisions: [], accountId: 'account-1', accountGeneration: 1, contextNotice: 'Synthetic selected source only.'}};
      return structuredClone(stored);
    });
    core.getReview.mockImplementation(async () => structuredClone(stored!));
    const mount = async () => {app = mountStudio(document.body, native); await app.selectRepository(async () => generic); await app.showDocument(path);};
    await mount();
    expect(core.requestReview).not.toHaveBeenCalled();expect(native.previewReview).not.toHaveBeenCalled();
    expect(document.querySelector('.badge')?.textContent).toBe('Source file · Editable Markdown');
    await open();
    expect(panel().textContent).toContain('Source file');
    expect(button('Run Heinlein Review').disabled).toBe(true);
    button('Preview reviewer batch').click();
    await vi.waitFor(() => expect(native.previewReview).toHaveBeenCalledOnce());
    expect(core.requestReview).not.toHaveBeenCalled();expect(core.saveDocument).not.toHaveBeenCalled();
    expect(native.previewReview.mock.calls[0][0]).toMatchObject({repositoryId: generic.id, scope: 'scene', snapshots: [{path, source: raw, sourceHash: 'a'.repeat(64)}], workflow: {reviewers: ['mechanical'], context: [], contextNote: ''}});
    expect(native.previewReview.mock.calls[0][0].snapshots[0].sceneId).toBeUndefined();
    button('Run Heinlein Review').click();await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce());
    expect(core.requestReview.mock.calls[0][0].snapshots[0].source).toBe(raw);
    expect(core.saveDocument).not.toHaveBeenCalled();expect(core.applyProposalReview).not.toHaveBeenCalled();
    app!.destroy();app = undefined;await mount();
    expect(core.requestReview).toHaveBeenCalledOnce();await open();
    await vi.waitFor(() => expect(button('Reopen saved review unmapped-review')).toBeTruthy());
    button('Reopen saved review unmapped-review').click();await vi.waitFor(() => expect(core.getReview).toHaveBeenCalledOnce());
    expect(core.requestReview).toHaveBeenCalledOnce();expect(native.previewReview).toHaveBeenCalledOnce();
    expect(core.saveDocument).not.toHaveBeenCalled();expect(core.applyProposalReview).not.toHaveBeenCalled();
  });
  it('previews and sends exact unsaved editor content only after explicit review, without implicit save', async () => {const core = bridge(); await start(core); view().dispatch({changes: {from: view().state.doc.length, insert: '\nUnsaved 🦊—fragment.'}}); await open(); expect(core.requestReview).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled(); const expected = original + '\r\nUnsaved 🦊—fragment.'; expect(panel().textContent).toContain(expected); button('Run Heinlein Review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); expect(core.requestReview.mock.calls[0][0]).toMatchObject({repositoryId: session.id, scope: 'scene', snapshots: [{path: 'scene.md', source: expected, sourceHash: 'a'.repeat(64)}]}); expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.applyProposalReview).not.toHaveBeenCalled();});
  it('keeps author editing and manual save usable while a review is pending', async () => {const core = bridge(); const pending = deferred<ReviewResult>(); core.requestReview.mockReturnValueOnce(pending.promise); await start(core); await open(); button('Run Heinlein Review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); expect(view().state.readOnly).toBe(false); view().dispatch({changes: {from: view().state.doc.length, insert: '!'}}); await app!.saveCurrent(); expect(core.saveDocument).toHaveBeenCalledOnce(); const request = core.requestReview.mock.calls[0][0]; pending.resolve(result(request)); await Promise.resolve(); expect(view().state.doc.toString()).toContain('Last line!'); expect(core.applyProposalReview).not.toHaveBeenCalled();});
  it('clears private snapshots and cancels pending review on scene navigation', async () => {const core = bridge(); const pending = deferred<ReviewResult>(); core.requestReview.mockReturnValueOnce(pending.promise); await start(core); await open(); button('Run Heinlein Review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); const request = core.requestReview.mock.calls[0][0]; await app!.showDocument('other.md'); expect(core.cancelQuestion).toHaveBeenCalledWith(request.requestId); expect(panel().hidden).toBe(true); expect(panel().textContent).not.toContain(original); pending.resolve(result(request)); await Promise.resolve(); expect(panel().hidden).toBe(true);});
  it('clears and cancels pending review on repository navigation', async () => {const core = bridge(); const pending = deferred<ReviewResult>(); core.requestReview.mockReturnValueOnce(pending.promise); await start(core); await open(); button('Run Heinlein Review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); const request = core.requestReview.mock.calls[0][0]; await app!.selectRepository(async () => ({...session, id: 'another-repository'})); expect(core.cancelQuestion).toHaveBeenCalledWith(request.requestId); expect(panel().hidden).toBe(true); pending.resolve(result(request)); await Promise.resolve(); expect(panel().textContent).not.toContain(original);});
  it('captures ordered source scenes for assembled chapter review, never the generated export', async () => {const core = bridge(); await start(core); await app!.showDocument('chapter.md'); expect(view().state.readOnly).toBe(true); await open(); expect(core.requestReview).not.toHaveBeenCalled(); button('Run Heinlein Review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); const request = core.requestReview.mock.calls[0][0]; expect(request.scope).toBe('chapter'); expect(request.snapshots.map(snapshot => snapshot.path)).toEqual(['scene.md', 'other.md']); expect(request.snapshots.map(snapshot => snapshot.source)).toEqual([original, original]); expect(core.readDocument.mock.calls.some(call => call[1] === 'chapter.md')).toBe(false); expect(core.saveDocument).not.toHaveBeenCalled();});
  it('requires separate native confirmation for each accepted edit and preserves the remaining review after source reload', async () => {
    const core = bridge(); let disk = original; let accepted = 0; let request!: ReviewRequest;
    const origin = {kind: 'nativeOpenAi' as const, sessionId: '', clientLabel: '', identityAssurance: 'unverifiedProviderMetadata' as const, provider: 'openai' as const, model: 'mock-model', requestId: 'native-request'};
    const edits: ReviewResult['edits'] = [{id: 'edit-1', path: 'scene.md', fromUtf8: 31, toUtf8: 38, original: 'passage', replacement: 'paragraph', reason: 'Clarify noun', role: 'editor', status: 'pending', proposalId: null}, {id: 'edit-2', path: 'scene.md', fromUtf8: 41, toUtf8: 45, original: 'Last', replacement: 'Final', reason: 'Clarify ending', role: 'proofreader', status: 'pending', proposalId: null}];
    const current = (): ReviewResult => ({...result(request), edits: edits.map((edit, index) => ({...edit, status: index < accepted ? 'accepted' : 'pending'}))});
    core.requestReview.mockImplementation(async value => {request = value; return current();});
    core.getReview.mockImplementation(async () => current());
    core.readDocument.mockImplementation(async (_id, path) => ({path, text: disk, contentHash: 'a'.repeat(64), sizeBytes: new TextEncoder().encode(disk).length, frontmatter: null, generatedCompatibility: false}));
    const proposal = (): ProposalReview => ({id: `authority-${accepted}`, proposalId: `proposal-${accepted + 1}`, kind: 'apply', path: 'scene.md', baseHash: 'a'.repeat(64), replacementHash: 'replacement', diffHash: 'diff', baseText: disk, replacementText: accepted === 0 ? disk.replace('passage', 'paragraph') : disk.replace('Last', 'Final'), origin, expiresAtMs: Date.now() + 300000, parentReceiptId: null});
    core.prepareReviewEdit.mockImplementation(async () => ({proposalId: `proposal-${accepted + 1}`}));
    const native = {...core, listProposals: vi.fn(async () => ({pending: [], receipts: []})), reviewProposal: vi.fn(async () => proposal()), reviewProposalRevert: vi.fn(async () => proposal()), cancelProposalReview: vi.fn(async () => {}), applyProposalReview: vi.fn(async (_repositoryId: string, binding: ProposalBinding): Promise<ProposalOutcome> => {disk = proposal().replacementText; accepted++; return {receipt: {id: `receipt-${accepted}`, kind: 'apply', status: 'completed', proposalId: binding.proposalId, path: 'scene.md', baseHash: binding.baseHash, replacementHash: binding.replacementHash, diffHash: binding.diffHash, origin, parentReceiptId: null, message: null, createdAtMs: Date.now(), revertAvailable: true}, warning: null};})};
    await start(native); await open(); button('Run Heinlein Review').click(); await vi.waitFor(() => expect(button('Accept edit').disabled).toBe(false));
    for (let index = 0; index < 2; index++) {
      button('Accept edit').click(); await vi.waitFor(() => expect(document.querySelector('[aria-label="Review whole-scene proposal"]')).not.toBeNull());
      expect(native.applyProposalReview).toHaveBeenCalledTimes(index); expect(native.saveDocument).not.toHaveBeenCalled();
      const comparison = document.querySelector('[aria-label="Review whole-scene proposal"]')!; expect(comparison.textContent).toContain('Native OpenAI suggestion'); expect(comparison.querySelector('pre')!.textContent).toBe(disk);
      button('Continue to native confirmation').click(); await vi.waitFor(() => expect(native.getReview).toHaveBeenCalledTimes(index + 1));
      expect(panel().hidden).toBe(false); expect(native.applyProposalReview).toHaveBeenCalledTimes(index + 1); expect(view().state.doc.toString()).toBe(disk.replace(/\r\n/g, '\n'));
    }
    expect(disk).toContain('paragraph'); expect(disk).toContain('Final line'); expect(native.saveDocument).not.toHaveBeenCalled();
    expect(panel().querySelectorAll('button[data-edit-action="accept"]')).toHaveLength(0);
  });

});
