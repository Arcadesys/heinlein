// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createWritingPanel} from './writingPanel';
import type {LocalCore,Manuscript,RepositorySession} from './localCore';
let panel:ReturnType<typeof createWritingPanel>;
const repo={id:'session',name:'book',projectKey:'stable',manifests:[]} as RepositorySession;
const book={path:'scene-manifest.json',project:'Book',schemaVersion:1,volumes:[{number:1,title:'V',path:'v',chapters:[{number:1,title:'C',path:'c',source:'generated.md',scenes:[{path:'a.md'},{path:'b.md'}]}]}]} as Manuscript;
beforeEach(()=>{const store=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v)});panel=createWritingPanel();document.body.replaceChildren(panel.element);});
afterEach(()=>{panel.destroy();vi.unstubAllGlobals();});
describe('writing progress panel',()=>{
  it('shows scene counts without frontmatter and sound starts off',()=>{
    panel.openScene('stable','a.md','---\ntitle: Hidden words\n---\none two');
    expect(panel.element.textContent).toContain('Scene: 2 words');
    expect(panel.element.querySelector('button')?.getAttribute('aria-pressed')).toBe('false');
    panel.changed('one two','one two three','user');
    expect(panel.element.textContent).toContain('1 / 1,000 daily growth credited');
  });
  it('counts manuscript in background and keeps current unsaved scene words',async()=>{
    panel.openScene('stable','a.md','one two three');
    const core={readDocument:vi.fn(async(_id:string,path:string)=>({text:path==='a.md'?'old':'four five'}))} as unknown as LocalCore;
    await panel.setManuscript(core,repo,book);
    expect(panel.element.textContent).toContain('Manuscript: 5 words');
    expect(core.readDocument).toHaveBeenCalledTimes(2);
  });
  it('labels incomplete manuscript counts instead of claiming a full total',async()=>{
    const core={readDocument:vi.fn(async(_id:string,path:string)=>{if(path==='b.md')throw Error('unreadable');return {text:'one two'};})} as unknown as LocalCore;
    await panel.setManuscript(core,repo,book);
    expect(panel.element.textContent).toContain('Manuscript: 2 words (1 unreadable; partial)');
  });
  it('ignores stale background results after switching manuscripts',async()=>{
    let finish!:(value:unknown)=>void;
    const core={readDocument:vi.fn(()=>new Promise(resolve=>{finish=resolve;}))} as unknown as LocalCore;
    const one={...book,volumes:[{...book.volumes[0],chapters:[{...book.volumes[0].chapters[0],scenes:[{path:'a.md'}]}]}]};
    const pending=panel.setManuscript(core,repo,one); panel.clearManuscript(); finish({text:'old words'}); await pending;
    expect(panel.element.textContent).toContain('Manuscript: —');
  });
  it('removes discarded text from the manuscript total and preserves exact saved snapshots',async()=>{
    const core={readDocument:vi.fn(async()=>({text:'one two'}))} as unknown as LocalCore;
    await panel.setManuscript(core,repo,book);
    panel.openScene('stable','a.md','one two');
    panel.changed('one two','one two three four','user');
    expect(panel.element.textContent).toContain('Manuscript: 6 words');
    panel.clearScene();
    expect(panel.element.textContent).toContain('Manuscript: 4 words');
    panel.openScene('stable','a.md','one two');
    panel.changed('one two','one two three four five','user');
    panel.saved('stable','a.md','one two three');
    expect(panel.element.textContent).toContain('Manuscript: 7 words');
    panel.clearScene();
    expect(panel.element.textContent).toContain('Manuscript: 5 words');
  });

  it('does not replace a newer saved count with a stale background read',async()=>{
    let finish!:(value:unknown)=>void;
    const core={readDocument:vi.fn(()=>new Promise(resolve=>{finish=resolve;}))} as unknown as LocalCore;
    const one={...book,volumes:[{...book.volumes[0],chapters:[{...book.volumes[0].chapters[0],scenes:[{path:'a.md'}]}]}]};
    const pending=panel.setManuscript(core,repo,one);
    panel.saved('stable','a.md','new saved words');
    finish({text:'old'}); await pending;
    expect(panel.element.textContent).toContain('Manuscript: 3 words');
  });

  it('keeps daily progress identity when an ms scene moves',()=>{
    panel.openScene('stable','ms/a.md','one','id-1');
    panel.changed('one','one two','user');
    panel.openScene('stable','ms/group/a.md','one two','id-1');
    panel.changed('one two','one','user');
    panel.changed('one','one two','user');
    expect(panel.element.textContent).toContain('1 / 1,000 daily growth credited');
  });
  it('counts a flat drafting manifest',async()=>{
    const core={readDocument:vi.fn(async()=>({text:'one two'}))} as unknown as LocalCore;
    await panel.setManuscript(core,repo,{scenes:[{path:'ms/a.md'},{path:'ms/b.md'}]});
    expect(panel.element.textContent).toContain('Manuscript: 4 words');
  });

});
