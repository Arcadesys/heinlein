// Text zoom for the whole UI. Steps map to `:root[data-zoom]` rules in style.css,
// which scale the root font size; everything else is sized in rem so it follows.
export const ZOOM_STEPS = [75, 90, 100, 115, 130, 150, 175, 200, 250, 300] as const;
export const DEFAULT_ZOOM = 100;
const STORAGE_KEY = 'heinlein-studio-zoom-v1';

export type ZoomAction = 'in' | 'out' | 'reset';

export function nextZoom(current: number, action: ZoomAction): number {
  if (action === 'reset') return DEFAULT_ZOOM;
  const index = ZOOM_STEPS.findIndex(step => step >= current);
  const at = index === -1 ? ZOOM_STEPS.length - 1 : index;
  if (action === 'in') {
    const higher = ZOOM_STEPS.find(step => step > current);
    return higher ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  return at > 0 ? ZOOM_STEPS[at - 1] : ZOOM_STEPS[0];
}

export function parseZoom(raw: unknown): number {
  const value = Number(raw);
  return (ZOOM_STEPS as readonly number[]).includes(value) ? value : DEFAULT_ZOOM;
}

export function shortcutAction(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): ZoomAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.key === '=' || event.key === '+') return 'in';
  if (event.key === '-' || event.key === '_') return 'out';
  if (event.key === '0') return 'reset';
  return null;
}

export function loadZoom(): number {
  try { return parseZoom(localStorage.getItem(STORAGE_KEY)); } catch { return DEFAULT_ZOOM; }
}
export function saveZoom(value: number) {
  try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* storage is a convenience only */ }
}
