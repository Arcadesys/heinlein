import {Transaction, type Text} from '@codemirror/state';
import {EditorView, type ViewUpdate} from '@codemirror/view';

/** A real writing edit, not navigation, paste/drop, history, recovery or an agent edit. */
export function isWritingInput(transactions: readonly Transaction[]): boolean {
  return transactions.some(transaction => {
    if (!transaction.docChanged) return false;
    if (transaction.isUserEvent('input.type') || transaction.isUserEvent('delete')) return true;
    // Enter may replace several selected lines with one newline, so net line
    // growth cannot distinguish it from a non-typing change.
    if (transaction.annotation(Transaction.userEvent) !== 'input') return false;
    let newline = false;
    transaction.changes.iterChanges((_from, _to, _newFrom, _newTo, insert) => {if (insert.lines > 1) newline = true;});
    return newline;
  });
}

/** Presentation only. Never dispatches an editor transaction or changes its width. */
export function createTypingChrome(options: {
  root: HTMLElement;
  writerPane: HTMLElement;
  controls: HTMLElement[];
  canHide(): boolean;
}) {
  const {root, writerPane} = options;
  const element = document.createElement('div');
  element.className = 'typing-chrome';
  const clip = document.createElement('div');
  clip.className = 'typing-chrome-clip';
  const content = document.createElement('div');
  content.className = 'typing-chrome-content';
  content.id = 'writing-tabs-and-tools';
  content.append(...options.controls);
  clip.append(content);
  const revealButton = document.createElement('button');
  revealButton.type = 'button';
  revealButton.className = 'typing-chrome-reveal';
  revealButton.textContent = 'Tabs and tools';
  revealButton.title = 'Show tabs and tools (Escape). They slide away when you type.';
  revealButton.setAttribute('aria-label', 'Show tabs and tools');
  revealButton.setAttribute('aria-keyshortcuts', 'Escape');
  revealButton.setAttribute('aria-controls', content.id);
  revealButton.setAttribute('aria-expanded', 'false');
  revealButton.hidden = true;
  element.append(clip, revealButton);
  let hidden = false;
  let composing = false;
  let pendingComposition = false;
  let frame = 0;
  let disposed = false;
  let anchorTop = 0;
  let anchorScroll = 0;
  let preserveScroll = false;
  let settle: ReturnType<typeof setTimeout> | null = null;
  let compositionView: EditorView | null = null;
  let compositionStartText: Text | null = null;
  let activeWriter: EditorView | null = null;

  // Recover vertical space without moving a scrolled passage on screen. At the
  // beginning of a document the page may slide upward, but never changes width.
  const compensateScroll = (keepCaretVisible = true) => {
    if (!preserveScroll) return;
    const bounds = writerPane.getBoundingClientRect();
    writerPane.scrollTop = anchorScroll + bounds.top - anchorTop;
    if (!keepCaretVisible || !activeWriter?.hasFocus || !writerPane.contains(activeWriter.dom)) return;
    // A stacked reference changes the writer's lower boundary too. Preserve
    // the passage when it fits, but never anchor the caret outside its pane.
    const caret = activeWriter.coordsAtPos(activeWriter.state.selection.main.head);
    if (caret && bounds.height > caret.bottom - caret.top + 8) {
      if (caret.bottom > bounds.bottom - 4) writerPane.scrollTop += caret.bottom - bounds.bottom + 4;
      else if (caret.top < bounds.top + 4) writerPane.scrollTop += caret.top - bounds.top - 4;
    }
  };
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => compensateScroll());
  resize?.observe(element);
  function setHidden(value: boolean) {
    if (disposed || hidden === value) return;
    anchorTop = writerPane.getBoundingClientRect().top;
    anchorScroll = writerPane.scrollTop;
    preserveScroll = writerPane.scrollTop > content.getBoundingClientRect().height;
    hidden = value;
    element.classList.toggle('is-typing', value);
    content.inert = value;
    content.setAttribute('aria-hidden', String(value));
    revealButton.hidden = !value;
    // Handles reduced motion and the first frame before ResizeObserver fires.
    compensateScroll(false); // The editor may still be delivering this update.
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {compensateScroll();preserveScroll = false;settle = null;}, 180);
  }
  const hasDialog = () => !!root.querySelector('dialog[open], [role="dialog"][aria-modal="true"]');
  function hide() {
    if (!options.canHide() || !element.isConnected || hasDialog() || content.contains(document.activeElement)) return;
    setHidden(true);
  }
  function reveal() {
    composing = false;pendingComposition = false;compositionView = null;compositionStartText = null;
    if (frame) {cancelAnimationFrame(frame);frame = 0;}
    setHidden(false);
  }
  function reset() {
    reveal();
    preserveScroll = false;activeWriter = null;
    if (settle) {clearTimeout(settle);settle = null;}
  }
  const extension = EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.view.hasFocus || update.state.readOnly || !writerPane.contains(update.view.dom) || !isWritingInput(update.transactions)) return;
    activeWriter = update.view;
    if (composing || update.view.composing) pendingComposition = true;
    else hide();
  });
  const compositionStart = (event: Event) => {
    if (!(event.target as Element)?.closest('.cm-content')) return;
    composing = true;
    compositionView = EditorView.findFromDOM(event.target as HTMLElement);
    compositionStartText = compositionView?.state.doc ?? null;
  };
  const compositionEnd = () => {
    composing = false;
    if (frame) cancelAnimationFrame(frame);
    // Let the IME commit and CodeMirror settle before moving its candidate anchor.
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (pendingComposition && writerPane.contains(document.activeElement) && compositionView && compositionStartText && !compositionView.state.doc.eq(compositionStartText)) hide();
      pendingComposition = false;compositionView = null;compositionStartText = null;
    });
  };
  const escape = (event: KeyboardEvent) => {
    if (!hidden || event.defaultPrevented || event.isComposing || composing || event.keyCode === 229 || hasDialog()) return;
    if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && writerPane.contains(event.target as Node)) {
      // Bubble after the editor: search/completion/selection get first refusal.
      reveal();
      event.preventDefault(); // Do not also close navigation and move focus.
    }
  };
  const tab = (event: KeyboardEvent) => {
    if (event.target !== revealButton && hidden && event.key === 'Tab' && !event.isComposing && !composing && !hasDialog()) reveal();
  };
  const focus = (event: FocusEvent) => {
    if (event.target !== revealButton && !writerPane.contains(event.target as Node)) reveal();
  };
  // Pointer restoration keeps the caret and selection. Keyboard activation of
  // the restore button intentionally enters the now-visible controls.
  revealButton.addEventListener('pointerdown', event => event.preventDefault());
  revealButton.addEventListener('click', () => {
    const keyboard = document.activeElement === revealButton;
    reveal();
    if (keyboard) content.querySelector<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), summary')?.focus({preventScroll: true});
  });
  writerPane.addEventListener('compositionstart', compositionStart);
  writerPane.addEventListener('compositionend', compositionEnd);
  root.addEventListener('keydown', escape);
  root.addEventListener('keydown', tab, true);
  root.addEventListener('focusin', focus);
  return {
    element, extension, reveal, reset,
    destroy() {
      reset();
      disposed = true;
      resize?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (settle) clearTimeout(settle);
      writerPane.removeEventListener('compositionstart', compositionStart);
      writerPane.removeEventListener('compositionend', compositionEnd);
      root.removeEventListener('keydown', escape);
      root.removeEventListener('keydown', tab, true);
      root.removeEventListener('focusin', focus);
    },
  };
}
