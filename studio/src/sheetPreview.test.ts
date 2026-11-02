import { describe, expect, it } from 'vitest';
import { sheetPreview } from './sheetPreview';

describe('sheet preview', () => {
  it('skips metadata, headings, separators and fenced and indented code', () => {
    expect(sheetPreview('---\ntitle: Test\n---\n# Heading\nFirst line\n\n```js\nhidden\n```\n---\n    hidden\nSecond line\nA heading\n===\nThird line\nFourth line')).toBe('First line Second line Third line');
  });
  it('handles empty and unfinished metadata, and limits Unicode characters', () => {
    expect(sheetPreview('')).toBe('');
    expect(sheetPreview('---\ntitle: private')).toBe('');
    expect(Array.from(sheetPreview('🐈'.repeat(320)))).toHaveLength(300);
  });
});
