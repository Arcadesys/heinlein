// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {renderQuestionAnswer} from './questionAnswer';

describe('Ask diff answers', () => {
  it('renders wording suggestions as read-only chips alongside concise advice', () => {
    const view = renderQuestionAnswer('A tighter verb.\n\n```diff\n-Rain tapped.\n+Rain drummed.\n```\n\nKeep the ending.', 'Answer');
    expect(view.querySelectorAll('.question-diff-chip')).toHaveLength(1);
    expect(view.querySelector('del')!.textContent).toBe('tapped');
    expect(view.querySelector('ins')!.textContent).toBe('drummed');
    expect(view.textContent).toContain('Keep the ending.');
    expect(view.querySelector('button')).toBeNull();
  });
  it('keeps malformed patches literal and model HTML inert', () => {
    const view = renderQuestionAnswer('```diff\n@@ pretend patch\n<script>bad()</script>\n```', 'Answer');
    expect(view.querySelector('.question-diff-chip')).toBeNull();
    expect(view.querySelector('script')).toBeNull();
    expect(view.textContent).toContain('<script>bad()</script>');
  });
});
