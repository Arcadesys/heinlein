// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createThemePanel} from './themePanel';
import {DEFAULT_APPEARANCE} from './appearance';
import {createThemeStore, THEME_STORAGE_KEY} from './themeTokens';
import type {LocalCore, QuestionAnswer, QuestionRequest, QuestionStatus} from './localCore';
const dark = {bg: '#101010', surface: '#181818', hover: '#222222', fg: '#ffffff', muted: '#bbbbbb', accent: '#ffcc66', border: '#aaaaaa', warn: '#ffdd88', danger: '#ffaaaa', radius: 12};
const status = (): QuestionStatus => ({configured: true, model: 'chosen-model', selectedModel: 'chosen-model', message: '', accounts: [{id: 'chosen-account', label: 'Selected writer', signedIn: true, planEnabled: true}], activeAccountId: 'chosen-account', models: [{slug: 'chosen-model', displayName: 'Selected model'}], signInPending: false, generation: 4, usageLimited: false});
function bridge() {return {available: () => true, questionStatus: vi.fn(async () => status()), askQuestion: vi.fn(async (request: QuestionRequest): Promise<QuestionAnswer> => ({requestId: request.requestId, text: JSON.stringify(dark), model: 'chosen-model', incomplete: false})), cancelQuestion: vi.fn(async () => true)};}
let panel: ReturnType<typeof createThemePanel>;
function mount(core = bridge()) {panel = createThemePanel(core as unknown as LocalCore, () => DEFAULT_APPEARANCE); document.body.append(panel.element); return core;}
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent === name)!;
function aesthetic(text = 'Warm library') {const input = document.querySelector<HTMLTextAreaElement>('#theme-aesthetic')!; input.value = text; input.dispatchEvent(new Event('input'));}
function paste(text = JSON.stringify(dark)) {document.querySelector<HTMLTextAreaElement>('#theme-agent-json')!.value = text; button('Preview pasted tokens').click();}
const message = () => panel.element.textContent!;
const deferred = <T,>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {resolve, promise};};
beforeEach(() => {localStorage.clear(); document.body.replaceChildren(); document.documentElement.removeAttribute('style');});
afterEach(() => panel?.destroy());
describe('theme review flow (deterministic provider fixture, not live agent proof)', () => {
  it('sends only the explicit aesthetic contract and previews before saving', async () => {
    const core = mount(); aesthetic(); await panel.check(); button('Generate theme candidate').click();
    await vi.waitFor(() => expect(button('Apply theme').disabled).toBe(false));
    expect(core.askQuestion).toHaveBeenCalledOnce(); const [request, binding] = core.askQuestion.mock.calls[0] as unknown as [QuestionRequest, unknown];
    expect(request.context).toBe(''); expect(request.history).toEqual([]); expect(request.question).toContain('Warm library');
    expect(binding).toEqual({generation: 4, accountId: 'chosen-account', model: 'chosen-model'});
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull(); expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#0a0a14');
    expect(document.querySelector<HTMLElement>('.theme-live-sample')!.style.getPropertyValue('--bg')).toBe('#101010');
    expect(message()).toContain('Candidate preview — not saved'); expect(document.querySelector('[aria-label="Theme CSS diff"]')!.textContent).toContain('− #0a0a14');
    button('Apply theme').click(); expect(createThemeStore().state.accepted).toEqual(dark); expect(document.documentElement.style.getPropertyValue('--bg')).toBe(dark.bg);
  });
  it('persists across remounts, discards candidates on close, and resets/reverts', () => {
    mount(); paste(); panel.close(); expect(button('Apply theme').disabled).toBe(true); expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    paste(); button('Apply theme').click(); panel.destroy(); document.body.replaceChildren(); mount(); expect(document.documentElement.style.getPropertyValue('--bg')).toBe(dark.bg);
    button('Reset to baseline').click(); expect(createThemeStore().state.accepted).toBeNull(); expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#0a0a14');
    button('Revert accepted theme').click(); expect(createThemeStore().state.accepted).toEqual(dark);
    paste(JSON.stringify({...dark, radius: 4})); button('Discard candidate').click(); expect(createThemeStore().state.accepted?.radius).toBe(12);
  });
  it('rejects unsafe CSS and surfaces write failures without changing accepted state', () => {
    mount(); paste('{"css":"@import url(https://attacker.invalid)"}'); expect(message()).toContain('extra fields are rejected');
    expect(document.querySelector('style,script')).toBeNull(); expect(button('Apply theme').disabled).toBe(true);
    paste(); const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw new Error('Quota full');});
    button('Apply theme').click(); expect(message()).toContain('Quota full'); expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#0a0a14'); expect(button('Apply theme').disabled).toBe(false); spy.mockRestore();
  });
  it.each(['empty', 'incomplete', 'malformed', 'failure', 'usage'])('surfaces %s without retries or fallback', async kind => {
    const core = bridge();
    if (kind === 'failure') core.askQuestion.mockRejectedValue({message: 'OpenAI completed without answer text; no retry'});
    else core.askQuestion.mockImplementation(async request => ({requestId: request.requestId, text: kind === 'empty' ? '' : kind === 'malformed' ? 'bad' : JSON.stringify(dark), model: 'chosen-model', incomplete: kind === 'incomplete'}));
    if (kind === 'usage') core.questionStatus.mockResolvedValue({...status(), usageLimited: true});
    mount(core); aesthetic(); await panel.check(); button('Generate theme candidate').click();
    if (kind === 'usage') expect(core.askQuestion).not.toHaveBeenCalled();
    else {await vi.waitFor(() => expect(button('Cancel theme request').disabled).toBe(true)); expect(core.askQuestion).toHaveBeenCalledOnce();}
    expect(createThemeStore().state.accepted).toBeNull(); expect(button('Apply theme').disabled).toBe(true);
  });
  it('rejects a preset visibly when another window accepted a theme after this baseline panel opened', () => {
    mount(); createThemeStore().apply(dark); expect(panel.usePreset()).toBe(false); expect(message()).toContain('another window'); expect(createThemeStore().state.accepted).toEqual(dark);
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#0a0a14');
  });
  it('rejects an answer after connection generation changes', async () => {
    const core = mount(); aesthetic(); await panel.check(); core.questionStatus.mockResolvedValue({...status(), generation: 5}); button('Generate theme candidate').click();
    await vi.waitFor(() => expect(message()).toContain('Connection changed')); expect(button('Apply theme').disabled).toBe(true);
  });
  it('cancels stale answers without clearing a newer pending request', async () => {
    const first = deferred<QuestionAnswer>(), second = deferred<QuestionAnswer>(); const core = bridge();
    core.askQuestion.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    mount(core); aesthetic(); await panel.check(); button('Generate theme candidate').click(); const request1 = core.askQuestion.mock.calls[0][0];
    button('Cancel theme request').click(); button('Generate theme candidate').click(); const request2 = core.askQuestion.mock.calls[1][0];
    first.resolve({requestId: request1.requestId, text: JSON.stringify(dark), model: 'chosen-model', incomplete: false}); await Promise.resolve(); await Promise.resolve();
    expect(button('Cancel theme request').disabled).toBe(false); expect(button('Apply theme').disabled).toBe(true);
    second.resolve({requestId: request2.requestId, text: JSON.stringify(dark), model: 'chosen-model', incomplete: false}); await vi.waitFor(() => expect(button('Apply theme').disabled).toBe(false));
    expect(core.cancelQuestion).toHaveBeenCalledWith(request1.requestId);
  });
  it('ignores late responses after closing and invalidates candidates after editing', async () => {
    const response = deferred<QuestionAnswer>(); const core = bridge(); core.askQuestion.mockImplementationOnce(() => response.promise);
    mount(core); aesthetic(); await panel.check(); button('Generate theme candidate').click(); const request = core.askQuestion.mock.calls[0][0]; panel.close();
    response.resolve({requestId: request.requestId, text: JSON.stringify(dark), model: 'chosen-model', incomplete: false}); await Promise.resolve(); await Promise.resolve();
    expect(button('Apply theme').disabled).toBe(true); paste(); aesthetic('Different aesthetic'); expect(button('Apply theme').disabled).toBe(true);
  });
});
