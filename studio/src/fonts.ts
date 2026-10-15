// Interface / text / monospace font choices, in the manner of Obsidian's Appearance settings.
// A choice is just a family name; it reaches CSS as a quoted string via the CSSOM, never as markup.
export const FONT_ROLES = [
  { key: 'ui', label: 'Interface font', hint: 'Menus, buttons, and labels.', property: '--font-ui', fallback: 'var(--ui-fallback)' },
  { key: 'text', label: 'Text font', hint: 'The source text you read. Blank follows the monospace font.', property: '--font-text', fallback: 'var(--font-mono)' },
  { key: 'mono', label: 'Monospace font', hint: 'File paths, frontmatter, and code.', property: '--font-mono', fallback: 'var(--mono-fallback)' },
] as const;
export type FontRole = typeof FONT_ROLES[number]['key'];
export type FontChoices = Partial<Record<FontRole, string>>;

const STORAGE_KEY = 'heinlein-studio-fonts-v1';
const MAX_NAME = 100;

/** Returns a clean family name, or null for blank / unusable input. */
export function cleanFamily(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name && name.length <= MAX_NAME ? name : null;
}

/** A CSS font-family list: the quoted family, then the role's fallback stack. */
export function familyValue(name: string, fallback: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", ${fallback}`;
}

export function parseChoices(raw: unknown): FontChoices {
  let data: unknown = raw;
  if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { return {}; } }
  if (!data || typeof data !== 'object') return {};
  const out: FontChoices = {};
  for (const { key } of FONT_ROLES) {
    const name = cleanFamily((data as Record<string, unknown>)[key]);
    if (name) out[key] = name;
  }
  return out;
}

export function loadChoices(): FontChoices {
  try { return parseChoices(localStorage.getItem(STORAGE_KEY)); } catch { return {}; }
}
export function saveChoices(choices: FontChoices) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choices)); } catch { /* storage is a convenience only */ }
}

export function applyChoices(choices: FontChoices, target: HTMLElement = document.documentElement) {
  for (const role of FONT_ROLES) {
    const name = choices[role.key];
    if (name) target.style.setProperty(role.property, familyValue(name, role.fallback));
    else target.style.removeProperty(role.property);
  }
}
