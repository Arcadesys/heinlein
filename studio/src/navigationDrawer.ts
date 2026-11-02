const STORAGE_KEY = 'heinlein-studio-navigation-v1';

/** One non-modal drawer holding the Project › Group › Scene tree; closing it retains the live panel and its state. */
export function createNavigationDrawer(library: HTMLElement, changed: (open: boolean) => void) {
  let open = !window.matchMedia?.('(max-width: 760px)').matches;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved.open === 'boolean') open = saved.open;
    else {
      const legacy = JSON.parse(localStorage.getItem('heinlein-studio-collapsed-v1') ?? '{}');
      if (legacy?.files === true && legacy?.manuscript === true && legacy?.scenes !== false) open = false;
    }
  } catch { /* Invalid or unavailable storage must not prevent navigation. */ }
  const element = document.createElement('nav');
  element.className = 'navigator'; element.setAttribute('aria-label', 'Project navigator');
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'navigation-toggle';
  toggle.setAttribute('aria-controls', 'navigation-drawer');
  toggle.setAttribute('aria-keyshortcuts', 'Control+\\ Meta+\\');
  const drawer = document.createElement('div'); drawer.id = 'navigation-drawer'; drawer.className = 'navigation-drawer floating-card';
  library.tabIndex = -1;
  drawer.append(library); element.append(toggle, drawer);
  toggle.addEventListener('click', () => setOpen(!open, true));
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open && !event.isComposing && !(event.target as HTMLElement).closest?.('details[open].row-menu')) {
      event.preventDefault(); event.stopPropagation(); setOpen(false, true);
    }
  });
  const closeFromPage = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !open || !element.isConnected || element.contains(event.target as Node) || document.querySelector('dialog[open]')) return;
    event.preventDefault(); setOpen(false, true);
  };
  document.addEventListener('keydown', closeFromPage);
  function render() {
    element.classList.toggle('navigation-closed', !open);
    drawer.inert = !open;
    drawer.setAttribute('aria-hidden', String(!open));
    toggle.textContent = open ? 'Close navigation' : 'Navigation';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = `${open ? 'Close' : 'Open'} navigation (Cmd/Ctrl+\\)`;
    changed(open);
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({open})); } catch { /* Convenience only. */ }
  }
  function setOpen(value: boolean, focus = false) {
    const containedFocus = drawer.contains(document.activeElement);
    open = value; render(); save();
    if (focus || containedFocus) (open ? library : toggle).focus();
  }
  render();
  return {element, select: (focus = true) => setOpen(true, focus), toggle: () => setOpen(!open, true), visible: () => open, destroy: () => document.removeEventListener('keydown', closeFromPage)};
}
