// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createManuscriptSearch, editorOffset, literalMatches, SEARCH_LIMITS, type SearchScope} from './manuscriptSearch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return {promise, resolve};
}
function setup(overrides: Partial<SearchScope> = {}) {
  const read = vi.fn(async (_path: string) => 'needle');
  let scope: SearchScope | null = {key: 'book-a', title: 'Synthetic book', scenes: [{path: 'one.md', title: 'One'}], read, ...overrides};
  const openResult = vi.fn(); const closed = vi.fn();
  const search = createManuscriptSearch(document.body, {scope: () => scope, openResult, closed});
  search.open();
  const input = document.querySelector<HTMLInputElement>('input[type=search]')!;
  const checkbox = document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  const results = () => [...document.querySelectorAll<HTMLButtonElement>('.manuscript-search-result')];
  const status = () => document.querySelector('[role=status]')?.textContent;
  const enter = (value: string) => {input.value = value; input.dispatchEvent(new Event('input', {bubbles: true}));};
  const submit = () => document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
  const button = (text: string) => [...document.querySelectorAll('button')].find(button => button.textContent === text)!;
  return {search, read, openResult, closed, input, checkbox, results, status, enter, submit, button, setScope: (next: SearchScope | null) => {scope = next;}};
}
beforeEach(() => {vi.useFakeTimers(); document.body.replaceChildren();});
afterEach(() => {vi.useRealTimers(); document.body.replaceChildren();});

describe('literal manuscript matches', () => {
  it.each(['.', '*', '+', '?', '^', '$', '{x}', '(x)', '|', '[x]', '\\', 'a.*[x]'])('treats %s literally', query => {
    const source = `prefix ${query} suffix`;
    const matches = literalMatches(source, query, true);
    expect(matches).toHaveLength(1);
    expect(source.slice(matches[0].from, matches[0].to)).toBe(query);
  });
  it('keeps original UTF-16 offsets after length-changing lowercase characters and astral text', () => {
    const source = 'İ🐺 prefix NEEDLE and needle';
    const matches = literalMatches(source, 'needle', false);
    expect(matches.map(match => match.from)).toEqual([source.indexOf('NEEDLE'), source.indexOf('needle')]);
    expect(matches.map(match => source.slice(match.from, match.to))).toEqual(['NEEDLE', 'needle']);
    expect(literalMatches('ſ K', 's', false)[0]).toMatchObject({from: 0, to: 1});
    expect(literalMatches('ſ K', 'k', false)[0]).toMatchObject({from: 2, to: 3});
  });
  it('honors match case', () => {
    expect(literalMatches('Word word WORD', 'word', true).map(match => match.from)).toEqual([5]);
    expect(literalMatches('Word word WORD', 'word', false)).toHaveLength(3);
  });
  it('counts mixed CRLF, bare CR and LF lines and preserves protected em dashes', () => {
    const source = '— first\r\n— second\r— third\n— fourth';
    const matches = literalMatches(source, '—', true);
    expect(matches.map(match => match.line)).toEqual([1, 2, 3, 4]);
    expect(matches.map(match => editorOffset(source, match.from))).toEqual([0, 8, 17, 25]);
    expect(matches.every(match => match.excerpt.includes('— first — second — third — fourth'))).toBe(true);
    expect(source).toBe('— first\r\n— second\r— third\n— fourth');
  });
  it('maps match ranges into newline-normalized editor coordinates', () => {
    const source = '🐺\r\na\rb\nneedle\r\nend';
    const match = literalMatches(source, 'needle', true)[0];
    const normalized = source.replace(/\r\n|\r/g, '\n');
    expect(normalized.slice(editorOffset(source, match.from), editorOffset(source, match.to))).toBe('needle');
  });
  it('returns bounded, non-overlapping matches and rejects invalid query lengths', () => {
    expect(literalMatches('aaaaa', 'aa', true).map(match => match.from)).toEqual([0, 2]);
    expect(literalMatches('a'.repeat(SEARCH_LIMITS.results + 1), 'a', true)).toHaveLength(SEARCH_LIMITS.results);
    expect(literalMatches('aaa', 'a', true, 2)).toHaveLength(2);
    expect(literalMatches('aaa', 'a', true, 0)).toEqual([]);
    expect(literalMatches('aaa', '', false)).toEqual([]);
    expect(literalMatches('a'.repeat(257), 'a'.repeat(257), true)).toEqual([]);
    expect(literalMatches('a'.repeat(256), 'a'.repeat(256), true)).toHaveLength(1);
  });
  it('bounds excerpts without altering source text', () => {
    const source = 'x'.repeat(100) + '— needle —' + 'y'.repeat(100);
    const match = literalMatches(source, 'needle', true)[0];
    expect(match.excerpt.startsWith('…')).toBe(true); expect(match.excerpt.endsWith('…')).toBe(true);
    expect(match.excerpt).toContain('— needle —'); expect(match.excerpt.length).toBeLessThanOrEqual(48 + 6 + 80 + 2);
  });
});

