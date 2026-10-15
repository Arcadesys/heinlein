import {StateEffect} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {selectionQuestionAvailability, type SelectionQuestionState} from './selectionQuestion';

interface SelectionAskHooks {
  current(): SelectionQuestionState | null;
  ask(snapshot: SelectionQuestionState): void;
  stale(): void;
  fallback: HTMLButtonElement;
  /** Optional second action shown beside Ask, with the selection's word count. */
  revise?(snapshot: SelectionQuestionState): void;
  keys?: string;
}
function sameSelection(before: SelectionQuestionState, after: SelectionQuestionState | null) {
  return after && !selectionQuestionAvailability(after) && before.repositoryId === after.repositoryId && before.path === after.path &&
    before.sceneId === after.sceneId && before.documentEpoch === after.documentEpoch && before.revision === after.revision &&
    before.source === after.source && before.from === after.from && before.to === after.to;
}
/** An editor-local affordance only: no context capture, copying, or provider I/O. */
export function createSelectionAskAction(view: EditorView, hooks: SelectionAskHooks) {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = 'Ask Heinlein';
  element.className = 'selection-ask-action'; element.hidden = true;
  element.setAttribute('aria-label', 'Ask Heinlein about highlighted passage');
  element.title = 'Capture this selection into Questions. Nothing is sent until you choose Send.';
  if (hooks.keys) element.dataset.keys = hooks.keys;
  // A portal avoids the app's size-containment changing fixed-position coordinates.
  document.body.append(element);
  let extras: HTMLElement | null = null; let words: HTMLElement | null = null;
  if (hooks.revise) {
    extras = document.createElement('div'); extras.className = 'selection-ask-extras'; extras.hidden = true;
    const revise = document.createElement('button'); revise.type = 'button'; revise.textContent = 'Suggest revision';
    revise.title = 'Open Questions in Suggest revision mode for this selection. Nothing is sent until you choose Send.';
    words = document.createElement('span'); words.className = 'selection-words';
    extras.append(revise, words); element.classList.add('with-extras'); document.body.append(extras);
    for (const type of ['pointerdown', 'mousedown'] as const) extras.addEventListener(type, event => { if ((event as MouseEvent).button === 0) event.preventDefault(); });
    revise.addEventListener('click', () => {
      const snapshot = displayed;
      if (disposed || !snapshot || !sameSelection(snapshot, hooks.current())) {hide(); if (!disposed) hooks.stale(); return;}
      hide(); hooks.revise!(snapshot);
    });
  }
  let disposed = false; let frame: number | null = null; let displayed: SelectionQuestionState | null = null;
  function hide() {element.hidden = true; if (extras) extras.hidden = true; displayed = null;}
  function refresh() {
    frame = null; if (disposed) return;
    const current = hooks.current(); const unavailable = selectionQuestionAvailability(current);
    hooks.fallback.disabled = Boolean(unavailable);
    if (unavailable || !current || (!view.hasFocus && document.activeElement !== element && document.activeElement !== hooks.fallback && !extras?.contains(document.activeElement))) {hide(); return;}
    const bounds = view.dom.getBoundingClientRect();
    const top = Math.max(0, bounds.top); const bottom = Math.min(window.innerHeight, bounds.bottom);
    const left = Math.max(0, bounds.left); const right = Math.min(window.innerWidth, bounds.right);
    if (top >= bottom || left >= right) {hide(); return;}
    const range = view.state.selection.main;
    const candidates = [view.coordsAtPos(range.head), view.coordsAtPos(range.anchor)];
    const anchor = candidates.find(rect => rect && rect.bottom > top && rect.top < bottom && rect.right >= left && rect.left <= right);
    if (!anchor) {hide(); return;}
    element.hidden = false;
    if (extras && words) {
      const selected = current.source.slice(current.from, current.to).trim().match(/\S+/g)?.length ?? 0;
      words.textContent = `${selected.toLocaleString()} ${selected === 1 ? 'word' : 'words'}`; extras.hidden = false;
    }
    const box = element.getBoundingClientRect(); const width = Math.max(140, box.width); const height = Math.max(44, box.height);
    const extraWidth = extras ? extras.getBoundingClientRect().width : 0;
    const margin = 8;
    const x = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - extraWidth - margin));
    const preferredTop = anchor.top - height - margin;
    const y = Math.max(margin, Math.min(preferredTop >= margin ? preferredTop : anchor.bottom + margin, window.innerHeight - height - margin));
    element.style.left = `${x}px`; element.style.top = `${y}px`;
    if (extras) { extras.style.left = `${x + width}px`; extras.style.top = `${y}px`; extras.style.height = `${height}px`; }
    displayed = {...current};
  }
  function schedule() {if (!disposed && frame === null) frame = requestAnimationFrame(refresh);}
  function preserveFocus(event: MouseEvent) {if (event.button === 0) event.preventDefault();}
  element.addEventListener('pointerdown', preserveFocus);
  element.addEventListener('mousedown', preserveFocus);
  element.addEventListener('click', () => {
    const snapshot = displayed;
    if (disposed || !snapshot || !sameSelection(snapshot, hooks.current())) {hide(); if (!disposed) hooks.stale(); return;}
    hide(); hooks.ask(snapshot);
  });
  view.dispatch({effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {
    if (disposed) return;
    // Invalidate synchronously, before a queued frame can display the next range.
    if (update.selectionSet || update.docChanged) hide();
    schedule();
  }))});
  document.addEventListener('scroll', schedule, {capture: true, passive: true});
  document.addEventListener('focusin', schedule);
  window.addEventListener('resize', schedule);
  schedule();
  return {element, refresh: schedule, destroy() {
    disposed = true; if (frame !== null) cancelAnimationFrame(frame); frame = null; hide(); element.remove(); extras?.remove();
    document.removeEventListener('scroll', schedule, true); document.removeEventListener('focusin', schedule); window.removeEventListener('resize', schedule);
  }};
}
