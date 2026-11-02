const openMenus = new Map<HTMLDetailsElement, {list: HTMLElement; close: (focus?: boolean) => void}>();
let globalListeners = false;
const closeOpenMenus = (keep?: Node) => {
  for (const [menu, {list, close}] of [...openMenus]) if (!keep || !(menu.contains(keep) || list.contains(keep))) close();
};

/**
 * A small disclosure menu (⋯) that closes on choice, Escape, Tab, outside click, scroll, or when another opens.
 * While open, its list moves to <body> so the drawer's clipping and backdrop blur cannot trap it.
 * Pass a function to build the items each time it opens.
 */
export function rowMenu(label: string, items: HTMLElement[] | (() => HTMLElement[]), className = '') {
  const menu = document.createElement('details'); menu.className = `row-menu ${className}`.trim();
  const summary = document.createElement('summary'); summary.textContent = '⋯';
  summary.setAttribute('aria-label', label); summary.title = label;
  const list = document.createElement('div'); list.className = 'row-menu-items'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', label);
  if (Array.isArray(items)) list.append(...items);
  menu.append(summary, list);
  const buttons = () => [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  function close(focus = false) {
    openMenus.delete(menu); menu.open = false; menu.append(list);
    if (focus && summary.isConnected) summary.focus();
  }
  menu.addEventListener('toggle', () => {
    if (!menu.open) { if (openMenus.has(menu)) close(); return; }
    closeOpenMenus(menu);
    if (!Array.isArray(items)) list.replaceChildren(...items());
    openMenus.set(menu, {list, close});
    document.body.append(list);
    const anchor = summary.getBoundingClientRect(); const width = list.offsetWidth; const height = list.offsetHeight;
    list.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
    list.style.top = `${anchor.bottom + height + 8 > window.innerHeight ? Math.max(8, anchor.top - height - 4) : anchor.bottom + 4}px`;
    buttons()[0]?.focus();
  });
  list.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const all = buttons(); const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
    all[next]?.focus();
  });
  list.addEventListener('click', event => { if ((event.target as HTMLElement).closest('button')) close(); });
  if (!globalListeners) {
    globalListeners = true;
    document.addEventListener('pointerdown', event => closeOpenMenus(event.target as Node), true);
    window.addEventListener('scroll', event => { if (!(event.target as Element).closest?.('.row-menu-items')) closeOpenMenus(); }, {capture: true, passive: true});
    window.addEventListener('resize', () => closeOpenMenus());
  }
  return menu;
}
