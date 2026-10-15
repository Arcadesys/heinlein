// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {applyRawChanges, createEditor} from './editor';
describe('byte-preserving editor changes', () => {
  it('retains unknown frontmatter, CRLF and mixed unchanged endings', () => {
    const raw = '---\r\nunknown: yes\r\n---\nHello\r\nWorld';
    expect(applyRawChanges(raw, [{from: 21, to: 26, insert: 'Goodbye'}])).toBe('---\r\nunknown: yes\r\n---\nGoodbye\r\nWorld');
    expect(applyRawChanges(raw, [])).toBe(raw);
  });
  it('restores the exact saved mixed-newline baseline on undo', () => {
    const editor = createEditor(document.createElement('div'), 'a\r\nb\nc', () => {}, () => {});
    editor.view.dispatch({changes: {from: 5, insert: 'x'}}); editor.markSaved(editor.text());
    editor.view.dispatch({changes: {from: 3, to: 4}}); editor.undo();
    expect(editor.text()).toBe('a\r\nb\ncx'); editor.destroy();
  });
  it('inserts with existing newline convention', () => {
    expect(applyRawChanges('a\r\nb', [{from: 1, to: 1, insert: '\nx'}])).toBe('a\r\nx\r\nb');
  });
});
