/** Plain-text navigation excerpt; source is never changed. */
export function sheetPreview(source: string): string {
  const lines = source.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  let index = 0;
  if (lines[0]?.trim() === '---') {
    index = 1;
    while (index < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[index].trim())) index++;
    if (index === lines.length) return '';
    index++;
  }
  let fence: {character: string; length: number} | null = null;
  const prose: string[] = [];
  for (; index < lines.length && prose.length < 3; index++) {
    const line = lines[index];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = null;
      continue;
    }
    if (marker) { fence = {character: marker[1][0], length: marker[1].length}; continue; }
    const text = line.trim();
    if (!text || /^#{1,6}(?:\s|$)/.test(text) || /^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(text) || /^ {4}|^\t/.test(line)) continue;
    // A Setext underline turns the preceding line into a heading.
    if (index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1])) { index++; continue; }
    prose.push(text);
  }
  return Array.from(prose.join(' ')).slice(0, 300).join('');
}
