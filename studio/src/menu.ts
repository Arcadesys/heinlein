/** A small, keyboard-complete dropdown menu attached to an existing trigger button. */
export interface MenuItem {
  label: string;
  /** Marks where the author is now; shown with a text cue as well as styling. */
  current?: boolean;
  disabled?: boolean;
  /** Detail shown under the label, such as a scene count. */
  detail?: string;
  run?: () => void;
  /** A non-interactive group title. */
  heading?: boolean;
}

export function attachMenu(trigger: HTMLButtonElement, label: string, items: () => MenuItem[]) {
  trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
  let panel: HTMLDivElement | null = null;
  function buttons() { return panel ? [...panel.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')] : []; }
  function close(focus = true) {
    if (!panel) return;
    panel.remove(); panel = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', reposition);
    if (focus && trigger.isConnected) trigger.focus();
  }
  function outside(event: Event) { if (panel && !panel.contains(event.target as Node) && !trigger.contains(event.target as Node)) close(false); }
  function reposition() {
    if (!panel) return;
    const box = trigger.getBoundingClientRect();
    panel.style.top = `${box.bottom + 6}px`;
    panel.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - panel.offsetWidth - 8))}px`;
  }
  function open() {
    if (panel) { close(); return; }
    const list = items();
    panel = document.createElement('div'); panel.className = 'menu floating-card'; panel.setAttribute('role', 'menu'); panel.setAttribute('aria-label', label);
    for (const item of list) {
      if (item.heading) {
        const heading = document.createElement('div'); heading.className = 'menu-heading'; heading.setAttribute('role', 'presentation'); heading.textContent = item.label;
        panel.append(heading); continue;
      }
      const row = document.createElement('button'); row.type = 'button'; row.className = 'menu-item'; row.setAttribute('role', 'menuitem');
      row.disabled = Boolean(item.disabled); row.tabIndex = -1;
      const text = document.createElement('span'); text.className = 'menu-label'; text.textContent = item.label; row.append(text);
      if (item.detail) { const detail = document.createElement('span'); detail.className = 'menu-detail'; detail.textContent = item.detail; row.append(detail); }
      if (item.current) {
        row.setAttribute('aria-current', 'true');
        const here = document.createElement('span'); here.className = 'menu-here'; here.textContent = 'You are here'; row.append(here);
      }
      row.addEventListener('click', () => { close(false); item.run?.(); });
      panel.append(row);
    }
    if (!list.length) { const empty = document.createElement('div'); empty.className = 'menu-heading'; empty.textContent = 'Nothing to choose yet.'; panel.append(empty); }
    panel.addEventListener('keydown', event => {
      const all = buttons(); const index = all.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab') { close(false); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); all[(index + 1) % all.length]?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); all[(index - 1 + all.length) % all.length]?.focus(); }
      else if (event.key === 'Home') { event.preventDefault(); all[0]?.focus(); }
      else if (event.key === 'End') { event.preventDefault(); all[all.length - 1]?.focus(); }
    });
    document.body.append(panel);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', reposition);
    reposition();
    const start = buttons().find(button => button.getAttribute('aria-current') === 'true') ?? buttons()[0];
    start?.focus(); start?.scrollIntoView?.({block: 'nearest'});
  }
  trigger.addEventListener('click', open);
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && !panel) { event.preventDefault(); open(); }
  });
  return {close, isOpen: () => Boolean(panel), destroy() { close(false); trigger.removeEventListener('click', open); }};
}
