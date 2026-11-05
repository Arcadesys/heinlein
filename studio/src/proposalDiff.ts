import {createQuestionComparison, questionDiff} from './questionDiff';

type Line = {kind: 'equal' | 'remove' | 'add'; text: string};
/** Presentation only. Keep line endings and whitespace; never reconstruct apply text from this view. */
function linesDiff(before: string, after: string): Line[] {
  const split = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(before), b = split(after), result: Line[] = [];
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {endA--; endB--;}
  for (const text of a.slice(0, start)) result.push({kind: 'equal', text});
  const n = endA - start, m = endB - start, width = m + 1;
  if ((n + 1) * width > 2_000_000) {
    for (const text of a.slice(start, endA)) result.push({kind: 'remove', text});
    for (const text of b.slice(start, endB)) result.push({kind: 'add', text});
  } else {
    const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      lengths[i * width + j] = a[start + i] === b[start + j] ? 1 + lengths[(i + 1) * width + j + 1] : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {result.push({kind: 'equal', text: a[start + i++]}); j++;}
      else if (i < n && (j === m || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) result.push({kind: 'remove', text: a[start + i++]});
      else result.push({kind: 'add', text: b[start + j++]});
    }
  }
  for (const text of a.slice(endA)) result.push({kind: 'equal', text});
  return result;
}

export function createProposalDiff(before: string, after: string, compact = false): HTMLElement {
  // A group, not a landmark: one list can show many diffs and landmark names must stay unique.
  const node = document.createElement('div'); node.className = 'proposal-diff'; node.setAttribute('role', 'group'); node.setAttribute('aria-label', 'Specific proposed changes');
  const lines = linesDiff(before, after), ranges: {start: number; end: number}[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === 'equal') continue;
    const start = Math.max(0, i - 2), end = Math.min(lines.length, i + 3), previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({start, end});
  }
  const heading = document.createElement('h3'); heading.textContent = ranges.length ? `${ranges.length} changed ${ranges.length === 1 ? 'passage' : 'passages'}` : 'No text changes'; node.append(heading);
  if (ranges.length) {
    const help = document.createElement('p'); help.textContent = 'Red strikethrough: removed text. Green underline: added text. Unchanged passages are omitted; whitespace changes are marked too.'; node.append(help);
  }
  ranges.forEach((range, index) => {
    const group = document.createElement(compact ? 'details' : 'section'); group.className = 'proposal-diff-hunk';
    const label = document.createElement('h4'); label.textContent = `Change ${index + 1}`;
    const slice = lines.slice(range.start, range.end);
    const comparison = createQuestionComparison(slice.filter(l => l.kind !== 'add').map(l => l.text).join(''), slice.filter(l => l.kind !== 'remove').map(l => l.text).join(''));
    comparison.querySelectorAll('h4').forEach((heading, i) => {heading.textContent = i === 0 ? 'Before' : 'After';});
    comparison.querySelectorAll<HTMLElement>('mark').forEach(mark => {
      const replacement = document.createElement(mark.classList.contains('question-diff-remove') ? 'del' : 'ins');
      replacement.className = mark.className; replacement.textContent = mark.textContent; mark.replaceWith(replacement);
    });
    comparison.querySelector('.question-diff-legend')!.textContent = '− Red strikethrough: removed. + Green underline: added.';
    // Group, not region: the same "Change 1" label repeats across every diff in a list.
    comparison.setAttribute('role', 'group');
    comparison.setAttribute('aria-label', `Change ${index + 1} comparison`);
    if (compact) {
      const summary = document.createElement('summary'); summary.append(document.createTextNode(`Change ${index + 1} · `));
      const removed = slice.filter(l => l.kind === 'remove').map(l => l.text).join('');
      const added = slice.filter(l => l.kind === 'add').map(l => l.text).join('');
      for (const part of questionDiff(removed, added)) {
        if (part.kind === 'equal') continue;
        const mark = document.createElement(part.kind === 'remove' ? 'del' : 'ins');
        mark.textContent = `${part.kind === 'remove' ? '−' : '+'} ${part.text.trim() ? part.text : JSON.stringify(part.text)}`;
        summary.append(mark, document.createTextNode(' '));
      }
      const hint = document.createElement('span'); hint.className = 'muted'; hint.textContent = 'Show scene context'; summary.append(hint);
      group.append(summary, comparison);
    } else group.append(label, comparison);
    node.append(group);
  });
  return node;
}
