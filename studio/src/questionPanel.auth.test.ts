// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createQuestionPanel, type QuestionScene} from './questionPanel';
import type {LocalCore, QuestionAnswer, QuestionConnection, QuestionRequest, QuestionStatus} from './localCore';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
const ready: QuestionStatus = {configured: true, model: 'model-one', message: 'Ready for questions.',
  accounts: [{id: 'account-one', label: 'Writer one', signedIn: true, planEnabled: true}, {id: 'account-two', label: 'Writer two', signedIn: true, planEnabled: true}],
  activeAccountId: 'account-one', models: [{slug: 'model-one', displayName: 'First model'}, {slug: 'model-two', displayName: 'Second model'}],
  selectedModel: 'model-one', generation: 1, signInPending: false, usageLimited: false};
const disconnected: QuestionStatus = {...ready, configured: false, model: null, selectedModel: null, activeAccountId: null, accounts: [], models: [], message: 'Connect ChatGPT to ask questions.'};
const answer = (request: QuestionRequest, text = 'Synthetic answer'): QuestionAnswer => ({requestId: request.requestId, text, model: 'model-one', incomplete: false});
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
function bridge(initial = ready) {
  return {available: vi.fn(() => true), questionStatus: vi.fn(async (): Promise<QuestionStatus> => initial),
    askQuestion: vi.fn(async (request: QuestionRequest, _connection: QuestionConnection) => answer(request)), cancelQuestion: vi.fn(async (_id: string) => true),
    connectQuestionAccount: vi.fn(async (_options: {allowChatgptPlan: boolean; accountId?: string}): Promise<QuestionStatus> => ({...ready, generation: 2})),
    cancelQuestionSignIn: vi.fn(async () => {}), selectQuestionAccount: vi.fn(async (accountId: string): Promise<QuestionStatus> => ({...ready, activeAccountId: accountId, generation: 2})),
    selectQuestionModel: vi.fn(async (slug: string): Promise<QuestionStatus> => ({...ready, model: slug, selectedModel: slug, generation: 2})),
    refreshQuestionConnection: vi.fn(async (): Promise<QuestionStatus> => initial),
    signOutQuestionAccount: vi.fn(async (_id?: string): Promise<QuestionStatus> => ({...disconnected, generation: 2})), openQuestionUsage: vi.fn(async () => {}),
  };
}
let panel: ReturnType<typeof createQuestionPanel> | undefined;
let scene: QuestionScene;
function button(label: string) {const found = [...document.querySelectorAll('button')].find(node => node.textContent === label); if (!found) throw new Error(`Missing ${label}`); return found;}
const composer = () => document.querySelector<HTMLTextAreaElement>('[aria-label="Your drafting question"]')!;
function write(value: string) {composer().value = value; composer().dispatchEvent(new Event('input', {bubbles: true}));}
function grant() {const input = document.querySelector<HTMLInputElement>('[aria-label="Allow Heinlein to use my ChatGPT plan"]')!; input.checked = true; input.dispatchEvent(new Event('change', {bubbles: true}));}
function choose(label: 'ChatGPT account' | 'Question model', value: string) {const select = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; select.value = value; select.dispatchEvent(new Event('change', {bubbles: true}));}
const status = () => document.querySelector('.question-status')!.textContent!;
async function start(core = bridge()) {
  panel = createQuestionPanel(core as unknown as LocalCore, {current: () => scene, focusEditor: vi.fn()}); document.body.append(panel.element); panel.open();
  await vi.waitFor(() => expect(button('Recheck OpenAI setup').disabled).toBe(false)); return core;
}
async function send(text = 'Synthetic question') {write(text); button('Send to OpenAI').click(); await vi.waitFor(() => expect(button('Cancel request').hidden).toBe(true));}
beforeEach(() => {vi.stubGlobal('crypto', webcrypto); document.body.replaceChildren(); scene = {repositoryId: 'repository', path: 'scene.md', source: 'Private scene snapshot', from: 0, to: 7, canCapture: true};});
afterEach(() => {panel?.destroy(); panel = undefined; vi.unstubAllGlobals();});

