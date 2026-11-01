// @vitest-environment jsdom
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {frontmatterEnd} from './assembledChapter';
import {createMarkdownReader, linkIsUnsafe, READING_LIMIT_BYTES, renderMarkdown} from './markdownReader';
import type {ReviewMark} from './reviewMarks';

const whole = (text: string) => [{from: 0, to: text.length}];
const render = (text: string, marks: ReviewMark[] = []) => renderMarkdown(text, whole(text), marks);
const mark = (id: string, from: number, to: number, kind: ReviewMark['kind'] = 'replace', group: string | null = null): ReviewMark => ({id, from, to, kind, group});
const at = (text: string, part: string): [number, number] => [text.indexOf(part), text.indexOf(part) + part.length];
beforeEach(() => document.body.replaceChildren());

describe('Markdown reading renderer', () => {
  it('formats headings, emphasis, lists, quotes, code, rules and tables below the page heading', () => {
    const {content} = render('# One\n\n## Two\n\nA *soft* **strong** ~~gone~~ `code` line.\n\n- a\n- b\n\n3. c\n\n> quote\n\n---\n\n```js\nlet x;\n```\n\n| h |\n|---|\n| d |\n');
    expect([...content.querySelectorAll('h3,h4')].map(n => n.tagName)).toEqual(['H3', 'H4']);
    expect(content.querySelector('em')!.textContent).toBe('soft');
    expect(content.querySelector('strong')!.textContent).toBe('strong');
    expect(content.querySelector('s')!.textContent).toBe('gone');
    expect(content.querySelector('p code')!.textContent).toBe('code');
    expect(content.querySelectorAll('ul li')).toHaveLength(2);
    expect(content.querySelector('ol')!.start).toBe(3);
    expect(content.querySelector('blockquote p')!.textContent).toBe('quote');
    expect(content.querySelector('hr')).toBeTruthy();
    expect(content.querySelector('pre.md-code code')!.textContent).toContain('let x;');
    expect(content.querySelector('th')!.textContent).toBe('h');
    expect(content.querySelector('td')!.textContent).toBe('d');
    expect(content.textContent).not.toContain('**');
  });
  it('builds only allowlisted elements with no source-derived attributes', () => {
    const hostile = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nText <b onclick="x()" style="color:red">raw</b> <iframe src="http://evil.test"></iframe>\n\n[a](javascript:alert(1) "t") ![i](http://evil.test/x.png "t") <https://auto.test> [r][ref]\n\n[ref]: http://evil.test/ref\n\n```html\n<script>code()</script>\n```\n\n| <img src=x> |\n|---|\n| <svg onload=x> |\n';
    const {content} = render(hostile);
    document.body.append(content);
    expect(content.querySelector('script,img,iframe,a,svg,object,embed,link,style,video,audio,source,form,input,base,meta')).toBeNull();
    const allowed = new Set(['class', 'tabindex']);
    for (const node of content.querySelectorAll('*')) for (const attribute of node.attributes) expect(allowed.has(attribute.name), `${node.tagName} ${attribute.name}`).toBe(true);
    expect(content.textContent).toContain('<script>alert(1)</script>');
    expect(content.textContent).toContain('<b onclick="x()" style="color:red">');
    expect(content.textContent).toContain('<script>code()</script>');
  });
  it('shows link destinations as text, labels unsafe ones and never loads an image', () => {
    const {content} = render('[safe](https://x.test) [bad](javascript:alert(1)) [odd](java\tscript:x) ![alt](https://x.test/i.png)');
    expect(content.querySelector('a,img')).toBeNull();
    expect(content.querySelector('.md-link')!.textContent).toBe('safe (https://x.test)');
    expect(content.querySelector('.md-link-blocked')!.textContent).toBe('bad (blocked link: javascript:alert(1))');
    expect(content.querySelector('.md-image')!.textContent).toBe('Image not loaded: alt (https://x.test/i.png)');
  });
  it.each([['javascript:x', true], ['JAVASCRIPT:x', true], ['java\tscript:x', true], [' data:text/html,x', true], ['file:///etc', true], ['vbscript:x', true], ['https://x', false], ['HTTP://x', false], ['mailto:a@b', false], ['chapter.md', false], ['#top', false]])('labels %j as unsafe: %s', (url, unsafe) => {
    expect(linkIsUnsafe(url)).toBe(unsafe);
  });
  it('leaves entities and unfamiliar syntax literal, and hides only the escape backslash', () => {
    const {content} = render('A &amp; B \\* C :smile:');
    expect(content.textContent).toBe('A &amp; B * C :smile:');
  });
  it('keeps every text node a verbatim slice with Unicode, em dashes and CRLF-normalized positions', () => {
    const lf = '# Écriture 🦊\n\nA 👩🏽‍🚀 fragment — kept.\nNext e\u0301 line.\n';
    const word = at(lf, 'fragment');
    const {content, marked} = render(lf, [mark('x', ...word)]);
    expect(marked.get('x')!.textContent).toBe('fragment');
    expect(content.querySelector('p')!.textContent).toBe('A 👩🏽‍🚀 fragment — kept.\nNext e\u0301 line.');
  });
  it('marks exact words through nested inline syntax and splits across formatting', () => {
    const text = 'Plain **bold word** end.';
    const [from] = at(text, 'word');
    const {content} = render(text, [mark('inner', from, from + 4), mark('span', text.indexOf('Plain'), text.indexOf(' end'))]);
    expect(content.querySelector('strong [data-review-id="inner"]')!.textContent).toBe('word');
    expect([...content.querySelectorAll('[data-review-id="span"]')].map(n => n.textContent).join('|')).toBe('Plain |bold |word');
    expect(content.textContent).toBe('Plain bold word end.');
  });
  it('gives markup-only and spacing suggestions a block-scoped control, never a misplaced mark', () => {
    const text = '# Title\n\nSome **bold** text.\n\n[l](https://x.test)\n';
    const hash = text.indexOf('#'), stars = text.indexOf('**');
    const {content, marked} = render(text, [mark('hash', hash, hash + 1), mark('stars', stars, stars + 2)]);
    expect(marked.get('hash')!.tagName).toBe('BUTTON');
    expect(marked.get('hash')!.previousElementSibling!.textContent!.trim()).toBe('Title');
    expect(marked.get('stars')!.previousElementSibling!.tagName).toBe('P');
    expect(content.querySelectorAll('span[data-review-id]')).toHaveLength(0);
    expect(marked.get('hash')!.textContent).toBe('Formatting suggestion: open it');
  });
  it('places a suggestion before the body in a control at the top', () => {
    const text = '---\ntitle: x\n---\nBody words.\n';
    const body = frontmatterEnd(text)!;
    const {content, marked} = renderMarkdown(text, [{from: body, to: text.length}], [mark('fm', text.indexOf('title'), text.indexOf('title') + 5)]);
    expect(content.firstElementChild).toBe(marked.get('fm'));
    expect(content.textContent).not.toContain('title: x');
  });
  it('shows an insertion as a point with no added text', () => {
    const text = 'One two.';
    const {content, marked} = render(text, [mark('i', 3, 3, 'insert')]);
    expect(marked.get('i')!.className).toBe('cm-review-point');
    expect(content.textContent).toBe(text);
  });
  it('keeps overlapping alternatives nested, each still openable', () => {
    const text = 'in long grey sheets.';
    const {content} = render(text, [mark('all', ...at(text, 'long grey sheets'), 'replace', 'g'), mark('word', ...at(text, 'grey'), 'replace', 'g')]);
    expect(content.querySelector('[data-review-id="all"] [data-review-id="word"]')!.textContent).toBe('grey');
    expect(content.textContent).toBe(text);
  });
  it('renders parts separately so an open fence cannot swallow the next one, at exact positions', () => {
    const text = '```\nopen\n\nNext *part*';
    const next = text.indexOf('Next');
    const {content, marked} = renderMarkdown(text, [{from: 0, to: next - 2}, {from: next, to: text.length}], [mark('p', ...at(text, 'part'))]);
    expect(content.querySelector('em')!.textContent).toBe('part');
    expect(marked.get('p')!.textContent).toBe('part');
  });
});

describe('Markdown reader view', () => {
  const setup = (text: string, marks: ReviewMark[] = []) => {
    const open = vi.fn(), showSource = vi.fn();
    const reader = createMarkdownReader({label: 'Reading view', content: () => ({text, ranges: whole(text), marks}), open, showSource});
    document.body.append(reader.element);
    reader.element.hidden = false;
    reader.update();
    return {reader, open, showSource};
  };
  const key = (element: HTMLElement, code: string) => element.dispatchEvent(new KeyboardEvent('keydown', {code, ctrlKey: true, metaKey: true, altKey: true, bubbles: true}));
  it('opens a mark on click and does nothing else', () => {
    const text = 'One two.';
    const {reader, open} = setup(text, [mark('a', 0, 3)]);
    reader.element.querySelector<HTMLElement>('[data-review-id="a"]')!.click();
    expect(open).toHaveBeenCalledExactlyOnceWith('a');
  });
  it('does not open on a modified click', () => {
    const {reader, open} = setup('One two.', [mark('a', 0, 3)]);
    reader.element.querySelector<HTMLElement>('[data-review-id]')!.dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}));
    expect(open).not.toHaveBeenCalled();
  });
  it('steps with the keyboard, including markup-only suggestions and adjacent marks, and opens the one announced', () => {
    const text = '# T\n\nword. tail';
    const {reader, open} = setup(text, [mark('hash', 0, 1), mark('word', ...at(text, 'word')), mark('dot', ...at(text, '.'))]);
    key(reader.element, 'KeyO');
    expect(open).not.toHaveBeenCalled();
    for (const id of ['hash', 'word', 'dot', 'hash']) {
      key(reader.element, 'BracketRight');
      key(reader.element, 'KeyO');
      expect(open).toHaveBeenLastCalledWith(id);
    }
    key(reader.element, 'BracketLeft');
    key(reader.element, 'KeyO');
    expect(open).toHaveBeenLastCalledWith('dot');
    expect(reader.element.querySelector('.md-review-current')!.textContent).toBe('.');
    expect(reader.element.querySelectorAll('[tabindex]:not(.md-table)')).toHaveLength(0);
  });
  it('falls back to Source over the Reading limit, cutting nothing and rendering nothing', () => {
    const text = 'x'.repeat(READING_LIMIT_BYTES + 1);
    const {reader, showSource} = setup(text);
    expect(reader.element.textContent).toContain('over 2 MiB');
    expect(reader.element.textContent!.length).toBeLessThan(400);
    [...reader.element.querySelectorAll('button')].find(n => n.textContent === 'Show Source')!.click();
    expect(showSource).toHaveBeenCalledOnce();
  });
  it('renders right at the Reading limit', () => {
    const {reader} = setup('x'.repeat(READING_LIMIT_BYTES));
    expect(reader.element.querySelector('.markdown-reader-content p')).toBeTruthy();
  });
});

describe('shared frontmatter boundary', () => {
  it.each([['---\nt: 1\n---\nBody', 13], ['---\nt: 1\n---', 12], ['No frontmatter', 0], ['--- not\nthing', 0], ['---\nunfinished', null], ['---\n---\nB', 8]])('finds the body of %j', (text, end) => {
    expect(frontmatterEnd(text)).toBe(end);
  });
});
