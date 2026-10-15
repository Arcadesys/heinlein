// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {captureSelectionQuestion, createSelectionQuestionPanel, prepareSelectionReplacement, selectionQuestionAvailability,
  selectionQuestionContext, selectionQuestionProblem, selectionQuestionPrompt, type SelectionQuestionState, type SelectionReplacementReview} from './selectionQuestion';

// Indirect import keeps production TypeScript independent of Node type packages.
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
function state(source = 'prefix\r\nSelected — 🐺 e\u0301\r\nsuffix'): SelectionQuestionState {
  const from = source.indexOf('Selected'); const to = source.indexOf('\r\nsuffix');
  return {repositoryId: 'synthetic-session', path: 'ms/synthetic.md', sceneId: 'synthetic-scene', documentEpoch: 2, revision: 3,
    source, sourceHash: 'persisted-before-unsaved-edit', from: from < 0 ? 0 : from, to: to < 0 ? source.length : to,
    readOnly: false, recoveryPending: false, busy: false, detached: false};
}
let current: SelectionQuestionState;
let panel: ReturnType<typeof createSelectionQuestionPanel> | undefined;
let apply: ReturnType<typeof vi.fn<(review: SelectionReplacementReview) => boolean>>;
let report: ReturnType<typeof vi.fn>;
let clipboard: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function button(label: string) {
  const node = [...document.querySelectorAll('button')].find(node => node.textContent === label);
  if (!node) throw new Error(`Missing button: ${label}`); return node;
}
function input(label: string, value: string) {
  const node = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  node.value = value; node.dispatchEvent(new Event('input', {bubbles: true})); return node;
}
function replacement(value: string) { return input('Proposed replacement (paste text only)', value); }
async function open() {
  panel = createSelectionQuestionPanel({root: document.body, current: () => current, apply, report, writeClipboard: clipboard});
  expect(await panel.open()).toBe(true);
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); document.body.replaceChildren(); current = state();
  apply = vi.fn(() => true); report = vi.fn(); clipboard = vi.fn(async () => {});
});
afterEach(() => { panel?.destroy(); panel = undefined; vi.unstubAllGlobals(); });

