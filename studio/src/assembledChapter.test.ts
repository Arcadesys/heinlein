import {describe, expect, it} from 'vitest';
import {assembleChapter, chapterSelection} from './assembledChapter';
import type {Chapter, Document} from './localCore';
const chapter: Chapter = {number: 1, title: 'Chapter', path: '', source: 'chapter.md', scenes: [{path: 'one.md'}, {path: 'two.md'}]};
const doc = (path: string, text: string): Document => ({path, text, contentHash: text, frontmatter: null, sizeBytes: text.length, generatedCompatibility: false});
const one = doc('one.md', '---\r\ntitle: Hidden\r\n---\r\nSame 🦊—passage.\r\n');
const two = doc('two.md', 'Same 🦊—passage.');
describe('assembled chapter source mapping', () => {
  it('maps repeated prose by position to the right scene, excluding frontmatter', () => {
    const assembled = assembleChapter(chapter, [one, two]);
    expect(assembled.text).not.toContain('title: Hidden');
    const start = assembled.text.lastIndexOf('Same');
    const target = chapterSelection(assembled, start, start + two.text.length);
    expect(target.document.path).toBe('two.md'); expect(target.from).toBe(0); expect(target.to).toBe(two.text.length);
    const first = chapterSelection(assembled, 0, 'Same 🦊—passage.'.length);
    expect(first.document.text).toBe(one.text); expect(first.from).toBe('---\ntitle: Hidden\n---\n'.length);
  });
  it('rejects cross-scene selections and separators instead of guessing', () => {
    const assembled = assembleChapter(chapter, [one, two]);
    expect(() => chapterSelection(assembled, 2, assembled.text.length - 2)).toThrow('crosses source scenes');
    expect(() => chapterSelection(assembled, assembled.parts[0].to, assembled.parts[1].from)).toThrow('crosses source scenes');
    expect(() => chapterSelection(assembled, -1, 3)).toThrow('Select a passage');
  });
  it('rejects missing, reordered, generated, oversized or malformed source scenes', () => {
    expect(() => assembleChapter(chapter, [two, one])).toThrow();
    expect(() => assembleChapter(chapter, [one])).toThrow();
    expect(() => assembleChapter(chapter, [one, {...two, generatedCompatibility: true}])).toThrow();
    expect(() => assembleChapter(chapter, [doc('one.md', '---\nunfinished'), two])).toThrow('unfinished frontmatter');
    expect(() => assembleChapter(chapter, [doc('one.md', 'a'.repeat(8_000_001)), two])).toThrow('too large');
  });
});
