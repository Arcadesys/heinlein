import {describe, expect, it} from 'vitest';
import {changedSpan, decisionLabel, invisibleChangeNote, patchContext, pendingLabel, reviewProgress} from './reviewComparison';

const bytes = (text: string) => new TextEncoder().encode(text).length;
describe('review comparison display helpers', () => {
  const source = '---\r\ntitle: "Écriture 🦊"\r\n---\r\n🐺 bad — keep.\r\n';
  const from = bytes('---\r\ntitle: "Écriture 🦊"\r\n---\r\n🐺 ');
  it('returns raw neighbouring text only when the exact bytes still match', () => {
    const context = patchContext(source, from, from + 3, 'bad')!;
    expect(context.before + 'bad' + context.after).toBe(source);
    expect(context).toMatchObject({cutBefore: false, cutAfter: false});
    expect(patchContext(source, from, from + 3, 'bed')).toBeNull();
    expect(patchContext(source, from, bytes(source) + 1, 'bad')).toBeNull();
    expect(patchContext(source, from - 2, from + 3, '\ud83d')).toBeNull();
  });
  it('never splits a multi-byte character at the window edge', () => {
    for (let window = 1; window < 12; window++) {
      const context = patchContext(source, from, from + 3, 'bad', window)!;
      expect(source).toContain(context.before + 'bad' + context.after);
      expect(context.before + context.after).not.toContain('\ufffd');
    }
  });
  it('limits context to the paragraph and marks the cut for CRLF and LF', () => {
    const text = 'Earlier.\r\n\r\nNear bad far.\n\nLater.';
    const at = bytes('Earlier.\r\n\r\nNear ');
    expect(patchContext(text, at, at + 3, 'bad')).toEqual({before: 'Near ', after: ' far.', cutBefore: true, cutAfter: true});
  });
  it.each([['a bad — day', 'a good — day'], ['', 'added'], ['removed', ''], ['same', 'same'], ['🐺 e\u0301', '🐺 é'], ['x\r\ny', 'x\ny']])('rejoins exactly: %j → %j', (a, b) => {
    const part = changedSpan(a, b);
    expect(part.prefix + part.removed + part.suffix).toBe(a);
    expect(part.prefix + part.added + part.suffix).toBe(b);
  });
  it('narrows emphasis to whole changed words and leaves the em dash alone', () => {
    expect(changedSpan('a bad — day', 'a good — day')).toEqual({prefix: 'a ', removed: 'bad', added: 'good', suffix: ' — day'});
  });
  it('describes changes that rendered text would hide, without touching visible edits', () => {
    expect(invisibleChangeNote('one  two', 'one two')).toContain('removes 2 spaces and adds 1 space');
    expect(invisibleChangeNote('a\r\nb', 'a\nb')).toContain('removes 1 CRLF line break and adds 1 LF line break');
    expect(invisibleChangeNote('bad', 'good')).toBeNull();
    expect(invisibleChangeNote('', 'added')).toBeNull();
  });
  it('words every decision and pending state plainly, stale taking priority', () => {
    expect(decisionLabel('supersededByAuthorChoice')).toContain('competing alternative');
    expect(decisionLabel('blockedByAppliedDecision')).toContain('Blocked');
    expect(pendingLabel({sourceStale: true, conflictGroup: 'g', selected: true})).toContain('Source changed');
    expect(pendingLabel({conflictGroup: 'g', selected: true})).toContain('not applied yet');
    expect(pendingLabel({conflictGroup: 'g', selected: false})).toContain('choose one');
  });
  it('summarises progress without zero counts', () => {
    expect(reviewProgress([{status: 'pending'}, {status: 'prepared'}, {status: 'accepted'}])).toBe('3 suggestions: 2 waiting for your decision · 1 applied');
    expect(reviewProgress([])).toBe('0 suggestions');
  });
});
