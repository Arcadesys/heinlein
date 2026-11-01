// Formatted, read-only view of Markdown source. Manuscript text is untrusted: the DOM is built only from an
// allowlist of elements and text nodes, so nothing in the source can add markup, attributes, requests or scripts.
// Every text node is a verbatim slice of the LF source with a known range, which is what lets review marks land exactly.
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { ReviewMark } from './reviewMarks';
import { formatKeys, isMac } from './shortcuts';

type MdNode = ReturnType<typeof markdownLanguage.parser.parse>['topNode'];
export interface ReaderRange { from: number; to: number }
export interface ReaderContent { text: string; ranges: ReaderRange[]; note?: string; marks?: readonly ReviewMark[] }
/** Reading only. Source view, opening and saving have no such bound. */
export const READING_LIMIT_BYTES = 2 * 1024 * 1024;

const hiddenMarks = new Set(['EmphasisMark', 'CodeMark', 'LinkMark', 'HeaderMark', 'QuoteMark', 'ListMark', 'StrikethroughMark', 'SubscriptMark', 'SuperscriptMark', 'TableDelimiter', 'URL', 'LinkTitle', 'LinkLabel', 'CodeInfo']);
const inlineElements: Record<string, keyof HTMLElementTagNameMap> = {Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 's', Subscript: 'sub', Superscript: 'sup', InlineCode: 'code'};
const headingLevel = (name: string) => { const match = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(name); return match ? Number(match[1]) : 0; };
// Links never navigate. This only decides how a destination is labelled.
export function linkIsUnsafe(url: string) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(/[\u0000-\u0020\u007f-\u009f]/g, ''));
  return Boolean(scheme) && !['http', 'https', 'mailto'].includes(scheme![1].toLowerCase());
}

interface TextEntry { node: Text; from: number; to: number }
interface Rendered { content: HTMLElement; marked: Map<string, HTMLElement> }

