import type {Document, DraftingState, LocalCore} from './localCore';
import {withReferenceSheets} from './sheetManagement';
import './markdownExport.css';

export type ExportScope = {kind: 'group'; id: string} | {kind: 'folder'; path: string} | {kind: 'project'};
interface ExportPart {title: string; path?: string; level: number}
export interface MarkdownExport {filename: string; text: string; count: number}
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ITEMS = 4096;
const heading = (title: string, level: number) => `${'#'.repeat(Math.min(level, 6))} ${title.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&')}`;

/** Remove only a complete leading YAML block; preserve every body byte and line ending. */
export function exportBody(source: string): string {
  const start = source.startsWith('\uFEFF') ? 1 : 0;
  const opening = /^---[ \t]*(?:\r\n|\n|\r)/.exec(source.slice(start));
  if (!opening) return source.slice(start);
  const body = start + opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/gm;
  closing.lastIndex = body;
  const end = closing.exec(source);
  if (!end) throw new Error('A sheet has unfinished YAML metadata. Resolve it before exporting.');
  return source.slice(end.index + end[0].length);
}

/** Read-only snapshot: no save, recovery, organization, or network calls. */
export async function prepareMarkdownExport(core: LocalCore, repositoryId: string, title: string, scope: ExportScope,
  state: DraftingState | null, buffers: Map<string, Document> = new Map()): Promise<MarkdownExport> {
  const parts: ExportPart[] = [];
  const documents = new Map(buffers);
  let sourceBytes = 0;
  const counted = new Set<string>();
  const read = async (path: string) => {
    if (!documents.has(path)) documents.set(path, await core.readDocument(repositoryId, path));
    if (!counted.has(path)) {
      counted.add(path);
      sourceBytes += new TextEncoder().encode(documents.get(path)!.text).length;
      if (sourceBytes > MAX_BYTES || counted.size > MAX_ITEMS) throw new Error('This export exceeds the size limit. Choose a smaller folder or group.');
    }
    return documents.get(path)!;
  };
  if (scope.kind === 'folder') {
    const visited = new Set<string>();
    const walk = async (path: string, depth: number) => {
      if (depth > 32 || visited.has(path) || visited.size >= MAX_ITEMS) throw new Error('This folder exceeds the export limit. Export a smaller folder.');
      visited.add(path);
      const entries = [...await core.listDirectory(repositoryId, path)].sort((a, b) => a.name.localeCompare(b.name, 'en', {numeric: true}) || a.path.localeCompare(b.path));
      for (const entry of entries) {
        if (entry.kind === 'directory') await walk(entry.path, depth + 1);
        else if (/\.(md|markdown)$/i.test(entry.path)) {
          const doc = await read(entry.path);
          if (!doc.generatedCompatibility) parts.push({title: entry.path.slice(scope.path ? scope.path.length + 1 : 0).replace(/\.(md|markdown)$/i, ''), path: entry.path, level: 2});
        }
        if (parts.length > MAX_ITEMS) throw new Error('Too many sheets to export. Choose a smaller folder.');
      }
    };
    await walk(scope.path, 0);
    // Library order wins for indexed source files; remaining files keep natural filename order.
    if (state) {
      const order = libraryParts(state).filter(part => part.path).map(part => part.path!);
      const rank = new Map(order.map((path, index) => [path, index]));
      parts.sort((a, b) => (rank.get(a.path!) ?? Infinity) - (rank.get(b.path!) ?? Infinity));
    }
  } else {
    if (!state || state.recoveryRequired) throw new Error('Refresh the Library and resolve any interrupted change before exporting.');
    parts.push(...libraryParts(state, scope.kind === 'group' ? scope.id : null));
  }
  if (parts.length > MAX_ITEMS) throw new Error('Too many sheets to export. Choose a smaller group.');
  let text = `${heading(title, 1)}\n\n`;
  let count = 0;
  let bytes = new TextEncoder().encode(text).length;
  for (const part of parts) {
    let section = `${heading(part.title, part.level)}\n\n`;
    if (part.path) {
      const doc = await read(part.path);
      if (doc.generatedCompatibility) throw new Error(`Open the original source sheets for ${part.path} before exporting.`);
      section += exportBody(doc.text) + '\n\n';
      count++;
    }
    bytes += new TextEncoder().encode(section).length;
    if (bytes > MAX_BYTES) throw new Error('This export exceeds 64 MB. Choose a smaller folder or group.');
    text += section;
  }
  if (!count) throw new Error('No Markdown sheets were found to export.');
  const filename = (title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 120) || 'manuscript') + '.md';
  return {filename, text, count};
}

