// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import type {LocalCore, QuestionAnswer, QuestionRequest, RecoveryDraft} from './localCore';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
const original = '---\r\ntitle: Exact\r\n---\r\nA 🐺 passage.\r\nLast line';
const session = {id: 'session', name: 'Synthetic', manifests: []};
let app: ReturnType<typeof mountStudio> | undefined;
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
function core() {
  let draft: RecoveryDraft | null = null;
  const doc = (path: string, text = original) => ({path, text, contentHash: 'a'.repeat(64), sizeBytes: new TextEncoder().encode(text).length, frontmatter: null, generatedCompatibility: false});
  return {
    available: () => true, recentRepositories: vi.fn(async () => []), pickRepository: vi.fn(async () => session),
    openRecentRepository: vi.fn(async () => session), listDirectory: vi.fn(async () => []), listSystemFonts: vi.fn(async () => []),
    loadManuscript: vi.fn(async () => {throw new Error('No manuscript');}), readDocument: vi.fn(async (_id, path) => doc(path)),
    readRecovery: vi.fn(async () => draft), stageRecovery: vi.fn(async (_id, path, baseHash, text) => {draft = {id: 'draft', path, baseHash, text, updatedAt: 0}; return draft;}),
    discardRecovery: vi.fn(async () => {draft = null;}), saveDocument: vi.fn(async (_id, path, _hash, text) => doc(path, text)),
    setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
    questionStatus: vi.fn(async () => ({configured: true, model: 'mock-model', message: 'Mock OpenAI ready.', accounts: [{id: 'account-1', label: 'Mock writer', signedIn: true, planEnabled: true}], activeAccountId: 'account-1', models: [{slug: 'mock-model', displayName: 'Mock model'}], selectedModel: 'mock-model', signInPending: false, generation: 1, usageLimited: false})),
    askQuestion: vi.fn(async (request: QuestionRequest): Promise<QuestionAnswer> => ({requestId: request.requestId, text: 'Read-only mock advice', model: 'mock-model', incomplete: false})),
    cancelQuestion: vi.fn(async (_requestId: string) => true),
  } satisfies LocalCore;
}
function button(label: string) {const found = [...document.querySelectorAll('button')].find(node => node.textContent === label); if (!found) throw new Error(`Missing ${label}`); return found;}
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
const panel = () => document.querySelector<HTMLElement>('[aria-label="Drafting questions"]')!;
function question(value: string) {const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Your drafting question"]')!; input.value = value; input.dispatchEvent(new Event('input', {bubbles: true}));}
async function start(bridge: LocalCore) {app = mountStudio(document.body, bridge); await app.selectRepository(async () => session); await app.showDocument('scene.md');}
async function open() {button('Questions').click(); await vi.waitFor(() => expect(button('Recheck OpenAI setup').disabled).toBe(false));}
async function highlight(from: number, to: number) {
  vi.spyOn(view().dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 600, 500));
  vi.spyOn(view(), 'coordsAtPos').mockReturnValue({top: 200, bottom: 220, left: 200, right: 201});
  view().focus(); view().dispatch({selection: {anchor: from, head: to}});
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.selection-ask-action')!.hidden).toBe(false));
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear(); document.body.replaceChildren();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {app?.destroy(); app = undefined; vi.unstubAllGlobals();});