export function renderMarkdown(doc: string, ranges: readonly ReaderRange[], marks: readonly ReviewMark[] = []): Rendered {
  const content = document.createElement('div');
  content.className = 'markdown-reader-content';
  let texts: TextEntry[] = [];
  const tops: {element: HTMLElement; from: number; to: number}[] = [];
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, className = '') => { const node = document.createElement(tag); if (className) node.className = className; parent.append(node); return node; };
  const text = (parent: HTMLElement, from: number, to: number) => {
    if (to <= from) return;
    const node = document.createTextNode(doc.slice(from, to));
    parent.append(node);
    texts.push({node, from, to});
  };
  const generated = (parent: HTMLElement, value: string) => { make('span', parent, 'md-generated').textContent = value; };
  const children = (node: MdNode) => { const list: MdNode[] = []; for (let child = node.firstChild; child; child = child.nextSibling) list.push(child); return list; };

  function destination(url: MdNode | undefined, parent: HTMLElement, offset: number) {
    if (!url) return;
    const unsafe = linkIsUnsafe(doc.slice(url.from + offset, url.to + offset));
    generated(parent, unsafe ? ' (blocked link: ' : ' (');
    text(parent, url.from + offset, url.to + offset);
    generated(parent, ')');
    if (unsafe) parent.classList.add('md-link-blocked');
  }
  function inline(node: MdNode, parent: HTMLElement, offset: number, from = node.from, to = node.to) {
    let position = from;
    for (const child of children(node)) {
      if (child.to <= from || child.from >= to) continue;
      text(parent, position + offset, child.from + offset);
      position = child.to;
      const tag = inlineElements[child.name];
      if (tag) inline(child, make(tag, parent), offset);
      else if (child.name === 'Link' || child.name === 'Image') {
        const wrapper = make('span', parent, child.name === 'Link' ? 'md-link' : 'md-image');
        if (child.name === 'Image') generated(wrapper, 'Image not loaded: ');
        // Only the label reads as text here. The destination is shown once below, and titles stay out.
        const marks = child.getChildren('LinkMark');
        if (marks.length >= 2) inline(child, wrapper, offset, marks[0].to, marks[1].from);
        destination(child.getChild('URL') ?? undefined, wrapper, offset);
      }
      else if (child.name === 'URL' || child.name === 'Autolink') {
        const wrapper = make('span', parent, 'md-link');
        const url = child.name === 'URL' ? child : child.getChild('URL');
        const unsafe = url ? linkIsUnsafe(doc.slice(url.from + offset, url.to + offset)) : false;
        if (unsafe) { wrapper.classList.add('md-link-blocked'); generated(wrapper, 'Blocked link: '); }
        if (url) text(wrapper, url.from + offset, url.to + offset);
      }
      else if (child.name === 'HTMLTag') text(make('code', parent, 'md-raw'), child.from + offset, child.to + offset);
      else if (child.name === 'Escape') text(parent, child.from + 1 + offset, child.to + offset);
      else if (child.name === 'HardBreak') make('br', parent);
      else if (!hiddenMarks.has(child.name)) {
        // Entities, task markers, emoji and anything unknown stay literal rather than being interpreted.
        if (child.firstChild) inline(child, parent, offset); else text(parent, child.from + offset, child.to + offset);
      }
    }
    text(parent, position + offset, to + offset);
  }
  function literal(node: MdNode, parent: HTMLElement, offset: number, className: string) { text(make('pre', parent, className), node.from + offset, node.to + offset); }
  function block(node: MdNode, parent: HTMLElement, offset: number) {
    const level = headingLevel(node.name);
    if (level) {
      // The document title is the page heading, so source headings sit below it. Size follows the source level.
      inline(node, make(`h${Math.min(6, level + 2)}` as 'h3', parent, `md-heading-${level}`), offset);
      return;
    }
    switch (node.name) {
      case 'Paragraph': inline(node, make('p', parent), offset); return;
      case 'Task': inline(node, make('p', parent), offset); return;
      case 'Blockquote': { const quote = make('blockquote', parent); for (const child of children(node)) block(child, quote, offset); return; }
      case 'BulletList': { const list = make('ul', parent); for (const child of children(node)) block(child, list, offset); return; }
      case 'OrderedList': {
        const list = make('ol', parent);
        const first = /^\d+/.exec(doc.slice(node.from + offset, node.to + offset))?.[0];
        if (first && Number(first) !== 1 && first.length < 10) list.start = Number(first);
        for (const child of children(node)) block(child, list, offset);
        return;
      }
      case 'ListItem': { const item = make('li', parent); for (const child of children(node)) block(child, item, offset); return; }
      case 'ListMark': case 'QuoteMark': case 'CodeMark': case 'TaskMarker': case 'TableDelimiter': return;
      case 'HorizontalRule': make('hr', parent); return;
      case 'FencedCode': case 'CodeBlock': {
        const code = make('code', make('pre', parent, 'md-code'));
        const lines = children(node).filter(child => child.name === 'CodeText');
        for (const line of lines) text(code, line.from + offset, line.to + offset);
        return;
      }
      case 'Table': {
        const scroll = make('div', parent, 'md-table');
        scroll.tabIndex = 0;
        const table = make('table', scroll);
        for (const row of children(node)) {
          if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
          const line = make('tr', table);
          for (const cell of children(row)) if (cell.name === 'TableCell') inline(cell, make(row.name === 'TableHeader' ? 'th' : 'td', line), offset);
        }
        return;
      }
      default: literal(node, parent, offset, 'md-raw');
    }
  }
  for (const range of ranges) {
    const tree = markdownLanguage.parser.parse(doc.slice(range.from, range.to));
    for (const child of children(tree.topNode)) {
      const before = content.children.length;
      block(child, content, range.from);
      for (let index = before; index < content.children.length; index++) tops.push({element: content.children[index] as HTMLElement, from: child.from + range.from, to: child.to + range.from});
    }
  }

  function splitAt(position: number) {
    const index = texts.findIndex(entry => entry.from < position && position < entry.to);
    if (index < 0) return;
    const entry = texts[index];
    const after = entry.node.splitText(position - entry.from);
    texts.splice(index, 1, {node: entry.node, from: entry.from, to: position}, {node: after, from: position, to: entry.to});
  }
  const marked = new Map<string, HTMLElement>();
  const className = (mark: ReviewMark) => `cm-review-mark cm-review-${mark.group ? 'overlap' : mark.kind}`;
  const title = (mark: ReviewMark) => `${mark.group ? 'Competing suggestions' : mark.kind === 'delete' ? 'Suggested removal' : 'Suggested change'}. Click to open it.`;
  function hiddenMarkup(mark: ReviewMark) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-markup-suggestion';
    button.dataset.reviewId = mark.id;
    button.textContent = mark.group ? 'Competing formatting suggestion: open it' : 'Formatting suggestion: open it';
    let anchor: HTMLElement | null = null;
    for (const top of tops) if (top.from <= mark.from) anchor = top.element;
    if (anchor) anchor.after(button); else content.prepend(button);
    return button;
  }
  for (const mark of marks) {
    splitAt(mark.from);
    splitAt(mark.to);
    if (mark.from === mark.to) {
      const entry = texts.find(item => item.from === mark.from) ?? texts.find(item => item.to === mark.from);
      if (!entry) { marked.set(mark.id, hiddenMarkup(mark)); continue; }
      const point = document.createElement('span');
      point.className = 'cm-review-point';
      point.dataset.reviewId = mark.id;
      point.title = 'Suggested insertion. Click to open it.';
      if (entry.from === mark.from) entry.node.before(point); else entry.node.after(point);
      marked.set(mark.id, point);
      continue;
    }
    const covered = texts.filter(entry => entry.from >= mark.from && entry.to <= mark.to);
    // Markers, line breaks and spacing have nothing visible to underline, so they get an honest control instead.
    if (!covered.some(entry => /\S/.test(entry.node.data))) { marked.set(mark.id, hiddenMarkup(mark)); continue; }
    for (const entry of covered) {
      if (!/\S/.test(entry.node.data)) continue;
      const span = document.createElement('span');
      span.className = className(mark);
      span.dataset.reviewId = mark.id;
      span.title = title(mark);
      entry.node.replaceWith(span);
      span.append(entry.node);
      if (!marked.has(mark.id)) marked.set(mark.id, span);
    }
  }
  texts = [];
  return {content, marked};
}