describe('immutable local selection bindings', () => {
  it('hashes exact UTF-8 bytes including CRLF, BOM, astral Unicode and combining marks', async () => {
    current = state('\ufeffprefix\r\nSelected — 🐺 e\u0301\r\nsuffix');
    const snapshot = await captureSelectionQuestion(current);
    expect(snapshot.source).toBe(current.source); expect(snapshot.selectedText).toBe('Selected — 🐺 e\u0301');
    expect(snapshot.fromUtf8).toBe(new TextEncoder().encode(current.source.slice(0, current.from)).length);
    expect(snapshot.toUtf8 - snapshot.fromUtf8).toBe(new TextEncoder().encode(snapshot.selectedText).length);
    expect(snapshot.sourceUtf8Bytes).toBe(new TextEncoder().encode(current.source).length);
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(current.source));
    expect(snapshot.sourceSha256).toBe([...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join(''));
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
  it('matches the standard SHA-256 vector', async () => {
    expect((await captureSelectionQuestion(state('abc'))).sourceSha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it.each(['repositoryId', 'path', 'sceneId', 'documentEpoch', 'revision', 'source', 'from', 'to'] as const)('rejects changed %s', async field => {
    const snapshot = await captureSelectionQuestion(current);
    const changes = {repositoryId: 'another-session', path: 'another.md', sceneId: 'another-scene', documentEpoch: 4, revision: 5, source: `${current.source}!`, from: current.from + 1, to: current.to - 1};
    expect(selectionQuestionProblem(snapshot, {...current, [field]: changes[field]})).not.toBeNull();
    expect(() => prepareSelectionReplacement(snapshot, 'new', {...current, [field]: changes[field]})).toThrow();
  });
  it('rejects edit-and-undo even when source returns to identical bytes', async () => {
    const snapshot = await captureSelectionQuestion(current);
    expect(selectionQuestionProblem(snapshot, {...current, revision: current.revision + 2})).toContain('scene changed');
  });
  it('permits autosave acknowledging the identical current buffer', async () => {
    const snapshot = await captureSelectionQuestion(current);
    expect(selectionQuestionProblem(snapshot, {...current, sourceHash: snapshot.sourceSha256})).toBeNull();
  });
  it.each(['readOnly', 'recoveryPending', 'busy', 'detached'] as const)('rejects unsafe %s before capture and after review', async flag => {
    const snapshot = await captureSelectionQuestion(current); current = {...current, [flag]: true};
    expect(selectionQuestionAvailability(current)).not.toBeNull();
    await expect(captureSelectionQuestion(current)).rejects.toThrow();
    expect(selectionQuestionProblem(snapshot, current)).not.toBeNull();
  });
  it('rejects absent documents, empty/out-of-range ranges and partial Unicode/newlines', async () => {
    expect(selectionQuestionAvailability(null)).not.toBeNull();
    for (const range of [{from: 0, to: 0}, {from: -1, to: 3}, {from: 0, to: 999}, {from: NaN, to: 3}, {from: 0.5, to: 3}])
      expect(selectionQuestionAvailability({...current, ...range})).not.toBeNull();
    for (const [source, from, to] of [['a\r\nb', 0, 2], ['a\r\nb', 2, 4], ['a🐺b', 0, 2], ['a🐺b', 2, 4]] as const)
      expect(selectionQuestionAvailability({...state(source), from, to})).toContain('complete');
    await expect(captureSelectionQuestion(state('incomplete \ud800'))).rejects.toThrow('incomplete Unicode');
  });
  it('fails closed when local SHA-256 is unavailable', async () => {
    vi.stubGlobal('crypto', {}); await expect(captureSelectionQuestion(current)).rejects.toThrow('SHA-256 is unavailable');
  });
  it('preserves exact source outside the replacement and freezes the reviewed splice', async () => {
    const snapshot = await captureSelectionQuestion(current);
    const review = prepareSelectionReplacement(snapshot, 'New — 𝄞\r\nline\n', current);
    expect(review.nextSource).toBe('prefix\r\nNew — 𝄞\r\nline\n\r\nsuffix');
    expect(Object.isFrozen(review)).toBe(true);
    expect(() => prepareSelectionReplacement(snapshot, '\ud800', current)).toThrow('incomplete Unicode');
  });
  it('preserves a replacement BOM instead of treating it as a decoder marker', async () => {
    const snapshot = await captureSelectionQuestion(current);
    expect(prepareSelectionReplacement(snapshot, '\ufeffNew', current).nextSource).toBe('prefix\r\n\ufeffNew\r\nsuffix');
  });
  it.each(['🐺', '\r\n'])('does not split %s at the optional context boundaries', async atom => {
    const source = atom + 'p'.repeat(599) + 'X' + 's'.repeat(599) + atom;
    const from = atom.length + 599; const active = {...state(source), from, to: from + 1};
    const context = selectionQuestionContext(await captureSelectionQuestion(active));
    expect(context.before).toBe('p'.repeat(599)); expect(context.after).toBe('s'.repeat(599));
  });
  it.each([
    {source: 'a\rb\nc', from: 2, to: 3, replacement: ''},
    {source: 'a\rb\nc', from: 2, to: 3, replacement: '\nnew'},
    {source: 'a\rb\nc', from: 2, to: 3, replacement: 'new\r'},
  ])('rejects a replacement that fuses adjacent CR/LF breaks: $replacement', async example => {
    const active = {...state(example.source), from: example.from, to: example.to};
    const snapshot = await captureSelectionQuestion(active);
    expect(() => prepareSelectionReplacement(snapshot, example.replacement, active)).toThrow('separate CR/LF');
  });
  it('includes only selected text by default and visibly bounded scene context on request', async () => {
    current = {...state(), source: `NEVER SHARE${'p'.repeat(700)}SELECTED${'s'.repeat(700)}PRIVATE TAIL`, from: 711, to: 719};
    const snapshot = await captureSelectionQuestion(current); const question = 'Keep the em dash?';
    expect(selectionQuestionPrompt(snapshot, question, false)).not.toContain('pppp');
    const context = selectionQuestionContext(snapshot); expect(context.before.length).toBe(600); expect(context.after.length).toBe(600);
    const prompt = selectionQuestionPrompt(snapshot, question, true);
    expect(prompt).toContain(context.before); expect(prompt).toContain(context.after);
    expect(prompt).not.toContain('NEVER SHARE'); expect(prompt).not.toContain('PRIVATE TAIL');
  });
});

describe('manual selection question dialog', () => {
  it('is honest, accessible, inert and copies nothing until an explicit click', async () => {
    current = state('prefix\r\nSelected <img src=x onerror=alert(1)> — 🐺\r\nsuffix'); await open();
    expect(document.querySelector('dialog')?.textContent).toContain('Manual copy/paste handoff. No provider is connected.');
    expect(document.querySelector('img, script, iframe')).toBeNull();
    expect(document.querySelector('[aria-label="Exact selected source"]')?.textContent).toBe(current.source.slice(current.from, current.to));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Your question');
    expect(clipboard).not.toHaveBeenCalled(); expect(button('Copy prompt for ChatGPT').disabled).toBe(true);
    input('Your question', 'How does this image work?'); expect(clipboard).not.toHaveBeenCalled();
    button('Copy prompt for ChatGPT').click(); await tick();
    expect(clipboard).toHaveBeenCalledTimes(1); expect(clipboard.mock.calls[0][0]).not.toContain('prefix');
    expect(clipboard.mock.calls[0][0]).toContain(current.source.slice(current.from, current.to));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('No provider is connected');
  });
  it('exposes surrounding context only after opt-in and copies exactly the shown prompt', async () => {
    await open(); input('Your question', 'Question');
    expect(document.querySelector('[aria-label="Optional scene context"]')?.textContent).toBe('');
    const checkbox = document.querySelector<HTMLInputElement>('input[type=checkbox]')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    expect(document.querySelector('[aria-label="Optional scene context"]')?.textContent).toContain('prefix');
    button('Copy prompt for ChatGPT').click(); await tick();
    expect(clipboard.mock.calls[0][0]).toBe(document.querySelector('[aria-label="Complete prompt to copy"]')?.textContent);
    checkbox.checked = false; checkbox.dispatchEvent(new Event('change'));
    expect(document.querySelector('[aria-label="Optional scene context"]')?.textContent).toBe('');
  });
  it.each(['rejected', 'synchronous'] as const)('offers manual selection when clipboard %s failure occurs', async failure => {
    clipboard = vi.fn(() => { if (failure === 'synchronous') throw new Error('Denied'); return Promise.reject(new Error('Denied')); });
    await open(); input('Your question', 'Question'); button('Copy prompt for ChatGPT').click(); await tick();
    const manual = button('Select prompt for manual copy'); expect(manual.hidden).toBe(false); expect(document.activeElement).toBe(manual);
    manual.click(); expect(document.getSelection()?.toString()).toBe(document.querySelector('[aria-label="Complete prompt to copy"]')?.textContent);
    expect(apply).not.toHaveBeenCalled();
  });
  it('offers manual copy when the platform has no clipboard API', async () => {
    vi.stubGlobal('navigator', {});
    panel = createSelectionQuestionPanel({root: document.body, current: () => current, apply, report});
    expect(await panel.open()).toBe(true); input('Your question', 'Question');
    button('Copy prompt for ChatGPT').click(); await tick();
    expect(button('Select prompt for manual copy').hidden).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Clipboard unavailable');
  });
  it('requires a separate review and consumes application before a second click', async () => {
    await open(); const applyButton = button('Apply reviewed replacement'); expect(applyButton.disabled).toBe(true);
    expect(button('Review replacement').disabled).toBe(true);
    replacement('Replacement — 🐺'); applyButton.click(); expect(apply).not.toHaveBeenCalled();
    button('Review replacement').click(); expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Replacement review"]')?.textContent).toContain('Replacement — 🐺');
    applyButton.click(); applyButton.click(); expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].nextSource).toBe('prefix\r\nReplacement — 🐺\r\nsuffix');
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('invalidates reviewed replacement on input and rejects programmatic value changes without input', async () => {
    await open(); replacement('First'); button('Review replacement').click();
    replacement('Second'); expect(button('Apply reviewed replacement').disabled).toBe(true);
    button('Review replacement').click(); document.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Proposed"]')!.value = 'Unreviewed';
    button('Apply reviewed replacement').click(); expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Review it again');
  });
  it('requires explicit empty input review and warns before deletion', async () => {
    await open(); replacement(''); button('Review replacement').click();
    expect(document.querySelector('[aria-label="Replacement review"]')?.textContent).toContain('delete the selected passage');
    button('Apply reviewed replacement').click(); expect(apply.mock.calls[0][0].replacement).toBe('');
  });
  it('renders pasted HTML, script and Markdown fences literally without fetching', async () => {
    await open(); replacement('<script>alert(1)</script><img src="https://example.invalid/x">\n```markdown\n—\n```');
    button('Review replacement').click(); expect(document.querySelector('script,img,a,iframe')).toBeNull();
    expect(document.querySelector('[aria-label="Replacement review"]')?.textContent).toContain('<script>alert(1)</script>');
  });
  it.each(['source', 'revision', 'from', 'path', 'readOnly', 'recoveryPending', 'busy', 'detached'] as const)('blocks stale apply after %s changes', async field => {
    await open(); replacement('New'); button('Review replacement').click();
    const changes = {source: `${current.source}!`, revision: current.revision + 1, from: current.from + 1, path: 'other.md', readOnly: true, recoveryPending: true, busy: true, detached: true};
    current = {...current, [field]: changes[field]}; button('Apply reviewed replacement').click();
    expect(apply).not.toHaveBeenCalled(); expect(button('Apply reviewed replacement').disabled).toBe(true);
  });
  it.each(['false', 'throw'] as const)('never retries an uncertain apply callback returning %s in the same dialog', async failure => {
    apply = vi.fn(() => { if (failure === 'throw') throw new Error('uncertain'); return false; });
    await open(); replacement('New'); button('Review replacement').click(); button('Apply reviewed replacement').click();
    replacement('Another'); button('Review replacement').click(); button('Apply reviewed replacement').click();
    expect(apply).toHaveBeenCalledTimes(1); expect(button('Review replacement').disabled).toBe(true);
  });
  it.each(['Cancel', 'Escape', 'cancel event', 'clear', 'destroy'] as const)('cancels without changes via %s and restores focus', async mode => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    await open(); replacement('New'); button('Review replacement').click();
    if (mode === 'Cancel') button('Cancel').click();
    else if (mode === 'Escape') document.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    else if (mode === 'cancel event') document.querySelector('dialog')!.dispatchEvent(new Event('cancel', {cancelable: true}));
    else if (mode === 'clear') panel!.clear(); else panel!.destroy();
    expect(apply).not.toHaveBeenCalled(); expect(document.querySelector('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
  });
  it('cannot reopen after cancellation during the asynchronous hash', async () => {
    let finish!: (value: ArrayBuffer) => void; vi.stubGlobal('crypto', {subtle: {digest: () => new Promise(resolve => {finish = resolve;})}});
    panel = createSelectionQuestionPanel({root: document.body, current: () => current, apply, report});
    const pending = panel.open(); panel.clear(); finish(new ArrayBuffer(32)); expect(await pending).toBe(false);
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('rejects changed source during asynchronous hash and prevents duplicate dialogs', async () => {
    let finish!: (value: ArrayBuffer) => void; vi.stubGlobal('crypto', {subtle: {digest: () => new Promise(resolve => {finish = resolve;})}});
    panel = createSelectionQuestionPanel({root: document.body, current: () => current, apply, report});
    const pending = panel.open(); expect(await panel.open()).toBe(false); current = {...current, revision: current.revision + 1};
    finish(new ArrayBuffer(32)); expect(await pending).toBe(false); expect(document.querySelector('dialog')).toBeNull();
    expect(report).toHaveBeenCalledWith(expect.stringContaining('scene changed'), true);
  });
  it('ignores delayed clipboard completion after close without reopening or applying', async () => {
    let finish!: () => void; clipboard = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    await open(); input('Your question', 'Question'); button('Copy prompt for ChatGPT').click(); button('Cancel').click();
    finish(); await tick(); expect(document.querySelector('dialog')).toBeNull(); expect(apply).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
  });
});