describe('Studio in-app drafting questions', () => {
  it('keeps editing, manual save, and autosave available during a pending request', async () => {
    const bridge = core(); const response = deferred<QuestionAnswer>(); bridge.askQuestion.mockReturnValueOnce(response.promise);
    await start(bridge); await open(); button('Capture current scene').click(); question('What next?'); button('Send to OpenAI').click();
    expect(document.querySelector('dialog[open]')).toBeNull(); expect(panel().tagName).toBe('ASIDE'); expect(view().state.readOnly).toBe(false);
    button('Return to writing').click(); expect(document.activeElement).toBe(view().contentDOM);
    view().dispatch({changes: {from: view().state.doc.length, insert: '\nAuthor keeps writing.'}});
    expect(button('Save').disabled).toBe(false); button('Save').click();
    await vi.waitFor(() => expect(bridge.saveDocument).toHaveBeenCalledTimes(1));
    expect(bridge.saveDocument.mock.calls[0][3]).toBe(original + '\r\nAuthor keeps writing.');
    view().dispatch({changes: {from: view().state.doc.length, insert: ' More.'}});
    await vi.waitFor(() => expect(bridge.saveDocument).toHaveBeenCalledTimes(2), {timeout: 2500});
    expect(bridge.stageRecovery).toHaveBeenCalledTimes(2); expect(bridge.askQuestion).toHaveBeenCalledTimes(1);
    expect(bridge.askQuestion.mock.calls[0][0].context).toBe(original);
    view().focus(); const textBefore = view().state.doc.toString();
    const request = bridge.askQuestion.mock.calls[0][0]; response.resolve({requestId: request.requestId, text: 'Provider proposes a completely different scene.', model: 'mock-model', incomplete: false});
    await vi.waitFor(() => expect(panel().textContent).toContain('Answer ready'));
    expect(view().state.doc.toString()).toBe(textBefore); expect(document.activeElement).toBe(view().contentDOM);
    expect(bridge.saveDocument).toHaveBeenCalledTimes(2);
  });
  it('maps the selected passage to exact raw CRLF/Unicode context', async () => {
    const bridge = core(); await start(bridge); const text = view().state.doc.toString(); const from = text.indexOf('🐺');
    view().dispatch({selection: {anchor: from, head: text.length}}); await open(); button('Capture selected text').click(); question('About this passage'); button('Send to OpenAI').click();
    await vi.waitFor(() => expect(bridge.askQuestion).toHaveBeenCalledTimes(1));
    expect(bridge.askQuestion.mock.calls[0][0].context).toBe('🐺 passage.\r\nLast line');
    expect(bridge.readDocument).toHaveBeenCalledTimes(1); expect(bridge.saveDocument).not.toHaveBeenCalled();
  });
  it('cancels and clears private context/history on scene and repository navigation', async () => {
    const bridge = core(); const first = deferred<QuestionAnswer>(); bridge.askQuestion.mockReturnValueOnce(first.promise); await start(bridge); await open();
    button('Capture current scene').click(); question('Private old scene question'); button('Send to OpenAI').click(); const request1 = bridge.askQuestion.mock.calls[0][0];
    await app!.showDocument('other.md'); expect(panel().hidden).toBe(true); expect(panel().textContent).not.toContain('Private old scene question');
    expect(panel().textContent).not.toContain('A 🐺 passage.'); expect(bridge.cancelQuestion).toHaveBeenCalledWith(request1.requestId);
    first.resolve({requestId: request1.requestId, text: 'Late old scene answer', model: 'mock-model', incomplete: false}); await Promise.resolve();
    await open(); expect(panel().textContent).not.toContain('Late old scene answer');
    const second = deferred<QuestionAnswer>(); bridge.askQuestion.mockReturnValueOnce(second.promise); question('Old repository question'); button('Send to OpenAI').click(); const request2 = bridge.askQuestion.mock.calls[1][0];
    await app!.selectRepository(async () => ({...session, id: 'different-session'})); expect(bridge.cancelQuestion).toHaveBeenCalledWith(request2.requestId);
    second.resolve({requestId: request2.requestId, text: 'Late other repository answer', model: 'mock-model', incomplete: false}); await Promise.resolve();
    await app!.showDocument('next.md'); await open(); expect(panel().textContent).not.toContain('Late other repository answer'); expect(panel().textContent).toContain('No manuscript text will be sent');
  });
  it('keeps local drafting and save usable when OpenAI is unconfigured', async () => {
    const bridge = core(); bridge.questionStatus.mockResolvedValue({...await bridge.questionStatus(), configured: false, model: '', message: 'OpenAI is not configured.'}); await start(bridge); await open();
    question('A question'); expect(button('Send to OpenAI').disabled).toBe(true); expect(panel().textContent).toContain('not configured');
    view().dispatch({changes: {from: view().state.doc.length, insert: '!'}}); await app!.saveCurrent();
    expect(bridge.saveDocument).toHaveBeenCalledTimes(1); expect(bridge.askQuestion).not.toHaveBeenCalled();
  });
  it('supports keyboard close/return without changing the selection or intercepting editor Escape', async () => {
    const bridge = core(); await start(bridge); const from = view().state.doc.toString().indexOf('🐺');
    view().dispatch({selection: {anchor: from, head: from + 2}}); await open(); expect(button('Questions').getAttribute('aria-expanded')).toBe('true');
    button('Return to writing').click(); expect(document.activeElement).toBe(view().contentDOM);
    view().contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); expect(panel().hidden).toBe(false);
    const selectionBeforeClose = view().state.selection.main;
    document.querySelector('textarea[aria-label="Your drafting question"]')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(panel().hidden).toBe(true); expect(document.activeElement).toBe(view().contentDOM); expect(view().state.selection.main).toEqual(selectionBeforeClose);
    expect(button('Questions').getAttribute('aria-expanded')).toBe('false'); expect(bridge.askQuestion).not.toHaveBeenCalled();
  });
  it('offers contextual Ask Heinlein and captures exact highlighted bytes without sending', async () => {
    const bridge = core(); await start(bridge); const text = view().state.doc.toString(); const from = text.indexOf('🐺'); await highlight(from, text.length);
    const action = document.querySelector<HTMLButtonElement>('.selection-ask-action')!; const before = view().state.selection;
    const pointer = new MouseEvent('pointerdown', {button: 0, bubbles: true, cancelable: true}); action.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true); expect(document.activeElement).toBe(view().contentDOM); expect(view().state.selection).toBe(before);
    action.click(); await vi.waitFor(() => expect(panel().hidden).toBe(false));
    expect(document.querySelector('[aria-label="Exact context to send"]')!.textContent).toBe('🐺 passage.\r\nLast line');
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Your drafting question"]'));
    expect(bridge.askQuestion).not.toHaveBeenCalled(); expect(bridge.saveDocument).not.toHaveBeenCalled(); expect(bridge.readDocument).toHaveBeenCalledTimes(1);
    expect(view().state.doc.toString()).toBe(text);
  });
  it('provides a toolbar and keyboard fallback for asking about the selection', async () => {
    const bridge = core(); await start(bridge); await highlight(0, 3);
    expect(button('Ask Heinlein about selection').disabled).toBe(false);
    const key = new KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, altKey: true, bubbles: true, cancelable: true}); view().contentDOM.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true); await vi.waitFor(() => expect(panel().hidden).toBe(false));
    expect(document.querySelector('[aria-label="Exact context to send"]')!.textContent).toBe('---'); expect(bridge.askQuestion).not.toHaveBeenCalled();
  });
  it.each(['selection', 'scene', 'close', 'clear'] as const)('discards an asynchronous selection capture after %s invalidation', async change => {
    const bridge = core(); await start(bridge); if (change === 'close' || change === 'clear') await open(); await highlight(0, 3);
    const digest = deferred<ArrayBuffer>(); vi.stubGlobal('crypto', {subtle: {digest: vi.fn(() => digest.promise)}, randomUUID: webcrypto.randomUUID.bind(webcrypto)});
    document.querySelector<HTMLButtonElement>('.selection-ask-action')!.click();
    if (change === 'scene') await app!.showDocument('other.md'); else if (change === 'close') button('Close questions').click(); else if (change === 'clear') button('Clear conversation').click(); else view().dispatch({selection: {anchor: 4, head: 7}});
    digest.resolve(new ArrayBuffer(32)); await new Promise(resolve => setTimeout(resolve, 20));
    expect(panel().hidden).toBe(change !== 'clear'); expect(bridge.askQuestion).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Exact context to send"]')!.textContent).toBe('');
    expect(document.querySelectorAll('.selection-ask-action')).toHaveLength(1);
  });
  it('captures a new selection into an existing panel, cancels its old request, and ignores late text', async () => {
    const bridge = core(); const response = deferred<QuestionAnswer>(); bridge.askQuestion.mockReturnValueOnce(response.promise);
    await start(bridge); await open(); question('Earlier question'); button('Send to OpenAI').click(); const request = bridge.askQuestion.mock.calls[0][0];
    await highlight(0, 3); document.querySelector<HTMLButtonElement>('.selection-ask-action')!.click();
    await vi.waitFor(() => expect(bridge.cancelQuestion).toHaveBeenCalledWith(request.requestId));
    expect(document.querySelector('[aria-label="Exact context to send"]')!.textContent).toBe('---'); expect(panel().textContent).toContain('may still count toward plan usage');
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Your drafting question"]')); expect(bridge.askQuestion).toHaveBeenCalledTimes(1);
    response.resolve({requestId: request.requestId, text: 'Old request answer', model: 'mock-model', incomplete: false}); await Promise.resolve();
    expect(panel().textContent).not.toContain('Old request answer'); expect(view().state.doc.toString()).toBe(original.replace(/\r\n/g, '\n'));
  });
  it('rejects context above 16,000 UTF-8 bytes before opening or hashing without truncation', async () => {
    const bridge = core(); await start(bridge); view().dispatch({changes: {from: 0, to: view().state.doc.length, insert: '🐺'.repeat(4001)}});
    await highlight(0, view().state.doc.length); const digest = vi.fn(); vi.stubGlobal('crypto', {subtle: {digest}, randomUUID: webcrypto.randomUUID.bind(webcrypto)});
    document.querySelector<HTMLButtonElement>('.selection-ask-action')!.click();
    expect(panel().hidden).toBe(true); expect(document.querySelector('.status')!.textContent).toContain('16,000 UTF-8 bytes');
    expect(digest).not.toHaveBeenCalled(); expect(bridge.askQuestion).not.toHaveBeenCalled();
  });
});

