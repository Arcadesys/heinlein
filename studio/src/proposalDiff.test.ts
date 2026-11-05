// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {createProposalDiff} from './proposalDiff';

describe('proposal change passages', () => {
  it('shows changed words on cards and keeps scene context folded until clicked', () => {
    const view = createProposalDiff('Rain tapped the glass.\n', 'Rain drummed the glass.\n', true);
    const card = view.querySelector('details')!;
    expect(card.open).toBe(false);
    expect(card.querySelector('summary del')?.textContent).toBe('− tapped');
    expect(card.querySelector('summary ins')?.textContent).toBe('+ drummed');
    expect(card.querySelector('summary')?.textContent).not.toContain('the glass');
    expect(card.querySelector('pre')?.textContent).toBe('Rain tapped the glass.\n');
    card.querySelector('summary')!.click();
    expect(card.open).toBe(true);
  });
  it('shows distant edits without echoing the unchanged scene', () => {
    const middle = Array.from({length: 200}, (_, i) => `Unchanged paragraph ${i}.\n`).join('');
    const view = createProposalDiff(`# Vivian\n${middle}showing  his ass.\n`, `## Vivian\n${middle}showing his ass.\n`);
    expect(view.querySelectorAll('.proposal-diff-hunk')).toHaveLength(2);
    expect(view.textContent).not.toContain('Unchanged paragraph 100.');
    expect([...view.querySelectorAll('.question-diff-add')].map(n => n.textContent).join('')).toContain('#');
    expect([...view.querySelectorAll('.question-diff-remove')].map(n => n.textContent).join('')).toContain('  ');
  });
  it.each([['', '<script>literal</script>\n'], ['Delete — 🦊\r\n', ''], ['one\r\n two\n', 'one\r\n\ttwo\n']])('retains exact changed text and treats markup literally', (before, after) => {
    const view = createProposalDiff(before, after);
    expect([...view.querySelectorAll('pre')].map(n => n.textContent)).toEqual([before, after]);
    expect(view.querySelector('script')).toBeNull();
  });
  it('reports identical text without changes', () => {
    const view = createProposalDiff('Keep — this.\n', 'Keep — this.\n');
    expect(view.textContent).toBe('No text changes');
    expect(view.querySelector('pre')).toBeNull();
  });
});
