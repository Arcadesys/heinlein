/** Keep in-app moves out of the operating system's file-drop handler. */
export interface LibraryDragSource {id: string; kind: 'scene' | 'group'}
export interface LibraryDropTarget {
  parentId: string | null; beforeId: string | null;
  marker: HTMLElement; side: 'before' | 'after' | 'inside'; label: string;
}
interface Options<T> {
  begin(source: LibraryDragSource): T | null;
  resolve(source: LibraryDragSource, x: number, y: number): LibraryDropTarget | null;
  drop(source: LibraryDragSource, target: LibraryDropTarget, guard: T): void;
  announce(message: string): void;
}
export function libraryPointerDrag<T>(root: HTMLElement, options: Options<T>) {
  let pending: {button: HTMLElement; source: LibraryDragSource; guard: T; pointerId: number; x: number; y: number; startX: number; startY: number; active: boolean} | null = null;
  let target: LibraryDropTarget | null = null;
  let mark: {node: HTMLElement; shadow: string; outline: string; offset: string} | null = null;
  let frame: number | undefined, suppressClick = false, lastLabel = '';
  function unmark() {
    if (mark) { mark.node.style.boxShadow = mark.shadow; mark.node.style.outline = mark.outline; mark.node.style.outlineOffset = mark.offset; mark = null; }
  }
  function locate() {
    if (!pending?.active) return;
    unmark(); target = options.resolve(pending.source, pending.x, pending.y);
    if (!target) return;
    const node = target.marker;
    mark = {node, shadow: node.style.boxShadow, outline: node.style.outline, offset: node.style.outlineOffset};
    if (target.side === 'inside') { node.style.outline = '3px solid var(--accent)'; node.style.outlineOffset = '-3px'; }
    else node.style.boxShadow = `inset 0 ${target.side === 'before' ? 4 : -4}px 0 var(--accent)`;
    if (target.label !== lastLabel) { lastLabel = target.label; options.announce(`${target.label}. Release to move; Escape cancels.`); }
  }
  function scrollFrame() {
    if (!pending?.active) return;
    for (let node: HTMLElement | null = pending.button.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight || !/auto|scroll/.test(getComputedStyle(node).overflowY)) continue;
      const b = node.getBoundingClientRect();
      if (pending.x >= b.left && pending.x <= b.right) {
        const dy = pending.y < b.top + 40 ? -8 : pending.y > b.bottom - 40 ? 8 : 0;
        if (dy) { node.scrollTop += dy; locate(); }
      }
      break;
    }
    frame = requestAnimationFrame(scrollFrame);
  }
  function cancel() {
    if (frame !== undefined) { cancelAnimationFrame(frame); frame = undefined; }
    const old = pending; pending = null; target = null; lastLabel = ''; unmark();
    if (old) { old.button.style.cursor = 'grab'; try { if (old.button.hasPointerCapture(old.pointerId)) old.button.releasePointerCapture(old.pointerId); } catch { /* Source was refreshed. */ } }
  }
  function down(e: PointerEvent) {
    if (e.button !== 0 || !['mouse', 'pen'].includes(e.pointerType)) return;
    const button = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-library-drag-id]') : null;
    if (!button || !root.contains(button)) return;
    cancel(); suppressClick = false;
    const source = {id: button.dataset.libraryDragId!, kind: button.dataset.libraryDragKind as LibraryDragSource['kind']};
    const guard = options.begin(source); if (guard === null) return;
    pending = {button, source, guard, pointerId: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, active: false};
    button.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!pending || e.pointerId !== pending.pointerId) return;
    pending.x = e.clientX; pending.y = e.clientY;
    if (!pending.active) {
      if (Math.hypot(pending.x - pending.startX, pending.y - pending.startY) < 6) return;
      pending.active = true; pending.button.style.cursor = 'grabbing'; pending.button.focus({preventScroll: true}); frame = requestAnimationFrame(scrollFrame);
    }
    e.preventDefault(); locate();
  }
  function up(e: PointerEvent) {
    if (!pending || e.pointerId !== pending.pointerId) return;
    if (!pending.active) { cancel(); return; }
    e.preventDefault(); e.stopPropagation(); locate();
    const old = pending, destination = target; suppressClick = true; cancel();
    if (destination) options.drop(old.source, destination, old.guard); else options.announce('Move canceled. Nothing changed.');
  }
  function click(e: MouseEvent) { if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); } }
  function escape(e: KeyboardEvent) { if (e.key === 'Escape' && pending) { e.preventDefault(); suppressClick = pending.active; cancel(); options.announce('Move canceled. Nothing changed.'); } }
  function lost(e: PointerEvent) { if (pending?.pointerId === e.pointerId) cancel(); }
  root.addEventListener('pointerdown', down); root.addEventListener('pointermove', move); root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', lost); root.addEventListener('lostpointercapture', lost); root.addEventListener('click', click, true); root.addEventListener('keydown', escape);
  return {
    bind(button: HTMLElement, source: LibraryDragSource) { button.draggable = false; button.dataset.libraryDragId = source.id; button.dataset.libraryDragKind = source.kind; button.style.cursor = 'grab'; },
    cancel,
    destroy() { cancel(); root.removeEventListener('pointerdown', down); root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up); root.removeEventListener('pointercancel', lost); root.removeEventListener('lostpointercapture', lost); root.removeEventListener('click', click, true); root.removeEventListener('keydown', escape); },
  };
}
