import type {Document, DraftingState, LocalCore} from './localCore';
import {prepareMarkdownExport} from './markdownExport';
import './markdownExport.css';

/** Formats the designed-book pipeline can build. PDF, EPUB and DOCX are on by default. */
export const BOOK_FORMATS = [
  {id: 'pdf', label: 'PDF (print-ready book)', defaultOn: true},
  {id: 'epub', label: 'EPUB (ebook)', defaultOn: true},
  {id: 'docx', label: 'DOCX (Word)', defaultOn: true},
  {id: 'html', label: 'HTML (web page)', defaultOn: false},
  {id: 'text', label: 'Plain text', defaultOn: false},
] as const;
export type BookFormat = typeof BOOK_FORMATS[number]['id'];
export interface PublishSpec {title: string; author: string; rights: string; formats: BookFormat[]; folderName: string; brandingApproved: boolean; text: string}
export interface PublishResult {folder: string; files: string[]}
interface Remembered {title?: string; author?: string; rights?: string; formats?: BookFormat[]; brandingApproved?: boolean}

const KEY = 'heinlein.publish.v1:';
function recall(project: string): Remembered {
  try {const raw = localStorage.getItem(KEY + project); return raw ? JSON.parse(raw) as Remembered : {};} catch {return {};}
}
function remember(project: string, value: Remembered) {
  try {localStorage.setItem(KEY + project, JSON.stringify(value));} catch {/* per-viewer convenience only */}
}
const pad = (n: number) => String(n).padStart(2, '0');
/** A new, dated folder name each time, so a publish never replaces an earlier book. */
export function bookFolderName(title: string, now = new Date()): string {
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'Book';
  return `${safe} — published ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * Publish: build the designed book straight from the live manuscript.
 * Reads current editor text in Library order (reference sheets excluded) and
 * hands it to the native host, which runs the Heinlein publisher and writes a
 * NEW folder. No source file is written.
 */
export function createBookPublish(core: LocalCore, hooks: {
  root: HTMLElement;
  snapshot(): {repositoryId: string; state: DraftingState | null; buffers: Map<string, Document>} | null;
  report(message: string, error?: boolean): void;
}) {
  let dialog: HTMLDialogElement | null = null;
  let version = 0;
  const supported = Boolean(core.publishBook);
  function close() {version++; dialog?.close?.(); dialog?.remove(); dialog = null;}
  function open(project: string) {
    if (dialog || !core.publishBook) return;
    const snapshot = hooks.snapshot();
    if (!snapshot) {hooks.report('Resolve the open recovery or file operation before publishing.', true); return;}
    const opener = document.activeElement as HTMLElement | null;
    const saved = recall(project);
    const node = document.createElement('dialog'); node.className = 'appearance-dialog drafting-dialog markdown-export-dialog book-publish-dialog'; node.setAttribute('aria-labelledby', 'book-publish-title');
    const h = document.createElement('h2'); h.id = 'book-publish-title'; h.textContent = 'Publish book';
    const intro = document.createElement('p'); intro.textContent = 'Builds your designed book from the text you have now, including unsaved edits, in Library order. Reference sheets and private notes stay out. Your story files are not changed.';
    const text = (label: string, value: string, aria: string, max: number) => {
      const wrap = document.createElement('label'); wrap.textContent = label + ' ';
      const input = document.createElement('input'); input.type = 'text'; input.value = value; input.maxLength = max; input.setAttribute('aria-label', aria);
      wrap.append(input); return {wrap, input};
    };
    const title = text('Book title', saved.title || project, 'Book title', 200);
    const author = text('Author', saved.author ?? '', 'Author', 200);
    const rights = text('Rights (optional)', saved.rights ?? '', 'Rights statement', 2000);
    const formats = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = 'Formats'; formats.append(legend);
    const chosen = new Set<BookFormat>(saved.formats?.length ? saved.formats : BOOK_FORMATS.filter(f => f.defaultOn).map(f => f.id));
    const boxes = BOOK_FORMATS.map(format => {
      const wrap = document.createElement('label'); wrap.className = 'book-publish-check'; const box = document.createElement('input'); box.type = 'checkbox'; box.checked = chosen.has(format.id); box.value = format.id; box.setAttribute('aria-label', format.label);
      const text = document.createElement('span'); text.textContent = format.label; wrap.append(box, text); formats.append(wrap); return box;
    });
    const brandingWrap = document.createElement('label'); const branding = document.createElement('input'); branding.type = 'checkbox'; branding.checked = saved.brandingApproved === true; branding.setAttribute('aria-label', 'Approve book design and imprint branding');
    brandingWrap.className = 'book-publish-check'; const brandingText = document.createElement('span'); brandingText.textContent = 'Use the Heinlein book design with FREE PLAY Publishing imprint pages (or this project’s own heinlein.yaml design)'; brandingWrap.append(branding, brandingText);
    const dependency = document.createElement('p'); dependency.className = 'export-dependency-note'; dependency.textContent = 'Needs the Heinlein publisher and Pandoc. PDF also needs Chrome. You choose where the new book folder goes.';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const publish = document.createElement('button'); publish.type = 'button'; publish.className = 'primary'; publish.textContent = 'Publish…';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    const controls = [title.input, author.input, rights.input, ...boxes, branding, publish, cancel];
    const dismiss = () => {close(); if (opener?.isConnected) opener.focus();};
    cancel.onclick = dismiss; node.addEventListener('cancel', event => {event.preventDefault(); if (!cancel.disabled) dismiss();});
    node.append(h, intro, title.wrap, author.wrap, rights.wrap, formats, brandingWrap, dependency, status, publish, cancel);
    dialog = node; hooks.root.append(node); if (node.showModal) node.showModal(); else node.setAttribute('open', '');
    publish.focus();
    const current = version;
    publish.onclick = async () => {
      const picked = boxes.filter(b => b.checked).map(b => b.value as BookFormat);
      const bookTitle = title.input.value.trim();
      if (!bookTitle) {status.textContent = 'Add a book title first.'; title.input.focus(); return;}
      if (!picked.length) {status.textContent = 'Choose at least one format.'; boxes[0].focus(); return;}
      if (!branding.checked) {status.textContent = 'Tick the book design box to publish with it.'; branding.focus(); return;}
      remember(project, {title: bookTitle, author: author.input.value.trim(), rights: rights.input.value.trim(), formats: picked, brandingApproved: true});
      controls.forEach(c => c.disabled = true); node.setAttribute('aria-busy', 'true');
      status.textContent = 'Building your book. This can take up to a minute…';
      try {
        const prepared = await prepareMarkdownExport(core, snapshot.repositoryId, bookTitle, {kind: 'project'}, snapshot.state, snapshot.buffers);
        if (current !== version) return;
        const spec: PublishSpec = {title: bookTitle, author: author.input.value.trim(), rights: rights.input.value.trim(), formats: picked, folderName: bookFolderName(bookTitle), brandingApproved: true, text: prepared.text};
        const result = await core.publishBook!(snapshot.repositoryId, spec);
        if (current !== version) return;
        if (result) {dismiss(); hooks.report(`Published ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'} to “${result.folder}”.`);}
        else status.textContent = 'Publish canceled. Nothing was written.';
      } catch (error) {
        if (current === version) status.textContent = `Publish failed: ${String(error)}`;
      } finally {
        if (current === version) {controls.forEach(c => c.disabled = false); node.removeAttribute('aria-busy'); publish.focus();}
      }
    };
  }
  return {open, supported, destroy: close};
}
