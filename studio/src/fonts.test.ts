// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyChoices, cleanFamily, familyValue, parseChoices } from './fonts';

describe('font choices', () => {
  it('cleans names and rejects blanks and oversize input', () => {
    expect(cleanFamily('  Avenir   Next ')).toBe('Avenir Next');
    expect(cleanFamily('')).toBeNull();
    expect(cleanFamily('   ')).toBeNull();
    expect(cleanFamily('x'.repeat(101))).toBeNull();
    expect(cleanFamily(42)).toBeNull();
    expect(cleanFamily('A\nB')).toBe('A B');
  });
  it('quotes names so they cannot escape the font-family value', () => {
    expect(familyValue('Menlo', 'monospace')).toBe('"Menlo", monospace');
    expect(familyValue('x"; color: red; "', 'serif')).toBe('"x\\"; color: red; \\"", serif');
    expect(familyValue('a\\b', 'serif')).toBe('"a\\\\b", serif');
  });
  it('ignores malformed stored data', () => {
    expect(parseChoices('not json')).toEqual({});
    expect(parseChoices('{"ui":"Avenir Next","text":"","bogus":"x"}')).toEqual({ ui: 'Avenir Next' });
    expect(parseChoices(null)).toEqual({});
  });
  it('sets and clears CSS custom properties', () => {
    const node = document.createElement('div');
    applyChoices({ ui: 'Avenir Next', mono: 'Menlo' }, node);
    expect(node.style.getPropertyValue('--font-ui')).toBe('"Avenir Next", var(--ui-fallback)');
    expect(node.style.getPropertyValue('--font-mono')).toBe('"Menlo", var(--mono-fallback)');
    expect(node.style.getPropertyValue('--font-text')).toBe('');
    applyChoices({}, node);
    expect(node.style.getPropertyValue('--font-ui')).toBe('');
  });
});
