import MarkdownIt from 'markdown-it';

// Generated advice is untrusted. Never execute HTML or fetch embedded images.
const parser = new MarkdownIt({html: false, linkify: false, typographer: false});
parser.validateLink = href => /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
parser.renderer.rules.image = (tokens, index) => parser.utils.escapeHtml(tokens[index].content);
const linkOpen = parser.renderer.rules.link_open;
parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return linkOpen ? linkOpen(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
};

export function renderMarkdown(text: string, label?: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'rendered-markdown';
  if (label) {element.setAttribute('role', 'region'); element.setAttribute('aria-label', label); element.tabIndex = 0;}
  // Safe because raw HTML is disabled and only validated links become attributes.
  element.innerHTML = parser.render(text);
  return element;
}