describe('ChatGPT sign-in controls and billing bindings', () => {
  it('requires explicit plan-use consent and never signs in, refreshes models, or infers automatically', async () => {
    const openBrowser = vi.spyOn(window, 'open').mockImplementation(() => null); const core = await start(bridge(disconnected));
    write('A local question'); expect(button('Continue with ChatGPT').disabled).toBe(true); expect(button('Send to OpenAI').disabled).toBe(true);
    expect(core.connectQuestionAccount).not.toHaveBeenCalled(); expect(core.refreshQuestionConnection).not.toHaveBeenCalled(); expect(core.askQuestion).not.toHaveBeenCalled();
    grant(); button('Continue with ChatGPT').click();
    await vi.waitFor(() => expect(status()).toContain('Connection updated'));
    expect(core.connectQuestionAccount).toHaveBeenCalledWith({allowChatgptPlan: true}); expect(openBrowser).not.toHaveBeenCalled();
    expect(core.askQuestion).not.toHaveBeenCalled(); expect(document.querySelector('input[type="password"]')).toBeNull(); expect(document.body.textContent).toContain('plan allowance');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Allow Heinlein to use my ChatGPT plan"]')!.checked).toBe(false); openBrowser.mockRestore();
  });
  it('binds each explicit Send to the displayed account, model, and generation', async () => {
    const core = await start(); await send();
    expect(core.askQuestion.mock.calls[0][1]).toEqual({generation: 1, accountId: 'account-one', model: 'model-one'});
    expect(document.querySelector('.question-connection')!.textContent).toContain('Writer one · model-one');
  });
  it('reauthorizes the selected signed-out saved account without registering a new client', async () => {
    const core = await start(bridge({...disconnected, accounts: [{...ready.accounts[0], signedIn: false, planEnabled: false}]}));
    choose('ChatGPT account', 'account-one'); expect(core.selectQuestionAccount).not.toHaveBeenCalled(); write('Held locally'); expect(button('Send to OpenAI').disabled).toBe(true);
    grant(); button('Continue with ChatGPT').click(); await vi.waitFor(() => expect(status()).toContain('Connection updated'));
    expect(core.connectQuestionAccount).toHaveBeenCalledWith({allowChatgptPlan: true, accountId: 'account-one'});
  });
  it('reconsents the signed-in saved client when plan use was disabled', async () => {
    const core = await start(bridge({...ready, accounts: [{...ready.accounts[0], planEnabled: false}]}));
    grant(); button('Continue with ChatGPT').click(); await vi.waitFor(() => expect(status()).toContain('Connection updated'));
    expect(core.connectQuestionAccount).toHaveBeenCalledWith({allowChatgptPlan: true, accountId: 'account-one'});
  });
  it('uses a new registration only after Add account is explicitly chosen when saved accounts exist', async () => {
    const core = await start(bridge({...disconnected, accounts: [{...ready.accounts[0], signedIn: false}]}));
    grant(); expect(button('Continue with ChatGPT').disabled).toBe(true); button('Add ChatGPT account').click();
    expect(core.connectQuestionAccount).not.toHaveBeenCalled(); expect(button('Continue with ChatGPT').disabled).toBe(true);
    grant(); button('Continue with ChatGPT').click(); await vi.waitFor(() => expect(status()).toContain('Connection updated'));
    expect(core.connectQuestionAccount).toHaveBeenCalledWith({allowChatgptPlan: true});
  });
  it.each([
    {name: 'grant disabled', value: {...ready, accounts: [{...ready.accounts[0], planEnabled: false}]}},
    {name: 'signed out', value: {...ready, accounts: [{...ready.accounts[0], signedIn: false}]}},
    {name: 'usage limited', value: {...ready, usageLimited: true}},
    {name: 'missing active account', value: {...ready, activeAccountId: null}},
    {name: 'model not in catalog', value: {...ready, models: []}},
    {name: 'mismatched selected model', value: {...ready, selectedModel: 'model-two'}},
    {name: 'invalid generation', value: {...ready, generation: -1}},
  ])('blocks Send for $name even if configured is true', async ({value}) => {
    const core = await start(bridge(value)); write('Question'); expect(button('Send to OpenAI').disabled).toBe(true); button('Send to OpenAI').click(); expect(core.askQuestion).not.toHaveBeenCalled();
  });
  it('switches accounts by explicit choice, cancels the pending request, and clears all old content', async () => {
    const response = deferred<QuestionAnswer>(); const core = await start(); core.askQuestion.mockReturnValueOnce(response.promise);
    button('Capture current scene').click(); write('Old account question'); button('Send to OpenAI').click(); const request = core.askQuestion.mock.calls[0][0];
    choose('ChatGPT account', 'account-two'); expect(core.cancelQuestion).toHaveBeenCalledWith(request.requestId);
    await vi.waitFor(() => expect(status()).toContain('Connection updated')); expect(panel!.element.textContent).not.toContain('Private scene snapshot');
    response.resolve(answer(request, 'Late old account answer')); await Promise.resolve(); expect(panel!.element.textContent).not.toContain('Late old account answer');
    await send('New account question'); expect(core.askQuestion.mock.calls[1][0]).toMatchObject({context: '', history: []});
    expect(core.askQuestion.mock.calls[1][1]).toEqual({generation: 2, accountId: 'account-two', model: 'model-one'});
  });
  it('disables Send during model changes and binds the resulting model without stale history', async () => {
    const core = await start(); await send('Old model question'); button('Capture current scene').click();
    const selection = deferred<QuestionStatus>(); core.selectQuestionModel.mockReturnValueOnce(selection.promise); choose('Question model', 'model-two');
    write('Cannot send yet'); expect(button('Send to OpenAI').disabled).toBe(true); expect(panel!.element.textContent).not.toContain('Old model question');
    selection.resolve({...ready, generation: 2, model: 'model-two', selectedModel: 'model-two'}); await vi.waitFor(() => expect(status()).toContain('Connection updated'));
    await send('New model question'); expect(core.askQuestion.mock.calls[1][1]).toEqual({generation: 2, accountId: 'account-one', model: 'model-two'});
    expect(core.askQuestion.mock.calls[1][0]).toMatchObject({history: [], context: ''});
  });
  it('cancels sign-in and ignores completion arriving before cancellation acknowledgement', async () => {
    const connection = deferred<QuestionStatus>(); const cancellation = deferred<void>(); const core = bridge(disconnected);
    core.connectQuestionAccount.mockReturnValueOnce(connection.promise); core.cancelQuestionSignIn.mockReturnValueOnce(cancellation.promise); await start(core);
    grant(); button('Continue with ChatGPT').click(); expect(button('Cancel connection').hidden).toBe(false); button('Cancel connection').click();
    connection.resolve(ready); await Promise.resolve(); expect(panel!.element.textContent).not.toContain('Writer one · model-one');
    expect(button('Send to OpenAI').disabled).toBe(true); cancellation.resolve(); await vi.waitFor(() => expect(status()).toContain('Connection canceled'));
    expect(core.cancelQuestionSignIn).toHaveBeenCalledTimes(1); expect(core.askQuestion).not.toHaveBeenCalled();
  });
  it('cancels sign-in on close and ignores a late auth result after reopening', async () => {
    const connection = deferred<QuestionStatus>(); const core = bridge(disconnected); core.connectQuestionAccount.mockReturnValueOnce(connection.promise); await start(core);
    grant(); button('Continue with ChatGPT').click(); button('Close questions').click(); expect(core.cancelQuestionSignIn).toHaveBeenCalledTimes(1);
    panel!.open(); await vi.waitFor(() => expect(button('Recheck OpenAI setup').disabled).toBe(false)); connection.resolve(ready); await Promise.resolve();
    expect(panel!.element.textContent).not.toContain('Writer one · model-one'); write('Still disconnected'); expect(button('Send to OpenAI').disabled).toBe(true);
  });
  it('ignores a stale model selection response after close/reopen', async () => {
    const core = await start(); const selection = deferred<QuestionStatus>(); core.selectQuestionModel.mockReturnValueOnce(selection.promise);
    choose('Question model', 'model-two'); button('Close questions').click(); panel!.open();
    await vi.waitFor(() => expect(button('Recheck OpenAI setup').disabled).toBe(false)); selection.resolve({...ready, model: 'model-two', selectedModel: 'model-two', generation: 2}); await Promise.resolve();
    await send(); expect(core.askQuestion.mock.calls[0][1]).toEqual({generation: 1, accountId: 'account-one', model: 'model-one'});
  });
  it('signs out the selected account and cancels/clears an in-flight question', async () => {
    const core = await start(); const response = deferred<QuestionAnswer>(); core.askQuestion.mockReturnValueOnce(response.promise);
    button('Capture current scene').click(); write('Question before sign-out'); button('Send to OpenAI').click(); const request = core.askQuestion.mock.calls[0][0];
    button('Sign out of selected account').click(); await vi.waitFor(() => expect(status()).toContain('Signed out'));
    expect(core.signOutQuestionAccount).toHaveBeenCalledWith('account-one'); expect(core.cancelQuestion).toHaveBeenCalledWith(request.requestId);
    response.resolve(answer(request, 'Answer after sign-out')); await Promise.resolve(); expect(panel!.element.textContent).not.toContain('Answer after sign-out');
    expect(panel!.element.textContent).not.toContain('Private scene snapshot'); write('After sign-out'); expect(button('Send to OpenAI').disabled).toBe(true);
  });
  it('never re-enables Send after an unconfirmed account change', async () => {
    const core = await start(); core.selectQuestionAccount.mockRejectedValueOnce({code: 'stale', message: 'The account changed elsewhere.'}); choose('ChatGPT account', 'account-two');
    await vi.waitFor(() => expect(status()).toBe('The account changed elsewhere.')); write('Do not send'); expect(button('Send to OpenAI').disabled).toBe(true);
    expect(document.querySelector('.question-connection')!.textContent).toContain('not confirmed'); expect(core.askQuestion).not.toHaveBeenCalled();
  });
  it('performs remote account/model recheck and usage opening only on explicit controls', async () => {
    const core = await start(); write('Typing does not refresh'); expect(core.refreshQuestionConnection).not.toHaveBeenCalled();
    button('Manage ChatGPT usage').click(); expect(core.openQuestionUsage).toHaveBeenCalledWith();
    button('Recheck OpenAI setup').click(); await vi.waitFor(() => expect(core.refreshQuestionConnection).toHaveBeenCalledTimes(1));
    expect(core.askQuestion).not.toHaveBeenCalled();
  });
  it('clears conversation when recheck finds an externally changed account/model generation', async () => {
    const core = await start(); await send('Old external generation'); button('Capture current scene').click();
    core.refreshQuestionConnection.mockResolvedValueOnce({...ready, generation: 9, activeAccountId: 'account-two'}); button('Recheck OpenAI setup').click();
    await vi.waitFor(() => expect(button('Recheck OpenAI setup').disabled).toBe(false)); expect(panel!.element.textContent).not.toContain('Old external generation');
    expect(panel!.element.textContent).not.toContain('Private scene snapshot'); await send('New external generation');
    expect(core.askQuestion.mock.calls[1][1]).toEqual({generation: 9, accountId: 'account-two', model: 'model-one'});
  });
  it('blocks further sends after a native plan-limit error until an explicit successful recheck', async () => {
    const core = await start(); core.askQuestion.mockRejectedValueOnce({code: 'usage_limit', message: 'Plan limit reached.'});
    core.questionStatus.mockResolvedValue({...ready, usageLimited: true}); await send('Limited question');
    await vi.waitFor(() => expect(button('Send to OpenAI').disabled).toBe(true)); expect(panel!.element.textContent).toContain('Plan usage is limited');
    expect(core.refreshQuestionConnection).not.toHaveBeenCalled(); core.refreshQuestionConnection.mockResolvedValue(ready); button('Recheck OpenAI setup').click();
    await vi.waitFor(() => expect(button('Send to OpenAI').disabled).toBe(false)); expect(core.askQuestion).toHaveBeenCalledTimes(1);
  });
  it('does not render unexpected auth URLs/tokens or store authentication data in browser storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const core = bridge({...ready, authURL: 'https://example.invalid/private-oauth', accessToken: 'synthetic-secret'} as QuestionStatus); await start(core);
    expect(panel!.element.textContent).not.toContain('private-oauth'); expect(panel!.element.textContent).not.toContain('synthetic-secret'); expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
  });
});