function libraryParts(state: DraftingState, groupId: string | null = null): ExportPart[] {
  const hasLibrary = Boolean(state.library);
  state = withReferenceSheets(state);
  const sheets = state.scenes;
  if (groupId && !state.groups.some(group => group.id === groupId)) throw new Error('This group is no longer in the Library.');
  // Older manuscripts have a flat reading order. Keep it even if group order
  // differs or scenes belonging to a group are interleaved.
  if (!hasLibrary) {
    const result: ExportPart[] = [];
    let previousGroup: string | null = null;
    for (const sheet of sheets.filter(sheet => !groupId || sheet.groupId === groupId)) {
      if (!groupId && sheet.groupId && sheet.groupId !== previousGroup) {
        const group = state.groups.find(group => group.id === sheet.groupId);
        if (group) result.push({title: group.title, level: 2});
      }
      previousGroup = sheet.groupId;
      result.push({title: sheet.title, path: sheet.path, level: !groupId && sheet.groupId ? 3 : 2});
    }
    return result;
  }
  const entries = state.library!;
  const result: ExportPart[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, level: number) => {
    if (level > 32) throw new Error('The Library nesting exceeds the export limit.');
    for (const entry of entries.filter(entry => entry.parentId === parentId)) {
      if (visited.has(entry.id)) throw new Error('The Library contains a duplicate or cyclic entry. Refresh before exporting.');
      visited.add(entry.id);
      if (entry.kind === 'group') {
        const group = state.groups.find(group => group.id === entry.id);
        if (!group) throw new Error('A Library group is missing. Refresh before exporting.');
        result.push({title: group.title, level}); walk(group.id, level + 1);
      } else {
        const sheet = sheets.find(sheet => sheet.id === entry.id);
        if (!sheet) throw new Error('A Library sheet is missing. Refresh before exporting.');
        result.push({title: sheet.title, path: sheet.path, level});
      }
    }
  };
  walk(groupId, 2);
  if (!groupId && visited.size !== entries.length) throw new Error('Some Library entries are unreachable. Refresh before exporting.');
  return result;
}

export function createMarkdownExport(core: LocalCore, hooks: {
  root: HTMLElement;
  snapshot(): {repositoryId: string; state: DraftingState | null; buffers: Map<string, Document>} | null;
  report(message: string, error?: boolean): void;
}) {
  let dialog: HTMLDialogElement | null = null;
  let version = 0;
  function close() { version++; dialog?.close?.(); dialog?.remove(); dialog = null; }
  async function open(title: string, scope: ExportScope) {
    if (dialog || !core.saveMarkdownExport) return;
    const snapshot = hooks.snapshot();
    if (!snapshot) { hooks.report('Resolve the open recovery or file operation before exporting.', true); return; }
    const menuLabel = document.activeElement?.closest('.row-menu-items')?.getAttribute('aria-label');
    const returnFocus = [...hooks.root.querySelectorAll<HTMLElement>('summary')].find(node => node.getAttribute('aria-label') === menuLabel) ?? document.activeElement as HTMLElement | null;
    const node = document.createElement('dialog'); node.className = 'appearance-dialog drafting-dialog markdown-export-dialog'; node.setAttribute('aria-label', 'Export as Markdown');
    const h = document.createElement('h2'); h.textContent = 'Export as Markdown';
    const label = document.createElement('p'); label.textContent = title;
    const description = document.createElement('p'); description.textContent = 'Includes all sheets and nested content, including reference sheets. Uses current editor text and adds headings. YAML metadata is omitted; images and attachments aren’t bundled. Save a new file outside the project; sources stay unchanged.';
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Preparing export…';
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Choose export location…'; save.disabled = true;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    const dismiss = () => {close(); if (returnFocus?.isConnected) returnFocus.focus();};
    cancel.onclick = dismiss; node.addEventListener('cancel', event => {event.preventDefault(); if (!cancel.disabled) dismiss();});
    node.append(h, label, description, status, save, cancel); dialog = node; hooks.root.append(node);
    if (node.showModal) node.showModal(); else node.setAttribute('open', ''); cancel.focus();
    const current = version;
    try {
      const prepared = await prepareMarkdownExport(core, snapshot.repositoryId, title, scope, snapshot.state, snapshot.buffers);
      if (current !== version) return;
      status.textContent = `${prepared.count} ${prepared.count === 1 ? 'sheet' : 'sheets'} ready. Captured when this dialog opened.`; save.disabled = false;
      save.onclick = async () => {
        save.disabled = true; cancel.disabled = true;
        try {
          const saved = await core.saveMarkdownExport!(snapshot.repositoryId, prepared.filename, prepared.text);
          if (current !== version) return;
          if (saved) {dismiss(); hooks.report(`Exported ${prepared.count} ${prepared.count === 1 ? 'sheet' : 'sheets'} as one Markdown file.`);}
          else status.textContent = 'Export canceled. Choose a location to try again.';
        } catch (error) { if (current === version) status.textContent = `Export failed: ${String(error)}`; }
        finally { if (current === version) {save.disabled = false; cancel.disabled = false; save.focus();} }
      };
    } catch (error) { if (current === version) status.textContent = `Export failed: ${String(error)}`; }
  }
  return {open, destroy: close};
}
