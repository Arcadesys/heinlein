import {RangeSetBuilder, type Text} from '@codemirror/state';
import {Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate} from '@codemirror/view';

/**
 * Author notes use CriticMarkup comments: `{>>note<<}`. They are private
 * instructions for Heinlein about the adjacent prose and never part of the
 * published text. A note may wrap lines but never crosses a blank line.
 */
export const NOTE_OPEN = '{>>';
export const NOTE_CLOSE = '<<}';
const NOTE_PATTERN = /\{>>(?:(?!<<\}|\n[ \t]*\n|\r\n[ \t]*\r\n)[\s\S])*?<<\}/g;

export function findAuthorComments(text: string): {from: number; to: number}[] {
  return [...text.matchAll(NOTE_PATTERN)].map(match => ({from: match.index!, to: match.index! + match[0].length}));
}

/** Why a note can't be inserted as written, or null when it can. */
export function noteProblem(note: string): string | null {
  const text = note.trim();
  if (!text) return 'Write a note first.';
  if (text.includes(NOTE_OPEN) || text.includes(NOTE_CLOSE)) return `A note can't contain ${NOTE_OPEN} or ${NOTE_CLOSE}.`;
  if (/\n[ \t]*\n/.test(text.replace(/\r\n?/g, '\n'))) return "A note can't contain a blank line.";
  return null;
}

/** The exact text inserted after the noted passage. */
export function noteInsertion(note: string): string {
  return ` ${NOTE_OPEN}${note.trim().replace(/\r\n?/g, '\n')}${NOTE_CLOSE}`;
}

// Colour and background only: a note must never change line metrics or reflow text.
const mark = Decoration.mark({class: 'cm-author-comment', attributes: {title: 'Note for Heinlein. Not published.'}});
function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const {from, to} of findAuthorComments(view.state.doc.toString())) builder.add(from, to, mark);
  return builder.finish();
}
export const authorCommentMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(update: ViewUpdate) { if (update.docChanged) this.decorations = build(update.view); }
}, {decorations: plugin => plugin.decorations});

export interface NoteTarget { doc: Text; from: number; to: number }
/** Capture where a note will go: after the highlighted passage, or at the cursor. */
export function noteTarget(view: EditorView): NoteTarget {
  const range = view.state.selection.main; return {doc: view.state.doc, from: range.from, to: range.to};
}
/**
 * Insert the note after the captured passage as one author edit, leaving the
 * passage itself untouched and still selected. Returns a refusal message, or null.
 */
export function insertNote(view: EditorView, target: NoteTarget, note: string): string | null {
  const problem = noteProblem(note); if (problem) return problem;
  if (view.state.readOnly) return 'This document is read-only.';
  const now = view.state.selection.main;
  if (view.state.doc !== target.doc || now.from !== target.from || now.to !== target.to) return 'The text or selection changed. Cancel, highlight the passage again, and add the note.';
  view.dispatch({changes: {from: target.to, insert: noteInsertion(note)}, selection: {anchor: target.from, head: target.to}, userEvent: 'input.note', scrollIntoView: true});
  return null;
}
