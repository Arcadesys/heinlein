// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createQuestionPanel, questionBytes} from './questionPanel';
import type {LocalCore, QuestionRequest, QuestionRevisionAnswer, QuestionStatus} from './localCore';
import type {SelectionQuestionState} from './selectionQuestion';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
const ready: QuestionStatus = {configured: true, model: 'mock-model', message: 'Ready.', accounts: [{id: 'opaque', label: 'Writer', signedIn: true, planEnabled: true}], activeAccountId: 'opaque', models: [{slug: 'mock-model', displayName: 'Mock'}], selectedModel: 'mock-model', signInPending: false, generation: 1, usageLimited: false};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
const origin = {kind: 'nativeOpenAi' as const, sessionId: '', clientLabel: '', identityAssurance: 'unverifiedProviderMetadata' as const, provider: 'openai' as const, model: 'mock-model', requestId: 'request'};
function answer(request: QuestionRequest): QuestionRevisionAnswer {return {requestId: request.requestId, text: 'A suggested change, with reasoning.', model: 'mock-model', incomplete: false, proposalId: 'proposal-1', replacementText: 'A different 🐺 passage.'};}
function core() {return {
  available: () => true, questionStatus: vi.fn(async () => ready), cancelQuestion: vi.fn(async () => true),
  askQuestion: vi.fn(async (request: QuestionRequest) => ({requestId: request.requestId, text: 'Advice only', model: 'mock-model', incomplete: false})),
  suggestQuestionRevision: vi.fn(async (request: QuestionRequest) => answer(request)),
  rejectProposal: vi.fn(async (_repositoryId: string, proposalId: string) => ({id: 'rejection-1', kind: 'reject' as const, status: 'rejected' as const, proposalId, path: 'scene.md', baseHash: 'base', replacementHash: 'new', diffHash: 'diff', origin, createdAtMs: 1, parentReceiptId: null, message: null, revertAvailable: false})),
};}
let panel: ReturnType<typeof createQuestionPanel>;
let state: SelectionQuestionState;
let unavailable: string | null;
const review = vi.fn(async (_id: string, _snapshot: unknown, _guard: () => string | null) => {});
const prepare = vi.fn(async () => {});
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent === name)!;
function write(value = 'Please clarify this passage') {const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Your drafting question"]')!; field.value = value; field.dispatchEvent(new Event('input'));}
function mode(value: 'ask' | 'revision') {const select = document.querySelector<HTMLSelectElement>('[aria-label="Response mode"]')!; select.value = value; select.dispatchEvent(new Event('change'));}
async function start(bridge = core()) {
  panel = createQuestionPanel(bridge as unknown as LocalCore, {current: () => ({...state, canCapture: true}), selectionState: () => state, revisionUnavailable: () => unavailable, prepareRevision: prepare, reviewRevision: review, focusEditor: vi.fn()});
  document.body.append(panel.element); panel.open(); await vi.waitFor(() => expect(button('Recheck OpenAI setup').disabled).toBe(false)); return bridge;
}
async function sendRevision() {mode('revision'); write(); button('Send to OpenAI').click(); await vi.waitFor(() => expect(button('Review suggested revision')).toBeDefined());}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); document.body.replaceChildren(); review.mockClear(); prepare.mockReset(); prepare.mockResolvedValue(); unavailable = null;
  const source = 'Before\r\nA 🐺 passage.\r\nAfter';
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  state = {repositoryId: 'repo', path: 'scene.md', sceneId: 'scene', documentEpoch: 4, revision: 7, source, sourceHash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''), from: 8, to: source.indexOf('\r\nAfter'), readOnly: false, recoveryPending: false, busy: false, detached: false};
});
afterEach(() => {panel?.destroy(); vi.unstubAllGlobals();});

