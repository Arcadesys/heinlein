// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createMarkdownExport, exportBody, prepareMarkdownExport, stripComments} from './markdownExport';
import type {Document, DraftingState, Entry, LocalCore} from './localCore';

const doc = (path: string, text = `Body of ${path} — 🐺\r\n\r\nPunch.\n`): Document => ({path, text, contentHash:'hash', sizeBytes:text.length, frontmatter:null, generatedCompatibility:false});
const state: DraftingState = {manifestPath:'ms/manuscript.json', project:'Book', revision:'r',
  groups:[{id:'g',title:'Act one'},{id:'child',title:'Nested'},{id:'other',title:'Other'}],
  scenes:[{id:'a',title:'First',path:'ms/a.md',groupId:'g'},{id:'b',title:'Second',path:'ms/b.md',groupId:'child'},{id:'c',title:'Outside',path:'ms/c.md',groupId:'other'}],
  referenceSheets:[{id:'ref',title:'Reference notes',path:'ms/ref.md',groupId:'child',reference:true}],
  library:[{id:'g',kind:'group',parentId:null},{id:'child',kind:'group',parentId:'g'},{id:'b',kind:'scene',parentId:'child'},{id:'a',kind:'scene',parentId:'g'},{id:'other',kind:'group',parentId:null},{id:'c',kind:'scene',parentId:'other'}], untrackedPaths:[],missingPaths:[]};
function bridge() {
  return {readDocument:vi.fn(async (_id:string,path:string)=>doc(path)),listDirectory:vi.fn(async()=>[]),saveDocument:vi.fn(),stageRecovery:vi.fn(),saveMarkdownExport:vi.fn(async()=>true)} as unknown as LocalCore;
}
beforeEach(()=>{
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal = function(){this.setAttribute('open','');};
  HTMLDialogElement.prototype.close = function(){this.removeAttribute('open');};
});
afterEach(()=>{vi.restoreAllMocks();});

