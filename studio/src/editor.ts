import { Annotation, Compartment, EditorState, StateEffect, StateField, Transaction, RangeSet } from '@codemirror/state';
import { EditorView, keymap, drawSelection, gutter, GutterMarker, Decoration, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, invertedEffects, undo, redo } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import type { TypewriterKey } from './writingFeedback';
import { focusMode } from './focusMode';

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
  let result = ''; let cursor = 0;
  const append = (part: string) => {
    // Deleting text between a lone CR and an LF (or inserting CR-style lines
    // before an LF) must not fuse two visible line breaks into one CRLF. Add
    // only the boundary separator; untouched source spans retain their bytes.
    if (result.endsWith('\r') && part.startsWith('\n')) result += '\n';
    result += part;
  };
  for (const change of changes) {
    const from = rawOffset(text, change.from); const to = rawOffset(text, change.to);
    append(text.slice(cursor, from));
    append(change.insert.replace(/\n/g, newline));
    cursor = to;
  }
  append(text.slice(cursor));
  return result;
}
export type EditorChangeOrigin = 'user' | 'history' | 'programmatic' | 'recovery';
export interface EditorPassage {id: string; from: number; to: number; label: string; active: boolean; open(): void}
const passageEffect = StateEffect.define<EditorPassage[]>();
class PassageMarker extends GutterMarker {
  constructor(readonly passages: EditorPassage[]) {super();}
  eq(other: PassageMarker) {return this.passages.length === other.passages.length && this.passages.every((p, i) => p.id === other.passages[i].id && p.label === other.passages[i].label && p.active === other.passages[i].active);}
  toDOM() {
    const node = document.createElement('div'); node.className = 'question-passage-chips';
    const passage = this.passages.find(p => p.active) ?? this.passages[0];
    if (passage) {
      const chip = document.createElement('button'); chip.type = 'button'; chip.tabIndex = -1; chip.className = 'question-passage-chip';
      const label = `${this.passages.length > 1 ? `${this.passages.length} passages · ` : ''}${passage.label} at this passage`;
      chip.setAttribute('aria-label', label); chip.title = label; chip.setAttribute('aria-pressed', String(passage.active));
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
      const sparkle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      sparkle.setAttribute('d', 'M12 2 15 9 22 12 15 15 12 22 9 15 2 12 9 9Z');
      icon.append(sparkle); chip.append(icon);
      chip.addEventListener('mousedown', event => event.preventDefault()); chip.addEventListener('click', passage.open); node.append(chip);
    }
    return node;
  }
}
const passageField = StateField.define<{markers: RangeSet<GutterMarker>; decorations: DecorationSet}>({
  create: () => ({markers: RangeSet.empty, decorations: Decoration.none}),
  update(value, transaction) {
    if (transaction.docChanged) value = {markers: RangeSet.empty, decorations: Decoration.none};
    for (const effect of transaction.effects) if (effect.is(passageEffect)) {
      const lines = new Map<number, EditorPassage[]>(); const ranges = [];
      for (const passage of effect.value) {
        if (passage.from < 0 || passage.to > transaction.newDoc.length || passage.to <= passage.from) continue;
        const position = transaction.newDoc.lineAt(passage.from).from; const group = lines.get(position) ?? []; group.push(passage); lines.set(position, group);
        if (passage.active) ranges.push(Decoration.mark({class: 'question-passage-highlight'}).range(passage.from, passage.to));
      }
      // Nearby anchors share one chip so generous targets cannot overlap on adjacent lines.
      const clusters: [number, EditorPassage[]][] = []; let previousLine = -2;
      for (const [position, passages] of [...lines].sort((a,b) => a[0]-b[0])) {const line = transaction.newDoc.lineAt(position).number; if (clusters.length && line <= previousLine + 1) clusters.at(-1)![1].push(...passages); else clusters.push([position, [...passages]]); previousLine = line;}
      value = {markers: RangeSet.of(clusters.map(([pos, passages]) => new PassageMarker(passages).range(pos))), decorations: Decoration.set(ranges, true)};
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
const replacement = Annotation.define<{text: string; origin: EditorChangeOrigin}>();
type RawHistory = {length: number; breaks: number; endings: {position: number; text: string}[]};
// Only newline metadata belongs in history, not a full manuscript copy per
// keystroke. Dropping mapped metadata keeps the earliest snapshot when typing
// groups merge, and invalidates snapshots changed by non-history transactions.
const rawHistory = StateEffect.define<RawHistory>({map: () => undefined});
function historyEndings(text: string): RawHistory {
  let removed = 0; let breaks = 0;
  const endings: RawHistory['endings'] = [];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    breaks++;
    if (match[0] !== '\n') endings.push({position: match.index! - removed, text: match[0]});
    if (match[0] === '\r\n') removed++;
  }
  return {length: text.length - removed, breaks, endings};
}
export function createEditor(parent: HTMLElement, source: string, changed: (raw: string, origin: EditorChangeOrigin) => void, save: () => void, typed?: (kind: TypewriterKey) => void) {
  let raw = source;
  let savedSource = source;
  const editable = new Compartment();
  const normalize = (text: string) => text.replace(/\r\n|\r/g, '\n');
  const rawSource = StateField.define<string>({
    create: () => source,
    update: (before, transaction) => {
      if (!transaction.docChanged) return before;
      const exact = transaction.annotation(replacement);
      if (exact) return exact.text;
      const visible = transaction.newDoc.toString();
      // History changes restore characters; these unmapped snapshots restore
      // only their exact newline bytes. Never apply incompatible metadata.
      for (let index = transaction.effects.length - 1; index >= 0; index--) {
        const effect = transaction.effects[index];
        if (!effect.is(rawHistory)) continue;
        const snapshot = effect.value;
        if (snapshot.length !== visible.length || snapshot.breaks !== transaction.newDoc.lines - 1 || snapshot.endings.some(ending => visible[ending.position] !== '\n')) continue;
        let restored = ''; let cursor = 0;
        for (const ending of snapshot.endings) {restored += visible.slice(cursor, ending.position) + ending.text; cursor = ending.position + 1;}
        return restored + visible.slice(cursor);
      }
      if (visible === normalize(savedSource)) return savedSource;
      if (visible === normalize(source)) return source;
      const changes: {from: number; to: number; insert: string}[] = [];
      transaction.changes.iterChanges((from, to, _a, _b, insert) => changes.push({from, to, insert: insert.toString()}));
      return applyRawChanges(before, changes);
    },
  });
  const view = new EditorView({ parent, state: EditorState.create({
    doc: normalize(source),
    extensions: [editable.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]), rawSource, passageField,
      // Reserve the compact icon width even before the first passage is marked.
      gutter({class: 'question-gutter', side: 'after', initialSpacer: () => new PassageMarker([]), markers: view => view.state.field(passageField).markers}),
      invertedEffects.of(transaction => transaction.docChanged ? [rawHistory.of(historyEndings(transaction.startState.field(rawSource)))] : []),
      history(), drawSelection(), markdown(), search({top: true}), EditorView.lineWrapping,
      EditorView.contentAttributes.of({'aria-label': 'Markdown editor', 'spellcheck': 'true'}),
      keymap.of([{key: 'Mod-s', run: () => { save(); return true; }}, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        const exact = update.transactions.map(transaction => transaction.annotation(replacement)).find(Boolean);
        raw = update.state.field(rawSource);
        const origin = exact?.origin ?? (update.transactions.some(transaction => transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) ? 'history'
          : update.transactions.some(transaction => transaction.isUserEvent('input') || transaction.isUserEvent('delete') || transaction.isUserEvent('move')) ? 'user' : 'programmatic');
        changed(raw, origin);
        // Transaction events distinguish actual typing from paste, drop, history and loads.
        // Composition updates stay silent to avoid repeated IME clicks.
        if (!update.state.readOnly && origin === 'user' && !view.composing) {
          for (const transaction of update.transactions) {
            if (!transaction.docChanged) continue;
            if (transaction.isUserEvent('delete')) { typed?.('delete'); break; }
            let newline = false;
            transaction.changes.iterChanges((_a, _b, _c, _d, insert) => { if (insert.lines > 1) newline = true; });
            // CodeMirror's Return command uses the plain input event.
            if (transaction.isUserEvent('input.type') || (newline && transaction.annotation(Transaction.userEvent) === 'input')) {
              typed?.(newline ? 'return' : 'key'); break;
            }
          }
        }
      }),
      focusMode,
      // Colors and type come from Appearance tokens on :root, so themes restyle the editor live.
      EditorView.theme({
        '&': {color: 'var(--fg)', backgroundColor: 'transparent', minHeight: '24rem'},
        '.cm-content': {fontFamily: 'var(--font-text, var(--text-fallback))', fontSize: 'var(--type-body)', lineHeight: 'var(--leading-body)', padding: '0 0 40vh', caretColor: 'var(--accent)'},
        '.cm-line': {padding: '0', transition: 'opacity .3s'},
        '.cm-cursor, .cm-dropCursor': {borderLeftColor: 'var(--accent)', borderLeftWidth: '2px'},
        // Matches CodeMirror's own focused-selection specificity so the base light theme can't win.
        '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, & .cm-content ::selection': {backgroundColor: 'var(--selection)'},
        '.cm-panels': {backgroundColor: 'var(--surface)', color: 'var(--fg)', borderColor: 'var(--border-strong)'},
        '.cm-searchMatch': {backgroundColor: 'var(--selection)', outline: '1px solid var(--accent)'},
      }),
    ],
  }) });
  return { view,
    setPassages: (passages: EditorPassage[]) => {
      const converted = passages.map(p => ({...p, from: normalize(raw.slice(0, p.from)).length, to: normalize(raw.slice(0, p.to)).length}));
      view.dispatch({effects: passageEffect.of(converted)});
    },
    selectPassage: (from: number, to: number) => view.dispatch({selection: {anchor: normalize(raw.slice(0, from)).length, head: normalize(raw.slice(0, to)).length}, scrollIntoView: true}),
    replaceText: (text: string, origin: EditorChangeOrigin = 'programmatic') => {
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text.replace(/\r\n|\r/g, '\n')}, annotations: replacement.of({text, origin})});
    },
    setEditable: (value: boolean) => view.dispatch({effects: editable.reconfigure([EditorState.readOnly.of(!value), EditorView.editable.of(value)])}),
    markSaved: (text: string) => { savedSource = text; }, text: () => raw, destroy: () => view.destroy(), undo: () => undo(view), redo: () => redo(view), find: () => openSearchPanel(view) };
}
