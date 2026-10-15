// Theme, accent, measure, leading and writing-mode preferences for the full-screen editor.
// Values reach CSS only as custom properties set through the CSSOM, never as markup.
export const THEMES = [
  { id: 'arcades', name: 'Arcades', bg: '#0a0a14', surface: '#14142a', hover: '#1e1e3a', fg: '#e8e8ec', muted: '#9a9ab0', border: 'rgba(255,138,0,0.2)', strong: 'rgba(255,138,0,0.45)', chrome: 'rgba(10,10,20,0.85)', light: false, glow: true },
  { id: 'midnight', name: 'Midnight', bg: '#000000', surface: '#0a0a14', hover: '#14142a', fg: '#e8e8ec', muted: '#9a9ab0', border: 'rgba(232,232,236,0.12)', strong: 'rgba(232,232,236,0.3)', chrome: 'rgba(0,0,0,0.85)', light: false, glow: true },
  { id: 'paper', name: 'Paper', bg: '#faf9f7', surface: '#ffffff', hover: '#f0eeeb', fg: '#1a1a2e', muted: '#6b6b80', border: 'rgba(0,0,0,0.10)', strong: 'rgba(0,0,0,0.25)', chrome: 'rgba(250,249,247,0.88)', light: true, glow: true },
  { id: 'contrast', name: 'High contrast', bg: '#000000', surface: '#000000', hover: '#1f1f1f', fg: '#ffffff', muted: '#d6d6de', border: 'rgba(255,255,255,0.55)', strong: '#ffffff', chrome: 'rgba(0,0,0,0.96)', light: false, glow: false },
] as const;
export const ACCENTS = [
  { id: 'pink', name: 'Neon pink', dark: '#ff3cac', light: '#d42e90' },
  { id: 'orange', name: 'Neon orange', dark: '#ff8a00', light: '#e07800' },
  { id: 'gold', name: 'Gold', dark: '#ffaa00', light: '#cc8800' },
  { id: 'magenta', name: 'Magenta', dark: '#ff6b9d', light: '#c44f7a' },
] as const;
export const WIDTHS = [{ id: 'narrow', label: 'Narrow', value: '52ch' }, { id: 'medium', label: 'Medium', value: '68ch' }, { id: 'wide', label: 'Wide', value: '84ch' }] as const;
export const LEADINGS = [{ id: 'snug', label: 'Snug', value: 1.5 }, { id: 'airy', label: 'Airy', value: 1.75 }, { id: 'double', label: 'Double', value: 2 }] as const;

export type ThemeId = typeof THEMES[number]['id'];
export type AccentId = typeof ACCENTS[number]['id'];
export type WidthId = typeof WIDTHS[number]['id'];
export type LeadingId = typeof LEADINGS[number]['id'];
export interface Appearance { theme: ThemeId; accent: AccentId; width: WidthId; leading: LeadingId; fade: boolean; focus: boolean }

export const DEFAULT_APPEARANCE: Appearance = { theme: 'arcades', accent: 'pink', width: 'medium', leading: 'airy', fade: true, focus: false };
const STORAGE_KEY = 'heinlein-studio-appearance-v1';

const pick = <T extends { id: string }>(list: readonly T[], value: unknown, fallback: T['id']): T['id'] =>
  list.some(item => item.id === value) ? value as T['id'] : fallback;

export function parseAppearance(raw: unknown): Appearance {
  let data: unknown = raw;
  if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { data = null; } }
  const source = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return {
    theme: pick(THEMES, source.theme, DEFAULT_APPEARANCE.theme),
    accent: pick(ACCENTS, source.accent, DEFAULT_APPEARANCE.accent),
    width: pick(WIDTHS, source.width, DEFAULT_APPEARANCE.width),
    leading: pick(LEADINGS, source.leading, DEFAULT_APPEARANCE.leading),
    fade: typeof source.fade === 'boolean' ? source.fade : DEFAULT_APPEARANCE.fade,
    focus: typeof source.focus === 'boolean' ? source.focus : DEFAULT_APPEARANCE.focus,
  };
}
export function loadAppearance(): Appearance {
  try { return parseAppearance(localStorage.getItem(STORAGE_KEY)); } catch { return { ...DEFAULT_APPEARANCE }; }
}
export function saveAppearance(value: Appearance) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* storage is a convenience only */ }
}

export function accentColor(value: Pick<Appearance, 'theme' | 'accent'>): string {
  const theme = THEMES.find(item => item.id === value.theme)!; const accent = ACCENTS.find(item => item.id === value.accent)!;
  return theme.light ? accent.light : accent.dark;
}
function rgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
/** The custom properties a preference set resolves to; exported for tests and previews. */
export function appearanceVariables(value: Appearance): Record<string, string> {
  const theme = THEMES.find(item => item.id === value.theme)!;
  const accent = accentColor(value);
  return {
    '--bg': theme.bg, '--surface': theme.surface, '--surface-hover': theme.hover, '--fg': theme.fg, '--fg-muted': theme.muted,
    '--border': theme.border, '--border-strong': theme.strong, '--chrome-bg': theme.chrome,
    '--accent': accent, '--accent-glow': theme.glow ? rgba(accent, theme.light ? 0.12 : 0.22) : 'transparent',
    '--selection': rgba(accent, theme.light ? 0.22 : 0.35),
    '--measure': WIDTHS.find(item => item.id === value.width)!.value,
    '--leading-body': String(LEADINGS.find(item => item.id === value.leading)!.value),
  };
}
export function applyAppearance(value: Appearance, target: HTMLElement = document.documentElement) {
  const variables = appearanceVariables(value);
  for (const name in variables) target.style.setProperty(name, variables[name]);
  const theme = THEMES.find(item => item.id === value.theme)!;
  target.dataset.theme = theme.id;
  target.style.colorScheme = theme.light ? 'light' : 'dark';
  target.toggleAttribute('data-focus-mode', value.focus);
  target.toggleAttribute('data-fade-chrome', value.fade);
}
