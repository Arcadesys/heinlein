// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { DEFAULT_APPEARANCE, appearanceVariables, applyAppearance, parseAppearance } from './appearance';
import { createPalette, filterItems, fuzzyMatch, scopeFor, type PaletteItem } from './palette';
import { formatKeys } from './shortcuts';
import { paragraphAround } from './focusMode';
import { FONT_PRESETS } from './fonts';
import { mountStudio as mount } from './studio';
import type { LocalCore, RepositorySession } from './localCore';

describe('appearance preferences', () => {
  it('defaults to Arcades with a pink accent and ignores malformed storage', () => {
    expect(parseAppearance('not json')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance({theme: 'paper', accent: 'nope', width: 'wide', fade: 'yes', focus: true}))
      .toEqual({...DEFAULT_APPEARANCE, theme: 'paper', width: 'wide', focus: true});
  });
  it('uses the light accent on Paper and drops the glow on High contrast', () => {
    expect(appearanceVariables({...DEFAULT_APPEARANCE, theme: 'paper'})['--accent']).toBe('#d42e90');
    expect(appearanceVariables({...DEFAULT_APPEARANCE, theme: 'contrast'})['--accent-glow']).toBe('transparent');
  });
  it('applies tokens and writing-mode flags to the target', () => {
    const node = document.createElement('div');
    applyAppearance({...DEFAULT_APPEARANCE, theme: 'midnight', width: 'narrow', leading: 'double', focus: true, fade: false}, node);
    expect(node.style.getPropertyValue('--bg')).toBe('#000000');
    expect(node.style.getPropertyValue('--measure')).toBe('52ch');
    expect(node.style.getPropertyValue('--leading-body')).toBe('2');
    expect(node.dataset.theme).toBe('midnight');
    expect(node.hasAttribute('data-focus-mode')).toBe(true);
    expect(node.hasAttribute('data-fade-chrome')).toBe(false);
  });
  it('offers Courier New as a text font', () => { expect(FONT_PRESETS.text).toContain('Courier New'); });
});

describe('palette matching', () => {
  it('matches subsequences, ignoring case and spaces', () => {
    expect(fuzzyMatch('spl sc', 'Split scene at cursor')).toBe(true);
    expect(fuzzyMatch('xyz', 'Split scene')).toBe(false);
    expect(fuzzyMatch('', 'anything')).toBe(true);
  });
  it('switches scope on a leading > or /', () => {
    expect(scopeFor('>save', 'scenes')).toBe('commands');
    expect(scopeFor('/ms', 'scenes')).toBe('files');
    expect(scopeFor('casino', 'files')).toBe('files');
  });
  it('filters on label and sub, without the scope prefix', () => {
    const items = [{key: 'a', label: 'Counted out', sub: 'ms/02.md', run() {}}, {key: 'b', label: 'Banco', sub: 'ms/04.md', run() {}}];
    expect(filterItems(items, '>04').map(item => item.key)).toEqual(['b']);
  });
});

describe('palette keyboard', () => {
  beforeEach(() => document.body.replaceChildren());
  function setup(reorder = vi.fn(async () => true)) {
    const ran: string[] = []; const closed = vi.fn();
    const scenes: PaletteItem[] = ['One', 'Two', 'Three'].map(label => ({key: label, label, run: () => ran.push(label)}));
    const palette = createPalette(document.body, {items: scope => scope === 'scenes' ? scenes : [{key: 'c', label: 'Save now', run: () => ran.push('save')}], reorder, closed});
    return {palette, ran, closed, reorder};
  }
  const key = (key: string, init: KeyboardEventInit = {}) => document.querySelector('.palette-input')!.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, ...init}));
  it('moves, runs the highlighted item, and closes', () => {
    const {palette, ran, closed} = setup(); palette.open('scenes');
    expect(document.activeElement).toBe(document.querySelector('.palette-input'));
    key('ArrowDown'); key('Enter');
    expect(ran).toEqual(['Two']); expect(palette.isOpen()).toBe(false); expect(closed).toHaveBeenCalledOnce();
  });
  it('cycles scope with Tab and closes on Escape', () => {
    const {palette, ran} = setup(); palette.open('scenes');
    key('Tab'); key('Tab'); expect(document.querySelector('.palette-scope')!.textContent).toBe('Commands');
    key('Enter'); expect(ran).toEqual(['save']);
    palette.open('files'); key('Escape'); expect(document.querySelector('.palette')).toBeNull();
  });
  it('asks to reorder scenes with Alt+arrows only when unfiltered', async () => {
    const {palette, reorder} = setup(); palette.open('scenes');
    key('ArrowDown', {altKey: true}); await Promise.resolve();
    expect(reorder).toHaveBeenCalledWith('One', 1);
    const input = document.querySelector<HTMLInputElement>('.palette-input')!; input.value = 'T'; input.dispatchEvent(new Event('input'));
    key('ArrowUp', {altKey: true}); expect(reorder).toHaveBeenCalledTimes(1);
  });
});

describe('helpers', () => {
  it('formats Mac shortcuts for other platforms', () => {
    expect(formatKeys('⌘⇧P', false)).toBe('Ctrl+Shift+P');
    expect(formatKeys('⌘=  ⌘−', false)).toBe('Ctrl+=  Ctrl+−');
    expect(formatKeys('⌘K', true)).toBe('⌘K');
  });
  it('finds the blank-line paragraph around a line', () => {
    const lines = ['# Title', '', 'one', 'two', '', 'three'];
    const text = (n: number) => lines[n - 1];
    expect(paragraphAround(text, 4, lines.length)).toEqual([3, 4]);
    expect(paragraphAround(text, 2, lines.length)).toEqual([2, 2]);
    expect(paragraphAround(text, 6, lines.length)).toEqual([6, 6]);
  });
});

