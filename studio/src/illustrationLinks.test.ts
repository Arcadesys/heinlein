import { describe, it, expect } from 'vitest';
import { imageLinks, imageMarkdown, relocatedPassage } from './illustrationLinks';
describe('scene-local illustration links', () => {
  it('preserves author descriptions, ignores code, and resolves scene-local definitions', () => {
    const alt = 'Map [north] & *east* — 🦊';
    const link = imageMarkdown(alt, '../assets/images/map.png');
    expect(
      imageLinks(`\`${link}\`\n\n${link}\n\n![South][map]\n\n[map]: <South map.jpg>`).map((i) => [
        i.alt,
        i.url
      ])
    ).toEqual([
      [alt, '../assets/images/map.png'],
      ['South', 'South%20map.jpg']
    ]);
  });
  it('rebases only a restored image destination and retains exact surrounding bytes', () => {
    const s = 'Before\r\n![A map](../assets/images/a.png "The title")\r\nAfter';
    expect(relocatedPassage(s, 0, s.length, 'ms/a.md', 'ms/part/a.md')).toBe(
      s.replace('../assets', '../../assets')
    );
    expect(() => relocatedPassage(s, 12, s.length, 'ms/a.md', 'ms/part/a.md')).toThrow(
      'complete image link'
    );
  });
});
