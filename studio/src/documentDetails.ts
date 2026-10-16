import {EditorState, StateEffect, StateField, Transaction} from '@codemirror/state';
import {Decoration, EditorView} from '@codemirror/view';
import {isMap, parseDocument} from 'yaml';

// Presentation only. The original document remains the editor's sole source of
// truth; YAML is never serialized back into it, even when malformed or unknown.
export function inspectDetails(source: string) {
  const match = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\r|\n)([\s\S]*?)^---[ \t]*(?:\r\n|\r|\n|$)/m.exec(source);
  if (!match || match.index !== 0) return {end: 0, entries: [] as [string, unknown][], problem: /^(?:\uFEFF)?---[ \t]*(?:\r\n|\r|\n)/.test(source) ? 'The document details have no closing divider. The full source remains visible.' : null};
  try {
    const parsed = parseDocument(match[1].replace(/\r\n|\r/g, '\n'), {uniqueKeys: true});
    if (parsed.errors.length || !isMap(parsed.contents)) return {end: 0, entries: [] as [string, unknown][], problem: 'These document details could not be read safely. Review them in the source below.'};
    const value = parsed.toJS({mapAsMap: true, maxAliasCount: 50}) as Map<unknown, unknown>;
    if ([...value.keys()].some(key => typeof key !== 'string')) throw new Error('Complex keys');
    return {end: match[0].length, entries: [...value.entries()] as [string, unknown][], problem: null};
  } catch {
    return {end: 0, entries: [] as [string, unknown][], problem: 'These document details could not be read safely. Review them in the source below.'};
  }
}
const labels: Record<string, string> = {title: 'Title', slug: 'Short identifier', type: 'Document type', status: 'Status', canonical: 'Part of canon', universe: 'Story universe', words: 'Recorded word count', series: 'Series', part: 'Part number', venue: 'Publication venue', date: 'Date', supersedes: 'Replaces', duplicate_of: 'Duplicate of', tags: 'Tags'};
const help: Record<string, string> = {slug: 'The identifier stored in this file.', canonical: 'Whether this document is marked as part of the story canon.', words: 'Stored in the file; this is not a live word count.', supersedes: 'Earlier documents this one replaces.', duplicate_of: 'The original document, if this is a duplicate.'};
export function detailValue(value: unknown, depth = 0): string {
  if (depth > 4) return 'Structured details · View in source';
  if (value == null || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(item => detailValue(item, depth + 1)).join(', ') : 'None';
  if (typeof value === 'object') return 'Structured details · View in source';
  return String(value);
}
const reveal = StateEffect.define<boolean>();
const folded = StateField.define<{hidden: boolean; end: number}>({
  create: state => ({hidden: true, end: inspectDetails(state.doc.toString()).end}),
  update: (before, tr) => {
    let hidden = before.hidden;
    for (const effect of tr.effects) if (effect.is(reveal)) hidden = !effect.value;
    const end = tr.docChanged ? inspectDetails(tr.newDoc.toString()).end : before.end;
    if (tr.docChanged) tr.changes.iterChangedRanges((from) => {if (from < before.end) hidden = false;});
    if (tr.selection && tr.newSelection.ranges.some(range => range.from < end)) hidden = false;
    return {hidden, end};
  },
  provide: field => EditorView.decorations.from(field, value => value.hidden && value.end ? Decoration.set([Decoration.replace({block: true}).range(0, value.end)]) : Decoration.none),
});
export function createDocumentDetails(parent: HTMLElement, editor: {view: EditorView; text: () => string}) {
  const details = document.createElement('details'); details.className = 'metadata document-details';
  const summary = document.createElement('summary'); summary.textContent = 'Document details';
  const content = document.createElement('div'); content.className = 'document-details-content';
  const explanation = document.createElement('p'); explanation.className = 'muted';
  explanation.textContent = 'Information stored with this manuscript. To change it, open the source fields below; edits use the same Save and Undo as your writing.';
  const fields = document.createElement('dl'); fields.className = 'document-details-fields';
  const problem = document.createElement('p'); problem.className = 'muted';
  const toggle = document.createElement('button'); toggle.type = 'button';
  toggle.addEventListener('click', () => {
    const state = editor.view.state.field(folded); const show = state.hidden;
    editor.view.dispatch({effects: reveal.of(show), ...(!show && editor.view.state.selection.ranges.some(range => range.from < state.end) ? {selection: {anchor: state.end}} : {})});
    if (show) {editor.view.dispatch({selection: {anchor: 0}, scrollIntoView: true}); editor.view.focus();}
  });
  content.append(explanation, fields, problem, toggle); details.append(summary, content); parent.replaceWith(details);
  function refresh() {
    const data = inspectDetails(editor.text()); fields.replaceChildren();
    for (const [key, value] of data.entries) {
      const group = document.createElement('div'); const name = document.createElement('dt'); const description = document.createElement('dd');
      name.textContent = Object.hasOwn(labels, key) ? labels[key] : key.replace(/[_-]/g, ' ').replace(/^./, letter => letter.toUpperCase());
      description.textContent = (key === 'type' || key === 'status') && typeof value === 'string' ? value.replace(/[_-]/g, ' ').replace(/^./, letter => letter.toUpperCase()) : key === 'words' && typeof value === 'number' ? value.toLocaleString() : detailValue(value);
      if (Object.hasOwn(help, key)) {const hint = document.createElement('small'); hint.textContent = help[key]; description.append(hint);}
      group.append(name, description); fields.append(group);
    }
    problem.textContent = data.problem ?? (data.end ? '' : 'This document has no document details.'); problem.hidden = !problem.textContent;
    toggle.hidden = !data.end;
    const hidden = editor.view.state.field(folded).hidden;
    toggle.textContent = hidden ? 'Edit source fields' : 'Hide source fields'; toggle.setAttribute('aria-expanded', String(!hidden));
  }
  const end = inspectDetails(editor.view.state.doc.toString()).end;
  editor.view.dispatch({effects: StateEffect.appendConfig.of([
    folded,
    EditorState.transactionFilter.of(tr => {
      const state = tr.startState.field(folded, false);
      if (!state?.hidden || !state.end || !tr.docChanged || !tr.annotation(Transaction.userEvent) || tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;
      const closingAtEof = state.end === tr.startState.doc.length && tr.startState.doc.sliceString(state.end - 1) !== '\n';
      let touches = false; tr.changes.iterChangedRanges(from => {if (from < state.end || closingAtEof && from === state.end) touches = true;});
      // Never let Backspace at the start of the prose silently delete hidden
      // metadata. Reveal first; a second deliberate edit operates on visible text.
      return touches ? {effects: reveal.of(true), selection: tr.startState.selection} : tr;
    }),
    EditorView.updateListener.of(update => {if (update.docChanged || update.startState.field(folded, false)?.hidden !== update.state.field(folded).hidden) refresh();}),
  ]), ...(end ? {selection: {anchor: end}} : {})});
  refresh(); return details;
}
