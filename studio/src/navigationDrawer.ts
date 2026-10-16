import { REPOSITORY_DRAG_TYPE, SCENE_DRAG_TYPE } from './draftingPanel';

const TAB_ORDER = ['files', 'manuscript', 'scenes'] as const;
type NavigationTab = typeof TAB_ORDER[number];
const STORAGE_KEY = 'heinlein-studio-navigation-v1';

/** One non-modal drawer; switching tabs retains the live panels and their state. */
export function createNavigationDrawer(files: HTMLElement, manuscript: HTMLElement, scenes: HTMLElement, changed: (open: boolean) => void) {
  let active: NavigationTab = 'files';
  let open = !window.matchMedia?.('(max-width: 760px)').matches;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved.open === 'boolean' && TAB_ORDER.includes(saved.active)) {
      open = saved.open; active = saved.active;
    } else {
      const legacy = JSON.parse(localStorage.getItem('heinlein-studio-collapsed-v1') ?? '{}');
      if (legacy?.files === true && legacy?.manuscript === true) {
        if (legacy?.scenes === false) active = 'scenes'; else open = false;
      }
      else if (legacy?.files === true && legacy?.manuscript === false) active = 'manuscript';
    }
  } catch { /* Invalid or unavailable storage must not prevent navigation. */ }
  const element = document.createElement('nav');
  element.className = 'navigator'; element.setAttribute('aria-label', 'Files, manuscript, and scene navigator');
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'navigation-toggle';
  toggle.setAttribute('aria-controls', 'navigation-drawer');
  toggle.setAttribute('aria-keyshortcuts', 'Control+\\ Meta+\\');
  const drawer = document.createElement('div'); drawer.id = 'navigation-drawer'; drawer.className = 'navigation-drawer floating-card';
  const tablist = document.createElement('div'); tablist.className = 'navigation-tabs';
  tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', 'Navigation views');
  const panels = {files, manuscript, scenes};
  const tabs = new Map<NavigationTab, HTMLButtonElement>();
  for (const key of TAB_ORDER) {
    const tab = document.createElement('button'); tab.type = 'button'; tab.id = `navigation-tab-${key}`;
    tab.textContent = key === 'files' ? 'Repository' : key === 'manuscript' ? 'Manuscript' : 'Scenes';
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `navigation-panel-${key}`);
    tab.addEventListener('click', () => select(key));
    // Keep existing drag/import targets reachable without accepting or applying a drop here.
    tab.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.some(type => type === REPOSITORY_DRAG_TYPE || type === SCENE_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (active !== key) select(key, false);
    });
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      select(event.key === 'Home' ? 'files' : event.key === 'End' ? 'scenes' : TAB_ORDER[(TAB_ORDER.indexOf(key) + direction + TAB_ORDER.length) % TAB_ORDER.length]);
    });
    tabs.set(key, tab); tablist.append(tab);
    panels[key].id = `navigation-panel-${key}`; panels[key].setAttribute('role', 'tabpanel');
    panels[key].setAttribute('aria-labelledby', tab.id); panels[key].tabIndex = 0;
  }
  drawer.append(tablist, files, manuscript, scenes); element.append(toggle, drawer);
  toggle.addEventListener('click', () => setOpen(!open, true));
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); setOpen(false, true);
    }
  });
  function render() {
    drawer.hidden = !open; element.classList.toggle('navigation-closed', !open);
    toggle.textContent = open ? 'Close navigation' : 'Navigation';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = `${open ? 'Close' : 'Open'} navigation (Cmd/Ctrl+\\)`;
    for (const [key, tab] of tabs) {
      tab.setAttribute('aria-selected', String(key === active)); tab.tabIndex = key === active ? 0 : -1;
      panels[key].hidden = key !== active;
    }
    changed(open);
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({open, active})); } catch { /* Convenience only. */ }
  }
  function setOpen(value: boolean, focus = false) {
    const containedFocus = drawer.contains(document.activeElement);
    open = value; render(); save();
    if (focus || containedFocus) (open ? tabs.get(active)! : toggle).focus();
  }
  function select(key: NavigationTab, focus = true) {
    active = key; setOpen(true, focus);
  }
  render();
  return {element, select, toggle: () => setOpen(!open, true), visible: (key: NavigationTab) => open && key === active};
}
