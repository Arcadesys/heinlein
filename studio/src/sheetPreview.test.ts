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
  it('shows emphasis, links, code and quotes as plain text without touching word-internal marks', () => {
    expect(sheetPreview('The apartment smelled of *old paper* and **lemon oil**.')).toBe('The apartment smelled of old paper and lemon oil.');
    expect(sheetPreview('> She read [the letter](https://example.com/a_b) and ![a map](map.png) with `care` and ~~doubt~~.')).toBe('She read the letter and a map with care and doubt.');
    expect(sheetPreview('An _italic_ word, a snake_case_name, 5 * 3 * 2 and a lone * mark.')).toBe('An italic word, a snake_case_name, 5 * 3 * 2 and a lone * mark.');
  });
  it('keeps em dashes and authorial fragments exactly', () => {
    expect(sheetPreview('He laughed. It came out wrong — too loud, too bright — and stopped.')).toBe('He laughed. It came out wrong — too loud, too bright — and stopped.');
  });
});
