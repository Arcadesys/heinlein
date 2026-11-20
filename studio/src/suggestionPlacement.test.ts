import {describe, expect, it} from 'vitest';
import {placeSuggestion, POPOVER_GAP, VIEWPORT_GUTTER} from './suggestionPlacement';

const viewport = {width: 1200, height: 800};
const word = (left: number, top: number, width = 60, height = 24) => ({left, top, right: left + width, bottom: top + height});

describe('suggestion popover placement', () => {
  it('sits just below the highlight, centred on it, with the caret over it', () => {
    const anchor = word(500, 200);
    const placed = placeSuggestion(anchor, viewport, 300);
    expect(placed).toMatchObject({kind: 'below', top: anchor.bottom + POPOVER_GAP});
    if (placed.kind === 'sheet') throw new Error('expected a popover');
    expect(placed.left + placed.arrowX).toBe(530);
    // Never covers the highlighted text.
    expect(placed.top).toBeGreaterThan(anchor.bottom);
  });
  it('flips above a highlight near the bottom of the window', () => {
    const anchor = word(500, 700);
    const placed = placeSuggestion(anchor, viewport, 300);
    expect(placed.kind).toBe('above');
    if (placed.kind === 'sheet') throw new Error('expected a popover');
    expect(placed.top + 300).toBe(anchor.top - POPOVER_GAP);
  });
  it('stays inside the window gutter and keeps the caret on the card', () => {
    const placed = placeSuggestion(word(2, 200, 10), viewport, 300);
    if (placed.kind === 'sheet') throw new Error('expected a popover');
    expect(placed.left).toBe(VIEWPORT_GUTTER);
    expect(placed.arrowX).toBeGreaterThanOrEqual(24);
    const right = placeSuggestion(word(1190, 200, 8), viewport, 300);
    if (right.kind === 'sheet') throw new Error('expected a popover');
    expect(right.left + right.width).toBe(viewport.width - VIEWPORT_GUTTER);
  });
  it('caps a tall card to the room on its side so it scrolls instead of covering the passage', () => {
    const anchor = word(500, 300);
    const placed = placeSuggestion(anchor, viewport, 2000);
    if (placed.kind === 'sheet') throw new Error('expected a popover');
    expect(placed.kind).toBe('below');
    expect(placed.top + placed.maxHeight).toBeLessThanOrEqual(viewport.height - VIEWPORT_GUTTER);
  });
  it('becomes a bottom sheet on narrow windows, without an anchor, or when the highlight is off screen', () => {
    // A narrow sheet stops below a visible highlight, so the passage is still readable.
    expect(placeSuggestion(word(100, 200), {width: 500, height: 800}, 300)).toEqual({kind: 'sheet', maxHeight: 800 - 224 - POPOVER_GAP});
    expect(placeSuggestion(word(100, 700), {width: 500, height: 800}, 300)).toEqual({kind: 'sheet', maxHeight: 400});
    expect(placeSuggestion(null, viewport, 300)).toEqual({kind: 'sheet'});
    expect(placeSuggestion(word(100, 900), viewport, 300)).toEqual({kind: 'sheet'});
  });
});
