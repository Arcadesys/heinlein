// Command palette: one fuzzy finder for scenes, files and commands. Keyboard first;
// the element exists only while open, so closed palettes leave nothing in the page.
export type PaletteScope = 'scenes' | 'files' | 'commands';
export interface PaletteItem { key: string; label: string; sub?: string; right?: string; num?: string; run(): void }
interface PaletteHooks {
  items(scope: PaletteScope): PaletteItem[];
  /** Scenes only: move the highlighted scene one place; resolves to the new list when it moved. */
  reorder?(key: string, direction: -1 | 1): Promise<boolean> | boolean;
  closed(): void;
}
export const PALETTE_SCOPES: {id: PaletteScope; label: string; keys: string; glyph: string}[] = [
  {id: 'scenes', label: 'Scenes', keys: '⌘K', glyph: '›'},
  {id: 'files', label: 'Files', keys: '⌘P', glyph: '/'},
  {id: 'commands', label: 'Commands', keys: '⌘⇧P', glyph: '>'},
];

/** Case-insensitive subsequence match: "spl sc" finds "Split scene". Spaces are ignored. */
export function fuzzyMatch(query: string, text: string): boolean {
  const needle = query.toLowerCase().replace(/\s+/g, '');
  if (!needle) return true;
  let index = 0;
  for (const char of text.toLowerCase()) if (char === needle[index] && ++index === needle.length) return true;
  return false;
}
/** A leading ">" or "/" switches scope, as in editors that share one palette. */
export function scopeFor(query: string, scope: PaletteScope): PaletteScope {
  return query.startsWith('>') ? 'commands' : query.startsWith('/') ? 'files' : scope;
}
export function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const needle = query.replace(/^[>/]\s*/, '');
  return items.filter(item => fuzzyMatch(needle, `${item.label} ${item.sub ?? ''}`));
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
}
let paletteIds = 0;

export function createPalette(host: HTMLElement, hooks: PaletteHooks) {
  let element: HTMLElement | null = null;
  let scope: PaletteScope = 'scenes';
  let index = 0;
  let shown: PaletteItem[] = [];
  let input: HTMLInputElement; let list: HTMLElement; let label: HTMLElement; let chips: HTMLElement;
  const id = `palette-${++paletteIds}`;

  function current() { return scopeFor(input.value, scope); }
  function render() {
    if (!element) return;
    const active = current();
    shown = filterItems(hooks.items(active), input.value);
    index = shown.length ? Math.min(Math.max(index, 0), shown.length - 1) : 0;
    label.textContent = PALETTE_SCOPES.find(item => item.id === active)!.label;
    chips.querySelectorAll<HTMLButtonElement>('button').forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.scope === active)));
    list.replaceChildren();
    shown.forEach((item, position) => {
      const row = node('div', 'palette-item'); row.id = `${id}-option-${position}`;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(position === index));
      const text = node('span', 'palette-text');
      text.append(node('span', 'palette-label', item.label));
      if (item.sub) text.append(node('span', 'palette-sub', item.sub));
      row.append(node('span', 'palette-num', item.num ?? ''), text, node('span', 'palette-right', item.right ?? ''));
      row.addEventListener('mousemove', () => { if (index !== position) { index = position; mark(); } });
      row.addEventListener('mousedown', event => event.preventDefault());
      row.addEventListener('click', () => { index = position; run(); });
      list.append(row);
    });
    if (!shown.length) list.append(node('p', 'palette-empty', 'No matches.'));
    mark();
  }
  function mark() {
    list.querySelectorAll('[role="option"]').forEach((row, position) => row.setAttribute('aria-selected', String(position === index)));
    const selected = list.querySelector<HTMLElement>(`#${id}-option-${index}`);
    if (selected) { input.setAttribute('aria-activedescendant', selected.id); selected.scrollIntoView?.({block: 'nearest'}); }
    else input.removeAttribute('aria-activedescendant');
  }
  function run() {
    const item = shown[index]; if (!item) return;
    // Focus returns to the editor first, so whatever the item opens can take it.
    close(); item.run();
  }
  function setScope(next: PaletteScope) {
    scope = next; input.value = input.value.replace(/^[>/]\s*/, ''); index = 0; render(); input.focus({preventScroll: true});
  }
  async function move(direction: -1 | 1) {
    const item = shown[index];
    if (!item || !hooks.reorder || current() !== 'scenes' || input.value.trim()) return;
    if (!await hooks.reorder(item.key, direction) || !element) return;
    render();
    const moved = shown.findIndex(entry => entry.key === item.key);
    if (moved >= 0) { index = moved; mark(); }
  }
  function keydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const direction = event.key === 'ArrowUp' ? -1 : 1;
      if (event.altKey) { void move(direction); return; }
      if (shown.length) { index = (index + direction + shown.length) % shown.length; mark(); }
      return;
    }
    if (event.key === 'Enter') { event.preventDefault(); run(); return; }
    if (event.key === 'Tab') {
      event.preventDefault();
      const order = PALETTE_SCOPES.map(item => item.id); const at = order.indexOf(current());
      setScope(order[(at + (event.shiftKey ? order.length - 1 : 1)) % order.length]); return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }
  function open(next: PaletteScope, query = '') {
    if (element) { scope = next; input.value = query; index = 0; render(); input.focus({preventScroll: true}); return; }
    scope = next; index = 0;
    element = node('div', 'palette-layer');
    const backdrop = node('div', 'overlay-backdrop'); backdrop.addEventListener('mousedown', () => close());
    const panel = node('div', 'palette'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', 'Command palette');
    const head = node('div', 'palette-head');
    label = node('span', 'palette-scope');
    input = node('input', 'palette-input'); input.type = 'text'; input.value = query; input.spellcheck = false; input.autocomplete = 'off';
    input.placeholder = 'Jump to a scene — / for files, > for commands';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', `${id}-list`); input.setAttribute('aria-label', 'Search scenes, files and commands');
    input.addEventListener('input', () => { index = 0; render(); });
    input.addEventListener('keydown', keydown);
    head.append(label, input);
    chips = node('div', 'palette-scopes');
    for (const item of PALETTE_SCOPES) {
      const chip = node('button', 'palette-chip'); chip.type = 'button'; chip.dataset.scope = item.id;
      chip.append(item.label, node('kbd', '', item.keys));
      chip.addEventListener('mousedown', event => event.preventDefault());
      chip.addEventListener('click', () => setScope(item.id));
      chips.append(chip);
    }
    list = node('div', 'palette-list'); list.id = `${id}-list`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Results');
    const hints = node('div', 'palette-hints');
    for (const hint of ['↑↓ move', '↵ open', '⇥ scope', '⌥↑↓ reorder scenes', 'esc close']) hints.append(node('span', '', hint));
    panel.append(head, chips, node('div', 'palette-rule'), list, hints);
    element.append(backdrop, panel);
    host.append(element);
    render();
    input.focus({preventScroll: true});
  }
  function close(notify = true) {
    if (!element) return;
    element.remove(); element = null; shown = [];
    if (notify) hooks.closed();
  }
  return { open, close: () => close(), isOpen: () => Boolean(element), refresh: render, scope: () => (element ? current() : null) };
}
