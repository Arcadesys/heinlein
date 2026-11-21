// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {bookFolderName, createBookPublish} from './bookPublish';
import type {Document, DraftingState, LocalCore} from './localCore';

const doc = (path: string, text = `Saved text of ${path} — 🐺\n`): Document => ({path, text, contentHash: 'hash', sizeBytes: text.length, frontmatter: null, generatedCompatibility: false});
const state: DraftingState = {manifestPath: 'ms/manuscript.json', project: 'Book', revision: 'r',
  groups: [{id: 'g', title: 'Act one'}],
  scenes: [{id: 'a', title: 'First', path: 'ms/a.md', groupId: 'g'}, {id: 'b', title: 'Second', path: 'ms/b.md', groupId: 'g'}],
  referenceSheets: [{id: 'ref', title: 'Reference notes', path: 'ms/ref.md', groupId: 'g', reference: true}],
  library: [{id: 'g', kind: 'group', parentId: null}, {id: 'a', kind: 'scene', parentId: 'g'}, {id: 'b', kind: 'scene', parentId: 'g'}], untrackedPaths: [], missingPaths: []};

function setup(publishBook = vi.fn(async () => ({folder: 'Book — published', files: ['book.pdf', 'book.epub', 'book.docx']}))) {
  const core = {readDocument: vi.fn(async (_id: string, path: string) => doc(path)), saveDocument: vi.fn(), stageRecovery: vi.fn(), publishBook} as unknown as LocalCore;
  const report = vi.fn();
  // The open editor buffer has unsaved text; Publish must use it.
  const buffers = new Map([['ms/a.md', doc('ms/a.md', 'Live unsaved words. {>>private<<}\n')]]);
  const publish = createBookPublish(core, {root: document.body, snapshot: () => ({repositoryId: 'repo', state: structuredClone(state), buffers}), report});
  return {core, report, publish, publishBook};
}
const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const click = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label)!.click();
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute('open', '');};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute('open');};
});
afterEach(() => {vi.restoreAllMocks();});

describe('Publish book', () => {
  it('builds PDF, EPUB and DOCX by default from live text in Library order without saving', async () => {
    const {core, report, publish, publishBook} = setup();
    publish.open('Book');
    q<HTMLInputElement>('input[aria-label="Author"]').value = 'Example Author';
    q<HTMLInputElement>('input[aria-label="Approve book design and imprint branding"]').checked = true;
    click('Publish…'); await settle(); await settle();
    expect(publishBook).toHaveBeenCalledTimes(1);
    const [repositoryId, spec] = publishBook.mock.calls[0] as unknown as [string, {formats: string[]; text: string; title: string; author: string; brandingApproved: boolean; folderName: string}];
    expect(repositoryId).toBe('repo');
    expect(spec.formats).toEqual(['pdf', 'epub', 'docx']);
    expect(spec.title).toBe('Book'); expect(spec.author).toBe('Example Author'); expect(spec.brandingApproved).toBe(true);
    expect(spec.text).toContain('Live unsaved words.');
    expect(spec.text).not.toContain('private');
    expect(spec.text).not.toContain('Reference notes');
    expect(spec.text.indexOf('First')).toBeLessThan(spec.text.indexOf('Second'));
    expect(spec.folderName).toMatch(/^Book — published \d{4}-\d\d-\d\d \d{4}$/);
    expect(core.readDocument).not.toHaveBeenCalledWith('repo', 'ms/a.md');
    expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.stageRecovery).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('Published 3 files to “Book — published”.');
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('refuses to build until the author approves the book design, and remembers choices for one-click next time', async () => {
    const {publish, publishBook} = setup();
    publish.open('Book');
    click('Publish…'); await settle();
    expect(publishBook).not.toHaveBeenCalled();
    expect(q('[role="status"]').textContent).toContain('book design');
    q<HTMLInputElement>('input[aria-label="Approve book design and imprint branding"]').checked = true;
    q<HTMLInputElement>('input[aria-label="HTML (web page)"]').checked = true;
    q<HTMLInputElement>('input[aria-label="Author"]').value = 'Example Author';
    click('Publish…'); await settle(); await settle();
    expect(publishBook).toHaveBeenCalledTimes(1);
    publish.open('Book');
    expect(q<HTMLInputElement>('input[aria-label="Approve book design and imprint branding"]').checked).toBe(true);
    expect(q<HTMLInputElement>('input[aria-label="Author"]').value).toBe('Example Author');
    expect(q<HTMLInputElement>('input[aria-label="HTML (web page)"]').checked).toBe(true);
    click('Publish…'); await settle(); await settle();
    expect(publishBook).toHaveBeenCalledTimes(2);
  });
  it('keeps the dialog open with a clear message when the folder picker is canceled or the build fails', async () => {
    const publishBook = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce('PDF conversion failed. Check Chrome.');
    const {publish} = setup(publishBook);
    publish.open('Book');
    q<HTMLInputElement>('input[aria-label="Approve book design and imprint branding"]').checked = true;
    click('Publish…'); await settle(); await settle();
    expect(q('[role="status"]').textContent).toBe('Publish canceled. Nothing was written.');
    click('Publish…'); await settle(); await settle();
    expect(q('[role="status"]').textContent).toContain('PDF conversion failed');
    expect(q<HTMLButtonElement>('button.primary').disabled).toBe(false);
  });
  it('makes a safe, dated folder name', () => {
    expect(bookFolderName('A/B: "Draft"?', new Date(2026, 10, 21, 9, 5))).toBe('A-B- -Draft-- — published 2026-11-21 0905');
    expect(bookFolderName('...', new Date(2026, 0, 2, 3, 4))).toBe('Book — published 2026-01-02 0304');
  });
});
