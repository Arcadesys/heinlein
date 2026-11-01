// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createEditor} from './editor';
import type {ReviewEdit} from './localCore';
import {computeReviewMarks, createReviewMarkPublisher, locateUtf8, resolveReviewMarks, reviewMarkExtension, reviewMarksIn, setReviewMarks, type ReviewMarkInput} from './reviewMarks';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
import {StateEffect} from '@codemirror/state';

const bytes = (text: string) => new TextEncoder().encode(text).length;
const hash = 'a'.repeat(64);
const source = '---\r\ntitle: "É 🦊"\r\n---\n🐺 first — one.\r\n\rSecond 👩🏽‍🚀 two.\nThird é three — end.\r\n';
function edit(id: string, original: string, replacement: string, overrides: Partial<ReviewEdit> = {}, text = source): ReviewEdit {
  const from = bytes(text.slice(0, text.indexOf(original)));
  return {id, path: 'scene.md', fromUtf8: from, toUtf8: from + bytes(original), original, replacement, reason: id, role: 'editor', status: 'pending', proposalId: null, ...overrides};
}
const input = (edits: ReviewEdit[], baseline = hash): ReviewMarkInput => ({repositoryId: 'repo', projectKey: null, edits, baselineHash: () => baseline});
const target = (text = source, contentHash = hash, path = 'scene.md') => ({path, source: text, contentHash, toView: (position: number) => position});
let host: HTMLElement; let mounted: ReturnType<typeof createEditor>;
const open = (text = source) => {mounted = createEditor(host, text, () => {}, () => {}); mounted.view.dispatch({effects: StateEffect.appendConfig.of(reviewMarkExtension({open() {}, invalidated() {}, keys: {next: 'n', previous: 'p', open: 'o'}}))}); return mounted;};
beforeEach(() => {vi.stubGlobal('crypto', webcrypto); document.body.replaceChildren(); host = document.createElement('div'); document.body.append(host); Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();});
afterEach(() => {mounted?.destroy(); vi.unstubAllGlobals();});

describe('review mark mapping', () => {
  it.each(['first', 'one.', 'Second', 'two.', 'Third', 'three', 'end.', '🐺', '👩🏽‍🚀', 'é', '—', '🦊'])('lands exactly on %s through UTF-8, surrogates and mixed newlines', word => {
    const {view} = open();
    const [mark] = resolveReviewMarks(input([edit('x', word, 'new')]), [target()]);
    expect(view.state.sliceDoc(mark.from, mark.to)).toBe(word);
  });
  it('spans a CRLF as one CodeMirror line break without altering raw source', () => {
    const {view, text} = open();
    const [mark] = resolveReviewMarks(input([edit('x', 'one.\r\n\rSecond', 'joined')]), [target()]);
    expect(view.state.sliceDoc(mark.from, mark.to)).toBe('one.\n\nSecond');
    setReviewMarks(view, [mark]);
    expect(text()).toBe(source);
  });
  it('does not treat a captured offset as a CodeMirror or UTF-16 offset', () => {
    const wrong = edit('x', 'three', 'new');
    expect(wrong.fromUtf8).not.toBe(source.indexOf('three'));
    expect(locateUtf8(source, [wrong.fromUtf8]).get(wrong.fromUtf8)!.raw).toBe(source.indexOf('three'));
  });
  it('refuses a position inside a CRLF or a character', () => {
    const inside = bytes(source.slice(0, source.indexOf('\r\n') + 1));
    expect(locateUtf8(source, [inside]).has(inside)).toBe(false);
    const split = bytes(source.slice(0, source.indexOf('🐺'))) + 1;
    expect(locateUtf8(source, [split]).has(split)).toBe(false);
  });
  it('classifies replacement, deletion and insertion and keeps overlaps as a group', () => {
    const marks = resolveReviewMarks(input([edit('r', 'first', 'new'), edit('d', 'two.', ''), {...edit('i', 'Third', 'x'), toUtf8: edit('i', 'Third', 'x').fromUtf8, original: ''}, edit('o', 'three', 'a', {conflictGroup: 'g'})]), [target()]);
    expect(Object.fromEntries(marks.map(mark => [mark.id, mark.kind]))).toEqual({r: 'replace', d: 'delete', i: 'insert', o: 'replace'});
    expect(marks.find(mark => mark.id === 'o')!.group).toBe('g');
  });
  it('marks nothing when the applied text is not where the lineage says, even if the word exists elsewhere', () => {
    const accepted = edit('a', 'first', 'an early line', {status: 'accepted'});
    const later = edit('b', 'three', 'new');
    const moved = source.replace('first', 'other words');
    expect(resolveReviewMarks(input([accepted, later]), [target(moved)])).toEqual([]);
  });
  it('never relocates a suggestion whose text moved, even though the same text exists', () => {
    const moved = `Earlier three. ${source}`;
    expect(resolveReviewMarks(input([edit('b', 'three', 'new')]), [target(moved)])).toEqual([]);
  });
  it('honours path, hash, staleness and decided status', () => {
    const one = edit('x', 'first', 'new');
    expect(resolveReviewMarks(input([one]), [target(source, hash, 'other.md')])).toEqual([]);
    expect(resolveReviewMarks(input([one], 'b'.repeat(64)), [target()])).toEqual([]);
    expect(resolveReviewMarks(input([{...one, sourceStale: true}]), [target()])).toEqual([]);
    for (const status of ['rejected', 'supersededByAuthorChoice', 'blockedByAppliedDecision'] as const) expect(resolveReviewMarks(input([{...one, status}]), [target()])).toEqual([]);
    expect(resolveReviewMarks(input([{...one, status: 'prepared'}]), [target()])).toHaveLength(1);
  });
  it('drops marks on any document change rather than mapping them forward, and never edits text', () => {
    const {view, text} = open();
    setReviewMarks(view, resolveReviewMarks(input([edit('x', 'first', 'new')]), [target()]));
    const selection = view.state.selection.main.head;
    expect(reviewMarksIn(view.state)).toHaveLength(1);
    expect(text()).toBe(source);
    expect(view.state.selection.main.head).toBe(selection);
    view.dispatch({changes: {from: view.state.doc.length, insert: '!'}});
    expect(reviewMarksIn(view.state)).toEqual([]);
  });
});

