import type {EditorView} from '@codemirror/view';

export interface SceneBreak {from: number; to: number; label: string}
export const SCENE_NAVIGATOR_LIMIT = 500;

/** Positions use the editor's normalized UTF-16 document, not raw CRLF bytes. */
export function sceneBreaks(source: string): SceneBreak[] {
  const lines = source.replace(/\r\n|\r/g, '\n').split('\n');
  const entries: SceneBreak[] = [];
  let offset = 0; let pending = false; let metadata = false;
  let fence: {character: string; length: number} | null = null;
  for (const [index, line] of lines.entries()) {
    const start = offset; offset += line.length + 1;
    const trimmed = line.trim();
    if (index === 0 && trimmed.replace(/^\uFEFF/, '') === '---') {metadata = true; continue;}
    if (metadata) {if (trimmed === '---' || trimmed === '...') metadata = false; continue;}
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {fence = {character: opening[1][0], length: opening[1].length}; continue;}
    if (/^ {0,3}---[ \t]*$/.test(line)) {pending = true; continue;}
    if (!pending || !trimmed) continue;
    entries.push({from: start + line.search(/\S/), to: start + line.trimEnd().length, label: trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed});
    pending = false;
    if (entries.length === SCENE_NAVIGATOR_LIMIT) break;
  }
  return entries;
}

/** Local navigation only: no filesystem, model, or persistence operations. */
export function createSceneNavigator(current: () => EditorView | null) {
  const element = document.createElement('div'); element.className = 'panel-body scene-navigator-body'; element.id = 'scene-navigator-body';
  const summary = document.createElement('p'); summary.className = 'muted'; summary.setAttribute('role', 'status');
  const list = document.createElement('ol'); list.className = 'scene-break-list';
  element.append(summary, list);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  function refresh() {
    clearTimeout(timer); timer = undefined;
    if (disposed) return;
    const view = current(); const snapshot = view?.state.doc;
    const entries = snapshot ? sceneBreaks(snapshot.toString()) : [];
    list.replaceChildren();
    summary.textContent = !snapshot ? 'Open a source scene or assembled chapter.' : !entries.length ? 'No --- scene breaks in this document.' : `${entries.length}${entries.length === SCENE_NAVIGATOR_LIMIT ? '+' : ''} scene breaks · Select a first line to jump there.`;
    for (const [index, entry] of entries.entries()) {
      const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button';
      button.textContent = entry.label; button.setAttribute('aria-label', `Passage ${index + 1}: ${entry.label}`);
      button.addEventListener('click', () => {
        if (!view || current() !== view || view.state.doc !== snapshot) {refresh(); summary.textContent = 'The document changed. Choose the passage again.'; return;}
        list.querySelectorAll('button').forEach(node => node.removeAttribute('aria-current'));
        button.setAttribute('aria-current', 'location');
        view.dispatch({selection: {anchor: entry.from, head: entry.to}, scrollIntoView: true}); view.focus();
      });
      item.append(button); list.append(item);
    }
  }
  return {element, refresh,
    schedule() {clearTimeout(timer); timer = setTimeout(refresh, 120);},
    destroy() {disposed = true; clearTimeout(timer); element.remove();},
  };
}
