import {renderMarkdown} from './markdown';
import {createQuestionDiffChips} from './questionDiff';

interface StructuredAdvice {
  schemaVersion: 2;
  answer: string;
  strengths: string[];
  findings: {text: string; evidence: string; editIds: string[]}[];
  edits: {id: string; sceneIndex: number; original: string; replacement: string; reason: string; role: string}[];
}
function structuredAdvice(text: string): StructuredAdvice | undefined {
  try {
    const value = JSON.parse(text);
    if (value?.schemaVersion !== 2 || typeof value.answer !== 'string'
      || !Array.isArray(value.strengths) || value.strengths.length > 32 || value.strengths.some((s: unknown) => typeof s !== 'string')
      || !Array.isArray(value.findings) || value.findings.length > 32 || value.findings.some((f: StructuredAdvice['findings'][number]) => !f || typeof f.text !== 'string' || typeof f.evidence !== 'string' || !Array.isArray(f.editIds))
      || !Array.isArray(value.edits) || value.edits.length > 32 || value.edits.some((e: StructuredAdvice['edits'][number]) => !e || typeof e.original !== 'string' || typeof e.replacement !== 'string' || typeof e.reason !== 'string')) return;
    return value;
  } catch { return; }
}
function plain(tag: string, text: string): HTMLElement {
  const node = document.createElement(tag); node.textContent = text; return node;
}

/** Ask remains read-only. New answers use structured advice; historical fenced diffs remain readable. Both formats use the same chips as saved revisions, without granting apply authority. */
export function renderQuestionAnswer(text: string, label: string): HTMLElement {
  const view = document.createElement('div'); view.className = 'rendered-markdown';
  view.setAttribute('role', 'region'); view.setAttribute('aria-label', label); view.tabIndex = 0;
  const advice = structuredAdvice(text);
  if (advice) {
    view.append(renderMarkdown(advice.answer));
    if (advice.strengths.length) {
      const list = document.createElement('ul');
      for (const strength of advice.strengths) list.append(plain('li', strength));
      view.append(plain('h4', 'Strengths'), list);
    }
    if (advice.findings.length) {
      view.append(plain('h4', 'Findings'));
      for (const finding of advice.findings) {
        const section = document.createElement('section');
        section.append(plain('p', finding.text), plain('p', `Evidence: ${finding.evidence}`));
        view.append(section);
      }
    }
    if (advice.edits.length) {
      view.append(plain('h4', 'Suggested edits · advice only'));
      for (const edit of advice.edits) {
        const chips = createQuestionDiffChips(edit.original, edit.replacement);
        chips.setAttribute('aria-label', 'Suggested wording · advice only');
        view.append(plain('p', edit.reason), chips);
      }
    }
    return view;
  }
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
