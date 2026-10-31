// Production renderer with the existing synthetic in-memory host only.
import './standalone.fixture';
import {applyAppearance, loadAppearance} from '../../src/appearance';
import {EditorView} from '@codemirror/view';
const fixture = window as any;
fixture.projectFixture.savedText = Array.from({length: 180}, (_, i) => `Paragraph ${i}: The fox followed the winding path, carrying a notebook full of deliberate fragments — and stories. `.repeat(5)).join('\r\n\r\n');
fixture.openSyntheticProject().then(() => {
  const view = EditorView.findFromDOM(document.querySelector('.markdown-editor .cm-editor')!)!;
  if (location.search.includes('middle')) {
    view.dispatch({selection: {anchor: view.state.doc.line(181).from + 25}, scrollIntoView: true});
    view.focus();
  }
  const baseline = fixture.projectFixture.savedText as string;
  const anchorPosition = view.state.doc.line(181).from;
  fixture.shiftFixture = {view, baseline, insertionOffset: baseline.indexOf('Paragraph 90:') + 25, theme: (theme: 'default' | 'contrast') => applyAppearance({...loadAppearance(), theme: theme === 'default' ? loadAppearance().theme : theme}), sample: () => {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(anchorPosition);
    const at = view.coordsAtPos(head), anchor = view.coordsAtPos(line.from);
    const preview = document.querySelector('.preview')!;
    return {head, at, anchor, previewTop: preview.scrollTop, scrollTop: view.scrollDOM.scrollTop, width: view.contentDOM.getBoundingClientRect().width, source: fixture.projectFixture.savedText.length};
  }};
});
