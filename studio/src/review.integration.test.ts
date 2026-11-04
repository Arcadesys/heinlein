// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import {reviewMarksIn} from './reviewMarks';
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
const button = (label: string) => {const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === label); if (!found) throw new Error(`Missing ${label}`); return found;};
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
const panel = () => document.querySelector<HTMLElement>('[aria-label="Heinlein Review"]')!;
async function start(core: LocalCore) {app = mountStudio(document.body, core); await app.selectRepository(async () => session); await app.showDocument('scene.md');}
async function open() {const launch=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.startsWith('Heinlein')&&!b.textContent?.includes('Review'))!;launch.click();button('Whole scene').click(); await vi.waitFor(() => expect(panel().querySelector<HTMLElement>('.review-connection')!.dataset.state).not.toBe('checking'));}
beforeEach(() => {vi.stubGlobal('crypto', webcrypto); localStorage.clear(); document.body.replaceChildren(); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();});
afterEach(() => {app?.destroy(); app = undefined; vi.unstubAllGlobals();});
describe('Studio Heinlein Review integration', () => {
  it('captures the entire chapter from its second scene without navigating, sending, or changing source', async () => {
    const core = bridge();
    await start(core); await app!.showDocument('other.md'); await open();
    const editor = view(), selection = editor.state.selection;
    const capture = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Entire chapter…'))!;
    expect(capture).toBeTruthy(); capture.click();
    await vi.waitFor(() => expect(panel().textContent).toContain('Entire chapter captured.'));
    expect(view()).toBe(editor); expect(view().state.selection).toBe(selection); expect(view().state.doc.toString()).toBe(original.replace(/\r\n/g, '\n'));
    expect(core.requestReview).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.applyProposalReview).not.toHaveBeenCalled();
    button('Run review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce());
    expect(core.requestReview.mock.calls[0][0]).toMatchObject({scope: 'chapter', snapshots: [{path: 'scene.md', source: original}, {path: 'other.md', source: original}]});
    expect(core.readDocument.mock.calls.some(call => call[1] === 'chapter.md')).toBe(false);
  });
  it('discards chapter capture if the active document changes while sources are loading', async () => {
    const core = bridge(); await start(core); await open();
    const loading = deferred<Awaited<ReturnType<typeof core.readDocument>>>();
    core.readDocument.mockReturnValueOnce(loading.promise);
    [...panel().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Entire chapter…'))!.click();
    await app!.showDocument('outside.md');
    loading.resolve({path: 'scene.md', text: original, contentHash: 'a'.repeat(64), sizeBytes: original.length, frontmatter: null, generatedCompatibility: false});
    await Promise.resolve(); await Promise.resolve();
    expect(core.requestReview).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled();
    expect(panel().hidden).toBe(true); expect(view().state.readOnly).toBe(false);
    await open(); expect(panel().textContent).not.toContain('Entire chapter…');
  });
  it('keeps scene review available when a chapter source cannot be read', async () => {
    const core = bridge(); await start(core); await open();
    core.readDocument.mockRejectedValueOnce(new Error('A source scene is missing.'));
    [...panel().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Entire chapter…'))!.click();
    await vi.waitFor(() => expect(panel().textContent).toContain('A source scene is missing.'));
    expect(core.requestReview).not.toHaveBeenCalled();
    button('Run review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce());
    expect(core.requestReview.mock.calls[0][0].scope).toBe('scene');
  });
  it('uses current drafting chapter order when there is no legacy manuscript', async () => {
    const core = bridge();
    const native = {...core, loadDrafting: vi.fn(async () => ({manifestPath: 'ms/manuscript.json', revision: 'current-draft', project: 'Synthetic', groups: [{id: 'chapter-a', title: 'Chapter A'}], scenes: [
      {id: 'two', title: 'Second', path: 'other.md', groupId: 'chapter-a'},
      {id: 'one', title: 'First', path: 'scene.md', groupId: 'chapter-a'},
      {id: 'outside', title: 'Outside', path: 'outside.md', groupId: null},
    ], untrackedPaths: [], missingPaths: []})), previewDraftingChange: vi.fn(), applyDraftingChange: vi.fn(), undoDraftingChange: vi.fn()};
    app = mountStudio(document.body, native); await app.selectRepository(async () => ({...session, manifests: []})); await app.showDocument('scene.md'); await open();
    const capture = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Entire chapter…'))!;
    expect(capture.textContent).toContain('Chapter A'); capture.click();
    await vi.waitFor(() => expect(panel().textContent).toContain('Entire chapter captured.'));
    button('Run review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce());
    expect(core.requestReview.mock.calls[0][0].snapshots.map(s => s.path)).toEqual(['other.md', 'scene.md']);
    expect(core.saveDocument).not.toHaveBeenCalled();
  });
  it('rejects assembled outputs in a chapter source mapping without partially replacing the scene scope', async () => {
    const core = bridge(); await start(core); await open();
    core.readDocument.mockResolvedValueOnce({path: 'scene.md', text: original, contentHash: 'a'.repeat(64), sizeBytes: original.length, frontmatter: null, generatedCompatibility: true});
    [...panel().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Entire chapter…'))!.click();
    await vi.waitFor(() => expect(panel().textContent).toContain('A chapter source is unavailable or is an assembled output.'));
    expect(core.requestReview).not.toHaveBeenCalled();
    button('Run review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce());
    expect(core.requestReview.mock.calls[0][0].scope).toBe('scene');
  });
  it('rejects disk drift rather than pairing the open editor text with a different saved hash', async () => {
    const core = bridge(); await start(core); await open();
    core.readDocument.mockResolvedValueOnce({path: 'scene.md', text: 'Changed on disk', contentHash: 'b'.repeat(64), sizeBytes: 15, frontmatter: null, generatedCompatibility: false});
    [...panel().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Entire chapter…'))!.click();
    await vi.waitFor(() => expect(panel().textContent).toContain('The open source changed on disk.'));
    expect(core.requestReview).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled();
    expect(view().state.doc.toString()).toBe(original.replace(/\r\n/g, '\n'));
  });
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
    expect([...document.querySelectorAll('.badge')].map(node=>node.textContent)).toContain('Source file · Editable Markdown');
    await open();
    expect(panel().textContent).toContain('This scene');
    expect(panel().textContent).toContain('Source file');
    expect(button('Preview review').disabled).toBe(false);
    button('Preview review').click();
    await vi.waitFor(() => expect(native.previewReview).toHaveBeenCalledOnce());
    expect(core.requestReview).not.toHaveBeenCalled();expect(core.saveDocument).not.toHaveBeenCalled();
    expect(native.previewReview.mock.calls[0][0]).toMatchObject({repositoryId: generic.id, scope: 'scene', snapshots: [{path, source: raw, sourceHash: 'a'.repeat(64)}], workflow: {reviewers: ['mechanical'], context: [], contextNote: ''}});
    expect(native.previewReview.mock.calls[0][0].snapshots[0].sceneId).toBeUndefined();
    button('Run review').click();await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce());
    expect(core.requestReview.mock.calls[0][0].snapshots[0].source).toBe(raw);
    expect(core.saveDocument).not.toHaveBeenCalled();expect(core.applyProposalReview).not.toHaveBeenCalled();
    app!.destroy();app = undefined;await mount();
    expect(core.requestReview).toHaveBeenCalledOnce();await open();
    await vi.waitFor(() => expect(button('Reopen saved review unmapped-review')).toBeTruthy());
    button('Reopen saved review unmapped-review').click();await vi.waitFor(() => expect(core.getReview).toHaveBeenCalledOnce());
    expect(core.requestReview).toHaveBeenCalledOnce();expect(native.previewReview).toHaveBeenCalledOnce();
    expect(core.saveDocument).not.toHaveBeenCalled();expect(core.applyProposalReview).not.toHaveBeenCalled();
  });
  it('previews and sends exact unsaved editor content only after explicit review, without implicit save', async () => {const core = bridge(); await start(core); view().dispatch({changes: {from: view().state.doc.length, insert: '\nUnsaved 🦊—fragment.'}}); await open(); expect(core.requestReview).not.toHaveBeenCalled(); expect(core.saveDocument).not.toHaveBeenCalled(); const expected = original + '\r\nUnsaved 🦊—fragment.'; expect(panel().textContent).toContain(expected); button('Run review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); expect(core.requestReview.mock.calls[0][0]).toMatchObject({repositoryId: session.id, scope: 'scene', snapshots: [{path: 'scene.md', source: expected, sourceHash: 'a'.repeat(64)}]}); expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.applyProposalReview).not.toHaveBeenCalled();});
  it('keeps author editing and manual save usable while a review is pending', async () => {const core = bridge(); const pending = deferred<ReviewResult>(); core.requestReview.mockReturnValueOnce(pending.promise); await start(core); await open(); button('Run review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); expect(view().state.readOnly).toBe(false); view().dispatch({changes: {from: view().state.doc.length, insert: '!'}}); await app!.saveCurrent(); expect(core.saveDocument).toHaveBeenCalledOnce(); const request = core.requestReview.mock.calls[0][0]; pending.resolve(result(request)); await Promise.resolve(); expect(view().state.doc.toString()).toContain('Last line!'); expect(core.applyProposalReview).not.toHaveBeenCalled();});
  it('keeps a captured review running across scene navigation and opens its completed results', async () => {
    const core=bridge(), pending=deferred<ReviewResult>(); core.requestReview.mockReturnValueOnce(pending.promise);
    await start(core); await open(); button('Run review').click(); await vi.waitFor(()=>expect(core.requestReview).toHaveBeenCalledOnce());
    const request=core.requestReview.mock.calls[0][0]; await app!.showDocument('other.md');
    expect(core.cancelQuestion).not.toHaveBeenCalled(); expect(panel().hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.review-background')!.hidden).toBe(false);
    expect(document.querySelector('.review-activity-button')!.textContent).toContain('Review in progress');
    pending.resolve(result(request)); await vi.waitFor(()=>expect(document.querySelector('.review-completion-toast')!.textContent).toContain('Review complete.'));
    expect(document.querySelector<HTMLElement>('.review-completion-toast')!.hidden).toBe(false);
    button('Open review').click(); expect(panel().hidden).toBe(false); expect(panel().textContent).toContain('Review ready.');
    expect(core.requestReview).toHaveBeenCalledOnce(); expect(core.applyProposalReview).not.toHaveBeenCalled();
  });
  it('clears and cancels pending review on repository navigation', async () => {const core = bridge(); const pending = deferred<ReviewResult>(); core.requestReview.mockReturnValueOnce(pending.promise); await start(core); await open(); button('Run review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); const request = core.requestReview.mock.calls[0][0]; await app!.selectRepository(async () => ({...session, id: 'another-repository'})); expect(core.cancelQuestion).toHaveBeenCalledWith(request.requestId); expect(panel().hidden).toBe(true); pending.resolve(result(request)); await Promise.resolve(); expect(panel().textContent).not.toContain(original);});
  it('captures ordered source scenes for assembled chapter review, never the generated export', async () => {const core = bridge(); await start(core); await app!.showDocument('chapter.md'); expect(view().state.readOnly).toBe(false); await open(); expect(core.requestReview).not.toHaveBeenCalled(); button('Run review').click(); await vi.waitFor(() => expect(core.requestReview).toHaveBeenCalledOnce()); const request = core.requestReview.mock.calls[0][0]; expect(request.scope).toBe('chapter'); expect(request.snapshots.map(snapshot => snapshot.path)).toEqual(['scene.md', 'other.md']); expect(request.snapshots.map(snapshot => snapshot.source)).toEqual([original, original]); expect(core.readDocument.mock.calls.some(call => call[1] === 'chapter.md')).toBe(false); expect(core.saveDocument).not.toHaveBeenCalled();});
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
    await start(native); await open(); button('Run review').click(); await vi.waitFor(() => expect(button('Accept…').disabled).toBe(false));
    for (let index = 0; index < 2; index++) {
      button('Accept…').click(); await vi.waitFor(() => expect(document.querySelector('[aria-label="Review whole-scene proposal"]')).not.toBeNull());
      expect(native.applyProposalReview).toHaveBeenCalledTimes(index); expect(native.saveDocument).not.toHaveBeenCalled();
      const comparison = document.querySelector('[aria-label="Review whole-scene proposal"]')!; expect(comparison.textContent).toContain('Native OpenAI suggestion'); expect(comparison.querySelector('pre')!.textContent).toBe(disk);
      button('Continue to native confirmation').click(); await vi.waitFor(() => expect(native.getReview).toHaveBeenCalledTimes(index + 1));
      expect(panel().hidden).toBe(false); expect(native.applyProposalReview).toHaveBeenCalledTimes(index + 1); expect(view().state.doc.toString()).toBe(disk.replace(/\r\n/g, '\n'));
    }
    expect(disk).toContain('paragraph'); expect(disk).toContain('Final line'); expect(native.saveDocument).not.toHaveBeenCalled();
    expect(panel().querySelectorAll('button[data-edit-action="accept"]')).toHaveLength(0);
  });

  describe('inline suggestion marks', () => {
    const at = (text: string, word: string) => new TextEncoder().encode(text.slice(0, text.indexOf(word))).length;
    const edit = (path: string, word: string): ReviewResult['edits'][number] => ({id: `${path}-${word}`, path, fromUtf8: at(original, word), toUtf8: at(original, word) + new TextEncoder().encode(word).length, original: word, replacement: 'new', reason: 'Synthetic', role: 'editor', status: 'pending', proposalId: null});
    const run = async (core: ReturnType<typeof bridge>, edits: ReviewResult['edits']) => {core.requestReview.mockImplementation(async request => ({...result(request), edits})); await open(); button('Run review').click(); await vi.waitFor(() => expect(panel().querySelectorAll('.review-edit').length).toBe(edits.length));};
    const words = () => reviewMarksIn(view().state).map(mark => view().state.sliceDoc(mark.from, mark.to));
    it('marks a source file only for its own path and exact text', async () => {
      const core = bridge(); await start(core);
      await run(core, [edit('scene.md', 'passage')]);
      expect(words()).toEqual(['passage']);
      expect(view().state.doc.toString()).toBe(original.replace(/\r\n/g, '\n'));
      expect(core.saveDocument).not.toHaveBeenCalled();
    });
    it('maps an assembled chapter part to its own body, keeping the right scene and skipping frontmatter', async () => {
      const core = bridge(); await start(core); await app!.showDocument('chapter.md');
      await run(core, [edit('other.md', 'passage'), edit('scene.md', 'Exact')]);
      const marks = reviewMarksIn(view().state);
      expect(marks.map(mark => mark.id)).toEqual(['other.md-passage']);
      const body = 'A 🐺 passage.\nLast line';
      expect(view().state.doc.toString()).toBe(`${body}\n\n---\n\n${body}`);
      expect(marks[0].from).toBe(body.length + 7 + body.indexOf('passage'));
    });
    it('clears on a typed edit and does not return until a refreshed review proves the match', async () => {
      const core = bridge(); await start(core);
      await run(core, [edit('scene.md', 'passage')]);
      view().dispatch({changes: {from: 0, insert: 'x'}});
      expect(reviewMarksIn(view().state)).toEqual([]);
      expect(panel().textContent).toContain('Highlights are off because the open text changed');
    });
    it('marks nothing over unsaved text at review time', async () => {
      const core = bridge(); await start(core);
      view().dispatch({changes: {from: view().state.doc.length, insert: '!'}});
      await run(core, [edit('scene.md', 'passage')]);
      expect(reviewMarksIn(view().state)).toEqual([]);
    });
    it('clears when the review closes, and a new document starts without marks', async () => {
      const core = bridge(); await start(core);
      await run(core, [edit('scene.md', 'passage')]);
      button('Discard review').click();
      expect(reviewMarksIn(view().state)).toEqual([]);
      await open(); button('Run review').click(); await vi.waitFor(() => expect(reviewMarksIn(view().state)).toHaveLength(1));
      await app!.showDocument('other.md');
      expect(reviewMarksIn(view().state)).toEqual([]);
      expect(panel().hidden).toBe(true);
    });
    it('clears when the repository changes, without touching the document', async () => {
      const core = bridge(); await start(core);
      await run(core, [edit('scene.md', 'passage')]);
      const text = view().state.doc.toString();
      core.readDocument.mockImplementation(async () => { throw new Error('Synthetic read failure'); });
      await app!.selectRepository(async () => ({...session, id: 'another-repository'})).catch(() => {});
      expect(panel().hidden).toBe(true);
      const remaining = document.querySelector('.cm-editor');
      if (remaining) expect(reviewMarksIn(view().state)).toEqual([]);
      expect(text).toContain('passage');
      expect(core.saveDocument).not.toHaveBeenCalled();
    });
  });

});
