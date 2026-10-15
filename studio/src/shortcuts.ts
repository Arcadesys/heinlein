// The keyboard cheat sheet (⌘/ or ?). Keys are written Mac-style and shown as Ctrl/Alt/Shift elsewhere.
export const SHORTCUT_GROUPS: {name: string; items: {label: string; keys: string}[]}[] = [
  {name: 'Navigate', items: [
    {label: 'Jump to scene', keys: '⌘K'}, {label: 'Files', keys: '⌘P'}, {label: 'Commands', keys: '⌘⇧P'},
    {label: 'Show or hide the file browser', keys: '⌘\\'}, {label: 'Reorder scene in palette', keys: '⌥↑ ⌥↓'}, {label: 'Step back / close', keys: 'esc'},
  ]},
  {name: 'Write', items: [
    {label: 'Save now', keys: '⌘S'}, {label: 'Split scene at cursor', keys: '⌘⇧↵'}, {label: 'Undo / redo', keys: '⌘Z  ⌘⇧Z'}, {label: 'Find', keys: '⌘F'},
  ]},
  {name: 'Ask', items: [
    {label: 'Ask Heinlein about selection', keys: '⌘J'}, {label: 'Capture selection into Questions', keys: '⌘⌥↵'}, {label: 'Close Questions', keys: 'esc'},
  ]},
  {name: 'View', items: [
    {label: 'Appearance', keys: '⌘,'}, {label: 'Larger / smaller text', keys: '⌘=  ⌘−'}, {label: 'Reset text size', keys: '⌘0'}, {label: 'This sheet', keys: '⌘/  ?'},
  ]},
];

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** "⌘⇧P" → "Ctrl+Shift+P" off macOS. Glyph-only keys (↵, ↑, esc) stay as written. */
export function formatKeys(keys: string, mac = isMac()): string {
  if (mac) return keys;
  return keys.split(/(\s+)/).map(chord => /^\s+$/.test(chord) ? chord : chord
    .replace(/⌘/g, 'Ctrl+').replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+')).join('');
}

export function shortcutSheet(): HTMLElement {
  const grid = document.createElement('div'); grid.className = 'shortcut-grid';
  for (const group of SHORTCUT_GROUPS) {
    const column = document.createElement('section'); column.className = 'shortcut-group'; column.setAttribute('aria-label', group.name);
    const heading = document.createElement('p'); heading.className = 'overline accent'; heading.textContent = group.name;
    const list = document.createElement('dl');
    for (const item of group.items) {
      const row = document.createElement('div'); row.className = 'shortcut-row';
      const term = document.createElement('dt'); term.textContent = item.label;
      const keys = document.createElement('dd'); const kbd = document.createElement('kbd'); kbd.textContent = formatKeys(item.keys); keys.append(kbd);
      row.append(term, keys); list.append(row);
    }
    column.append(heading, list); grid.append(column);
  }
  return grid;
}
