import type { Chapter, Document } from './localCore';

export interface ChapterPart { document: Document; from: number; to: number; bodyFrom: number }
export interface AssembledChapter { chapter: Chapter; text: string; parts: ChapterPart[] }
export const normalizeChapterText = (text: string) => text.replace(/\r\n|\r/g, '\n');

/** Where the body starts in normalized text: 0 without frontmatter, null when frontmatter is left unfinished. */
export function frontmatterEnd(source: string): number | null {
  if (!source.startsWith('---\n')) return 0;
  const closing = /^---[ \t]*$/gm;
  closing.lastIndex = 4;
  const match = closing.exec(source);
  if (!match) return null;
  const end = match.index + match[0].length;
  return source[end] === '\n' ? end + 1 : end;
}

// Assemble current source snapshots, never search a stale exported chapter for
// matching prose. All offsets are normalized UTF-16 positions, like CodeMirror.
export function assembleChapter(chapter: Chapter, documents: Document[]): AssembledChapter {
  if (!documents.length || documents.length !== chapter.scenes.length || documents.length > 500) throw new Error('This assembled chapter has no usable source-scene mapping.');
  let text = '';
  const parts: ChapterPart[] = [];
  for (const [index, document] of documents.entries()) {
    if (document.path !== chapter.scenes[index].path || document.generatedCompatibility) throw new Error('A chapter source is not an editable source scene.');
    const source = normalizeChapterText(document.text);
    const bodyFrom = frontmatterEnd(source);
    if (bodyFrom === null) throw new Error('A source scene has unfinished frontmatter. Open that source scene to resolve it.');
    if (index) text += '\n\n';
    const from = text.length;
    text += source.slice(bodyFrom);
    parts.push({document, from, to: text.length, bodyFrom});
    if (text.length > 8_000_000) throw new Error('This chapter is too large for an assembled view. Open a source scene instead.');
  }
  return {chapter, text, parts};
}

export function chapterSelection(chapter: AssembledChapter, from: number, to: number) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > chapter.text.length) throw new Error('Select a passage in the assembled chapter first.');
  const part = chapter.parts.find(part => from >= part.from && to <= part.to);
  if (!part) throw new Error('This passage crosses source scenes. Select a passage within one scene, or open a source scene below.');
  return {document: part.document, from: part.bodyFrom + from - part.from, to: part.bodyFrom + to - part.from};
}
