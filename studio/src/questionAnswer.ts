import {renderMarkdown} from './markdown';
import {createQuestionDiffChips} from './questionDiff';

/** Ask remains read-only. Suggested wording arrives as small fenced diffs and
 * uses the same chips as saved revisions, without granting apply authority. */
export function renderQuestionAnswer(text: string, label: string): HTMLElement {
  const view = document.createElement('div'); view.className = 'rendered-markdown';
  view.setAttribute('role', 'region'); view.setAttribute('aria-label', label); view.tabIndex = 0;
  const pattern = /^```diff[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*(?:\r?\n|$)/gm;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const lines = match[1].replace(/\r?\n$/, '').split(/\r?\n/);
    // Only the bounded, simple exact-text format requested by Ask is promoted
    // to chips. Arbitrary patches remain literal read-only advice.
    if (!lines.length || lines.some(line => !/^[ +\-]/.test(line)) || !lines.some(line => /^[+\-]/.test(line))) continue;
    if (match.index! > cursor) view.append(renderMarkdown(text.slice(cursor, match.index)));
    const original = lines.filter(line => !line.startsWith('+')).map(line => line.slice(1)).join('\n');
    const replacement = lines.filter(line => !line.startsWith('-')).map(line => line.slice(1)).join('\n');
    const chips = createQuestionDiffChips(original, replacement);
    chips.setAttribute('aria-label', 'Suggested wording · advice only'); view.append(chips);
    cursor = match.index! + match[0].length;
  }
  if (cursor < text.length) view.append(renderMarkdown(text.slice(cursor)));
  return view;
}