describe('explicit read-only manuscript search panel', () => {
  it('does not read on opening, typing, or changing match case', async () => {
    const ui = setup(); ui.enter('needle'); ui.checkbox.checked = true; ui.checkbox.dispatchEvent(new Event('change')); ui.search.open();
    await vi.runAllTimersAsync(); expect(ui.read).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.manuscript-search')).toHaveLength(1); expect(document.activeElement).toBe(ui.input);
    ui.submit(); await vi.runAllTimersAsync(); expect(ui.read).toHaveBeenCalledExactlyOnceWith('one.md'); expect(ui.results()).toHaveLength(1);
  });
  it('uses the unsaved buffer and returns exact source and scope key when opening a result', async () => {
    const source = '🐺\r\nunsaved — needle'; const ui = setup({buffer: {path: 'one.md', text: source}});
    ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync(); expect(ui.read).not.toHaveBeenCalled(); ui.results()[0].click();
    expect(ui.openResult).toHaveBeenCalledExactlyOnceWith({path: 'one.md', title: 'One', from: source.indexOf('needle'), to: source.length, line: 2, excerpt: '🐺 unsaved — needle'}, source, 'book-a');
    expect(ui.closed).toHaveBeenCalledOnce(); expect(ui.search.isOpen()).toBe(false);
  });
  it('reads other scenes, deduplicates paths, and honors case selection', async () => {
    const ui = setup({scenes: [{path: 'one.md', title: 'One'}, {path: 'two.md', title: 'Two'}, {path: 'two.md', title: 'Two'}], buffer: {path: 'one.md', text: 'NEEDLE'}});
    ui.checkbox.checked = true; ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync();
    expect(ui.read).toHaveBeenCalledExactlyOnceWith('two.md'); expect(ui.results()).toHaveLength(1); expect(ui.status()).toContain('2 of 2 scenes searched');
  });
  it('rejects empty and oversized queries without reading', async () => {
    const ui = setup(); ui.submit(); await vi.runAllTimersAsync(); expect(ui.status()).toContain('Enter 1–256');
    ui.enter('x'.repeat(257)); ui.submit(); await vi.runAllTimersAsync(); expect(ui.read).not.toHaveBeenCalled();
  });
  it('handles absent scope without reading', async () => {
    const ui = setup(); ui.setScope(null); ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync();
    expect(ui.status()).toContain('Open a manuscript'); expect(ui.read).not.toHaveBeenCalled();
  });
  it('renders titles, paths, and excerpts as text without HTML interpretation', async () => {
    const path = '<img src=x onerror=alert(1)>.md'; const title = '<script>bad()</script>'; const source = '<svg onload=bad()>needle</svg> —';
    const ui = setup({scenes: [{path, title}], buffer: {path, text: source}}); ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync();
    expect(ui.results()[0].textContent).toContain(title); expect(ui.results()[0].textContent).toContain(path); expect(ui.results()[0].textContent).toContain(source);
    expect(document.querySelector('img, script, svg')).toBeNull();
  });
  it('reports read failures and oversized scenes while continuing valid scenes', async () => {
    const read = vi.fn(async (path: string) => {if (path === 'bad') throw new Error('private error details'); return path === 'large' ? 'x'.repeat(SEARCH_LIMITS.sceneChars + 1) : 'needle';});
    const ui = setup({read, scenes: ['bad', 'large', 'good'].map(path => ({path, title: path}))}); ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync();
    expect(ui.results()).toHaveLength(1); expect(ui.status()).toContain('1 unreadable scenes skipped'); expect(ui.status()).toContain('1 oversized scenes skipped'); expect(ui.status()).not.toContain('private error details');
  });
  it('stops at the result limit without reading subsequent scenes', async () => {
    const ui = setup({buffer: {path: 'one.md', text: 'needle '.repeat(SEARCH_LIMITS.results + 1)}, scenes: [{path: 'one.md', title: 'One'}, {path: 'two.md', title: 'Two'}]});
    ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync(); expect(ui.results()).toHaveLength(SEARCH_LIMITS.results); expect(ui.read).not.toHaveBeenCalled(); expect(ui.status()).toContain('Search limit reached');
  });
  it('bounds scene count', async () => {
    const read = vi.fn(async (_path: string) => 'no match');
    const ui = setup({read, scenes: Array.from({length: SEARCH_LIMITS.scenes + 1}, (_, i) => ({path: `${i}.md`, title: `${i}`}))});
    ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync(); expect(read).toHaveBeenCalledTimes(SEARCH_LIMITS.scenes); expect(ui.status()).toContain('Search limit reached');
  });
  it('bounds total scanned characters', async () => {
    const read = vi.fn(async (_path: string) => 'x'.repeat(SEARCH_LIMITS.sceneChars));
    const ui = setup({read, scenes: Array.from({length: 6}, (_, i) => ({path: `${i}.md`, title: `${i}`}))});
    ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync(); expect(read).toHaveBeenCalledTimes(5); expect(ui.status()).toContain('4 of 6 scenes searched'); expect(ui.status()).toContain('Search limit reached');
  });
  it.each(['input', 'close', 'cancel', 'scope'] as const)('discards an async completion after %s', async action => {
    const pending = deferred<string>(); const read = vi.fn(() => pending.promise); const ui = setup({read});
    ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync(); expect(read).toHaveBeenCalledOnce();
    if (action === 'input') ui.enter('new query'); if (action === 'close') ui.search.close(); if (action === 'cancel') ui.button('Cancel search').click();
    if (action === 'scope') ui.setScope({key: 'book-b', title: 'Other', scenes: [], read});
    pending.resolve('needle'); await vi.runAllTimersAsync(); expect(ui.results()).toHaveLength(0); expect(ui.openResult).not.toHaveBeenCalled();
    if (action === 'cancel') expect(ui.status()).toBe('Search canceled.'); if (action === 'scope') expect(ui.status()).toContain('manuscript changed');
  });
  it('does not let an older request overwrite a newer search or hide its cancel control', async () => {
    const old = deferred<string>(); const newer = deferred<string>(); const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const ui = setup({read}); ui.enter('old'); ui.submit(); await vi.runAllTimersAsync(); ui.enter('new'); ui.submit(); await vi.runAllTimersAsync();
    old.resolve('old'); await vi.runAllTimersAsync(); expect(ui.results()).toHaveLength(0); expect(ui.button('Cancel search').hidden).toBe(false);
    newer.resolve('new'); await vi.runAllTimersAsync(); expect(ui.results()).toHaveLength(1); expect(ui.results()[0].textContent).toContain('new'); expect(ui.button('Cancel search').hidden).toBe(true);
  });
  it('prevents opening snapshot results after a scope change', async () => {
    const ui = setup(); ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync(); const stale = ui.results()[0]; ui.setScope(null); stale.click();
    expect(ui.openResult).not.toHaveBeenCalled(); expect(ui.results()).toHaveLength(0);
  });
  it('clears prior results on case changes, and closes on Escape except during composition', async () => {
    const ui = setup(); ui.enter('needle'); ui.submit(); await vi.runAllTimersAsync(); ui.checkbox.dispatchEvent(new Event('change')); expect(ui.results()).toHaveLength(0);
    ui.input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', isComposing: true, bubbles: true})); expect(ui.search.isOpen()).toBe(true);
    ui.input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); expect(ui.search.isOpen()).toBe(false); expect(ui.closed).toHaveBeenCalledOnce();
    ui.search.close(); expect(ui.closed).toHaveBeenCalledOnce();
  });
});
