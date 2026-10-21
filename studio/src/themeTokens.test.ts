// @vitest-environment jsdom
import {beforeEach, describe, expect, it} from 'vitest';
import {createThemeStore, contrast, parseTheme, renderTheme, THEME_STORAGE_KEY, themeCSS, themePrompt, validateTheme} from './themeTokens';
import {DEFAULT_APPEARANCE} from './appearance';
const dark = {bg: '#101010', surface: '#181818', hover: '#222222', fg: '#ffffff', muted: '#bbbbbb', accent: '#ffcc66', border: '#aaaaaa', warn: '#ffdd88', danger: '#ffaaaa', radius: 12};
const light = {...dark, bg: '#ffffff', surface: '#fafafa', hover: '#eeeeee', fg: '#111111', muted: '#444444', accent: '#553300', border: '#555555', warn: '#553311', danger: '#770022', radius: 0};
beforeEach(() => localStorage.clear());
describe('theme boundary', () => {
  it('accepts accessible dark and light tokens and computes known WCAG ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBe(21); expect(validateTheme(dark)).toEqual(dark); expect(validateTheme(light)).toEqual(light);
  });
  it('rejects URLs, CSS syntax, selectors, unknown fields and nonopaque colours in every colour slot', () => {
    for (const key of Object.keys(dark).filter(key => key !== 'radius')) {
      for (const value of ['url(https://attacker.invalid/x)', '@import "x"', '#fff', '#ffffff00', 'var(--secret)', 'red;display:none', '</style><script>', 'rgba(0,0,0,0)']) expect(() => validateTheme({...dark, [key]: value})).toThrow();
    }
    for (const extra of ['css', 'font', 'selector', 'content', '__proto__', 'logic']) expect(() => parseTheme(JSON.stringify(dark).replace('}', `,"${extra}":"x"}`))).toThrow();
    for (const value of [null, [], {}, {...dark, fg: '#181818'}, {...dark, border: '#181818'}, {...dark, accent: '#222222'}, {...dark, radius: -1}, {...dark, radius: 25}, {...dark, radius: 1.1}]) expect(() => validateTheme(value)).toThrow();
    expect(() => parseTheme('```json\n' + JSON.stringify(dark) + '\n```')).toThrow(/JSON/);
    expect(() => parseTheme(' '.repeat(4097))).toThrow(/4,096/);
  });
  it('renders only owned properties, preserving type, measure, content and other styles', () => {
    const host = document.createElement('div'); host.textContent = 'Exact — words'; host.style.setProperty('--font-text', 'Georgia');
    renderTheme(host, dark, DEFAULT_APPEARANCE); expect(host.style.getPropertyValue('--gradient')).toBe(dark.accent); expect(host.style.getPropertyValue('--on-accent')).toBe('#000000');
    expect(themeCSS(dark)).toContain('.theme-scope {'); expect(themeCSS(dark)).not.toMatch(/url|@import|content:/);
    renderTheme(host, null, DEFAULT_APPEARANCE); expect(host.style.getPropertyValue('--on-accent')).toBe(''); expect(host.style.getPropertyValue('--font-text')).toBe('Georgia'); expect(host.textContent).toBe('Exact — words');
  });
  it('bounds aesthetic input and creates a token-only request', () => {
    expect(themePrompt('Warm library')).toContain('Warm library'); expect(() => themePrompt('')).toThrow(); expect(() => themePrompt('x'.repeat(1201))).toThrow(); expect(() => themePrompt('界'.repeat(1200))).toThrow(/UTF-8/);
  });
});
describe('accepted theme persistence', () => {
  it('persists apply, previous theme, revert and baseline reset across store reopening', () => {
    let store = createThemeStore(); store.apply(dark); store = createThemeStore(); expect(store.state.accepted).toEqual(dark);
    store.apply(light); store = createThemeStore(); expect(store.state.previous).toEqual(dark);
    store.revert(); expect(createThemeStore().state.accepted).toEqual(dark);
    store.reset(); expect(createThemeStore().state.accepted).toBeNull(); store = createThemeStore(); store.revert(); expect(store.state.accepted).toEqual(dark);
  });
  it('retains accepted state after write failure and refuses stale cross-window writes', () => {
    const store = createThemeStore(); store.apply(dark);
    const stale = createThemeStore(); store.apply(light); expect(() => stale.reset()).toThrow(/another window/);
    const failing = createThemeStore({getItem: () => null, setItem: () => {throw new Error('Storage full');}} as unknown as Storage);
    expect(() => failing.apply(dark)).toThrow(/Storage full/); expect(failing.state.accepted).toBeNull();
  });
  it('fails closed for corrupt or unsafe saved tokens and repairs them only on reset', () => {
    localStorage.setItem(THEME_STORAGE_KEY, '{bad'); const store = createThemeStore(); expect(store.state.accepted).toBeNull(); expect(store.warning).toContain('could not be loaded');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('{bad'); store.reset(); expect(createThemeStore().warning).toBe('');
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({version: 1, accepted: {...dark, bg: 'url(x)'}, previous: null, canRevert: false})); expect(createThemeStore().state.accepted).toBeNull();
  });
});
