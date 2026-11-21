// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createQuestionPanel, type QuestionScene} from './questionPanel';
import type {LocalCore, QuestionAnswer, QuestionConnection, QuestionProvider, QuestionRequest, QuestionStatus} from './localCore';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};

const chatgpt: QuestionStatus = {configured: true, model: 'model-one', message: 'Connected to ChatGPT.',
  accounts: [{id: 'account-one', label: 'Writer one', signedIn: true, planEnabled: true}], activeAccountId: 'account-one',
  models: [{slug: 'model-one', displayName: 'First model'}], selectedModel: 'model-one', generation: 1, signInPending: false, usageLimited: false,
  provider: 'openAi', claude: {configured: false, active: false, keyHint: null, models: [], selectedModel: null}};
const opus = {slug: 'claude-opus-5-5', displayName: 'Claude Opus 5.5'}; const sonnet = {slug: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5'};
const claude: QuestionStatus = {...chatgpt, provider: 'anthropic', configured: true, model: opus.slug, selectedModel: opus.slug, generation: 5,
  message: 'Connected to Claude (Claude Opus 5.5). Requests use your Anthropic API key and are billed to your Anthropic account.',
  accounts: [{id: 'anthropic-0123abcd', label: 'Claude · key ending 1a2b', signedIn: true, planEnabled: true}], activeAccountId: 'anthropic-0123abcd',
  models: [opus, sonnet], claude: {configured: true, active: true, keyHint: '1a2b', models: [opus, sonnet], selectedModel: opus.slug}};
const answer = (request: QuestionRequest): QuestionAnswer => ({requestId: request.requestId, text: 'Synthetic advice', model: opus.slug, incomplete: false});

function bridge(initial = chatgpt) {
  return {available: vi.fn(() => true), questionStatus: vi.fn(async (): Promise<QuestionStatus> => initial),
    askQuestion: vi.fn(async (request: QuestionRequest, _connection: QuestionConnection) => answer(request)), cancelQuestion: vi.fn(async (_id: string) => true),
    connectQuestionAccount: vi.fn(async (): Promise<QuestionStatus> => chatgpt), refreshQuestionConnection: vi.fn(async (): Promise<QuestionStatus> => chatgpt),
    selectQuestionModel: vi.fn(async (): Promise<QuestionStatus> => chatgpt),
    connectClaudeKey: vi.fn(async (_key: string): Promise<QuestionStatus> => claude),
    selectQuestionProvider: vi.fn(async (provider: QuestionProvider): Promise<QuestionStatus> => provider === 'anthropic' ? claude : {...chatgpt, generation: 2, claude: {...claude.claude!, active: false}}),
    selectClaudeModel: vi.fn(async (slug: string): Promise<QuestionStatus> => ({...claude, model: slug, selectedModel: slug, generation: 6, claude: {...claude.claude!, selectedModel: slug}})),
    refreshClaudeModels: vi.fn(async (): Promise<QuestionStatus> => claude),
    removeClaudeKey: vi.fn(async (): Promise<QuestionStatus> => ({...chatgpt, generation: 3})),
  };
}
let panel: ReturnType<typeof createQuestionPanel> | undefined;
let scene: QuestionScene;
function button(label: string) {const found = [...document.querySelectorAll('button')].find(node => node.textContent === label); if (!found) throw new Error(`Missing ${label}`); return found;}
const radio = (value: QuestionProvider) => document.querySelector<HTMLInputElement>(`.heinlein-provider input[value="${value}"]`)!;
const keyField = () => document.querySelector<HTMLInputElement>('input[type="password"]');
const status = () => document.querySelector('.question-status')!.textContent!;
function choose(value: QuestionProvider) {radio(value).checked = true; radio(value).dispatchEvent(new Event('change', {bubbles: true}));}
function write(value: string) {const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="Your drafting question"]')!; composer.value = value; composer.dispatchEvent(new Event('input', {bubbles: true}));}
async function start(core = bridge()) {
  panel = createQuestionPanel(core as unknown as LocalCore, {current: () => scene, focusEditor: vi.fn()}); document.body.append(panel.element); panel.open();
  await vi.waitFor(() => expect(document.querySelector('.heinlein-provider input')).not.toBeNull());
  await vi.waitFor(() => expect(core.questionStatus).toHaveBeenCalled());
  await vi.waitFor(() => expect(radio('openAi').disabled).toBe(false));
  return core;
}
beforeEach(() => {localStorage.clear(); vi.stubGlobal('crypto', webcrypto); document.body.replaceChildren(); scene = {repositoryId: 'repository', path: 'scene.md', source: 'Private scene snapshot', from: 0, to: 7, canCapture: true};});
afterEach(() => {panel?.destroy(); panel = undefined; vi.unstubAllGlobals();});

describe('Claude as a provider', () => {
  it('offers the choice but shows no key field until the author picks Claude', async () => {
    const core = await start();
    expect(document.querySelector<HTMLElement>('.heinlein-provider')!.hidden).toBe(false);
    expect(radio('openAi').checked).toBe(true); expect(keyField()).toBeNull();
    choose('anthropic');
    expect(keyField()).not.toBeNull(); expect(status()).toContain('Paste your Anthropic API key');
    expect(core.selectQuestionProvider).not.toHaveBeenCalled(); expect(core.connectClaudeKey).not.toHaveBeenCalled();
    choose('openAi');
    expect(keyField()).toBeNull(); expect(core.selectQuestionProvider).not.toHaveBeenCalled();
  });

  it('checks a pasted key natively, clears it from the page at once, then sends to Claude', async () => {
    const core = await start();
    choose('anthropic'); keyField()!.value = '  sk-ant-synthetic-key-1a2b  ';
    button('Save key').click();
    expect(keyField()?.value ?? '').toBe('');
    expect(core.connectClaudeKey).toHaveBeenCalledWith('sk-ant-synthetic-key-1a2b');
    await vi.waitFor(() => expect(button('Send to Claude')).toBeDefined());
    expect(status()).toContain('Claude is connected');
    expect(document.body.textContent).toContain('Key saved · ends in 1a2b');
    expect(document.body.textContent).toContain('with Anthropic using your saved API key');
    expect(document.body.textContent).not.toContain('sk-ant-synthetic-key');
    expect(document.querySelector<HTMLElement>('[aria-label="Allow Heinlein to use my ChatGPT plan"]')!.closest('label')!.hidden).toBe(true);
    write('Where is the tension?'); button('Send to Claude').click();
    await vi.waitFor(() => expect(core.askQuestion).toHaveBeenCalled());
    expect(core.askQuestion.mock.calls[0][1]).toEqual({generation: 5, accountId: 'anthropic-0123abcd', model: opus.slug});
    expect(localStorage.length === 0 || !JSON.stringify({...localStorage}).includes('sk-ant')).toBe(true);
  });

  it('keeps the Claude card open with a plain message when Anthropic rejects the key', async () => {
    const core = bridge();
    core.connectClaudeKey.mockRejectedValueOnce({code: 'claude_rejected', message: 'Anthropic did not accept this API key. Check it at console.anthropic.com and paste it again.'});
    await start(core);
    choose('anthropic'); keyField()!.value = 'sk-ant-wrong'; button('Save key').click();
    await vi.waitFor(() => expect(status()).toContain('Anthropic did not accept this API key'));
    expect(keyField()).not.toBeNull(); expect(keyField()!.value).toBe('');
    expect(core.askQuestion).not.toHaveBeenCalled();
  });

  it('switches models and providers only through explicit native requests', async () => {
    const core = await start(bridge(claude));
    await vi.waitFor(() => expect(button('Send to Claude')).toBeDefined());
    expect(radio('anthropic').checked).toBe(true);
    const models = document.querySelector<HTMLSelectElement>('[aria-label="Claude model"]')!;
    expect([...models.options].map(option => option.value)).toEqual([opus.slug, sonnet.slug]);
    models.value = sonnet.slug; models.dispatchEvent(new Event('change', {bubbles: true}));
    await vi.waitFor(() => expect(core.selectClaudeModel).toHaveBeenCalledWith(sonnet.slug));
    await vi.waitFor(() => expect(radio('openAi').disabled).toBe(false));
    choose('openAi');
    await vi.waitFor(() => expect(core.selectQuestionProvider).toHaveBeenCalledWith('openAi'));
    await vi.waitFor(() => expect(button('Send to OpenAI')).toBeDefined());
    expect(keyField()).toBeNull();
    choose('anthropic');
    await vi.waitFor(() => expect(core.selectQuestionProvider).toHaveBeenLastCalledWith('anthropic'));
  });

  it('removes the key on request and returns to ChatGPT', async () => {
    const core = await start(bridge(claude));
    await vi.waitFor(() => expect(button('Remove key')).toBeDefined());
    button('Remove key').click();
    await vi.waitFor(() => expect(core.removeClaudeKey).toHaveBeenCalled());
    await vi.waitFor(() => expect(button('Send to OpenAI')).toBeDefined());
    expect(status()).toContain('removed from this Mac');
    expect(keyField()).toBeNull();
  });

  it('hides the choice on hosts without Claude support', async () => {
    const core = bridge();
    for (const key of ['connectClaudeKey', 'selectQuestionProvider', 'selectClaudeModel', 'refreshClaudeModels', 'removeClaudeKey'] as const) delete (core as Partial<typeof core>)[key];
    panel = createQuestionPanel(core as unknown as LocalCore, {current: () => scene, focusEditor: vi.fn()}); document.body.append(panel.element); panel.open();
    await vi.waitFor(() => expect(core.questionStatus).toHaveBeenCalled());
    expect(document.querySelector<HTMLElement>('.heinlein-provider')!.hidden).toBe(true);
    expect(keyField()).toBeNull();
  });
});
