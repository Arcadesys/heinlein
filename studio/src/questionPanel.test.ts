// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createQuestionPanel, questionBytes, questionHistory, questionProblem, type QuestionScene} from './questionPanel';
import type {LocalCore, QuestionAnswer, QuestionRequest, QuestionStatus} from './localCore';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const ready: QuestionStatus = {configured: true, model: 'mock-model', message: 'Mock provider ready.', accounts: [{id: 'account-1', label: 'Mock writer', signedIn: true, planEnabled: true}], activeAccountId: 'account-1', models: [{slug: 'mock-model', displayName: 'Mock model'}], selectedModel: 'mock-model', signInPending: false, generation: 1, usageLimited: false};
const reply = (request: QuestionRequest, text = 'Mock answer'): QuestionAnswer => ({requestId: request.requestId, text, model: 'mock-model', incomplete: false});
function bridge() {
  return {available: vi.fn(() => true), questionStatus: vi.fn(async () => ready),
    askQuestion: vi.fn(async (request: QuestionRequest) => reply(request)), cancelQuestion: vi.fn(async (_id: string) => true)};
}
let panel: ReturnType<typeof createQuestionPanel> | undefined;
let scene: QuestionScene | null;
const focusEditor = vi.fn();
function button(label: string) {const found = [...document.querySelectorAll('button')].find(node => node.textContent === label); if (!found) throw new Error(`Missing ${label}`); return found;}
const input = () => document.querySelector<HTMLTextAreaElement>('[aria-label="Your drafting question"]')!;
function write(value: string) {input().value = value; input().dispatchEvent(new Event('input', {bubbles: true}));}
const status = () => document.querySelector('.question-status')!.textContent!;
async function start(core = bridge()) {
  panel = createQuestionPanel(core as unknown as LocalCore, {current: () => scene, focusEditor}); document.body.append(panel.element); panel.open();
  await vi.waitFor(() => expect(button('Recheck OpenAI setup').disabled).toBe(false)); return core;
}
async function send(text = 'What happens next?') {write(text); button('Send to OpenAI').click(); await vi.waitFor(() => expect(button('Cancel request').hidden).toBe(true));}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); document.body.replaceChildren(); localStorage.clear(); focusEditor.mockReset();
  scene = {repositoryId: 'repo-1', path: 'scene.md', source: 'A 🐺 passage.\r\nNext line', from: 2, to: 4, canCapture: true};
});
afterEach(() => {panel?.destroy(); panel = undefined; vi.unstubAllGlobals();});

describe('question payload boundaries', () => {
  it('counts UTF-8 bytes rather than UTF-16 units and rejects incomplete Unicode', () => {
    expect(questionBytes('🐺')).toBe(4); expect(questionProblem('🐺'.repeat(1000), '')).toBeNull();
    expect(questionProblem('🐺'.repeat(1001), '')).toContain('4,000');
    expect(questionProblem(' ', '')).toContain('Write a question');
    expect(questionProblem('\ud800', '')).toContain('incomplete Unicode');
    expect(questionProblem('q', 'x'.repeat(16001))).toContain('too large');
  });
  it('keeps only complete recent pairs within the byte/message budget', () => {
    const messages = Array.from({length: 12}, (_, index) => ({role: index % 2 ? 'assistant' as const : 'user' as const, text: `${index}🐺`}));
    expect(questionHistory(messages, 1000)).toEqual(messages.slice(-8));
    expect(questionHistory(messages, 12)).toEqual(messages.slice(-2));
    expect(questionHistory(messages, 11)).toEqual([]);
    expect(questionHistory([{role: 'assistant', text: 'a'}, {role: 'user', text: 'q'}], 100)).toEqual([]);
  });
});

