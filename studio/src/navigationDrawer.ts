const STORAGE_KEY = 'heinlein-studio-navigation-v1';

/** One non-modal drawer holding the project navigator; closing it retains the live panel and its state. */
export function createNavigationDrawer(panel: HTMLElement, changed: (open: boolean) => void) {
  let open = !window.matchMedia?.('(max-width: 760px)').matches;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved.open === 'boolean') open = saved.open;
    else {
      const legacy = JSON.parse(localStorage.getItem('heinlein-studio-collapsed-v1') ?? '{}');
      if (legacy?.files === true && legacy?.manuscript === true && legacy?.scenes !== false) open = false;
    }
  } catch { /* Invalid or unavailable storage must not prevent navigation. */ }
  const small=window.matchMedia?.('(max-width:760px)');
  let suspended = false; let narrowSuppressed = false;
  let scrollTop = 0; let scrollLeft = 0; let wasShowing = false;
  const element = document.createElement('nav');
  element.className = 'navigator'; element.setAttribute('aria-label', 'Project navigator');
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'navigation-toggle';
  toggle.setAttribute('aria-controls', 'navigation-drawer');
  toggle.setAttribute('aria-keyshortcuts', 'Control+\\ Meta+\\');
  const drawer = document.createElement('div'); drawer.id = 'navigation-drawer'; drawer.className = 'navigation-drawer floating-card';
  panel.tabIndex = -1;
  const modal=document.createElement('dialog');modal.className='appearance-dialog navigation-modal';modal.setAttribute('aria-label','Navigation');const back=document.createElement('button');back.type='button';back.textContent='Return to writing';back.addEventListener('click',()=>setOpen(false,true));modal.append(back);
  drawer.append(panel); element.append(toggle, drawer,modal);
  modal.addEventListener('cancel',event=>{event.preventDefault();setOpen(false,true);});
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
    // Read only while laid out: a hidden drawer reports zero. Keep the author's
    // position across narrow-screen modal moves and suspension for Questions.
    if (wasShowing) {
      scrollTop = panel.scrollTop + (modal.open ? modal.scrollTop : 0);
      scrollLeft = panel.scrollLeft + (modal.open ? modal.scrollLeft : 0);
    }
    const showing = open && !suspended && !(narrowSuppressed && small?.matches);
    // Suspend interaction and narrow-screen dialogs without taking space away
    // from the desktop navigator while Questions overlays the manuscript.
    const occupying = showing || (suspended && open && !small?.matches);
    if(small?.matches&&showing){if(drawer.parentElement!==modal)modal.append(drawer);drawer.hidden=false;if(modal.isConnected&&!modal.open&&modal.showModal)modal.showModal();}
    else{if(modal.open&&modal.close)modal.close();if(drawer.parentElement!==element)element.append(drawer);drawer.hidden=!occupying;}
    element.classList.toggle('navigation-closed', !occupying);
    drawer.inert = !showing; drawer.setAttribute('aria-hidden', String(!showing));
    toggle.textContent = occupying ? 'Close navigation' : 'Navigation';
    toggle.setAttribute('aria-expanded', String(showing));
    toggle.title = `${showing ? 'Close' : 'Open'} navigation (Cmd/Ctrl+\\)`;
    changed(occupying);
    if (showing) {
      panel.scrollTop = scrollTop; panel.scrollLeft = scrollLeft;
      // Depending on the narrow layout, the dialog itself owns the overflow.
      if (modal.open) { modal.scrollTop = scrollTop - panel.scrollTop; modal.scrollLeft = scrollLeft - panel.scrollLeft; }
    }
    wasShowing = showing;
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({open})); } catch { /* Convenience only. */ }
  }
  function setOpen(value: boolean, focus = false) {
    const containedFocus = drawer.contains(document.activeElement);
    narrowSuppressed = false; open = value; render(); save();
    if (focus || containedFocus) (open ? panel : toggle).focus({preventScroll: true});
  }
  const resize=()=>render();small?.addEventListener?.('change',resize);
  render();queueMicrotask(()=>{if(element.isConnected)render();});
  return {element, suspend(value: boolean) {if (suspended && !value && small?.matches) narrowSuppressed = true; suspended = value; render();}, close:()=>setOpen(false), destroy:()=>{document.removeEventListener('keydown', closeFromPage);small?.removeEventListener?.('change',resize);if(modal.open&&modal.close)modal.close();modal.remove();}, select: (focus = true) => setOpen(true, focus), toggle: () => setOpen(!open, true), visible: () => open && !suspended && !(narrowSuppressed && small?.matches)};
}