async function revisionCore() {
  const bridge = core(); const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(original));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  bridge.readDocument.mockImplementation(async (_id, path) => ({path, text: original, contentHash: hash, sizeBytes: new TextEncoder().encode(original).length, frontmatter: null, generatedCompatibility: false}));
  const origin = {kind: 'nativeOpenAi' as const, sessionId: '', clientLabel: '', identityAssurance: 'unverifiedProviderMetadata' as const, provider: 'openai' as const, model: 'mock-model', requestId: 'native-request'};
  const review = {id: 'review', proposalId: 'proposal', kind: 'apply' as const, path: 'scene.md', baseHash: hash, replacementHash: 'replacement', diffHash: 'diff', baseText: original, replacementText: original.replace('🐺 passage.', 'new passage.'), origin, parentReceiptId: null, expiresAtMs: Date.now() + 300000};
  const receipt = {id: 'receipt', kind: 'reject' as const, status: 'rejected' as const, proposalId: 'proposal', path: 'scene.md', baseHash: hash, replacementHash: 'replacement', diffHash: 'diff', origin, parentReceiptId: null, message: null, createdAtMs: 1, revertAvailable: false};
  return {...bridge,
    suggestQuestionRevision: vi.fn(async (request: QuestionRequest) => ({requestId: request.requestId, text: 'Proposed explanation', model: 'mock-model', incomplete: false, proposalId: 'proposal', replacementText: 'new passage.'})),
    rejectProposal: vi.fn(async () => receipt), listProposals: vi.fn(async () => ({pending: [{...review, id: review.proposalId, createdAtMs: 1}], receipts: []})),
    reviewProposal: vi.fn(async () => review), reviewProposalRevert: vi.fn(async () => ({...review, kind: 'revert' as const})), applyProposalReview: vi.fn(async (): Promise<null> => null), cancelProposalReview: vi.fn(async () => {}),
  };
}
function responseMode(value: 'ask' | 'revision') {const mode = document.querySelector<HTMLSelectElement>('[aria-label="Response mode"]')!; mode.value = value; mode.dispatchEvent(new Event('change'));}
async function beginRevision(bridge: LocalCore) {
  await start(bridge); const source = view().state.doc.toString(); const from = source.indexOf('🐺');
  await highlight(from, source.indexOf('\nLast')); await open(); responseMode('revision'); question('Suggest a clearer passage');
}
async function suggested() {button('Send to OpenAI').click(); await vi.waitFor(() => expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Review suggested revision')).toBe(true));}

describe('Studio attributed revision workflow', () => {
  it('uses only the exact saved selection and requires whole-scene review then native author confirmation', async () => {
    const bridge = await revisionCore(); await beginRevision(bridge); await suggested();
    expect(bridge.askQuestion).not.toHaveBeenCalled(); expect(bridge.reviewProposal).not.toHaveBeenCalled(); expect(bridge.applyProposalReview).not.toHaveBeenCalled(); expect(bridge.saveDocument).not.toHaveBeenCalled();
    const args = bridge.suggestQuestionRevision.mock.calls[0] as unknown as [QuestionRequest, unknown, {selectedText: string; fromUtf8: number; toUtf8: number}];
    expect(args[0].context).toBe(''); expect(args[0].history).toEqual([]); expect(args[2].selectedText).toBe('🐺 passage.');
    expect(args[2].fromUtf8).toBe(new TextEncoder().encode(original.slice(0, original.indexOf('🐺'))).length);
    expect(view().state.doc.toString()).toBe(original.replace(/\r\n/g, '\n')); button('Review suggested revision').click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Review whole-scene proposal"]')).not.toBeNull());
    const dialog = document.querySelector('[aria-label="Review whole-scene proposal"]')!;
    expect(dialog.textContent).toContain('Native OpenAI suggestion'); expect(dialog.textContent).not.toContain('Unverified local MCP client'); expect(dialog.textContent).toContain('not authenticated authorship');
    expect([...dialog.querySelectorAll('pre')].map(node => node.textContent)).toEqual([original, original.replace('🐺 passage.', 'new passage.')]); expect(bridge.applyProposalReview).not.toHaveBeenCalled();
    button('Continue to native confirmation').click(); await vi.waitFor(() => expect(bridge.applyProposalReview).toHaveBeenCalledTimes(1));
    expect(bridge.applyProposalReview).toHaveBeenCalledWith(session.id, {reviewId: 'review', proposalId: 'proposal', baseHash: args[2] && (await bridge.readDocument('', '')).contentHash, replacementHash: 'replacement', diffHash: 'diff'});
    expect(bridge.saveDocument).not.toHaveBeenCalled(); expect(view().state.doc.toString()).toBe(original.replace(/\r\n/g, '\n'));
  });
  it('keeps typing and saving usable during a revision request and prevents reviewing the stale result', async () => {
    const bridge = await revisionCore(); const result = deferred<Awaited<ReturnType<typeof bridge.suggestQuestionRevision>>>(); bridge.suggestQuestionRevision.mockReturnValueOnce(result.promise);
    await beginRevision(bridge); button('Send to OpenAI').click(); await vi.waitFor(() => expect(bridge.suggestQuestionRevision).toHaveBeenCalledTimes(1));
    expect(view().state.readOnly).toBe(false); button('Return to writing').click(); view().dispatch({changes: {from: view().state.doc.length, insert: '!'}}); await app!.saveCurrent();
    expect(bridge.saveDocument).toHaveBeenCalledTimes(1); const request = bridge.suggestQuestionRevision.mock.calls[0][0];
    result.resolve({requestId: request.requestId, text: 'Stale explanation remains readable', model: 'mock-model', incomplete: false, proposalId: 'proposal', replacementText: 'new passage.'});
    await vi.waitFor(() => expect(panel().textContent).toContain('Stale explanation')); expect(button('Review suggested revision').disabled).toBe(true); expect(bridge.applyProposalReview).not.toHaveBeenCalled();
    button('Reject suggested revision').click(); await vi.waitFor(() => expect(bridge.rejectProposal).toHaveBeenCalledWith(session.id, 'proposal'));
  });
  it('blocks dirty targets without saving and allows switching back to ordinary advice', async () => {
    const bridge = await revisionCore(); await beginRevision(bridge); view().dispatch({changes: {from: view().state.doc.length, insert: '!'}});
    expect(button('Send to OpenAI').disabled).toBe(true); expect(panel().textContent).toContain('Save your scene'); expect(bridge.saveDocument).not.toHaveBeenCalled();
    responseMode('ask'); button('Send to OpenAI').click(); expect(bridge.askQuestion).toHaveBeenCalledTimes(1); expect(bridge.suggestQuestionRevision).not.toHaveBeenCalled();
  });
  it('invalidates a suggested revision after edit then undo even when exact source is restored', async () => {
    const bridge = await revisionCore(); await beginRevision(bridge); await suggested(); const selected = view().state.selection;
    view().dispatch({changes: {from: view().state.doc.length, insert: '!'}}); button('Undo').click(); view().dispatch({selection: selected});
    expect(view().state.doc.toString()).toBe(original.replace(/\r\n/g, '\n')); expect(button('Review suggested revision').disabled).toBe(true);
    button('Review suggested revision').click(); expect(bridge.reviewProposal).not.toHaveBeenCalled(); expect(bridge.applyProposalReview).not.toHaveBeenCalled();
  });
  it('awaits native dirty synchronization and invalidates source changes during that wait', async () => {
    const bridge = await revisionCore(); await beginRevision(bridge); const waiting = deferred<void>();
    bridge.setUnsavedChanges.mockReturnValueOnce(waiting.promise); view().dispatch({changes: {from: view().state.doc.length, insert: '!'}}); button('Undo').click();
    const text = view().state.doc.toString(); view().dispatch({selection: {anchor: text.indexOf('🐺'), head: text.indexOf('\nLast')}}); button('Capture revision selection').click();
    question('Try this exact saved passage'); button('Send to OpenAI').click(); await new Promise(resolve => setTimeout(resolve, 20)); expect(bridge.suggestQuestionRevision).not.toHaveBeenCalled();
    view().dispatch({selection: {anchor: 0, head: 3}}); waiting.resolve(); await vi.waitFor(() => expect(button('Cancel request').hidden).toBe(true)); expect(bridge.suggestQuestionRevision).not.toHaveBeenCalled();
  });
  it('rechecks exact editor revision after loading native review and never promotes late programmatic changes', async () => {
    const bridge = await revisionCore(); await beginRevision(bridge); await suggested(); const waiting = deferred<Awaited<ReturnType<typeof bridge.reviewProposal>>>(); const review = await bridge.reviewProposal(); bridge.reviewProposal.mockClear(); bridge.reviewProposal.mockReturnValueOnce(waiting.promise);
    button('Review suggested revision').click(); await vi.waitFor(() => expect(bridge.reviewProposal).toHaveBeenCalledTimes(1));
    view().dispatch({changes: {from: view().state.doc.length, insert: ' late edit'}}); waiting.resolve(review);
    await vi.waitFor(() => expect(bridge.cancelProposalReview).toHaveBeenCalledWith(session.id, 'review'));
    expect(document.querySelector('[aria-label="Review whole-scene proposal"]')).toBeNull(); expect(bridge.applyProposalReview).not.toHaveBeenCalled(); expect(view().state.doc.toString()).toContain('late edit');
  });
  it('rechecks the captured selection immediately before native confirmation', async () => {
    const bridge = await revisionCore(); await beginRevision(bridge); await suggested(); button('Review suggested revision').click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Review whole-scene proposal"]')).not.toBeNull());
    view().dispatch({selection: {anchor: 0, head: 3}}); button('Continue to native confirmation').click();
    await vi.waitFor(() => expect(bridge.cancelProposalReview).toHaveBeenCalledWith(session.id, 'review')); expect(bridge.applyProposalReview).not.toHaveBeenCalled(); expect(bridge.saveDocument).not.toHaveBeenCalled();
  });
  it('shows native-origin proposal rejection and immutable decision receipts without changing the manuscript', async () => {
    const bridge = await revisionCore(); await start(bridge); button('Revision proposals').click(); await vi.waitFor(() => expect(document.querySelector('[aria-label="Revision proposals and receipts"]')).not.toBeNull());
    expect(document.body.textContent).toContain('Native OpenAI suggestion'); button('Reject proposal').click(); await vi.waitFor(() => expect(document.body.textContent).toContain('Immutable local rejection receipt: receipt'));
    expect(bridge.rejectProposal).toHaveBeenCalledWith(session.id, 'proposal'); expect(bridge.saveDocument).not.toHaveBeenCalled(); expect(bridge.applyProposalReview).not.toHaveBeenCalled();
    button('Close').click(); bridge.listProposals.mockResolvedValue({pending: [], receipts: [await bridge.rejectProposal()] } as never); button('Revision proposals').click();
    await vi.waitFor(() => expect(document.querySelector('.proposal-receipt')?.textContent).toContain('Reject · scene.md · rejected'));
    expect(document.body.textContent).toContain('Studio explicit rejection'); expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Review revert')).toBe(false);
  });
});
