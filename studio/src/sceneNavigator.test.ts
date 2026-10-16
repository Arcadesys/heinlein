import {describe, expect, it} from 'vitest';
import {sceneBreaks, SCENE_NAVIGATOR_LIMIT} from './sceneNavigator';
describe('scene break first lines', () => {
  it('lists the first nonblank line after each break, preserving expressive text', () => {
    const source = 'Opening.\n\n---\n\n  Fragments. Again—yes.  \nNext line\n---\nRepeated line\n---\nRepeated line';
    expect(sceneBreaks(source).map(item => item.label)).toEqual(['Fragments. Again—yes.', 'Repeated line', 'Repeated line']);
    for (const entry of sceneBreaks(source)) expect(source.slice(entry.from, entry.to)).toBe(entry.label);
  });
  it('excludes frontmatter including BOM/CRLF and maps Unicode into normalized editor positions', () => {
    const source = '\uFEFF---\r\ntitle: Private\r\n---\r\nOpening.\r\n---\r\n\r\n🦊 Later—now.';
    const entries = sceneBreaks(source); expect(entries).toHaveLength(1); expect(entries[0].label).toBe('🦊 Later—now.');
    expect(source.replace(/\r\n/g, '\n').slice(entries[0].from, entries[0].to)).toBe('🦊 Later—now.');
    expect(sceneBreaks('---\ntitle: unfinished\n')).toEqual([]);
    expect(sceneBreaks('---\ntitle: Example\n...\nOpening\n---\nAfter')).toHaveLength(1);
  });
  it('ignores separators in fenced code and four-space indented code', () => {
    const source = 'Opening\n```md\n---\nNot a scene\n```\n~~~~\n---\nStill code\n~~~~\n    ---\nAlso code\n---\nReal scene';
    expect(sceneBreaks(source).map(item => item.label)).toEqual(['Real scene']);
  });
  it('does not create entries for empty or repeated breaks, and bounds huge lists', () => {
    expect(sceneBreaks('Opening\n---\n\n---\n')).toEqual([]);
    expect(sceneBreaks('Opening\n' + '---\nLine\n'.repeat(501))).toHaveLength(SCENE_NAVIGATOR_LIMIT);
  });
});
