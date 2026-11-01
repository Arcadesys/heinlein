// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {createReferencePane} from './referencePane';
const doc=(path:string,text='---\r\ntitle: 星\r\n---\r\nα — 🐺\nNext\r\n')=>({path,text,contentHash:'hash',sizeBytes:52,frontmatter:null,generatedCompatibility:false});
function setup(){let binding:{session:string;generation:number}|null={session:'one',generation:1};const core={readDocument:vi.fn(async(_id:string,path:string)=>doc(path))};const edit=vi.fn();const pane=createReferencePane(core,{binding:()=>binding,edit,focusWriter:()=>{}});document.body.replaceChildren(pane.element);return {core,pane,edit,set:(value:typeof binding)=>{binding=value;}};}
describe('saved source reference',()=>{
 it('renders inert exact source, keeps origin through primary toolbar focus, refreshes by read only',async()=>{
  const {pane,core}=setup();await pane.read({path:'a.md'});expect(pane.element.querySelector('pre')?.textContent).toBe(doc('a.md').text);
  pane.element.querySelector<HTMLElement>('pre')!.focus();const toolbar=document.createElement('button');document.body.append(toolbar);toolbar.focus();expect(pane.fromReference()).toBe(true);pane.activateWriter();expect(pane.fromReference()).toBe(false);
  expect(pane.element.querySelector('[aria-label="Open in main pane"]')).not.toBeNull();pane.markChanged('a.md');expect(pane.element.textContent).toContain('Changed');await pane.read({path:'a.md'});expect(core.readDocument).toHaveBeenCalledTimes(2);
 });
 it('unrelated saves do not cancel a pending reference; matching changes cannot mount old bytes as fresh',async()=>{
  const {pane,core}=setup();await pane.read({path:'a.md'});let release!:(value:ReturnType<typeof doc>)=>void;
  core.readDocument.mockImplementationOnce(()=>new Promise(r=>{release=r;}));const pending=pane.read({path:'b.md'});pane.markChanged('a.md');release(doc('b.md'));expect(await pending).toBe(true);expect(pane.snapshot()?.doc.path).toBe('b.md');
  core.readDocument.mockImplementationOnce(()=>new Promise(r=>{release=r;}));const changed=pane.read({path:'b.md'});pane.markChanged('b.md');release(doc('b.md','outdated B bytes'));expect(await changed).toBe(false);expect(pane.snapshot()?.doc.text).toBe(doc('b.md').text);expect(pane.element.textContent).toContain('Changed');
 });
 it('rejects late reads after a newer request, project change or close',async()=>{
  const {pane,core,set}=setup();let release!:(value:ReturnType<typeof doc>)=>void;core.readDocument.mockImplementationOnce(()=>new Promise(r=>{release=r;}));const pending=pane.read({path:'old.md'});await pane.read({path:'new.md'});release(doc('old.md'));await pending;expect(pane.snapshot()?.doc.path).toBe('new.md');
  core.readDocument.mockImplementationOnce(()=>new Promise(r=>{release=r;}));const changed=pane.read({path:'late.md'});set({session:'two',generation:2});release(doc('late.md'));await changed;expect(pane.snapshot()?.doc.path).toBe('new.md');pane.clear();expect(pane.element.hidden).toBe(true);
 });
 it('marks removed generic references unavailable and cancels only their pending path',async()=>{
  const {pane,core}=setup();await pane.read({path:'a.md'});let release!:(value:ReturnType<typeof doc>)=>void;core.readDocument.mockImplementationOnce(()=>new Promise(r=>{release=r;}));const pending=pane.read({path:'b.md'});pane.markUnavailable('a.md');release(doc('b.md'));expect(await pending).toBe(true);expect(pane.snapshot()?.doc.path).toBe('b.md');pane.markUnavailable('b.md');expect(pane.element.textContent).toContain('Historical copy');expect(pane.element.querySelector<HTMLButtonElement>('[aria-label="Open in main pane"]')!.disabled).toBe(true);
 });
 it('does not relabel old content after failed reads and disables removed scene editing',async()=>{
  const {pane,core}=setup();await pane.read({path:'a.md',sceneId:'a'});core.readDocument.mockRejectedValueOnce(Error('missing'));await pane.read({path:'b.md'});expect(pane.snapshot()?.doc.path).toBe('a.md');expect(pane.element.textContent).toContain('Reference read failed for b.md');pane.reconcile([]);expect(pane.element.textContent).toContain('Historical copy');expect(pane.element.querySelectorAll<HTMLButtonElement>('.reference-actions button')[1].disabled).toBe(true);
 });
});
describe('saved source reference reading view',()=>{
 it('formats a copy of the saved text, keeps exact source, and offers no marks or writing authority',async()=>{
  const {pane}=setup();await pane.read({path:'a.md'});
  const source=pane.element.querySelector<HTMLElement>('pre')!,reading=pane.element.querySelector<HTMLButtonElement>('[aria-label="Reference reading"]')!;
  expect(source.hidden).toBe(false);expect(reading.getAttribute('aria-pressed')).toBe('false');
  reading.click();
  const reader=pane.element.querySelector<HTMLElement>('.markdown-reader')!;
  expect(reader.hidden).toBe(false);expect(source.hidden).toBe(true);expect(source.textContent).toBe(doc('a.md').text);
  expect(reader.textContent).toContain('α — 🐺');expect(reader.textContent).not.toContain('title: 星');expect(reader.textContent).toContain('Frontmatter is not shown');
  expect(reader.querySelectorAll('[data-review-id]')).toHaveLength(0);
  reader.focus();expect(pane.fromReference()).toBe(true);
  pane.element.querySelector<HTMLButtonElement>('[aria-label="Reference source"]')!.click();
  expect(reader.hidden).toBe(true);expect(reader.textContent).not.toContain('α');
 });
 it('offers no reading view for text that is not Markdown, and clears the formatted copy on close',async()=>{
  const {pane}=setup();await pane.read({path:'a.txt'});
  expect(pane.element.querySelector<HTMLElement>('.md-view-toggle')!.hidden).toBe(true);
  await pane.read({path:'a.md'});pane.element.querySelector<HTMLButtonElement>('[aria-label="Reference reading"]')!.click();
  pane.clear();expect(pane.element.querySelector('.markdown-reader')!.textContent).not.toContain('α');
 });
});
