import './heinleinPane.css';

export interface HeinleinHeaderParts {
  /** The Passage / Whole scene segmented control (`.heinlein-tabs`, `aria-pressed` buttons). */
  tabs: HTMLElement;
  /** The connection status chip; it gains `.heinlein-status` and keeps its own click behavior. */
  status: HTMLButtonElement;
  /** Closes the pane and returns focus to the writing surface. */
  close: () => void;
}

const SVG = 'http://www.w3.org/2000/svg';
function closeIcon() {
  const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 14 14'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', 'M2 2l10 10M12 2L2 12'); svg.append(path); return svg;
}

/** Shared compact header for both Heinlein views: title, view tabs, connection chip, close. */
export function createHeinleinHeader({tabs, status, close}: HeinleinHeaderParts): HTMLElement {
  const head = document.createElement('header'); head.className = 'heinlein-head';
  const title = document.createElement('h2'); title.textContent = 'Heinlein';
  tabs.classList.add('heinlein-tabs');
  status.classList.add('heinlein-status'); status.type = 'button';
  if (!status.querySelector('.heinlein-status-dot')) {const dot = document.createElement('span'); dot.className = 'heinlein-status-dot'; dot.setAttribute('aria-hidden', 'true'); status.prepend(dot);}
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'heinlein-close';
  closeButton.setAttribute('aria-label', 'Close Heinlein'); closeButton.title = 'Close Heinlein (Esc)'; closeButton.append(closeIcon());
  closeButton.addEventListener('click', () => close());
  head.append(title, tabs, status, closeButton);
  return head;
}

/** Updates the chip's visible label, accessible detail and ready/attention state without replacing its dot. */
export function setHeinleinStatus(status: HTMLButtonElement, state: 'ready' | 'checking' | 'attention', detail: string) {
  status.dataset.state = state;
  if (!status.querySelector('.heinlein-status-label')) {const label = document.createElement('span'); label.className = 'heinlein-status-label'; label.textContent = 'ChatGPT'; status.append(label);}
  // The name starts with the visible label, then states connection health for assistive tech.
  const name = `ChatGPT${detail ? ` · ${detail}` : ''}`; status.setAttribute('aria-label', name); status.title = `${name} · Connection settings`;
}