describe('review mark lineage proof', () => {
  const sha = async (text: string) => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const accepted = edit('a', 'first', 'an early 🐺 line', {status: 'accepted'});
  const later = edit('b', 'three', 'new');
  const applied = source.replace('first', 'an early 🐺 line');
  it('does not draw when bytes changed outside every checked range, even at the same length and with a clean stale flag', async () => {
    const external = applied.replace('Second', 'Sekond');
    expect(external.length).toBe(applied.length);
    expect(external.indexOf('three')).toBe(applied.indexOf('three'));
    expect(await computeReviewMarks(input([accepted, later], await sha(source)), [target(external, 'changed-hash')])).toEqual([]);
    expect(resolveReviewMarks(input([accepted, later], await sha(source)), [target(external, 'changed-hash')])).toEqual([]);
  });
  it('still marks unrelated suggestions after genuine approvals, through Unicode and mixed newlines', async () => {
    const second = edit('c', 'Second', 'Next', {status: 'accepted'});
    const genuine = source.replace('first', 'an early 🐺 line').replace('Second', 'Next');
    const {view} = open(genuine);
    const marks = await computeReviewMarks(input([accepted, second, later], await sha(source)), [target(genuine, 'changed-hash')]);
    expect(marks.map(mark => mark.id)).toEqual(['b']);
    expect(view.state.sliceDoc(marks[0].from, marks[0].to)).toBe('three');
  });
  it('keeps later suggestions marked after an approved insertion, alone or after other approvals', async () => {
    const plain = 'abc def';
    const insertion = (at: number, text: string): ReviewEdit => ({...edit('i', 'abc', text, {status: 'accepted'}, plain), id: `insert-${at}`, fromUtf8: at, toUtf8: at, original: '', replacement: text});
    const pending = edit('p', 'def', 'new', {}, plain);
    const first = 'X🐺abc def';
    const {view} = open(first);
    const marks = await computeReviewMarks(input([insertion(0, 'X🐺'), pending], await sha(plain)), [target(first, 'changed-hash')]);
    expect(marks.map(mark => mark.id)).toEqual(['p']);
    expect(view.state.sliceDoc(marks[0].from, marks[0].to)).toBe('def');
    const replaced = edit('r', 'abc', 'ABCDE', {status: 'accepted'}, plain);
    const chained = 'ABCDE Ydef';
    const chainedMarks = await computeReviewMarks(input([replaced, insertion(4, 'Y'), pending], await sha(plain)), [target(chained, 'changed-hash')]);
    expect(chainedMarks.map(mark => mark.id)).toEqual(['p']);
    expect(chained.slice(chainedMarks[0].from, chainedMarks[0].to)).toBe('def');
    const atFirst = bytes(source.slice(0, source.indexOf('first')));
    const interior = source.replace('first', '👩🏽‍🚀\r\nfirst');
    mounted.destroy();
    const unicode = open(interior);
    const unicodeMarks = await computeReviewMarks(input([insertion(atFirst, '👩🏽‍🚀\r\n'), later], await sha(source)), [target(interior, 'changed-hash')]);
    expect(unicodeMarks.map(mark => mark.id)).toEqual(['b']);
    expect(unicode.view.state.sliceDoc(unicodeMarks[0].from, unicodeMarks[0].to)).toBe('three');
    const external = 'Xabc dez';
    expect(await computeReviewMarks(input([insertion(0, 'X'), edit('q', 'abc', 'new', {}, plain)], await sha(plain)), [target(external, 'changed-hash')])).toEqual([]);
  });
  it('fails closed on a wrong baseline hash or without local SHA-256', async () => {
    expect(await computeReviewMarks(input([accepted, later], 'b'.repeat(64)), [target(applied, 'changed-hash')])).toEqual([]);
    const right = await sha(source);
    vi.stubGlobal('crypto', {});
    expect(await computeReviewMarks(input([accepted, later], right), [target(applied, 'changed-hash')])).toEqual([]);
  });
  describe('publisher generation guard', () => {
    function slowDigest() {
      const real = webcrypto.subtle.digest.bind(webcrypto.subtle);
      let release!: () => void;
      const gate = new Promise<void>(resolve => {release = resolve;});
      vi.stubGlobal('crypto', {subtle: {digest: async (algorithm: string, data: BufferSource) => {await gate; return real(algorithm, data);}}});
      return release;
    }
    async function setup() {
      const expected = await sha(source);
      const editor = open(applied);
      const hooks = {view: () => editor.view as typeof editor.view | null, targets: () => [target(editor.text(), 'changed-hash')] as ReturnType<typeof target>[] | null, owns: () => true};
      return {editor, hooks, publisher: createReviewMarkPublisher(hooks), proof: input([accepted, later], expected)};
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    it('shows nothing during proof, then marks when text is unchanged', async () => {
      const {editor, publisher, proof} = await setup();
      const release = slowDigest(); const report = vi.fn();
      publisher.publish(proof, report);
      expect(reviewMarksIn(editor.view.state)).toEqual([]);
      expect(report).not.toHaveBeenCalled();
      release(); await settle();
      expect(reviewMarksIn(editor.view.state).map(mark => mark.id)).toEqual(['b']);
      expect(report).toHaveBeenCalledWith(1);
    });
    it('drops a late proof after typing, closing the review or losing the view', async () => {
      for (const interrupt of ['type', 'close', 'view', 'ineligible'] as const) {
        const {editor, hooks, publisher, proof} = await setup();
        const release = slowDigest(); const report = vi.fn();
        publisher.publish(proof, report);
        if (interrupt === 'type') editor.view.dispatch({changes: {from: 0, insert: 'x'}});
        if (interrupt === 'close') publisher.publish(null, () => {});
        if (interrupt === 'view') hooks.view = () => null;
        if (interrupt === 'ineligible') hooks.targets = () => null;
        release(); await settle();
        expect(reviewMarksIn(editor.view.state), interrupt).toEqual([]);
        expect(report, interrupt).not.toHaveBeenCalled();
        editor.destroy(); vi.stubGlobal('crypto', webcrypto);
      }
    });
    it('does not draw for a review owned by another repository', async () => {
      const {editor, hooks, publisher, proof} = await setup();
      hooks.owns = () => false;
      const report = vi.fn();
      publisher.publish(proof, report);
      await settle();
      expect(reviewMarksIn(editor.view.state)).toEqual([]);
      expect(report).toHaveBeenCalledWith(0);
    });
  });
});
