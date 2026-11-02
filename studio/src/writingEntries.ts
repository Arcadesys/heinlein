import type {Document, Entry} from './localCore';
const supportName = /^(?:readme|license|licence|changelog|contributing|agents|code_of_conduct|security)(?:\.|$)/i;
const writing = (entry: Entry) => entry.kind === 'file' && /\.(?:md|markdown)$/i.test(entry.name) && !supportName.test(entry.name);
/** Returns ordinary writing entries; uncertainty is left visible, never silently hidden. */
export async function writingEntries(entries: Entry[], list: (path:string) => Promise<Entry[]>, read: (path:string) => Promise<Document>): Promise<{entries: Entry[]; incomplete: boolean}> {
  let remaining = 512, incomplete = false; const visited = new Set<string>();
  async function fileVisible(entry: Entry): Promise<boolean> {
    if (!writing(entry)) return false;
    try { return !(await read(entry.path)).generatedCompatibility; } catch { incomplete = true; return true; }
  }
  async function folderVisible(path:string, depth:number): Promise<boolean> {
    if (depth > 16 || remaining <= 0 || visited.has(path)) { incomplete = true; return true; }
    visited.add(path);
    let children: Entry[]; try { children = await list(path); } catch { incomplete = true; return true; }
    for (const child of children) {
      if (--remaining < 0) { incomplete = true; return true; }
      if (!child.path.startsWith(`${path}/`)) continue;
      if (child.kind === 'file' && await fileVisible(child)) return true;
      if (child.kind === 'directory' && !child.name.startsWith('.') && await folderVisible(child.path, depth + 1)) return true;
    }
    return false;
  }
  const result: Entry[] = [];
  for (const entry of entries) {
    if (--remaining < 0) { incomplete = true; if (entry.kind === 'directory' || writing(entry)) result.push(entry); continue; }
    if (entry.kind === 'file' ? await fileVisible(entry) : !entry.name.startsWith('.') && await folderVisible(entry.path, 0)) result.push(entry);
  }
  return {entries: result, incomplete};
}