export function createMarkdownReader(hooks: {label: string; content(): ReaderContent; open?(id: string): void; showSource(): void}) {
  const element = document.createElement('section');
  element.className = 'markdown-reader';
  element.setAttribute('aria-label', hooks.label);
  element.tabIndex = 0;
  element.hidden = true;
  const announcer = document.createElement('p');
  announcer.className = 'sr-only';
  announcer.setAttribute('role', 'status');
  const body = document.createElement('div');
  element.append(announcer, body);
  let marks: readonly ReviewMark[] = [];
  let marked = new Map<string, HTMLElement>();
  let current = -1;
  const keys = {next: formatKeys('⌘⌥]'), open: formatKeys('⌘⌥O')};
  function showCurrent() {
    element.querySelectorAll('.md-review-current').forEach(node => node.classList.remove('md-review-current'));
    const node = current >= 0 ? marked.get(marks[current].id) : undefined;
    node?.classList.add('md-review-current');
    return node;
  }
  function update() {
    const before = current >= 0 ? marks[current]?.id : undefined;
    const source = hooks.content();
    body.replaceChildren();
    marked = new Map();
    marks = source.marks ?? [];
    if (new TextEncoder().encode(source.text).length > READING_LIMIT_BYTES) {
      marks = [];
      current = -1;
      const message = document.createElement('p');
      message.className = 'drafting-warning';
      message.textContent = 'This document is over 2 MiB, so it is not formatted here. Nothing was cut or changed. Use Source to read it in full.';
      const back = document.createElement('button');
      back.type = 'button';
      back.textContent = 'Show Source';
      back.addEventListener('click', () => hooks.showSource());
      body.append(message, back);
      return;
    }
    if (source.note) {
      const note = document.createElement('p');
      note.className = 'md-note';
      note.textContent = source.note;
      body.append(note);
    }
    const rendered = renderMarkdown(source.text, source.ranges, marks);
    marked = rendered.marked;
    body.append(rendered.content);
    current = before ? marks.findIndex(mark => mark.id === before) : -1;
    showCurrent();
  }
  element.addEventListener('click', event => {
    if (!hooks.open || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const node = (event.target as HTMLElement).closest?.<HTMLElement>('[data-review-id]');
    if (!node?.dataset.reviewId) return;
    // Selecting text across a mark stays ordinary reading.
    const selection = element.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed && node.tagName !== 'BUTTON') return;
    hooks.open(node.dataset.reviewId);
  });
  element.addEventListener('keydown', event => {
    if (!hooks.open || !marks.length || !event.altKey || event.shiftKey || !(isMac() ? event.metaKey : event.ctrlKey)) return;
    if (event.code === 'BracketRight' || event.code === 'BracketLeft') {
      event.preventDefault();
      current = event.code === 'BracketRight' ? (current + 1) % marks.length : (current <= 0 ? marks.length : current) - 1;
      showCurrent()?.scrollIntoView?.({block: 'nearest'});
      announcer.textContent = `Suggestion ${current + 1} of ${marks.length}${marks[current].group ? ', competing alternatives' : ''}. ${keys.open} opens it.`;
    }
    else if (event.code === 'KeyO') {
      event.preventDefault();
      if (current >= 0) hooks.open(marks[current].id);
      else announcer.textContent = `No suggestion selected. ${keys.next} moves to the next one.`;
    }
  });
  return {element, update, focus() { element.focus({preventScroll: true}); }, clear() { body.replaceChildren(); marks = []; marked = new Map(); current = -1; announcer.textContent = ''; }};
}
