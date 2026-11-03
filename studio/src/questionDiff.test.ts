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

describe('compact diff chips', () => {
  it('shows multiple changed spans without echoing unchanged prose', async () => {
    const {createQuestionDiffChips} = await import('./questionDiff');
    const view = createQuestionDiffChips('Rain tapped the glass roof. She waited.', 'Rain drummed the glass roof. She left.');
    expect(view.querySelectorAll('details')).toHaveLength(2);
    expect(view.textContent).not.toContain('the glass roof');
    expect([...view.querySelectorAll('del')].map(n => n.textContent)).toEqual(['tapped', 'waited']);
    expect([...view.querySelectorAll('ins')].map(n => n.textContent)).toEqual(['drummed', 'left']);
    expect(view.querySelector('details')!.open).toBe(false);
  });
  it('retains whitespace, Unicode and literal HTML in expanded diff text', async () => {
    const {createQuestionDiffChips} = await import('./questionDiff');
    const view = createQuestionDiffChips('— 🦊\r\n', '— <script>alert(1)</script>\t');
    expect(view.querySelector('script')).toBeNull();
    expect([...view.querySelectorAll('del')].map(n => n.textContent).join('')).toBe('🦊\r\n');
    expect([...view.querySelectorAll('ins')].map(n => n.textContent).join('')).toBe('<script>alert(1)</script>\t');
  });
});
