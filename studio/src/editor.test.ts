// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {applyRawChanges, createEditor} from './editor';
import {Transaction} from '@codemirror/state';
import {historyField, isolateHistory} from '@codemirror/commands';
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
  it('does not fuse separate CR and LF line breaks when deleting their separator', () => {
    const editor = createEditor(document.createElement('div'), 'a\rb\nc', () => {}, () => {});
    editor.view.dispatch({changes: {from: 2, to: 3}});
    expect(editor.text()).toBe('a\r\n\nc');
    expect(editor.text().replace(/\r\n|\r/g, '\n')).toBe(editor.view.state.doc.toString());
    editor.view.dispatch({changes: {from: 3, to: 4, insert: '🐺'}});
    expect(editor.text()).toBe('a\r\n\n🐺');
    editor.destroy();
  });
  it('does not fuse CR-style inserted newlines with untouched LF suffixes', () => {
    expect(applyRawChanges('a\rb\nc', [{from: 2, to: 3, insert: '\n'}])).toBe('a\r\r\n\nc');
    expect(applyRawChanges('a\rb\nc\rd\ne', [{from: 2, to: 3, insert: ''}, {from: 6, to: 7, insert: ''}])).toBe('a\r\n\nc\r\n\ne');
  });
  it('restores exact intermediate mixed-newline bytes through undo and redo', () => {
    const editor = createEditor(document.createElement('div'), 'a\r\nb\nc', () => {}, () => {});
    editor.view.dispatch({changes: {from: 5, insert: 'x'}, annotations: isolateHistory.of('full')});
    const intermediate = editor.text();
    editor.view.dispatch({changes: {from: 2, to: 4}, annotations: isolateHistory.of('full')});
    const later = editor.text();
    editor.undo(); expect(editor.text()).toBe(intermediate);
    editor.redo(); expect(editor.text()).toBe(later);
    editor.undo(); editor.undo(); expect(editor.text()).toBe('a\r\nb\nc');
    editor.destroy();
  });
  it('restores the earliest exact source in a grouped multi-transaction undo', () => {
    const editor = createEditor(document.createElement('div'), 'a\r\nb\nc\rd', () => {}, () => {});
    editor.view.dispatch({changes: {from: 7, insert: 'x'}, annotations: isolateHistory.of('full')});
    const beforeGroup = editor.text();
    editor.view.dispatch({changes: {from: 2, to: 4}, annotations: Transaction.userEvent.of('delete.selection')});
    editor.view.dispatch({changes: {from: 2, to: 4}, annotations: Transaction.userEvent.of('delete.selection')});
    const afterGroup = editor.text();
    editor.undo(); expect(editor.text()).toBe(beforeGroup);
    editor.redo(); expect(editor.text()).toBe(afterGroup);
    editor.destroy();
  });
  it('tracks raw bytes across multiple transactions delivered in one view update', () => {
    const editor = createEditor(document.createElement('div'), 'a\r\nb\nc', () => {}, () => {});
    const first = editor.view.state.update({changes: {from: 5, insert: 'x'}, annotations: isolateHistory.of('full')});
    const second = first.state.update({changes: {from: 2, to: 4}, annotations: isolateHistory.of('full')});
    editor.view.update([first, second]);
    expect(editor.text()).toBe('a\r\ncx');
    editor.undo(); expect(editor.text()).toBe('a\r\nb\ncx');
    editor.redo(); expect(editor.text()).toBe('a\r\ncx');
    editor.destroy();
  });
  it('never restores a stale history snapshot over a non-history programmatic edit', () => {
    const editor = createEditor(document.createElement('div'), 'a\r\nb\nc', () => {}, () => {});
    editor.view.dispatch({changes: {from: 5, insert: 'x'}, annotations: isolateHistory.of('full')});
    editor.view.dispatch({changes: {from: 0, insert: 'Keep — '}, annotations: Transaction.addToHistory.of(false)});
    editor.undo();
    expect(editor.text()).toBe('Keep — a\r\nb\nc');
    editor.redo(); expect(editor.text()).toBe('Keep — a\r\nb\ncx');
    editor.destroy();
  });
  it('keeps mapped non-history edits even when restored lines use the current convention', () => {
    const editor = createEditor(document.createElement('div'), 'a\r\nb\nc', () => {}, () => {});
    editor.view.dispatch({changes: {from: 2, to: 4}, annotations: isolateHistory.of('full')});
    editor.view.dispatch({changes: {from: 0, insert: 'Keep '}, annotations: Transaction.addToHistory.of(false)});
    editor.undo();
    // Mapping invalidates exact newline metadata; it must never invalidate the
    // unrelated characters. Studio has no addToHistory:false document writers.
    expect(editor.text()).toBe('Keep a\r\nb\r\nc');
    expect(editor.view.state.doc.toString()).toBe('Keep a\nb\nc');
    editor.destroy();
  });
  it('retains compact newline metadata rather than full source per grouped keystroke', () => {
    const source = `${'x'.repeat(2048)}\r\n`.repeat(128) + 'last\n';
    const editor = createEditor(document.createElement('div'), source, () => {}, () => {});
    for (let index = 0; index < 100; index++) {
      editor.view.dispatch({changes: {from: editor.view.state.doc.length, insert: 'x'}, annotations: [Transaction.userEvent.of('input.type'), Transaction.time.of(1000 + index)]});
    }
    const state = editor.view.state.field(historyField) as unknown as {done: {effects: {value: unknown}[]}[]};
    expect(state.done).toHaveLength(1);
    expect(state.done[0].effects).toHaveLength(1);
    expect(JSON.stringify(state.done[0].effects.map(effect => effect.value)).length).toBeLessThan(source.length / 16);
    editor.undo(); expect(editor.text()).toBe(source);
    editor.redo(); expect(editor.text()).toBe(source + 'x'.repeat(100));
    editor.destroy();
  }, 20000);
});
