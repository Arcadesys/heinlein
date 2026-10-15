import { EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';

// CodeMirror uses LF positions internally. Preserve every untouched source byte,
// including mixed newline styles, instead of serializing a parsed manuscript.
export function rawOffset(text: string, position: number): number {
  let raw = 0;
  for (let n = 0; n < position && raw < text.length; n++, raw++) {
    if (text[raw] === '\r' && text[raw + 1] === '\n') raw++;
  }
  return raw;
}
export function applyRawChanges(text: string, changes: {from: number; to: number; insert: string}[]): string {
  const newline = text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  for (const change of [...changes].reverse()) {
    text = text.slice(0, rawOffset(text, change.from)) + change.insert.replace(/\n/g, newline) + text.slice(rawOffset(text, change.to));
  }
  return text;
}
export function createEditor(parent: HTMLElement, source: string, changed: (raw: string) => void, save: () => void) {
  let raw = source;
  let savedSource = source;
  const view = new EditorView({ parent, state: EditorState.create({
    doc: source.replace(/\r\n|\r/g, '\n'),
    extensions: [history(), drawSelection(), markdown(), search({top: true}), EditorView.lineWrapping,
      EditorView.contentAttributes.of({'aria-label': 'Markdown editor', 'spellcheck': 'true'}),
      keymap.of([{key: 'Mod-s', run: () => { save(); return true; }}, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        const changes: {from: number; to: number; insert: string}[] = [];
        update.changes.iterChanges((from, to, _a, _b, insert) => changes.push({from, to, insert: insert.toString()}));
        const visible = update.state.doc.toString();
        raw = visible === savedSource.replace(/\r\n|\r/g, '\n') ? savedSource : visible === source.replace(/\r\n|\r/g, '\n') ? source : applyRawChanges(raw, changes);
        changed(raw);
      }),
      EditorView.theme({
        '&': {color: '#f4f2ec', backgroundColor: '#121714', minHeight: '24rem'},
        '.cm-content': {fontFamily: 'var(--font-text, var(--font-mono, ui-monospace, monospace))', fontSize: '1rem', lineHeight: '1.85', padding: '1rem'},
        '.cm-cursor': {borderLeftColor: '#fff'}, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {backgroundColor: '#415840'},
        '.cm-panels': {backgroundColor: '#222c25', color: '#fff'}, '.cm-searchMatch': {backgroundColor: '#79601b'},
      }, {dark: true}),
    ],
  }) });
  return { view, markSaved: (text: string) => { savedSource = text; }, text: () => raw, destroy: () => view.destroy(), undo: () => undo(view), redo: () => redo(view), find: () => openSearchPanel(view) };
}
