// @vitest-environment jsdom
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {EditorView} from '@codemirror/view';import {Transaction} from '@codemirror/state';
import {mountStudio} from './studio';import type {LocalCore,RecoveryDraft} from './localCore';
const session={id:'synthetic-session',projectKey:'synthetic-project',name:'Invented book',manifests:[]};
const raw='---\r\ntitle: 星\r\n---\r\nThe fox — 🐺 pauses.\nA second line.\r\n';
const doc=(path:string,text=raw)=>({path,text,contentHash:`hash:${text}`,sizeBytes:new TextEncoder().encode(text).length,frontmatter:null,generatedCompatibility:false});
function bridge(){const files=new Map([['a.md',raw],['b.md','Second invented source.\r\n']]);const drafts=new Map<string,RecoveryDraft>();return {files,drafts,core:{available:()=>true,pickRepository:vi.fn(async()=>session),recentRepositories:vi.fn(async()=>[]),openRecentRepository:vi.fn(async()=>session),listDirectory:vi.fn(async()=>[]),loadManuscript:vi.fn(async()=>{throw Error('No manuscript');}),readDocument:vi.fn(async(_id,path)=>doc(path,files.get(path)??raw)),saveDocument:vi.fn(async(_id,path,_hash,text)=>{files.set(path,text);return doc(path,text);}),readRecovery:vi.fn(async(_id,path)=>drafts.get(path)??null),stageRecovery:vi.fn(async(_id,path,baseHash,text)=>{const draft={id:'draft',path,baseHash,text,updatedAt:0};drafts.set(path,draft);return draft;}),discardRecovery:vi.fn(async(_id,path)=>{drafts.delete(path);}),setUnsavedChanges:vi.fn(async()=>{}),requestClose:vi.fn(async()=>{}),onCloseRequested:vi.fn(async()=>()=>{}),listSystemFonts:vi.fn(async()=>[])} satisfies LocalCore};}
let app:ReturnType<typeof mountStudio>;
const view=()=>EditorView.findFromDOM(document.querySelector('.active-document-pane .cm-editor') as HTMLElement)!;
const tabs=()=>[...document.querySelectorAll<HTMLButtonElement>('[role=tab][id^=document-tab]')];
const selected=()=>tabs().find(t=>t.getAttribute('aria-selected')==='true');
function button(label:string){const find=()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);if(!find()&&label.startsWith('Read beside active document:'))button('Read beside…').click();if(!find()&&label.startsWith('Close document '))button('Document details').click();const b=find();if(!b)throw Error(`Missing ${label}`);return b;}
async function start(core:LocalCore){app=mountStudio(document.body,core);await app.selectRepository(async()=>session);await app.showDocument('a.md');}
function change(){const v=view();v.dispatch({changes:{from:v.state.doc.length,insert:' New — 星.'},annotations:Transaction.userEvent.of('input.type')});}
beforeEach(()=>{localStorage.clear();document.body.replaceChildren();Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();});afterEach(()=>app?.destroy());
describe('one-writer document workspace',()=>{
 it('opens deduplicated tabs and a saved raw reference without writes or remounting the writer',async()=>{
  const {core,files}=bridge();const before=[...files];await start(core);await app.showDocument('b.md');await app.showDocument('a.md');const v=view();v.dispatch({selection:{anchor:5}});change();const head=v.state.selection.main.head;
  button('Read beside active document: a.md').click();await vi.waitFor(()=>expect(document.querySelector('.reference-source')?.textContent).toBe(raw));expect(view()).toBe(v);expect(view().state.selection.main.head).toBe(head);expect(core.stageRecovery).not.toHaveBeenCalled();expect(core.saveDocument).not.toHaveBeenCalled();expect([...files]).toEqual(before);expect(tabs()).toHaveLength(2);
  button('Refresh saved source').click();await vi.waitFor(()=>expect(core.readDocument).toHaveBeenCalledTimes(5));expect(view()).toBe(v);expect(view().state.selection.main.head).toBe(head);
  button('Close reference').click();expect(view()).toBe(v);expect(document.querySelector<HTMLElement>('.reference-pane')!.hidden).toBe(true);
 });
 it('chooses inactive B beside dirty writer A without activating or replacing it',async()=>{
  const {core,files}=bridge();await start(core);await app.showDocument('b.md');await app.showDocument('a.md');const writer=view();writer.dispatch({selection:{anchor:6}});change();const head=writer.state.selection.main.head,text=writer.state.doc.toString(),before=[...files];button('Read beside active document: b.md').click();await vi.waitFor(()=>expect(document.querySelector('.reference-source')?.textContent).toBe('Second invented source.\r\n'));expect(view()).toBe(writer);expect(selected()?.textContent).toBe('a.md');expect(writer.state.selection.main.head).toBe(head);expect(writer.state.doc.toString()).toBe(text);expect([...files]).toEqual(before);expect(core.saveDocument).not.toHaveBeenCalled();
 });
 it('marks saved reference stale and never copies its bytes into the writer',async()=>{
  const {core}=bridge();await start(core);button('Read beside active document: a.md').click();await vi.waitFor(()=>expect(document.querySelector('.reference-source')?.textContent).toBe(raw));change();await app.saveCurrent();expect(document.querySelector('.reference-state')?.textContent).toContain('Changed');expect(document.querySelector('.reference-source')?.textContent).toBe(raw);expect(core.saveDocument).toHaveBeenCalledWith(session.id,'a.md',`hash:${raw}`,`${raw} New — 星.`);
 });
 it.each(['Ask about selection','Questions','Heinlein Review','Split scene at cursor'])('refuses %s after reference selection then primary-toolbar click',async label=>{
  const {core}=bridge();await start(core);view().dispatch({selection:{anchor:4,head:12}});button('Read beside active document: a.md').click();await vi.waitFor(()=>expect(document.querySelector('.reference-source')).not.toBeNull());
  const pre=document.querySelector<HTMLElement>('.reference-source')!;pre.focus();const range=document.createRange();range.selectNodeContents(pre);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);
  const control=button(label);control.disabled=false;control.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));control.focus();control.click();expect(document.querySelector('.status')?.textContent).toBe('Activate this document to edit or review it.');expect(document.querySelector('[aria-label="Ask about selection"]')).toBeNull();expect(core.saveDocument).not.toHaveBeenCalled();expect(core.stageRecovery).not.toHaveBeenCalled();
 });
 it('cancelled active switch/close and failed replacement preserve the mounted writing identity',async()=>{
  const {core}=bridge();await start(core);await app.showDocument('b.md');await app.showDocument('a.md');const v=view();change();const switching=app.showDocument('b.md');await vi.waitFor(()=>expect(document.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull());button('Keep editing').click();await switching;expect(view()).toBe(v);expect(selected()?.textContent).toBe('a.md');
  button('Close document a.md').click();await vi.waitFor(()=>expect(document.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull());button('Keep editing').click();expect(tabs()).toHaveLength(2);expect(view()).toBe(v);
  const failed=app.showDocument('missing.md');await vi.waitFor(()=>expect(document.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull());core.readDocument.mockRejectedValueOnce(Error('not found'));button('Discard changes').click();await failed;expect(view()).toBe(v);expect(selected()?.textContent).toBe('a.md');expect(tabs()).toHaveLength(2);
 });
 it('Save and continue switches via the one writer, inactive close is inert and last close is guarded',async()=>{
  const {core}=bridge();await start(core);await app.showDocument('b.md');await app.showDocument('a.md');change();const switching=app.showDocument('b.md');await vi.waitFor(()=>expect(document.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull());button('Save and continue').click();await switching;expect(selected()?.textContent).toBe('b.md');expect(core.saveDocument).toHaveBeenCalledOnce();button('Close document a.md').click();expect(tabs()).toHaveLength(1);button('Close document b.md').click();await vi.waitFor(()=>expect(tabs()).toHaveLength(0));expect(document.querySelector('.markdown-editor')).toBeNull();expect(document.activeElement?.tagName).toBe('H2');
 });
 it('failed save or recovery mount cannot leave an unlabelled surviving writer',async()=>{
  const {core,drafts}=bridge();await start(core);change();core.saveDocument.mockRejectedValueOnce(Error('disk full'));const switching=app.showDocument('b.md');await vi.waitFor(()=>expect(document.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull());button('Save and continue').click();await switching;expect(selected()?.textContent).toBe('a.md');expect(document.querySelector('.status')?.textContent).toContain('disk full');
  const discard=app.showDocument('b.md');await vi.waitFor(()=>expect(document.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull());drafts.set('b.md',{id:'b-draft',path:'b.md',baseHash:'old',text:'Recovery — 星',updatedAt:0});button('Discard changes').click();await discard;expect(selected()?.textContent).toBe('b.md');expect(document.body.textContent).toContain('Recovery');
 });
 it('late document reads and failed project selection retain actual mounted state; successful project commit clears session tabs',async()=>{
  const {core}=bridge();await start(core);let release!:(value:ReturnType<typeof doc>)=>void;core.readDocument.mockImplementationOnce(()=>new Promise(r=>{release=r;}));const pending=app.showDocument('late.md');await vi.waitFor(()=>expect(core.readDocument).toHaveBeenCalledTimes(2));await app.showDocument('b.md');release(doc('late.md'));await pending;expect(selected()?.textContent).toBe('b.md');expect(tabs()).toHaveLength(2);
  await app.selectRepository(async()=>{throw Error('refused');});expect(selected()?.textContent).toBe('b.md');await app.selectRepository(async()=>null);expect(tabs()).toHaveLength(2);await app.selectRepository(async()=>({...session,id:'new-session',projectKey:'new'}));expect(tabs()).toHaveLength(0);
 });
});