describe('read-only Markdown export',()=>{
  it('exports nested groups in Library order, excludes references by default and uses the current buffer without saving',async()=>{
    const core=bridge(); const original=structuredClone(state);
    const text='---\r\nprivate: metadata\r\n---\r\nCurrent — 🐺\r\n\r\nPunch.\n';
    const exported=await prepareMarkdownExport(core,'repo','Act one',{kind:'group',id:'g'},state,new Map([['ms/a.md',doc('ms/a.md',text)]]));
    expect(exported.count).toBe(2);
    expect(exported.filename).toBe('Act one.md');
    expect(exported.text).toContain('Current — 🐺\r\n\r\nPunch.\n');
    expect(exported.text).not.toContain('private:'); expect(exported.text).not.toContain('Outside');
    expect(exported.text.indexOf('### Second')).toBeLessThan(exported.text.indexOf('## First'));
    expect(exported.text).not.toContain('Reference notes');
    const withReferences=await prepareMarkdownExport(core,'repo','Act one',{kind:'group',id:'g'},state,new Map([['ms/a.md',doc('ms/a.md',text)]]),{includeReferences:true});
    expect(withReferences.count).toBe(3);expect(withReferences.text).toContain('### Reference notes');
    expect(core.readDocument).not.toHaveBeenCalledWith('repo','ms/a.md');
    expect(core.saveDocument).not.toHaveBeenCalled(); expect(core.stageRecovery).not.toHaveBeenCalled();
    expect(state).toEqual(original);
  });
  it('recurses folders, naturally sorts filenames, and skips attachments and generated compatibility files',async()=>{
    const core=bridge();
    core.listDirectory=vi.fn(async(_id:string,path:string):Promise<Entry[]>=>path==='drafts' ? [
      {path:'drafts/10.md',name:'10.md',kind:'file',sizeBytes:1},{path:'drafts/2.markdown',name:'2.markdown',kind:'file',sizeBytes:1},
      {path:'drafts/nested',name:'nested',kind:'directory',sizeBytes:0},{path:'drafts/picture.png',name:'picture.png',kind:'file',sizeBytes:1},
      {path:'drafts/generated.md',name:'generated.md',kind:'file',sizeBytes:1},
    ]:[{path:'drafts/nested/1.md',name:'1.md',kind:'file',sizeBytes:1}]);
    core.readDocument=vi.fn(async(_id,path)=>({...doc(path),generatedCompatibility:path.endsWith('generated.md')}));
    const exported=await prepareMarkdownExport(core,'repo','Drafts',{kind:'folder',path:'drafts'},null);
    expect(exported.count).toBe(3); expect(exported.text.indexOf('## 2')).toBeLessThan(exported.text.indexOf('## 10'));
    expect(exported.text).toContain('## nested/1'); expect(exported.text).not.toContain('generated');
    expect(core.readDocument).not.toHaveBeenCalledWith('repo','drafts/picture.png');
  });
  it('uses Library reading order for indexed files in a physical folder',async()=>{
    const core=bridge(); core.listDirectory=async()=>['a','b','c'].map(name=>({name:`${name}.md`,path:`ms/${name}.md`,kind:'file',sizeBytes:1}));
    const exported=await prepareMarkdownExport(core,'repo','ms',{kind:'folder',path:'ms'},state);
    expect(exported.text.indexOf('## b')).toBeLessThan(exported.text.indexOf('## a'));
    expect(exported.text.indexOf('## a')).toBeLessThan(exported.text.indexOf('## c'));
  });
  it('preserves flat legacy reading order when it differs from group order',async()=>{
    const legacy={...state,library:undefined,referenceSheets:undefined,scenes:[state.scenes[2],state.scenes[0],state.scenes[1]]};
    const exported=await prepareMarkdownExport(bridge(),'repo','Book',{kind:'project'},legacy);
    expect(exported.text.indexOf('### Outside')).toBeLessThan(exported.text.indexOf('### First'));
    expect(exported.text.indexOf('### First')).toBeLessThan(exported.text.indexOf('### Second'));
  });
  it('fails the whole export on an unreadable or missing sheet rather than producing a partial manuscript',async()=>{
    const core=bridge();core.readDocument=vi.fn(async()=>{throw new Error('Missing scene');});
    await expect(prepareMarkdownExport(core,'repo','Act one',{kind:'group',id:'g'},state)).rejects.toThrow('Missing scene');
    expect(core.saveMarkdownExport).not.toHaveBeenCalled();
  });
  it('refuses empty exports, interrupted structure and invalid Library references',async()=>{
    const core=bridge();
    await expect(prepareMarkdownExport(core,'repo','Empty',{kind:'folder',path:''},null)).rejects.toThrow('No Markdown');
    await expect(prepareMarkdownExport(core,'repo','Book',{kind:'project'},{...state,recoveryRequired:true})).rejects.toThrow('interrupted');
    await expect(prepareMarkdownExport(core,'repo','Book',{kind:'project'},{...state,scenes:[]})).rejects.toThrow('missing');
    await expect(prepareMarkdownExport(core,'repo','Deleted',{kind:'group',id:'deleted'},state)).rejects.toThrow('no longer');
  });
  it('removes private author comments and the one space before each, leaving the prose intact',()=>{
    expect(stripComments('new {>>x<<}.')).toBe('new.');
    expect(stripComments('Start{>>tight<<} end')).toBe('Start end');
    expect(stripComments('two  {>>x<<}.')).toBe('two .');
    expect(stripComments('a {>>one<<} {>>two<<} b')).toBe('a b');
    expect(stripComments('Wraps {>>over\r\na line<<} — fine.\r\n')).toBe('Wraps — fine.\r\n');
    expect(stripComments('{>>lead<<}Body\n\nNext {>>x<<}\n')).toBe('Body\n\nNext\n');
    expect(stripComments('No notes — 🐺 <<} stray close\n')).toBe('No notes — 🐺 <<} stray close\n');
  });
  it('refuses an unclosed comment, including one that would close only across a blank line',()=>{
    expect(()=>stripComments('Body {>>never closed\n')).toThrow('A scene has an unfinished comment. Close or remove it before exporting.');
    expect(()=>stripComments('Body {>>split\n\nlater<<} text')).toThrow('unfinished comment');
    expect(()=>stripComments('Body {>>split\r\n \r\nlater<<}')).toThrow('unfinished comment');
    expect(()=>stripComments('ok {>>x<<} then {>>open')).toThrow('unfinished comment');
  });
  it('keeps author comments out of every export format and fails the export on an unclosed one',async()=>{
    const noted=new Map([['ms/a.md',doc('ms/a.md','---\ntitle: A\n---\nShe left {>>make this colder<<}.\n')]]);
    const exported=await prepareMarkdownExport(bridge(),'repo','Act one',{kind:'group',id:'g'},state,noted,{illustrated:true});
    expect(exported.text).toContain('She left.\n'); expect(exported.text).not.toContain('{>>'); expect(exported.text).not.toContain('colder');
    const open=new Map([['ms/a.md',doc('ms/a.md','She left {>>unfinished\n')]]);
    await expect(prepareMarkdownExport(bridge(),'repo','Act one',{kind:'group',id:'g'},state,open)).rejects.toThrow('unfinished comment');
  });
  it('strips only complete frontmatter and preserves body punctuation, whitespace and line endings',()=>{
    for(const newline of ['\n','\r\n','\r']) expect(exportBody(`\uFEFF---${newline}title: Secret${newline}...${newline}Body — 🐺${newline}`)).toBe(`Body — 🐺${newline}`);
    expect(exportBody('Punch.\n\n— Again.\n')).toBe('Punch.\n\n— Again.\n');
    expect(()=>exportBody('---\ntitle: unfinished\n')).toThrow('unfinished');
  });
});

