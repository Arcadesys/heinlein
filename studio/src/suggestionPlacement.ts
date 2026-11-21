// Where the suggestion popover sits relative to its highlight. Pure geometry: it never reads or moves text.
export interface AnchorRect { left: number; top: number; right: number; bottom: number }
export interface Viewport { width: number; height: number }
export type Placement =
  | {kind: 'below' | 'above'; left: number; top: number; width: number; maxHeight: number; arrowX: number}
  | {kind: 'sheet'; maxHeight?: number};

export const POPOVER_GAP = 12;
export const VIEWPORT_GUTTER = 16;
export const POPOVER_WIDTH = 480;
export const SHEET_BREAKPOINT = 640;
/** Below this much room on either side, the card would be too cramped to decide in, so it becomes a sheet. */
const MIN_ROOM = 220;

/** A sheet stops short of a visible highlight so the passage stays readable, but never shrinks below half the window. */
function sheet(anchor: AnchorRect | null, viewport: Viewport): Placement {
  if (!anchor || anchor.bottom < 0 || anchor.top > viewport.height) return {kind: 'sheet'};
  return {kind: 'sheet', maxHeight: Math.floor(Math.max(viewport.height - anchor.bottom - POPOVER_GAP, viewport.height * .5))};
}

export function placeSuggestion(anchor: AnchorRect | null, viewport: Viewport, height: number): Placement {
  if (!anchor || viewport.width < SHEET_BREAKPOINT) return sheet(anchor, viewport);
  // An anchor scrolled fully out of view cannot be pointed at.
  if (anchor.bottom < 0 || anchor.top > viewport.height) return {kind: 'sheet'};
  const width = Math.min(POPOVER_WIDTH, viewport.width - 2 * VIEWPORT_GUTTER);
  const below = viewport.height - VIEWPORT_GUTTER - (anchor.bottom + POPOVER_GAP);
  const above = anchor.top - POPOVER_GAP - VIEWPORT_GUTTER;
  const fitsBelow = below >= height, fitsAbove = above >= height;
  const kind: 'below' | 'above' = fitsBelow || (!fitsAbove && below >= above) ? 'below' : 'above';
  const room = kind === 'below' ? below : above;
  if (room < MIN_ROOM) return sheet(anchor, viewport);
  const shown = Math.min(height, room);
  const centre = (anchor.left + anchor.right) / 2;
  const left = Math.round(Math.min(Math.max(centre - width / 2, VIEWPORT_GUTTER), viewport.width - VIEWPORT_GUTTER - width));
  const top = Math.round(kind === 'below' ? anchor.bottom + POPOVER_GAP : anchor.top - POPOVER_GAP - shown);
  // The caret stays over the highlight but never leaves the card's rounded corners.
  const arrowX = Math.round(Math.min(Math.max(centre - left, 24), width - 24));
  return {kind, left, top, width, maxHeight: Math.floor(room), arrowX};
}
