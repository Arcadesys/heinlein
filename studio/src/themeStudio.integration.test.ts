// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {mountStudio} from './studio';
import type {LocalCore} from './localCore';
import {createThemeStore} from './themeTokens';
const tokens = {bg: '#101010', surface: '#181818', hover: '#222222', fg: '#ffffff', muted: '#bbbbbb', accent: '#ffcc66', border: '#aaaaaa', warn: '#ffdd88', danger: '#ffaaaa', radius: 12};
const source = 'Exact — words.\n\nA deliberate fragment.';
const session = {id: 'session', name: 'Synthetic', manifests: []};
let app: ReturnType<typeof mountStudio>;
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent === name)!;
beforeEach(() => {localStorage.clear(); document.body.replaceChildren(); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();});
afterEach(() => app?.destroy());
it('integrates with Appearance without changing manuscript text or invoking content writes', async () => {
  const core = {available: () => true, recentRepositories: vi.fn(async () => []), listSystemFonts: vi.fn(async () => []), listDirectory: vi.fn(async () => []), loadManuscript: vi.fn(), readDocument: vi.fn(async (_id, path) => ({path, text: source, sizeBytes: source.length, frontmatter: null, generatedCompatibility: false, contentHash: 'a'.repeat(64)})), readRecovery: vi.fn(async () => null), saveDocument: vi.fn(), stageRecovery: vi.fn(), discardRecovery: vi.fn(), setUnsavedChanges: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {})} as unknown as LocalCore;
  app = mountStudio(document.body, core); await app.selectRepository(async () => session); await app.showDocument('scene.md');
  const before = document.querySelector('.cm-content')!.textContent;
  document.dispatchEvent(new KeyboardEvent('keydown', {key: ',', ctrlKey: true, bubbles: true})); button('Vibecode theme').click();
  document.querySelector<HTMLTextAreaElement>('#theme-agent-json')!.value = JSON.stringify(tokens); button('Preview pasted tokens').click(); button('Apply theme').click();
  expect(document.querySelector('.cm-content')!.textContent).toBe(before); expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.stageRecovery).not.toHaveBeenCalled();
  expect(createThemeStore().state.accepted).toEqual(tokens);
  button('Theme').click(); button('Paper').click(); expect(createThemeStore().state.accepted).toBeNull(); expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#faf9f7');
  expect(document.querySelector('.cm-content')!.textContent).toBe(before);
});
