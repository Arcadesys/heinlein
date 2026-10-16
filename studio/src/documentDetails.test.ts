// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {Transaction} from '@codemirror/state';
import {createEditor, rawOffset} from './editor';
import {createDocumentDetails, inspectDetails, detailValue} from './documentDetails';
import {moveLineUp, selectAll} from '@codemirror/commands';
import {findNext, SearchQuery, setSearchQuery} from '@codemirror/search';
const raw = '---\r\n# Keep my comment\r\ntitle: "Morning."\r\ntype: short-fiction\r\ncanonical: true\r\nseries: null\r\ntags: []\r\nunknown_field:\r\n  nested: [one, two]\r\n---\r\nFirst 🦊—paragraph.\nSecond line.';
let editor: ReturnType<typeof createEditor>;
let details: HTMLDetailsElement;
beforeEach(() => {document.body.replaceChildren(); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();});
afterEach(() => editor?.destroy());
function start(source = raw) {
  const parent = document.createElement('div'); const host = document.createElement('div'); document.body.append(parent, host);
  const changed = vi.fn(); editor = createEditor(host, source, changed, () => {}); details = createDocumentDetails(parent, editor); return changed;
}
const toggle = () => details.querySelector('button')!;
describe('document details', () => {
  it('keeps the full byte-exact source while tucking fields away by default', () => {
    const changed = start(); expect(details.open).toBe(false); expect(details.querySelector('summary')?.textContent).toBe('Document details');
    expect(details.textContent).toContain('Short fiction'); expect(details.textContent).toContain('Part of canonYes'); expect(details.textContent).toContain('SeriesNot set'); expect(details.textContent).toContain('TagsNone'); expect(details.textContent).toContain('Unknown fieldStructured details');
    expect(editor.view.contentDOM.textContent).not.toContain('title:'); expect(editor.view.contentDOM.textContent).toContain('First 🦊—paragraph.');
    expect(editor.text()).toBe(raw); expect(changed).not.toHaveBeenCalled();
    const position = editor.view.state.selection.main.from; expect(raw.slice(rawOffset(raw, position))).toBe('First 🦊—paragraph.\nSecond line.');
  });
  it('preserves comments, unknown nested data and mixed endings through prose edits, save baseline and undo', () => {
    start(); const at = editor.view.state.doc.toString().indexOf('First');
    editor.view.dispatch({changes: {from: at, to: at + 5, insert: 'New'}, annotations: Transaction.userEvent.of('input.type')});
    expect(editor.text()).toBe(raw.replace('First', 'New')); editor.markSaved(editor.text());
    editor.undo(); expect(editor.text()).toBe(raw); editor.redo(); expect(editor.text()).toBe(raw.replace('First', 'New'));
  });
  it('reveals source for metadata editing and updates labels without reserialization', () => {
    start(); toggle().click(); expect(toggle().getAttribute('aria-expanded')).toBe('true'); expect(editor.view.contentDOM.textContent).toContain('title:'); expect(document.activeElement).toBe(editor.view.contentDOM);
    const at = editor.view.state.doc.toString().indexOf('Morning.'); editor.view.dispatch({changes: {from: at, to: at + 8, insert: 'Evening.'}, annotations: Transaction.userEvent.of('input.type')});
    expect(details.textContent).toContain('Evening.'); expect(editor.text()).toBe(raw.replace('Morning.', 'Evening.'));
    toggle().click(); expect(editor.view.contentDOM.textContent).not.toContain('title:'); editor.undo(); expect(editor.text()).toBe(raw); expect(details.textContent).toContain('Morning.');
  });
  it('reveals metadata on search selection without shifting any offsets', () => {
    start(); const at = editor.view.state.doc.toString().indexOf('Morning.'); editor.view.dispatch({selection: {anchor: at, head: at + 8}, scrollIntoView: true});
    expect(editor.view.state.sliceDoc(at, at + 8)).toBe('Morning.'); expect(editor.view.contentDOM.textContent).toContain('title:'); expect(toggle().getAttribute('aria-expanded')).toBe('true'); expect(editor.text()).toBe(raw);
  });
  it('finds hidden fields using the actual editor search command', () => {
    start(); editor.view.dispatch({effects: setSearchQuery.of(new SearchQuery({search: 'Morning.'}))}); expect(findNext(editor.view)).toBe(true);
    const range = editor.view.state.selection.main; expect(editor.view.state.sliceDoc(range.from, range.to)).toBe('Morning.');
    expect(editor.view.contentDOM.textContent).toContain('title:'); expect(editor.text()).toBe(raw);
  });
  it('treats prototype-looking unknown keys as ordinary source data', () => {
    start('---\nconstructor: custom\n__proto__: untouched\n---\nBody');
    expect(details.textContent).toContain('Constructorcustom'); expect(details.textContent).toContain('untouched');
    expect(details.textContent).not.toContain('function Object');
  });
  it('does not silently backspace through hidden fields', () => {
    const changed = start(); const end = editor.view.state.selection.main.from;
    editor.view.dispatch({changes: {from: end - 1, to: end}, annotations: Transaction.userEvent.of('delete.backward')});
    expect(editor.text()).toBe(raw); expect(changed).not.toHaveBeenCalled(); expect(editor.view.contentDOM.textContent).toContain('title:');
  });
  it('reveals before a line-move command can cross hidden metadata', () => {
    const changed = start(); moveLineUp(editor.view);
    expect(editor.text()).toBe(raw); expect(changed).not.toHaveBeenCalled(); expect(editor.view.contentDOM.textContent).toContain('title:');
  });
  it('reveals before typing against a closing divider at EOF without a newline', () => {
    const source = '---\ntitle: Test\n---'; const changed = start(source);
    editor.view.dispatch({changes: {from: editor.view.state.doc.length, insert: 'Body'}, annotations: Transaction.userEvent.of('input.type')});
    expect(editor.text()).toBe(source); expect(changed).not.toHaveBeenCalled(); expect(editor.view.contentDOM.textContent).toContain('title:');
    editor.view.dispatch({changes: {from: editor.view.state.doc.length, insert: '\nBody'}, annotations: Transaction.userEvent.of('input.type')});
    expect(editor.text()).toBe(source + '\nBody'); editor.undo(); expect(editor.text()).toBe(source);
  });
  it('reveals select-all before a deliberate whole-source edit', () => {
    start(); selectAll(editor.view); expect(editor.view.contentDOM.textContent).toContain('title:'); expect(editor.view.state.selection.main.from).toBe(0);
    editor.view.dispatch({changes: {from: 0, to: editor.view.state.doc.length, insert: 'Replacement'}, annotations: Transaction.userEvent.of('input.paste')}); expect(editor.text()).toBe('Replacement'); editor.undo(); expect(editor.text()).toBe(raw);
  });
  it('refreshes from recovery and programmatic replacements without rewriting them', () => {
    start(); const recovery = raw.replace('Morning.', 'Recovered.'); editor.replaceText(recovery, 'recovery'); expect(editor.text()).toBe(recovery); expect(details.textContent).toContain('Recovered.'); expect(editor.view.contentDOM.textContent).toContain('title:');
  });
  it.each(['No details\n---\nScene', '---\ntitle: incomplete', '---\ntitle: [broken\n---\nProse', '---\ntitle: one\ntitle: two\n---\nProse', '---\n- list\n---\nProse'])('keeps missing or unsafe frontmatter fully visible: %s', source => {
    start(source); expect(inspectDetails(source).end).toBe(0); expect(editor.text()).toBe(source); expect(editor.view.state.doc.toString()).toBe(source); expect(toggle().hidden).toBe(true);
  });
  it.each(['\r', '\r\n', '\n'])('folds each supported newline style without changing bytes: %j', newline => {
    const source = ['---', 'title: Test', '# comment', '---', 'Body'].join(newline);
    start(source); expect(editor.view.contentDOM.textContent).not.toContain('title:'); expect(editor.text()).toBe(source); expect(toggle().hidden).toBe(false);
  });
  it('uses native disclosure and button semantics and escapes manuscript HTML', () => {
    start('---\ntitle: "<img src=x onerror=alert(1)>"\n---\nText'); expect(details.tagName).toBe('DETAILS'); expect(details.firstElementChild?.tagName).toBe('SUMMARY'); expect(toggle().type).toBe('button'); expect(details.querySelector('img')).toBeNull();
    const cycle: unknown[] = []; cycle.push(cycle); expect(detailValue(cycle)).toContain('Structured');
  });
});
