import type {Document, DraftingState, LocalCore} from './localCore';
import {withReferenceSheets} from './sheetManagement';
import './markdownExport.css';

export type ExportScope = {kind: 'group'; id: string} | {kind: 'folder'; path: string} | {kind: 'project'};
interface ExportPart {title: string; path?: string; level: number}
export interface MarkdownExport {filename: string; text: string; count: number}
export const EXPORT_FORMATS = [{id:'markdown',label:'Markdown',extension:'md'},{id:'pdf',label:'PDF',extension:'pdf'},{id:'epub',label:'EPUB',extension:'epub'},{id:'html',label:'HTML',extension:'html'},{id:'docx',label:'DOCX',extension:'docx'}] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number]['id'];
export interface ManuscriptExportSpec {format:ExportFormat;title:string;author:string;text:string}
export interface ExportOptions {includeReferences?:boolean}

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
  state: DraftingState | null, buffers: Map<string, Document> = new Map(), options:ExportOptions = {}): Promise<MarkdownExport> {
  const parts: ExportPart[] = [];
  const includeReferences=options.includeReferences??false;
  const isReference=(path:string)=>{const indexed=state?.scenes.find(s=>s.path===path);return indexed?indexed.reference===true:!!state?.referenceSheets?.some(s=>s.path===path)||path.split('/').slice(0,-1).some(p=>p.toLowerCase()==='reference');};
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
        else if (/\.(md|markdown)$/i.test(entry.path) && (includeReferences || !isReference(entry.path))) {
          const doc = await read(entry.path);
          if (!doc.generatedCompatibility) parts.push({title: entry.path.slice(scope.path ? scope.path.length + 1 : 0).replace(/\.(md|markdown)$/i, ''), path: entry.path, level: 2});
        }
        if (parts.length > MAX_ITEMS) throw new Error('Too many sheets to export. Choose a smaller folder.');
      }
    };
    await walk(scope.path, 0);
    // Library order wins for indexed source files; remaining files keep natural filename order.
    if (state) {
      const order = libraryParts(state,null,includeReferences).filter(part => part.path).map(part => part.path!);
      const rank = new Map(order.map((path, index) => [path, index]));
      parts.sort((a, b) => (rank.get(a.path!) ?? Infinity) - (rank.get(b.path!) ?? Infinity));
    }
  } else {
    if (!state || state.recoveryRequired) throw new Error('Refresh the Library and resolve any interrupted change before exporting.');
    parts.push(...libraryParts(state, scope.kind === 'group' ? scope.id : null,includeReferences));
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

function libraryParts(state: DraftingState, groupId: string | null = null,includeReferences=false): ExportPart[] {
  const hasLibrary = Boolean(state.library) && !state.libraryLegacy;
  state = withReferenceSheets(state);
  const sheets = state.scenes;
  if (groupId && !state.groups.some(group => group.id === groupId)) throw new Error('This group is no longer in the Library.');
  // Older manuscripts have a flat reading order. Keep it even if group order
  // differs or scenes belonging to a group are interleaved.
  if (!hasLibrary) {
    const result: ExportPart[] = [];
    let previousGroup: string | null = null;
    for (const sheet of sheets.filter(sheet => (includeReferences || !sheet.reference) && (!groupId || sheet.groupId === groupId))) {
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
        if(sheet.reference&&!includeReferences)continue;
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
  function close() {version++;dialog?.close?.();dialog?.remove();dialog=null;}
  async function open(title:string,scope:ExportScope){
    if(dialog||(!core.saveMarkdownExport&&!core.exportManuscript))return;
    const snapshot=hooks.snapshot();if(!snapshot){hooks.report('Resolve the open recovery or file operation before exporting.',true);return;}
    const active=document.activeElement as HTMLElement|null;const menuLabel=active?.closest('.row-menu-items')?.getAttribute('aria-label');
    const opener=[...hooks.root.querySelectorAll<HTMLElement>('summary')].find(node=>node.getAttribute('aria-label')===menuLabel)??active;
    const node=document.createElement('dialog');node.className='appearance-dialog drafting-dialog markdown-export-dialog';
    const name=scope.kind==='project'?'Export manuscript':scope.kind==='group'?'Export group':'Export folder';node.setAttribute('aria-label',name);
    const h=document.createElement('h2');h.textContent=name;
    const label=document.createElement('p');label.textContent=`${scope.kind==='project'?'Entire manuscript':scope.kind==='group'?'Group':'Folder'} — ${title}`;
    const formatLabel=document.createElement('label');formatLabel.textContent='Format ';const format=document.createElement('select');format.setAttribute('aria-label','Export format');
    for(const choice of EXPORT_FORMATS){const option=document.createElement('option');option.value=choice.id;option.textContent=choice.label;option.disabled=choice.id!=='markdown'&&!core.exportManuscript;format.append(option);}formatLabel.append(format);
    const authorLabel=document.createElement('label');authorLabel.textContent='Author (optional) ';const author=document.createElement('input');author.type='text';author.maxLength=240;author.setAttribute('aria-label','Export author');authorLabel.append(author);
    const referencesLabel=document.createElement('label');const references=document.createElement('input');references.type='checkbox';references.setAttribute('aria-label','Include reference sheets');referencesLabel.append(references,document.createTextNode(' Include reference sheets'));
    const description=document.createElement('p');description.textContent='Uses manuscript reading order and current editor text. Reference sheets stay out unless selected. Adds headings and omits per-sheet YAML. Creates a new file outside the project; your writing stays unchanged.';
    const dependency=document.createElement('p');dependency.className='export-dependency-note';
    const status=document.createElement('p');status.setAttribute('role','status');
    const save=document.createElement('button');save.type='button';save.textContent='Choose export location…';save.disabled=true;
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';
    const dismiss=()=>{close();if(opener?.isConnected)opener.focus();};cancel.onclick=dismiss;node.addEventListener('cancel',event=>{event.preventDefault();if(!cancel.disabled)dismiss();});
    node.append(h,label,formatLabel,authorLabel,referencesLabel,description,dependency,status,save,cancel);dialog=node;hooks.root.append(node);if(node.showModal)node.showModal();else node.setAttribute('open','');cancel.focus();
    const current=version;let generation=0;let prepared:MarkdownExport|null=null;
    // Keep one source snapshot while the reference option changes. No source writes.
    const cache=new Map(snapshot.buffers),reads=new Map<string,Promise<Document>>();
    const frozenCore:LocalCore={...core,readDocument:(id,path)=>{
      if(cache.has(path))return Promise.resolve(cache.get(path)!);
      if(!reads.has(path))reads.set(path,core.readDocument(id,path).then(doc=>{cache.set(path,doc);return doc;}));return reads.get(path)!;
    }};
    function info(){dependency.textContent=format.value==='markdown'?'Markdown needs no converter. Images and attachments are not bundled.':'Uses the Heinlein publishing pipeline and Pandoc. PDF also requires Chrome. Local image attachments are not bundled in this version.';}
    async function prepare(){const ticket=++generation;prepared=null;save.disabled=true;status.textContent='Preparing export…';
      try{const next=await prepareMarkdownExport(frozenCore,snapshot!.repositoryId,title,scope,snapshot!.state,snapshot!.buffers,{includeReferences:references.checked});if(current!==version||ticket!==generation)return;prepared=next;status.textContent=`${next.count} ${next.count===1?'sheet':'sheets'} ready. Current editor text captured when this dialog opened.`;save.disabled=false;}
      catch(error){if(current===version&&ticket===generation)status.textContent=`Export failed: ${String(error)}`;}}
    references.addEventListener('change',()=>{void prepare();});format.addEventListener('change',info);info();
    save.onclick=async()=>{
      if(!prepared)return;const choice=EXPORT_FORMATS.find(c=>c.id===format.value)!;const filename=prepared.filename.replace(/\.md$/,`.${choice.extension}`);
      save.disabled=true;cancel.disabled=true;format.disabled=true;references.disabled=true;author.disabled=true;status.textContent=`Preparing ${choice.label} and choosing a new export file…`;
      try{const spec:ManuscriptExportSpec={format:choice.id,title,author:author.value.trim(),text:prepared.text};const saved=core.exportManuscript?await core.exportManuscript(snapshot.repositoryId,filename,spec):await core.saveMarkdownExport!(snapshot.repositoryId,filename,prepared.text);
        if(current!==version)return;if(saved){dismiss();hooks.report(`Exported ${prepared.count} ${prepared.count===1?'sheet':'sheets'} as one ${choice.label} file.`);}else status.textContent='Export canceled. Choose a location to try again.';
      }catch(error){if(current===version)status.textContent=`Export failed: ${String(error)}`;}
      finally{if(current===version){save.disabled=false;cancel.disabled=false;format.disabled=false;references.disabled=false;author.disabled=false;save.focus();}}
    };
    await prepare();
  }
  return {open,destroy:close};
}
