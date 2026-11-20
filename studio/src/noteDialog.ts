import {noteProblem} from './authorComments';

export interface NoteDialogHooks {
  /** The highlighted passage, or empty for a note at the cursor. */
  quote: string;
  /** Insert the note. Return a message to keep the dialog open, or null when done. */
  add(note: string): string | null;
  closed?(): void;
}

const QUOTE_LIMIT = 600;

/** A modal for writing one author note. It edits nothing until Add note succeeds. */
export function openNoteDialog(root: HTMLElement, hooks: NoteDialogHooks) {
  const dialog = document.createElement('dialog'); dialog.className = 'appearance-dialog note-dialog'; dialog.setAttribute('aria-labelledby', 'note-dialog-title');
  const title = document.createElement('h2'); title.id = 'note-dialog-title'; title.textContent = 'Add note';
  const intro = document.createElement('p'); intro.className = 'muted';
  intro.textContent = 'Heinlein reads notes as instructions when you ask for edits. Notes stay in your source and are left out of every export.';
  const quote = document.createElement('blockquote'); quote.className = 'note-dialog-quote';
  const passage = hooks.quote.trim();
  quote.textContent = !passage ? 'At cursor' : passage.length > QUOTE_LIMIT ? `${passage.slice(0, QUOTE_LIMIT)}…` : passage;
  if (!passage) quote.classList.add('muted');
  const label = document.createElement('label'); label.className = 'note-dialog-label'; label.textContent = 'Note for Heinlein';
  const input = document.createElement('textarea'); input.rows = 4; input.className = 'note-dialog-input';
  input.placeholder = 'wait, what / something more than this';
  label.append(input);
  const error = document.createElement('p'); error.className = 'note-dialog-error error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  const add = document.createElement('button'); add.type = 'button'; add.className = 'primary'; add.textContent = 'Add note';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  actions.append(add, cancel);
  dialog.append(title, intro, quote, label, error, actions);

  let done = false;
  const close = () => {
    if (done) return; done = true;
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    dialog.remove(); hooks.closed?.();
  };
  const show = (message: string) => { error.textContent = message; error.hidden = false; input.focus(); };
  const submit = () => {
    const problem = noteProblem(input.value); if (problem) { show(problem); return; }
    const refused = hooks.add(input.value); if (refused) { show(refused); return; }
    close();
  };
  add.addEventListener('click', submit);
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  input.addEventListener('input', () => { error.hidden = true; });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); submit(); }
  });
  root.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  input.focus();
  return {element: dialog, close};
}
