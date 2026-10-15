// @vitest-environment jsdom
import {afterAll, afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Transaction} from '@codemirror/state';
import {isolateHistory} from '@codemirror/commands';
import {applyRawChanges, createEditor, rawOffset} from './editor';
import {campaign, coverageCounter, normalize, positions, seeded, textAtoms} from './testing/seeded';

type Change = {from: number; to: number; insert: string};
// A separate token model treats CRLF as one displayed UTF-16 unit; all other
// units, including both halves of a surrogate pair, occupy their own position.
function modelChange(raw: string, changes: Change[]) {
  const tokens = raw.match(/\r\n|[\s\S]/g) ?? [];
  const lineEnding = tokens.find(token => /[\r\n]/.test(token)) ?? '\n';
  let cursor = 0;
  const output: string[] = [];
  for (const change of changes) {
    output.push(...tokens.slice(cursor, change.from), ...(change.insert.match(/[\s\S]/g) ?? []).map(unit => unit === '\n' ? lineEnding : unit));
    cursor = change.to;
  }
  output.push(...tokens.slice(cursor));
  return output.reduce((result, token) => result + (result.endsWith('\r') && token === '\n' ? '\n' : '') + token, '');
}
const settings = campaign('EDITOR');
const totals = coverageCounter();
afterAll(() => {console.info('EDITOR_FUZZ_COVERAGE', JSON.stringify({...settings, operations: totals.counts}));});
let editor: ReturnType<typeof createEditor> | undefined;
beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  document.body.replaceChildren();
});
afterEach(() => {editor?.destroy(); editor = undefined;});

describe('seeded actual editor byte/undo state machine', () => {
  for (let offset = 0; offset < settings.seeds; offset++) {
    const seed = (settings.firstSeed + offset) >>> 0;
    it(`preserves raw source and history invariants seed=${seed}`, () => {
      const random = seeded(seed);
      const source = ['---\r\nunknown: 🐺\n---\rFirst — line\r\nSecond e\u0301', '𝄞\ra\r\nb\nc', '', '漢字\n🐺\r\nlast'][random(4)];
      let saved = source;
      const trace: string[] = [];
      let origin = '';
      editor = createEditor(document.body, source, (_raw, value) => {origin = value;}, () => {});
      const history: string[] = [source];
      let historyIndex = 0;
      const coverage = new Set<string>();
      const record = (name: string) => {coverage.add(name); totals.record(name);};
      try {
        for (let step = 0; step < settings.steps; step++) {
          const choice = random(10);
          const before = editor.text();
          const visible = editor.view.state.doc.toString();
          if (choice < 6) {
            const boundaries = positions(visible);
            const start = random(boundaries.length);
            const end = start + random(boundaries.length - start);
            const insert = textAtoms[random(textAtoms.length)] + (random(5) ? '' : textAtoms[random(textAtoms.length)]);
            const changes: Change[] = [{from: boundaries[start], to: boundaries[end], insert}];
            // Non-overlapping multiple changes use the same old-document offsets.
            if (choice === 0 && boundaries[end] < visible.length) changes.push({from: visible.length, to: visible.length, insert: '🐾\n'});
            const nextVisible = normalize(modelChange(visible, changes));
            const expected = nextVisible === normalize(saved) ? saved : nextVisible === normalize(source) ? source : modelChange(before, changes);
            const event = choice === 1 ? undefined : choice === 2 ? 'delete.selection' : 'input.type';
            trace.push(`${step}: ${event ?? 'programmatic'} ${JSON.stringify(changes)}`);
            record(event ?? 'programmatic');
            if (changes.length > 1) record('multi-change');
            expect(applyRawChanges(before, changes)).toBe(modelChange(before, changes));
            editor.view.dispatch({changes, annotations: [isolateHistory.of('full'), ...(event ? [Transaction.userEvent.of(event)] : [])]});
            expect(editor.text()).toBe(expected);
            expect(editor.view.state.doc.toString()).toBe(nextVisible);
            expect(origin).toBe(event ? 'user' : 'programmatic');
            history.splice(historyIndex + 1); history.push(expected); historyIndex++;
          } else if (choice === 6) {
            trace.push(`${step}: markSaved`); record('markSaved');
            saved = editor.text(); editor.markSaved(saved);
          } else if (choice === 7 || choice === 8) {
            const direction = choice === 7 ? 'undo' : 'redo';
            trace.push(`${step}: ${direction}`); record(direction);
            const possible = choice === 7 ? historyIndex > 0 : historyIndex < history.length - 1;
            expect(editor[direction]()).toBe(possible);
            if (possible) {historyIndex += choice === 7 ? -1 : 1; expect(origin).toBe('history');}
            expect(editor.view.state.doc.toString()).toBe(normalize(history[historyIndex]));
            expect(editor.text()).toBe(history[historyIndex]);
          } else {
            trace.push(`${step}: selection/readOnly toggle`); record('readOnly');
            editor.setEditable(false); expect(editor.view.state.readOnly).toBe(true);
            editor.view.dispatch({selection: {anchor: random(visible.length + 1)}});
            expect(editor.text()).toBe(before); editor.setEditable(true);
          }
          expect(normalize(editor.text())).toBe(editor.view.state.doc.toString());
          let offset = 0; let position = 0;
          for (const token of editor.text().match(/\r\n|[\s\S]/g) ?? []) {
            expect(rawOffset(editor.text(), position++)).toBe(offset); offset += token.length;
          }
          expect(rawOffset(editor.text(), position)).toBe(editor.text().length);
          expect(document.querySelector('script')).toBeNull();
        }
        // Short prefixes remain valid replay/minimization inputs. Coverage is
        // reported across the campaign rather than requiring luck per seed.
      } catch (error) {
        throw new Error(`EDITOR_FUZZ_FIRST_SEED=${seed} EDITOR_FUZZ_SEEDS=1 EDITOR_FUZZ_STEPS=${settings.steps}\n${trace.join('\n')}`, {cause: error});
      }
    });
  }
});