describe('Studio chrome', () => {
  const apps: ReturnType<typeof mount>[] = [];
  const session: RepositorySession = {id: 'session', projectKey: 'project', name: 'La Ligne du Marais', manifests: []};
  function core(): LocalCore {
    return { available: () => true,
      pickRepository: vi.fn(async () => session), recentRepositories: vi.fn(async () => []), openRecentRepository: vi.fn(async () => session),
      listDirectory: vi.fn(async () => [{path: 'casino.md', name: 'casino.md', kind: 'file' as const, sizeBytes: 40}]),
      readDocument: vi.fn(async (_id, path) => ({path, text: 'Tuck spent a month in Paris.\n\nThen he found it.', sizeBytes: 44, frontmatter: null, contentHash: 'h1', generatedCompatibility: false})),
      loadManuscript: vi.fn(), saveDocument: vi.fn(), readRecovery: vi.fn(async () => null), stageRecovery: vi.fn(), discardRecovery: vi.fn(async () => {}),
      setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
      listSystemFonts: vi.fn(async () => ['Courier New']),
    } as unknown as LocalCore;
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const press = (key: string, init: KeyboardEventInit = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...init}));
  beforeEach(() => {
    localStorage.removeItem('heinlein-studio-navigation-v1');
    localStorage.removeItem('heinlein-studio-collapsed-v1');
    document.querySelectorAll('.cm-editor').forEach(node => EditorView.findFromDOM(node as HTMLElement)?.destroy());
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();
    document.body.replaceChildren(document.createElement('div'));
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  });
  afterEach(() => { apps.splice(0).forEach(app => app.destroy()); });
  async function start() {
    const app = mount(document.body.firstElementChild as HTMLElement, core()); apps.push(app);
    await app.selectRepository(async () => session); await settle(); return app;
  }
  it('shows the project in the status pill and opens a file from the palette', async () => {
    await start();
    expect(document.querySelector('.pill-project')!.textContent).toBe('La Ligne du Marais');
    press('p', {ctrlKey: true}); await settle();
    expect(document.querySelector('.palette-scope')!.textContent).toBe('Files');
    document.querySelector('.palette-input')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); await settle(); await settle();
    expect(document.querySelector('.pill-scene')!.textContent).toBe('casino.md');
    expect(document.querySelector('.pill-words')!.textContent).toBe('10 words');
    expect(document.querySelector('.cm-editor')).not.toBeNull();
  });
  it('shares one drawer across tabs and the keyboard shortcut without replacing the editor', async () => {
    const app = await start(); await app.showDocument('casino.md'); await settle();
    const editor = document.querySelector('.cm-editor');
    const repository = document.querySelector<HTMLElement>('#navigation-panel-files')!;
    const manuscript = document.querySelector<HTMLElement>('#navigation-panel-manuscript')!;
    document.querySelector<HTMLButtonElement>('#navigation-tab-manuscript')!.click();
    expect(repository.hidden).toBe(true); expect(manuscript.hidden).toBe(false);
    press('\\', {ctrlKey: true});
    expect(document.querySelector<HTMLElement>('#navigation-drawer')!.hidden).toBe(true);
    expect(document.querySelector('.workspace')!.classList.contains('navigation-open')).toBe(false);
    press('\\', {ctrlKey: true});
    expect(document.activeElement?.id).toBe('navigation-tab-manuscript');
    expect(document.querySelectorAll('.navigation-drawer')).toHaveLength(1);
    expect(document.querySelector('.cm-editor')).toBe(editor);
    document.querySelector<HTMLButtonElement>('#navigation-tab-files')!.click();
    expect(repository.hidden).toBe(false); expect(manuscript.hidden).toBe(true);
    expect(repository.querySelector('.file-entry')?.textContent).toContain('casino.md');
  });
  it('closes the command palette before focusing the navigation drawer', async () => {
    await start();
    press('p', {ctrlKey: true, shiftKey: true}); expect(document.querySelector('.palette')).not.toBeNull();
    press('\\', {ctrlKey: true});
    expect(document.querySelector('.palette')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('.navigation-toggle'));
    press('p', {ctrlKey: true, shiftKey: true}); press('\\', {ctrlKey: true});
    expect(document.querySelector('.palette')).toBeNull(); expect(document.activeElement?.id).toBe('navigation-tab-files');
  });
  it('toggles the shortcut sheet and Questions from the keyboard', async () => {
    const app = await start(); await app.showDocument('casino.md'); await settle();
    press('/', {ctrlKey: true}); expect(document.querySelector('.help-sheet')).not.toBeNull();
    press('Escape'); document.querySelector('.help-sheet')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(document.querySelector('.help-sheet')).toBeNull();
    press('j', {ctrlKey: true}); expect(document.querySelector<HTMLElement>('.question-panel')!.hidden).toBe(false);
    press('j', {ctrlKey: true}); expect(document.querySelector<HTMLElement>('.question-panel')!.hidden).toBe(true);
  });
  it('applies theme and Courier New live from the settings window', async () => {
    await start();
    press(',', {ctrlKey: true}); expect(document.querySelector('.settings-window')!.hasAttribute('open')).toBe(true);
    [...document.querySelectorAll<HTMLButtonElement>('.theme-card')].find(card => card.textContent === 'Paper')!.click();
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#faf9f7');
    [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Text font presets"] button')].find(chip => chip.textContent === 'Courier New')!.click();
    expect(document.documentElement.style.getPropertyValue('--font-text')).toContain('"Courier New"');
    document.querySelector<HTMLButtonElement>('[aria-label="Reset text font to default"]')!.click();
    [...document.querySelectorAll<HTMLButtonElement>('.theme-card')].find(card => card.textContent === 'Arcades')!.click();
  });
});
