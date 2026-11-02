// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {createQuestionComparison, questionDiff} from './questionDiff';
describe('exact presentation diffs', () => {
  it.each([
    ['Rain tapped the glass roof.', 'Rain drummed against the glass roof.'],
    ['Again. Again. — 🐺\r\n\tThen.', 'Again. — 🐺\r\n\tThen. Again.'],
    ['delete — this\r\n', ''], ['', '<script>literal</script>'],
    ['same\r\n—\t', 'same\r\n—\t'], ['a '.repeat(1100), 'b '.repeat(1100)],
  ])('retains exact original and replacement bytes', (before, after) => {
    const parts = questionDiff(before, after);
    expect(parts.filter(p => p.kind !== 'add').map(p => p.text).join('')).toBe(before);
    expect(parts.filter(p => p.kind !== 'remove').map(p => p.text).join('')).toBe(after);
    const view = createQuestionComparison(before, after);
    expect(view.querySelectorAll('pre')[0].textContent).toBe(before);
    expect(view.querySelectorAll('pre')[1].textContent).toBe(after);
    expect(view.querySelector('script')).toBeNull();
  });
  it('marks changed words rather than the whole passage', () => {
    const view = createQuestionComparison('Rain tapped the roof.', 'Rain drummed against the roof.');
    expect(view.querySelector('.question-diff-remove')?.textContent).toBe('tapped');
    expect(view.querySelector('.question-diff-add')?.textContent).toBe('drummed against');
  });
});