describe('explicit revision requests', () => {
  it('keeps ordinary Ask as attributed advice and never calls the revision command', async () => {
    const bridge = core(); bridge.askQuestion.mockImplementation(async request => ({...answer(request), text: 'Advice only'})); await start(bridge); write(); button('Send to OpenAI').click(); await vi.waitFor(() => expect(panel.element.textContent).toContain('Advice only'));
    expect(bridge.askQuestion).toHaveBeenCalledTimes(1); expect(bridge.suggestQuestionRevision).not.toHaveBeenCalled(); expect(button('Review suggested revision')).toBeUndefined();
    expect(panel.element.textContent).toContain('Recorded origin: native OpenAI'); expect(panel.element.textContent).toContain('not authenticated authorship');
  });
  it('previews exact target separately and sends only bounded optional context with a saved UTF-8 binding', async () => {
    const bridge = await start(); button('Capture current scene').click(); mode('revision'); write();
    expect(document.querySelector('[aria-label="Exact context to send"]')!.textContent).toBe('');
    expect(document.querySelector('[aria-label="Exact revision target"]')!.textContent).toBe('A 🐺 passage.');
    expect(bridge.suggestQuestionRevision).not.toHaveBeenCalled(); button('Send to OpenAI').click(); await vi.waitFor(() => expect(bridge.suggestQuestionRevision).toHaveBeenCalledTimes(1));
    const [request, connection, target] = (bridge.suggestQuestionRevision.mock.calls[0] as unknown as [QuestionRequest, unknown, unknown]);
    expect(request.context).toBe(''); expect(request.history).toEqual([]);
    expect(connection).toEqual({generation: 1, accountId: 'opaque', model: 'mock-model'});
    expect(target).toEqual({repositoryId: 'repo', path: 'scene.md', sourceHash: state.sourceHash, fromUtf8: 8, toUtf8: questionBytes(state.source.slice(0, state.to)), selectedText: 'A 🐺 passage.'});
    expect(prepare).toHaveBeenCalledTimes(1); expect(bridge.askQuestion).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
  it('never carries prior advice into revision history and requires explicit review', async () => {
    const bridge = await start(); write(); button('Send to OpenAI').click(); await vi.waitFor(() => expect(panel.element.textContent).toContain('Advice only'));
    await sendRevision(); expect(bridge.suggestQuestionRevision.mock.calls[0][0].history).toEqual([]);
    expect(panel.element.textContent).toContain('Revision requests include no conversation history');
    expect(document.querySelector('[aria-label="Suggested replacement 2"]')!.textContent).toBe('A different 🐺 passage.'); expect(review).not.toHaveBeenCalled();
    button('Review suggested revision').click(); await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    expect(review.mock.calls[0][0]).toBe('proposal-1'); expect(review.mock.calls[0][2]()).toBeNull();
  });
  it('blocks dirty saved-source requests while ordinary Ask remains available', async () => {
    const bridge = await start(); unavailable = 'Save your scene first.'; mode('revision'); write();
    expect(button('Send to OpenAI').disabled).toBe(true); expect(panel.element.textContent).toContain('Save your scene first');
    mode('ask'); expect(button('Send to OpenAI').disabled).toBe(false); button('Send to OpenAI').click(); expect(bridge.askQuestion).toHaveBeenCalledTimes(1); expect(bridge.suggestQuestionRevision).not.toHaveBeenCalled();
  });
  it.each(['source', 'selection', 'undo', 'scene', 'hash'] as const)('prevents promotion after %s changes, preserving explanation and Reject', async change => {
    const bridge = await start(); await sendRevision();
    if (change === 'source') state.source += ' newer';
    if (change === 'selection') state.to--;
    if (change === 'undo') state.revision += 2;
    if (change === 'scene') state.documentEpoch++;
    if (change === 'hash') state.sourceHash = 'different';
    panel.stateChanged(); expect(button('Review suggested revision').disabled).toBe(true); button('Review suggested revision').click(); expect(review).not.toHaveBeenCalled();
    expect(panel.element.textContent).toContain('A suggested change, with reasoning.'); expect(button('Reject suggested revision').disabled).toBe(false);
    button('Reject suggested revision').click(); await vi.waitFor(() => expect(bridge.rejectProposal).toHaveBeenCalledWith('repo', 'proposal-1'));
  });
  it('invalidates review when context is recaptured and records explicit rejection only once', async () => {
    const bridge = await start(); await sendRevision(); button('Capture current scene').click(); expect(button('Review suggested revision').disabled).toBe(true);
    button('Reject suggested revision').click(); button('Reject suggested revision').click(); await vi.waitFor(() => expect(panel.element.textContent).toContain('rejection-1'));
    expect(bridge.rejectProposal).toHaveBeenCalledTimes(1); expect(button('Reject suggested revision').disabled).toBe(true); expect(review).not.toHaveBeenCalled();
  });
  it('waits for local preparation and rejects edit/undo before provider dispatch', async () => {
    const waiting = deferred<void>(); prepare.mockReturnValueOnce(waiting.promise); const bridge = await start(); mode('revision'); write(); button('Send to OpenAI').click();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled()); state.revision += 2; waiting.resolve();
    await vi.waitFor(() => expect(button('Cancel request').hidden).toBe(true)); expect(bridge.suggestQuestionRevision).not.toHaveBeenCalled(); expect(panel.element.textContent).toContain('scene changed');
  });
  it.each(['close', 'cancel', 'clear'] as const)('ignores a prepared revision after %s', async action => {
    const waiting = deferred<void>(); prepare.mockReturnValueOnce(waiting.promise); const bridge = await start(); mode('revision'); write(); button('Send to OpenAI').click(); await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    button(action === 'close' ? 'Close questions' : action === 'cancel' ? 'Cancel request' : 'Clear conversation').click(); waiting.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(bridge.suggestQuestionRevision).not.toHaveBeenCalled(); expect(button('Review suggested revision')).toBeUndefined();
  });
  it('keeps a late stale suggestion readable without enabling review or automatic replacement', async () => {
    const bridge = core(); const result = deferred<QuestionRevisionAnswer>(); bridge.suggestQuestionRevision.mockReturnValueOnce(result.promise); await start(bridge); mode('revision'); write(); button('Send to OpenAI').click();
    await vi.waitFor(() => expect(bridge.suggestQuestionRevision).toHaveBeenCalledTimes(1)); state.source += ' new draft'; state.revision++; panel.stateChanged();
    result.resolve(answer(bridge.suggestQuestionRevision.mock.calls[0][0])); await vi.waitFor(() => expect(button('Review suggested revision')).toBeDefined());
    expect(button('Review suggested revision').disabled).toBe(true); expect(panel.element.textContent).toContain('A suggested change, with reasoning.'); expect(state.source).toContain('new draft'); expect(review).not.toHaveBeenCalled();
  });
  it('reports a native commit already finishing and ignores its late response after local cancellation', async () => {
    const bridge = core(); const waiting = deferred<QuestionRevisionAnswer>(); bridge.suggestQuestionRevision.mockReturnValueOnce(waiting.promise); bridge.cancelQuestion.mockResolvedValueOnce(false);
    await start(bridge); mode('revision'); write(); button('Send to OpenAI').click(); await vi.waitFor(() => expect(bridge.suggestQuestionRevision).toHaveBeenCalledTimes(1));
    button('Cancel request').click(); await vi.waitFor(() => expect(panel.element.textContent).toContain('already finishing'));
    expect(panel.element.textContent).toContain('check Revision proposals'); waiting.resolve(answer(bridge.suggestQuestionRevision.mock.calls[0][0])); await Promise.resolve(); expect(button('Review suggested revision')).toBeUndefined();
  });
  it('reports unconfirmed rejection without changing attribution or retrying automatically', async () => {
    const bridge = core(); bridge.rejectProposal.mockRejectedValueOnce(new Error('write unavailable')); await start(bridge); await sendRevision(); button('Reject suggested revision').click();
    await vi.waitFor(() => expect(panel.element.textContent).toContain('Rejection could not be confirmed')); expect(bridge.rejectProposal).toHaveBeenCalledTimes(1); expect(review).not.toHaveBeenCalled();
    expect(panel.element.textContent).toContain('native OpenAI');
  });
  it('does not restore rejected proposal text after closing during the native decision', async () => {
    const bridge = core(); const waiting = deferred<Awaited<ReturnType<typeof bridge.rejectProposal>>>(); const receipt = await bridge.rejectProposal('repo', 'proposal-1'); bridge.rejectProposal.mockReturnValueOnce(waiting.promise);
    await start(bridge); await sendRevision(); button('Reject suggested revision').click(); button('Close questions').click(); waiting.resolve(receipt); await Promise.resolve();
    expect(panel.element.textContent).not.toContain('A different 🐺 passage.'); expect(panel.element.textContent).not.toContain('rejection-1');
  });
  it('rejects mismatched saved hashes and oversized total payloads before dispatch', async () => {
    const bridge = await start(); state.sourceHash = 'wrong'; mode('revision'); write(); button('Send to OpenAI').click();
    await vi.waitFor(() => expect(panel.element.textContent).toContain('does not match its saved hash')); expect(bridge.suggestQuestionRevision).not.toHaveBeenCalled();
    state.source = 'x'.repeat(16000); state.from = 0; state.to = 16000; button('Capture revision selection').click(); button('Capture current scene').click(); write('q');
    expect(button('Send to OpenAI').disabled).toBe(true); expect(button('Send to OpenAI').title).toContain('32,000');
  });
  it('marks an explicitly empty replacement as a deletion that still requires review', async () => {
    const bridge = core(); bridge.suggestQuestionRevision.mockImplementation(async request => ({...answer(request), replacementText: ''})); await start(bridge); await sendRevision();
    expect(document.querySelector('[aria-label="Suggested replacement 1"]')!.textContent).toBe(''); expect(panel.element.textContent).toContain('will delete the selected passage'); expect(review).not.toHaveBeenCalled();
  });
  it('bounds visible conversation text including original revision targets and replacements', async () => {
    state.source = 'x'.repeat(16000); state.from = 0; state.to = state.source.length;
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(state.source)); state.sourceHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const bridge = core(); bridge.suggestQuestionRevision.mockImplementation(async request => ({...answer(request), text: 'e'.repeat(10000), replacementText: 'r'.repeat(1000)})); await start(bridge); mode('revision');
    for (let index = 0; index < 3; index++) {write(`Revision ${index}`); button('Send to OpenAI').click(); await vi.waitFor(() => expect(bridge.suggestQuestionRevision).toHaveBeenCalledTimes(index + 1)); await vi.waitFor(() => expect(button('Cancel request').hidden).toBe(true));}
    expect(document.querySelectorAll('.question-turn')).toHaveLength(2); expect(panel.element.textContent).not.toContain('Revision 0');
  });
  it('rejects incomplete or invalid revision results without offering review', async () => {
    const bridge = core(); bridge.suggestQuestionRevision.mockImplementation(async request => ({...answer(request), incomplete: true})); await start(bridge); mode('revision'); write(); button('Send to OpenAI').click();
    await vi.waitFor(() => expect(panel.element.textContent).toContain('revision response was incomplete')); expect(button('Review suggested revision')).toBeUndefined();
  });
});