it('lets the author cancel, retry the native picker, recover from save errors, and save the prepared snapshot',async()=>{
  const core=bridge(); const save=vi.mocked(core.saveMarkdownExport!); save.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Disk full')).mockResolvedValueOnce(true);
  const report=vi.fn();const exporter=createMarkdownExport(core,{root:document.body,snapshot:()=>({repositoryId:'repo',state,buffers:new Map()}),report});
  await exporter.open('Act one',{kind:'group',id:'g'});
  expect(document.querySelector('dialog')?.getAttribute('aria-label')).toBe('Export group');
  const button=document.querySelector<HTMLButtonElement>('dialog button')!; button.click();
  await vi.waitFor(()=>expect(document.querySelector('[role=status]')?.textContent).toContain('canceled'));
  button.click(); await vi.waitFor(()=>expect(document.querySelector('[role=status]')?.textContent).toContain('Disk full'));
  button.click(); await vi.waitFor(()=>expect(document.querySelector('dialog')).toBeNull());
  expect(report).toHaveBeenCalledWith('Exported 2 sheets as one Markdown file.');
  expect(save.mock.calls[0]).toEqual(save.mock.calls[2]);
  await exporter.open('Act one',{kind:'group',id:'g'});
  document.querySelector<HTMLButtonElement>('dialog button:last-child')!.click();
  expect(document.querySelector('dialog')).toBeNull(); expect(save).toHaveBeenCalledTimes(3); exporter.destroy();
});

it('respects native legacy ordering even with a synthesized Library array',async()=>{
 const nativeLegacy={...state,libraryLegacy:true,referenceSheets:undefined,scenes:[state.scenes[2],state.scenes[0],state.scenes[1]]};
 const result=await prepareMarkdownExport(bridge(),'repo','Book',{kind:'project'},nativeLegacy);
 expect(result.text.indexOf('### Outside')).toBeLessThan(result.text.indexOf('### First'));
 expect(result.text.indexOf('### First')).toBeLessThan(result.text.indexOf('### Second'));
});
it('explicit reference opt-in keeps captured sources and passes the chosen format to native conversion',async()=>{
 const core=bridge();const convert=vi.fn(async()=>true);core.exportManuscript=convert;
 const exporter=createMarkdownExport(core,{root:document.body,snapshot:()=>({repositoryId:'repo',state,buffers:new Map()}),report:vi.fn()});
 await exporter.open('Book',{kind:'project'});const check=document.querySelector<HTMLInputElement>('input[type=checkbox]')!;expect(check.checked).toBe(false);
 check.checked=true;check.dispatchEvent(new Event('change'));await vi.waitFor(()=>expect(document.querySelector('[role=status]')?.textContent).toContain('4 sheets ready'));
 const format=document.querySelector<HTMLSelectElement>('select')!;format.value='epub';format.dispatchEvent(new Event('change'));
 document.querySelector<HTMLButtonElement>('dialog button')!.click();await vi.waitFor(()=>expect(convert).toHaveBeenCalledOnce());
 expect(convert.mock.calls[0]).toMatchObject(['repo','Book.epub',{format:'epub',title:'Book',author:''}]);expect(vi.mocked(core.readDocument).mock.calls.filter(([,path])=>path==='ms/a.md')).toHaveLength(1);exporter.destroy();
});

it('retains the owning scene for two illustrations with identical relative URLs',async()=>{
  const book={...state,scenes:state.scenes.map(s=>({...s,path:`ms/${s.id}/scene.md`}))};
  const core=bridge();
  core.readDocument=async(_id,path)=>doc(path,`![Map of ${path}](map.png)\n`);
  const out=await prepareMarkdownExport(core,'repo','Book',{kind:'group',id:'g'},book,new Map(),{illustrated:true});
  expect(out.images).toEqual([{scene:'ms/b/scene.md',url:'map.png'},{scene:'ms/a/scene.md',url:'map.png'}]);
  expect(out.text).toContain('![Map of ms/b/scene.md](heinlein-illustration-0)');
  expect(out.text).toContain('![Map of ms/a/scene.md](heinlein-illustration-1)');
});
