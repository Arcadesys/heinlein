// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createEditor} from './editor';
import {findAuthorComments, insertNote, noteInsertion, noteProblem, noteTarget} from './authorComments';
import {openNoteDialog} from './noteDialog';

let editor: ReturnType<typeof createEditor> | undefined;
beforeEach(() => {
  document.body.replaceChildren();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { editor?.destroy(); editor = undefined; vi.restoreAllMocks(); });
function start(text: string, changed: (raw: string) => void = () => {}) {
  const host = document.createElement('div'); document.body.append(host);
  editor = createEditor(host, text, changed, () => {}); return editor;
}

describe('author note syntax', () => {
  it('finds complete notes, including wrapped lines, but never across a blank line', () => {
    const text = 'The world was new {>>wait, what / something more<<}. Next {>>two\nlines<<} and {>>broken\n\nnote<<} end.';
    expect(findAuthorComments(text).map(({from, to}) => text.slice(from, to))).toEqual(['{>>wait, what / something more<<}', '{>>two\nlines<<}']);
  });
  it('validates and formats note text', () => {
    expect(noteProblem('  ')).toBe('Write a note first.');
    expect(noteProblem('has <<} inside')).toContain("can't contain");
    expect(noteProblem('one\n\ntwo')).toContain('blank line');
    expect(noteProblem('wait, what')).toBeNull();
    expect(noteInsertion('  wait, what\r\nmore ')).toBe(' {>>wait, what\nmore<<}');
  });
});

describe('author notes in the editor', () => {
  it('marks notes without changing the source', () => {
    const view = start('The world was new {>>wait, what<<}.').view;
    const marked = [...view.contentDOM.querySelectorAll('.cm-author-comment')].map(node => node.textContent).join('');
    expect(marked).toBe('{>>wait, what<<}');
    expect(editor!.text()).toBe('The world was new {>>wait, what<<}.');
  });
  it('inserts the note after the highlighted passage and keeps the passage selected', () => {
    let saved = ''; const view = start('The world was new.\r\nNext line.', raw => { saved = raw; }).view;
    view.dispatch({selection: {anchor: 4, head: 17}});
    expect(insertNote(view, noteTarget(view), 'wait, what / something more than this')).toBeNull();
    expect(editor!.text()).toBe('The world was new {>>wait, what / something more than this<<}.\r\nNext line.');
    expect(saved).toBe(editor!.text());
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('world was new');
  });
  it('adds a note at the cursor when nothing is highlighted', () => {
    const view = start('Alpha beta.').view; view.dispatch({selection: {anchor: 5}});
    expect(insertNote(view, noteTarget(view), 'more')).toBeNull();
    expect(editor!.text()).toBe('Alpha {>>more<<} beta.');
  });
  it('refuses a stale selection, a changed document, or a read-only editor', () => {
    const view = start('Alpha beta gamma.').view; view.dispatch({selection: {anchor: 0, head: 5}});
    const target = noteTarget(view);
    view.dispatch({selection: {anchor: 6, head: 10}});
    expect(insertNote(view, target, 'note')).toContain('selection changed');
    view.dispatch({selection: {anchor: 0, head: 5}, changes: {from: 17, insert: '!'}});
    expect(insertNote(view, target, 'note')).toContain('changed');
    expect(editor!.text()).toBe('Alpha beta gamma.!');
    editor!.setEditable(false); expect(insertNote(view, noteTarget(view), 'note')).toContain('read-only');
  });
});

describe('Add note dialog', () => {
  const open = (add = vi.fn((_: string): string | null => null), closed = vi.fn()) => {
    const dialog = openNoteDialog(document.body, {quote: 'world was new', add, closed});
    const input = dialog.element.querySelector('textarea')!;
    const button = (label: string) => [...dialog.element.querySelectorAll('button')].find(b => b.textContent === label)!;
    return {dialog, input, add, closed, button, error: dialog.element.querySelector<HTMLElement>('.note-dialog-error')!};
  };
  it('shows the passage and adds the typed note', () => {
    const {dialog, input, add, closed, button} = open();
    expect(dialog.element.querySelector('blockquote')!.textContent).toBe('world was new');
    expect(dialog.element.querySelector('label')!.textContent).toContain('Note for Heinlein');
    input.value = 'wait, what'; button('Add note').click();
    expect(add).toHaveBeenCalledWith('wait, what'); expect(closed).toHaveBeenCalledOnce(); expect(dialog.element.isConnected).toBe(false);
  });
  it('adds with Cmd/Ctrl+Enter', () => {
    const {input, add} = open(); input.value = 'note';
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', metaKey: true, bubbles: true, cancelable: true}));
    expect(add).toHaveBeenCalledWith('note');
  });
  it('rejects invalid notes and stays open when the insertion is refused', () => {
    const add = vi.fn((_: string): string | null => 'The text or selection changed.');
    const {dialog, input, button, error} = open(add);
    input.value = 'bad {>> note'; button('Add note').click();
    expect(add).not.toHaveBeenCalled(); expect(error.hidden).toBe(false); expect(error.textContent).toContain("can't contain");
    input.value = 'fine'; button('Add note').click();
    expect(error.textContent).toBe('The text or selection changed.'); expect(dialog.element.isConnected).toBe(true);
  });
  it('inserts nothing on Cancel or Escape', () => {
    const first = open(); first.input.value = 'note'; first.button('Cancel').click();
    expect(first.add).not.toHaveBeenCalled(); expect(first.closed).toHaveBeenCalledOnce();
    const second = open(); second.dialog.element.dispatchEvent(new Event('cancel', {cancelable: true}));
    expect(second.add).not.toHaveBeenCalled(); expect(second.closed).toHaveBeenCalledOnce();
  });
});
