// Inline review highlights. These are CodeMirror decorations only: they never touch the
// document, selection authority or review state. Clicking one only asks the panel to show a card.
import { StateEffect, StateField, EditorSelection, type Extension, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import type { ReviewEdit } from './localCore';
import { lineageDelta, waiting } from './reviewComparison';

export interface ReviewMarkTarget {
  path: string;
  /** Raw source exactly as it is open now, never a normalized or exported copy. */
  source: string;
  contentHash: string;
  /** CodeMirror position in this source to a position in the visible view, or null when not shown. */
  toView(position: number): number | null;
}
export interface ReviewMarkInput {
  repositoryId: string;
  projectKey: string | null;
  edits: ReviewEdit[];
  baselineHash(path: string): string | undefined;
}
export type ReviewMarkKind = 'replace' | 'delete' | 'insert';
export interface ReviewMark { id: string; from: number; to: number; kind: ReviewMarkKind; group: string | null }

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;
function utf8Width(point: number) { return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4; }

/** One forward walk from captured UTF-8 offsets to raw UTF-16 and CodeMirror LF positions. */
export function locateUtf8(source: string, offsets: Iterable<number>) {
  const wanted = new Set(offsets);
  const found = new Map<number, {raw: number; view: number}>();
  let byte = 0, view = 0, raw = 0;
  while (raw <= source.length) {
    // A position between CR and LF has no CodeMirror equivalent, so it stays unresolved.
    const insideBreak = raw > 0 && source[raw - 1] === '\r' && source[raw] === '\n';
    if (!insideBreak && wanted.has(byte)) found.set(byte, {raw, view});
    if (raw === source.length) break;
    const point = source.codePointAt(raw)!;
    const units = point > 0xffff ? 2 : 1;
    byte += utf8Width(point);
    if (!(source[raw] === '\r' && source[raw + 1] === '\n')) view += units;
    raw += units;
  }
  return found;
}

/** Rebuilds the review's baseline bytes on a copy by reversing accepted patches. Null when they are not where the lineage says. */
export function baselineFromAccepted(source: string, edits: readonly ReviewEdit[], path: string): Uint8Array | null {
  const data = encoder.encode(source);
  const accepted = edits.filter(edit => edit.path === path && edit.status === 'accepted').sort((a, b) => a.fromUtf8 - b.fromUtf8);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of accepted) {
    const from = edit.fromUtf8 + lineageDelta(edits, edit), replacement = encoder.encode(edit.replacement);
    if (from < cursor || from + replacement.length > data.length || replacement.some((byte, index) => data[from + index] !== byte)) return null;
    parts.push(data.slice(cursor, from), encoder.encode(edit.original));
    cursor = from + replacement.length;
  }
  parts.push(data.slice(cursor));
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
async function sha256(bytes: Uint8Array) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const hasAccepted = (input: ReviewMarkInput, path: string) => input.edits.some(edit => edit.path === path && edit.status === 'accepted');
/**
 * Whole-file proof after approvals: the open text, with accepted patches reversed on a copy, must hash to
 * the review's immutable baseline. A change anywhere else in the file fails it, whatever its length.
 */
export async function proveAcceptedLineage(input: ReviewMarkInput, targets: readonly ReviewMarkTarget[]) {
  const proven = new Set<string>();
  for (const target of targets) {
    if (!hasAccepted(input, target.path)) continue;
    const baseline = baselineFromAccepted(target.source, input.edits, target.path);
    const expected = input.baselineHash(target.path);
    try { if (baseline && expected && await sha256(baseline) === expected) proven.add(target.path); } catch { /* No local SHA-256: stays unproven and unmarked. */ }
  }
  return proven;
}
/** Marks only suggestions proved to match this source. Anything uncertain is left unmarked, never searched for. */
export function resolveReviewMarks(input: ReviewMarkInput, targets: readonly ReviewMarkTarget[], proven: ReadonlySet<string> = new Set()): ReviewMark[] {
  const marks: ReviewMark[] = [];
  for (const target of targets) {
    const edits = input.edits.filter(edit => edit.path === target.path);
    const accepted = edits.filter(edit => edit.status === 'accepted');
    if (accepted.length ? !proven.has(target.path) : input.baselineHash(target.path) !== target.contentHash) continue;
    const span = (edit: ReviewEdit) => { const from = edit.fromUtf8 + lineageDelta(input.edits, edit); return {from, to: from + (edit.status === 'accepted' ? utf8Length(edit.replacement) : edit.toUtf8 - edit.fromUtf8)}; };
    const pending = edits.filter(edit => waiting(edit) && !edit.sourceStale);
    const located = locateUtf8(target.source, [...accepted, ...pending].flatMap(edit => { const {from, to} = span(edit); return [from, to]; }));
    const slice = (edit: ReviewEdit) => { const {from, to} = span(edit); const a = located.get(from), b = located.get(to); return a && b ? {text: target.source.slice(a.raw, b.raw), from: a.view, to: b.view} : null; };
    // Every applied change must still be exactly where the accepted lineage says it is.
    if (accepted.some(edit => slice(edit)?.text !== edit.replacement)) continue;
    for (const edit of pending) {
      const place = slice(edit);
      if (!place || place.text !== edit.original) continue;
      const from = target.toView(place.from), to = target.toView(place.to);
      if (from === null || to === null || to < from) continue;
      marks.push({id: edit.id, from, to, kind: from === to ? 'insert' : edit.replacement ? 'replace' : 'delete', group: edit.conflictGroup ?? null});
    }
  }
  return marks.sort((a, b) => a.from - b.from || a.to - b.to);
}

export async function computeReviewMarks(input: ReviewMarkInput, targets: readonly ReviewMarkTarget[]) {
  return resolveReviewMarks(input, targets, await proveAcceptedLineage(input, targets));
}
/** Publishes marks to the current view. Nothing is shown while a proof runs, and a late proof for older text is dropped. */
export function createReviewMarkPublisher(hooks: {view(): EditorView | null; targets(): ReviewMarkTarget[] | null; owns(input: ReviewMarkInput): boolean}) {
  let generation = 0;
  return {publish(input: ReviewMarkInput | null, report: (count: number | null) => void) {
    const token = ++generation;
    const view = hooks.view();
    if (!view) { report(input ? 0 : null); return; }
    const targets = input && hooks.owns(input) ? hooks.targets() : null;
    if (!input || !targets) { setReviewMarks(view, []); report(input ? 0 : null); return; }
    if (!targets.some(target => hasAccepted(input, target.path))) {
      const marks = resolveReviewMarks(input, targets);
      setReviewMarks(view, marks);
      report(marks.length);
      return;
    }
    setReviewMarks(view, []);
    void proveAcceptedLineage(input, targets).then(proven => {
      const now = hooks.targets();
      if (token !== generation || hooks.view() !== view || !now || now.length !== targets.length || now.some((target, index) => target.path !== targets[index].path || target.source !== targets[index].source)) return;
      const marks = resolveReviewMarks(input, targets, proven);
      setReviewMarks(view, marks);
      report(marks.length);
    });
  }};
}
class PointWidget extends WidgetType {
  constructor(readonly id: string) { super(); }
  eq(other: PointWidget) { return other.id === this.id; }
  toDOM() { const node = document.createElement('span'); node.className = 'cm-review-point'; node.dataset.reviewId = this.id; node.title = 'Suggested insertion. Click to open it.'; return node; }
  ignoreEvent() { return false; }
}
function decorate(state: EditorState, marks: readonly ReviewMark[]): DecorationSet {
  const ranges = marks.flatMap(mark => {
    // A range of only line breaks has no glyph to underline, so it gets the same point marker.
    if (mark.from === mark.to || /^\n+$/.test(state.sliceDoc(mark.from, mark.to))) return [Decoration.widget({widget: new PointWidget(mark.id), side: 1}).range(mark.from)];
    const label = mark.group ? 'Competing suggestions.' : mark.kind === 'delete' ? 'Suggested removal.' : 'Suggested change.';
    return [Decoration.mark({class: `cm-review-mark cm-review-${mark.group ? 'overlap' : mark.kind}`, attributes: {'data-review-id': mark.id, title: `${label} Click to open it.`}}).range(mark.from, mark.to)];
  });
  return Decoration.set(ranges, true);
}
const setMarks = StateEffect.define<readonly ReviewMark[]>();
const empty = {marks: [] as readonly ReviewMark[], decorations: Decoration.none};
const markState = StateField.define<typeof empty>({
  create: () => empty,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMarks)) return effect.value.length ? {marks: effect.value, decorations: decorate(transaction.state, effect.value)} : empty;
    // Ranges were proved against one exact source. Any edit ends that proof; they are not mapped forward.
    return transaction.docChanged ? empty : value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
export const reviewMarksIn = (state: EditorState) => state.field(markState, false)?.marks ?? [];
export function setReviewMarks(view: EditorView, marks: readonly ReviewMark[]) {
  const before = reviewMarksIn(view.state);
  if (before.length || marks.length) view.dispatch({effects: setMarks.of(marks)});
}
export interface ReviewMarkKeys { next: string; previous: string; open: string }
function step(view: EditorView, direction: 1 | -1, keys: ReviewMarkKeys) {
  const marks = reviewMarksIn(view.state);
  if (!marks.length) return false;
  const head = view.state.selection.main.head;
  const ahead = marks.findIndex(mark => mark.from > head), behind = marks.filter(mark => mark.from < head).length - 1;
  const at = direction > 0 ? (ahead >= 0 ? ahead : 0) : (behind >= 0 ? behind : marks.length - 1);
  view.dispatch({selection: EditorSelection.cursor(marks[at].from), scrollIntoView: true, userEvent: 'select', effects: EditorView.announce.of(`Suggestion ${at + 1} of ${marks.length}${marks[at].group ? ', competing alternatives' : ''}. ${keys.open} opens it.`)});
  return true;
}
export function reviewMarkExtension(hooks: {open(id: string): void; invalidated(): void; keys: ReviewMarkKeys}): Extension {
  let pressed: {id: string; x: number; y: number} | null = null;
  return [markState,
    keymap.of([
      {key: 'Mod-Alt-]', run: view => step(view, 1, hooks.keys)},
      {key: 'Mod-Alt-[', run: view => step(view, -1, hooks.keys)},
      {key: 'Mod-Alt-o', run: view => {
        const marks = reviewMarksIn(view.state);
        if (!marks.length) return false;
        const head = view.state.selection.main.head;
        const hit = marks.find(mark => mark.from <= head && head <= mark.to);
        if (hit) hooks.open(hit.id);
        else view.dispatch({effects: EditorView.announce.of(`No suggestion at the cursor. ${hooks.keys.next} moves to the next one.`)});
        return true;
      }},
    ]),
    EditorView.domEventHandlers({
      // The press names the mark: focusing the editor can scroll it before release, which retargets the click.
      mousedown(event) {
        const id = (event.target as HTMLElement).closest?.<HTMLElement>('[data-review-id]')?.dataset.reviewId;
        pressed = id && event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey ? {id, x: event.clientX, y: event.clientY} : null;
        return false;
      },
      // Runs after CodeMirror placed the caret. A drag, double click selection or modified click stays ordinary editing.
      click(event, view) {
        const press = pressed;
        pressed = null;
        if (!press || view.compositionStarted || !view.state.selection.main.empty || Math.abs(event.clientX - press.x) > 4 || Math.abs(event.clientY - press.y) > 4) return false;
        if (reviewMarksIn(view.state).some(mark => mark.id === press.id)) hooks.open(press.id);
        return false;
      },
    }),
    EditorView.updateListener.of(update => { if (update.docChanged && reviewMarksIn(update.startState).length) hooks.invalidated(); }),
  ];
}
