import { describe, expect, it } from 'vitest';
import { DEFAULT_ZOOM, ZOOM_STEPS, nextZoom, parseZoom, shortcutAction } from './zoom';

describe('zoom steps', () => {
  it('moves one step and clamps at both ends', () => {
    expect(nextZoom(100, 'in')).toBe(115);
    expect(nextZoom(100, 'out')).toBe(90);
    expect(nextZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], 'in')).toBe(300);
    expect(nextZoom(ZOOM_STEPS[0], 'out')).toBe(75);
    expect(nextZoom(300, 'reset')).toBe(DEFAULT_ZOOM);
  });
  it('rejects unknown stored values', () => {
    expect(parseZoom('130')).toBe(130);
    expect(parseZoom('9999')).toBe(100);
    expect(parseZoom(null)).toBe(100);
  });
  it('maps only Cmd/Ctrl combinations', () => {
    const key = (k: string, extra = {}) => shortcutAction({ key: k, metaKey: true, ctrlKey: false, altKey: false, ...extra });
    expect(key('+')).toBe('in');
    expect(key('=')).toBe('in');
    expect(key('-')).toBe('out');
    expect(key('0')).toBe('reset');
    expect(key('a')).toBeNull();
    expect(key('=', { metaKey: false })).toBeNull();
    expect(key('=', { altKey: true })).toBeNull();
  });
});
