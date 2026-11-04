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

it('renders shared structured advice with inert evidence and read-only diffs', () => {
  const view=renderQuestionAnswer(JSON.stringify({schemaVersion:2,answer:'A stronger verb would help.',strengths:['Clear setting.'],findings:[{text:'Make the rain more immediate.',evidence:'<script>Rain tapped.</script>',editIds:['e1']}],edits:[{id:'e1',sceneIndex:0,original:'Rain tapped.',replacement:'Rain drummed.',reason:'A stronger sound.',role:'editor'}]}),'Answer');
  expect(view.getAttribute('aria-label')).toBe('Answer');
  expect(view.tabIndex).toBe(0);expect(view.textContent).toContain('Evidence: <script>Rain tapped.</script>');
  expect(view.textContent).toContain('Suggested edits · advice only');
  expect(view.querySelectorAll('.question-diff-chip')).toHaveLength(1);expect(view.querySelector('button,script')).toBeNull();
  expect(view.textContent).not.toContain('schemaVersion');
});
it('accepts a direct answer with no findings or edits',()=>{
  const view=renderQuestionAnswer(JSON.stringify({schemaVersion:2,answer:'The ending works.',strengths:[],findings:[],edits:[]}),'Answer');
  expect(view.textContent?.trim()).toBe('The ending works.');expect(view.querySelector('.question-diff-chip')).toBeNull();
});
