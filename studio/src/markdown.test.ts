// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {renderMarkdown} from './markdown';

describe('advice Markdown', () => {
  it('renders semantic formatting without normalizing authorial punctuation', () => {
    const node = renderMarkdown('# Advice\n\n**Keep** *this* — exactly.\n\n- One\n- Two\n\n> Quoted\n\n```js\nconst x = 1;\n```', 'Answer 1');
    expect(node.querySelector('h1')?.textContent).toBe('Advice');
    expect(node.querySelector('strong')?.textContent).toBe('Keep');
    expect(node.querySelector('em')?.textContent).toBe('this');
    expect(node.querySelectorAll('li')).toHaveLength(2);
    expect(node.querySelector('blockquote')?.textContent).toContain('Quoted');
    expect(node.querySelector('pre code')?.textContent).toBe('const x = 1;\n');
    expect(node.textContent).toContain('— exactly.');
    expect(node.tabIndex).toBe(0); expect(node.getAttribute('aria-label')).toBe('Answer 1');
  });
  it('blocks executable HTML, unsafe URLs and image fetches', () => {
    const node = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [file](file:///secret) [relative](/private) ![description](https://example.com/tracker.png)\n\n[safe](https://example.com)');
    expect(node.querySelector('script,img,iframe')).toBeNull();
    expect(node.querySelectorAll('a')).toHaveLength(1);
    expect(node.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(node.textContent).toContain('description');
  });
});