describe('nonmodal drafting questions', () => {
  it('does not send on open or typing and sends only the exact explicit payload', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const core = await start();
    expect(document.querySelector('dialog')).toBeNull(); expect(input()).toBe(document.activeElement);
    expect(core.askQuestion).not.toHaveBeenCalled(); write('  A precise question?  ');
    input().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true}));
    expect(core.askQuestion).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('No manuscript text will be sent');
    button('Send to OpenAI').click(); await vi.waitFor(() => expect(status()).toContain('Answer ready'));
    expect(core.askQuestion.mock.calls[0][0]).toEqual({requestId: expect.any(String), question: '  A precise question?  ', context: '', history: []});
    expect(fetch).not.toHaveBeenCalled(); expect(focusEditor).not.toHaveBeenCalled();
  });
  it('captures raw context only on request and shows the exact frozen snapshot', async () => {
    const core = await start(); button('Capture current scene').click();
    const captured = scene!.source; expect(document.querySelector('[aria-label="Exact context to send"]')!.textContent).toBe(captured);
    scene!.source += ' newer edits'; write('Question'); button('Send to OpenAI').click();
    await vi.waitFor(() => expect(status()).toContain('Answer ready'));
    expect(core.askQuestion.mock.calls[0][0].context).toBe(captured);
    expect(document.body.textContent).toContain('Later editor changes are not included');
    button('Remove context').click(); await send('Question without context');
    expect(core.askQuestion.mock.calls[1][0].context).toBe('');
  });
  it('captures selected text without neighboring text or metadata', async () => {
    const core = await start(); button('Capture selected text').click(); await send();
    expect(core.askQuestion.mock.calls[0][0].context).toBe('🐺');
    expect(Object.keys(core.askQuestion.mock.calls[0][0]).sort()).toEqual(['context', 'history', 'question', 'requestId']);
  });
  it('rejects oversized captures without replacing the existing preview', async () => {
    await start(); button('Capture selected text').click(); scene!.source = '🐺'.repeat(4001); button('Capture current scene').click();
    expect(status()).toContain('16,000'); expect(document.querySelector('[aria-label="Exact context to send"]')!.textContent).toBe('🐺');
    scene!.source = '🐺'.repeat(4000); button('Capture current scene').click();
    expect(questionBytes(document.querySelector('[aria-label="Exact context to send"]')!.textContent!)).toBe(16000);
  });
  it('rejects empty, unsafe, and unavailable selections', async () => {
    await start(); scene!.to = scene!.from; button('Capture selected text').click(); expect(status()).toContain('nonempty');
    scene!.to = 3; button('Capture selected text').click(); expect(status()).toContain('complete Unicode');
    scene!.canCapture = false; button('Capture current scene').click(); expect(status()).toContain('recovery');
    expect(document.querySelector('[aria-label="Exact context to send"]')!.textContent).toBe('');
  });
  it('disables empty/oversized questions without a network request', async () => {
    const core = await start(); expect(button('Send to OpenAI').disabled).toBe(true);
    write('🐺'.repeat(1001)); expect(button('Send to OpenAI').disabled).toBe(true); expect(document.body.textContent).toContain('Question is too long');
    button('Send to OpenAI').click(); expect(core.askQuestion).not.toHaveBeenCalled();
    write('valid'); expect(button('Send to OpenAI').disabled).toBe(false);
  });
  it('keeps unconfigured and browser-only setups offline', async () => {
    const core = bridge(); core.available.mockReturnValue(false); await start(core); write('Question');
    expect(core.questionStatus).not.toHaveBeenCalled(); expect(button('Send to OpenAI').disabled).toBe(true);
    expect(document.body.textContent).toContain('native Heinlein host'); expect(core.askQuestion).not.toHaveBeenCalled();
    core.available.mockReturnValue(true); core.questionStatus.mockResolvedValue({...ready, configured: false, model: null, message: 'Configure the native host first.'});
    button('Recheck OpenAI setup').click(); await vi.waitFor(() => expect(document.body.textContent).toContain('Configure the native host first'));
    expect(button('Send to OpenAI').disabled).toBe(true); expect(document.querySelector('input[type="password"]')).toBeNull();
  });
  it('handles setup failures and explicit recheck without auto-sending', async () => {
    const core = bridge(); core.questionStatus.mockRejectedValueOnce(new Error('offline')); await start(core); write('Question');
    expect(button('Send to OpenAI').disabled).toBe(true); expect(document.body.textContent).toContain('setup could not be checked');
    button('Recheck OpenAI setup').click(); await vi.waitFor(() => expect(button('Send to OpenAI').disabled).toBe(false));
    expect(core.askQuestion).not.toHaveBeenCalled();
  });
  it('awaits configuration and ignores a setup result after close', async () => {
    const result = deferred<QuestionStatus>(); const core = bridge(); core.questionStatus.mockReturnValueOnce(result.promise);
    panel = createQuestionPanel(core as unknown as LocalCore, {current: () => scene, focusEditor}); document.body.append(panel.element); panel.open(); write('Question');
    expect(button('Send to OpenAI').disabled).toBe(true); button('Close questions').click(); result.resolve(ready); await Promise.resolve();
    expect(panel.element.hidden).toBe(true); expect(core.askQuestion).not.toHaveBeenCalled();
    panel.open(); await vi.waitFor(() => expect(document.body.textContent).toContain('Mock provider ready')); expect(input().value).toBe('');
  });
  it('renders provider text inertly, reports usage/incomplete output, and never offers application', async () => {
    const core = bridge(); core.askQuestion.mockImplementation(async request => ({...reply(request, '<img src=x onerror="alert(1)">\n<script>bad()</script>'), incomplete: true, inputTokens: 100, outputTokens: 55}));
    await start(core); await send();
    expect(document.querySelector('img, script')).toBeNull(); expect(document.querySelector('[aria-label="Answer 1"]')!.textContent).toContain('<script>');
    expect(document.body.textContent).toContain('Incomplete answer'); expect(document.body.textContent).toContain('100 input tokens · 55 output tokens');
    expect([...document.querySelectorAll('button')].some(node => /apply|insert|replace/i.test(node.textContent!))).toBe(false);
  });
  it.each([{name: 'empty', text: ''}, {name: 'whitespace', text: '   '}, {name: 'oversized', text: 'x'.repeat(32001)}])('rejects $name answers without adding history', async ({text}) => {
    const core = bridge(); core.askQuestion.mockImplementation(async request => reply(request, text)); await start(core); await send();
    expect(document.querySelector('.question-transcript')!.textContent).toBe(''); expect(input().value).toBe('What happens next?');
    expect(status()).toMatch(/no text|safe text limit/); expect(core.askQuestion).toHaveBeenCalledTimes(1);
  });
  it('handles sanitized errors without retrying and preserves the question', async () => {
    const core = bridge(); core.askQuestion.mockRejectedValueOnce({code: 'network', message: 'OpenAI is unreachable.'}); await start(core); await send('Keep my question');
    expect(status()).toBe('OpenAI is unreachable.'); expect(input().value).toBe('Keep my question'); expect(core.askQuestion).toHaveBeenCalledTimes(1);
    core.askQuestion.mockRejectedValueOnce('untrusted raw failure'); button('Send to OpenAI').click();
    await vi.waitFor(() => expect(status()).toContain('Nothing was retried automatically')); expect(status()).not.toContain('untrusted');
  });
  it('ignores mismatched request IDs', async () => {
    const core = bridge(); core.askQuestion.mockImplementation(async request => ({...reply(request, 'Wrong answer'), requestId: 'other'})); await start(core); await send();
    expect(status()).toContain('did not match'); expect(document.querySelector('.question-transcript')!.textContent).toBe('');
  });
  it('does not duplicate a pending send and ignores canceled/reordered responses', async () => {
    const first = deferred<QuestionAnswer>(); const second = deferred<QuestionAnswer>();
    const core = bridge(); core.askQuestion.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise); await start(core);
    write('First question'); button('Send to OpenAI').click(); button('Send to OpenAI').click(); expect(core.askQuestion).toHaveBeenCalledTimes(1);
    expect(input().disabled).toBe(true); button('Cancel request').click(); expect(input().disabled).toBe(false);
    const request1 = core.askQuestion.mock.calls[0][0]; expect(core.cancelQuestion).toHaveBeenCalledWith(request1.requestId);
    write('Second question'); button('Send to OpenAI').click(); const request2 = core.askQuestion.mock.calls[1][0];
    expect(request2.requestId).not.toBe(request1.requestId); second.resolve(reply(request2, 'Second answer'));
    await vi.waitFor(() => expect(status()).toContain('Answer ready')); first.resolve(reply(request1, 'Stale answer')); await Promise.resolve();
    expect(document.querySelector('.question-transcript')!.textContent).toContain('Second answer'); expect(document.body.textContent).not.toContain('Stale answer');
  });
  it('clears pending payload, context, and history on reset and close', async () => {
    const result = deferred<QuestionAnswer>(); const core = await start(); await send('First');
    button('Capture current scene').click(); core.askQuestion.mockReturnValueOnce(result.promise); write('Pending'); button('Send to OpenAI').click();
    const request = core.askQuestion.mock.calls[1][0]; button('Clear conversation').click();
    expect(input().value).toBe(''); expect(document.querySelector('.question-transcript')!.textContent).toBe('');
    expect(document.querySelector('[aria-label="Exact context to send"]')!.textContent).toBe('');
    result.resolve(reply(request, 'Late reset answer')); await Promise.resolve(); expect(document.body.textContent).not.toContain('Late reset answer');
    expect(core.cancelQuestion).toHaveBeenCalledWith(request.requestId); button('Close questions').click(); expect(panel!.element.hidden).toBe(true);
  });
  it('removes private context and prior-message previews from hidden DOM on close', async () => {
    await start(); scene!.source = 'Private context never retained after close'; button('Capture current scene').click(); await send('Private question never retained after close');
    expect(panel!.element.textContent).toContain('Private context'); expect(panel!.element.textContent).toContain('Private question');
    button('Close questions').click(); expect(panel!.element.textContent).not.toContain('Private context'); expect(panel!.element.textContent).not.toContain('Private question');
    expect(panel!.element.textContent).not.toContain('Mock answer');
  });
  it('ignores late answers after close/reopen and repository switch', async () => {
    const result = deferred<QuestionAnswer>(); const core = bridge(); core.askQuestion.mockReturnValueOnce(result.promise); await start(core);
    write('Pending'); button('Send to OpenAI').click(); const request = core.askQuestion.mock.calls[0][0]; button('Close questions').click(); panel!.open();
    result.resolve(reply(request, 'Late closed answer')); await Promise.resolve(); expect(document.body.textContent).not.toContain('Late closed answer');
    const next = deferred<QuestionAnswer>(); core.askQuestion.mockReturnValueOnce(next.promise); await vi.waitFor(() => expect(button('Recheck OpenAI setup').disabled).toBe(false));
    write('Different pending'); button('Send to OpenAI').click(); const request2 = core.askQuestion.mock.calls[1][0]; scene!.repositoryId = 'repo-2';
    next.resolve(reply(request2, 'Other repository answer')); await Promise.resolve(); expect(document.body.textContent).not.toContain('Other repository answer');
  });
  it('previews and sends bounded history without automatically retaining old context', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const core = await start(); button('Capture selected text').click(); await send('First');
    button('Remove context').click(); write('Second');
    expect(document.querySelector('[aria-label="Exact conversation history to send"]')!.textContent).toContain('First');
    button('Send to OpenAI').click(); await vi.waitFor(() => expect(status()).toContain('Answer ready'));
    expect(core.askQuestion.mock.calls[1][0]).toMatchObject({question: 'Second', context: '', history: [{role: 'user', text: 'First'}, {role: 'assistant', text: 'Mock answer'}]});
    for (let i = 3; i <= 6; i++) await send(`Question ${i}`);
    expect(core.askQuestion.mock.calls[5][0].history).toHaveLength(8); expect(document.querySelectorAll('.question-turn')).toHaveLength(4);
    expect(document.body.textContent).toContain('2 earlier turns have been cleared'); expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
  });
  it('visibly omits a whole previous turn when remaining request budget is too small', async () => {
    const core = bridge(); core.askQuestion.mockImplementationOnce(async request => reply(request, 'x'.repeat(20000))); await start(core); await send('First');
    scene!.source = 'y'.repeat(16000); button('Capture current scene').click(); write('Next');
    expect(document.body.textContent).toContain('2 older messages are omitted'); button('Send to OpenAI').click();
    await vi.waitFor(() => expect(core.askQuestion).toHaveBeenCalledTimes(2)); expect(core.askQuestion.mock.calls[1][0].history).toEqual([]);
  });
  it('keeps focus stable for async answers and provides scoped Escape/return controls', async () => {
    const result = deferred<QuestionAnswer>(); const core = bridge(); core.askQuestion.mockReturnValueOnce(result.promise); await start(core);
    const outside = document.createElement('button'); document.body.append(outside); write('Question'); button('Send to OpenAI').click(); outside.focus();
    result.resolve(reply(core.askQuestion.mock.calls[0][0])); await vi.waitFor(() => expect(status()).toContain('Answer ready')); expect(document.activeElement).toBe(outside);
    outside.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); expect(panel!.element.hidden).toBe(false);
    button('Return to writing').click(); expect(focusEditor).toHaveBeenCalledTimes(1);
    input().focus(); const tab = new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}); input().dispatchEvent(tab); expect(tab.defaultPrevented).toBe(false);
    input().dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); expect(panel!.element.hidden).toBe(true); expect(focusEditor).toHaveBeenCalledTimes(2);
  });
});
