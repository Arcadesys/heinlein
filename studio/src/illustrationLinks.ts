import MarkdownIt from 'markdown-it';
import { markdownLanguage } from '@codemirror/lang-markdown';

const parser = new MarkdownIt('commonmark');
export function imageLinks(text: string) {
  const links: {
    from: number;
    to: number;
    url: string;
    alt: string;
    destFrom?: number;
    destTo?: number;
  }[] = [];
  if (!text.includes('![')) return links;
  const env = {};
  parser.parse(text, env);
  markdownLanguage.parser.parse(text).iterate({
    enter(node) {
      if (node.name !== 'Image') return;
      const token = parser
        .parseInline(text.slice(node.from, node.to), env)[0]
        ?.children?.find((t) => t.type === 'image');
      const dest = node.node.getChild('URL');
      if (token)
        links.push({
          destFrom: dest?.from,
          destTo: dest?.to,
          from: node.from,
          to: node.to,
          url: String(token.attrGet('src') ?? ''),
          alt: parser.renderer.renderInlineAsText(token.children ?? [], parser.options, env)
        });
      return false;
    }
  });
  return links;
}

export function imageMarkdown(alt: string, url: string) {
  const escaped = alt.replace(/\s+/g, ' ').replace(/[\\\[\]*_`<>!&]/g, (c) => '\\' + c);
  return `![${escaped}](${url})`;
}

export function relocatedPassage(
  source: string,
  start: number,
  end: number,
  oldScene: string,
  newScene: string
): string {
  let passage = source.slice(start, end);
  for (const link of imageLinks(source).reverse()) {
    if (link.to <= start || link.from >= end) continue;
    if (oldScene === newScene && link.destFrom !== undefined) continue;
    const dirs = oldScene.split('/').slice(0, -1);
    const url = decodeURIComponent(link.url);
    if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(url) || url.includes('\\') || /[?#]/.test(link.url))
      throw Error('This illustration needs a local project image.');
    for (const part of url.split('/')) {
      if (part === '..') {
        if (!dirs.length) throw Error('Image is outside this project.');
        dirs.pop();
      } else if (part && part !== '.') dirs.push(part);
    }
    const target = newScene.split('/').slice(0, -1);
    let common = 0;
    while (common < dirs.length && common < target.length && dirs[common] === target[common]) common++;
    const relative = [
      ...Array(target.length - common).fill('..'),
      ...dirs
        .slice(common)
        .map((p) => encodeURIComponent(p).replace(/[()']/g, (c) => '%' + c.charCodeAt(0).toString(16)))
    ].join('/');
    if (relative === link.url && link.destFrom !== undefined) continue;
    if (link.from < start || link.to > end)
      throw Error('Select the complete image link to restore its destination.');
    const from = link.destFrom ?? link.from,
      to = link.destTo ?? link.to;
    passage =
      passage.slice(0, from - start) +
      (link.destFrom !== undefined ? relative : imageMarkdown(link.alt, relative)) +
      passage.slice(to - start);
  }
  return passage;
}
