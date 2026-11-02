
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
