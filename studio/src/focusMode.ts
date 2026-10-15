import {RangeSetBuilder} from '@codemirror/state';
import {Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate} from '@codemirror/view';

// Marks every visible line outside the cursor's paragraph. CSS dims them only while
// `:root[data-focus-mode]` is set, so turning the option off needs no editor change.
const dimmed = Decoration.line({class: 'cm-dimmed'});

/** The [first, last] line numbers of the blank-line-delimited paragraph holding `line`. */
export function paragraphAround(lineText: (line: number) => string, line: number, lines: number): [number, number] {
  if (!lineText(line).trim()) return [line, line];
  let first = line; let last = line;
  while (first > 1 && lineText(first - 1).trim()) first--;
  while (last < lines && lineText(last + 1).trim()) last++;
  return [first, last];
}

function build(view: EditorView): DecorationSet {
  const doc = view.state.doc; const builder = new RangeSetBuilder<Decoration>();
  const [first, last] = paragraphAround(n => doc.line(n).text, doc.lineAt(view.state.selection.main.head).number, doc.lines);
  let previous = -1;
  for (const {from, to} of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = doc.lineAt(position);
      if (line.from > previous && (line.number < first || line.number > last)) builder.add(line.from, line.from, dimmed);
      previous = line.from;
      position = line.to + 1;
    }
  }
  return builder.finish();
}

export const focusMode = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = build(update.view); }
}, {decorations: plugin => plugin.decorations});
