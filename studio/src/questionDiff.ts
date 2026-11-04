/** Presentation-only token diff. Every source character is retained verbatim. */
export type QuestionDiffPart = {kind: 'equal' | 'remove' | 'add'; text: string};
export function questionDiff(before: string, after: string): QuestionDiffPart[] {
  const tokenize = (text: string) => text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
  const a = tokenize(before), b = tokenize(after); const result: QuestionDiffPart[] = [];
  const push = (kind: QuestionDiffPart['kind'], text: string) => {if (!text) return; const last = result.at(-1); if (last?.kind === kind) last.text += text; else result.push({kind, text});};
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length; while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {endA--; endB--;}
  push('equal', a.slice(0, start).join(''));
  const n = endA - start, m = endB - start;
  // Bound both CPU and memory for whole-scene reviews. The fallback still shows exact text.
  if ((n + 1) * (m + 1) > 250_000) {push('remove', a.slice(start, endA).join('')); push('add', b.slice(start, endB).join(''));}
  else {
    const width = m + 1; const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lengths[i * width + j] = a[start + i] === b[start + j] ? 1 + lengths[(i + 1) * width + j + 1] : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {push('equal', a[start + i++]); j++;}
      else if (i < n && (j === m || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) push('remove', a[start + i++]);
      else push('add', b[start + j++]);
    }
  }
  push('equal', a.slice(endA).join('')); return result;
}
export function createQuestionComparison(before: string, after: string, fullScene = false) {
  const node = document.createElement('section'); node.className = 'question-comparison'; node.setAttribute('aria-label', fullScene ? 'Exact whole-scene comparison' : 'Passage comparison');
  const parts = questionDiff(before, after);
  for (const [title, excluded, changed] of [['Original', 'add', 'remove'], ['Suggested', 'remove', 'add']] as const) {
    const section = document.createElement('section'); const heading = document.createElement('h4'); heading.textContent = title;
    const text = document.createElement('pre'); text.className = 'question-diff-text'; text.tabIndex = 0; text.setAttribute('aria-label', `${title}${fullScene ? ' full scene' : ' passage'}`);
    for (const part of parts) {
      if (part.kind === excluded) continue;
      if (part.kind === changed) {const mark = document.createElement('mark'); mark.className = `question-diff-${changed}`; mark.append(document.createTextNode(part.text)); text.append(mark);}
      else text.append(document.createTextNode(part.text));
    }
    section.append(heading, text);
    if (!(title === 'Original' ? before : after)) {const empty = document.createElement('p'); empty.className = 'question-empty-replacement'; empty.textContent = title === 'Suggested' ? 'Empty replacement · this deletes the selected passage.' : 'Empty original'; section.append(empty);}
    node.append(section);
  }
  const legend = document.createElement('p'); legend.className = 'question-diff-legend'; legend.textContent = 'Dotted underline: removed text. Solid underline: added text.'; node.append(legend); return node;
}

/** Compact, keyboard accessible diff chips. Expanding a chip reveals exact
 * changed text; unchanged manuscript prose stays out of the response. */
export function createQuestionDiffChips(before: string, after: string) {
  const list = document.createElement('section'); list.className = 'question-diff-chips';
  list.setAttribute('aria-label', 'Proposed changes');
  const parts = questionDiff(before, after);
  const changes: {removed: string; added: string}[] = [];
  for (let i = 0; i < parts.length;) {
    if (parts[i].kind === 'equal') {i++; continue;}
    const change = {removed: '', added: ''};
    while (i < parts.length && parts[i].kind !== 'equal') {
      const part = parts[i++]; change[part.kind === 'remove' ? 'removed' : 'added'] += part.text;
    }
    changes.push(change);
  }
  if (!changes.length) {list.textContent = 'No text changes suggested.'; return list;}
  const clip = (text: string) => {const chars = [...text.replace(/\s+/gu, ' ').trim()]; return chars.length > 48 ? chars.slice(0, 47).join('') + '…' : chars.join('') || 'whitespace';};
  changes.forEach((change, index) => {
    const chip = document.createElement('details'); chip.className = 'question-diff-chip';
    const summary = document.createElement('summary');
    summary.textContent = `${index + 1}. ${change.removed ? `− ${clip(change.removed)}` : 'Insert'}${change.added ? ` → + ${clip(change.added)}` : ' → Delete'}`;
    const diff = document.createElement('div'); diff.className = 'question-chip-exact';
    for (const [label, text, tag] of [['Remove', change.removed, 'del'], ['Add', change.added, 'ins']] as const) {
      if (!text) continue;
      const row = document.createElement('div'); const title = document.createElement('strong'); title.textContent = label;
      const value = document.createElement(tag); value.textContent = text;
      row.append(title, value); diff.append(row);
    }
    chip.append(summary, diff); list.append(chip);
  });
  return list;
}
