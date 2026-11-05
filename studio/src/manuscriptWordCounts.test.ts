import {describe, expect, it, vi} from 'vitest';
import type {DraftingState, LocalCore, Manuscript, RepositorySession} from './localCore';
import {createManuscriptWordCounts, formatWordTotal, indexWordCounts, wordTotal} from './manuscriptWordCounts';
import {wordCount} from './writingFeedback';
const repo: RepositorySession = {id:'r', projectKey:'stable', name:'Book', manifests:[]};
const state = (): DraftingState => ({manifestPath:'ms/manuscript.json', project:'Book', revision:'v1', untrackedPaths:['ms/untracked.md','.trash/deleted.md'], missingPaths:[], groups:[{id:'outer',title:'Part'},{id:'inner',title:'Chapter'},{id:'empty',title:'Empty'}], scenes:[{id:'a',path:'a.md',title:'Opening',groupId:'outer'},{id:'b',path:'b.md',title:'Ending',groupId:'outer'},{id:'r',path:'reference.md',title:'Reference',groupId:'inner',reference:true}], library:[{id:'outer',kind:'group',parentId:null},{id:'inner',kind:'group',parentId:'outer'},{id:'empty',kind:'group',parentId:null},{id:'a',kind:'scene',parentId:'outer'},{id:'b',kind:'scene',parentId:'inner'},{id:'r',kind:'scene',parentId:'inner'}]});
const core = (files: Record<string,string>) => ({readDocument:vi.fn(async(_id:string,path:string)=>{if (!(path in files)) throw Error('Missing'); return {path,text:files[path],generatedCompatibility:false};})}) as unknown as LocalCore;
const deferred = <T>() => {let resolve!:(value:T)=>void; const promise=new Promise<T>(yes=>{resolve=yes;}); return {promise,resolve};};

describe('manuscript scope and live counts',()=>{
 it('uses nested library parents, excludes references and untracked/trash, and counts each path once',async()=>{
  const book=state(); book.scenes.push({...book.scenes[0],id:'duplicate'});
  const index=indexWordCounts(book); expect(index.scenes.map(s=>s.path)).toEqual(['a.md','b.md']);
  expect(index.groups.find(g=>g.id==='inner')).toMatchObject({label:'Part / Chapter',paths:['b.md']});
  expect(index.groups.find(g=>g.id==='outer')?.paths).toEqual(['a.md','b.md']);
  const reader=core({'a.md':'one two','b.md':'three'});const counts=createManuscriptWordCounts(()=>{});await counts.setManuscript(reader,repo,book);
  expect(wordTotal(counts.snapshot())).toEqual({words:3,pending:0,unavailable:0,scenes:2});expect(reader.readDocument).toHaveBeenCalledTimes(2);
  expect(formatWordTotal(wordTotal(counts.snapshot(),[]))).toBe('0 words');
 });
 it('supports legacy volume/chapter scopes without counting generated exports twice',()=>{
  const book:Manuscript={path:'manifest.json',project:'Legacy',schemaVersion:1,volumes:[{number:1,title:'Volume',path:'v',chapters:[{number:1,title:'Chapter',path:'c',source:'export.md',scenes:[{path:'a.md'},{path:'a.md'},{path:'b.md'}]}]}]};
  const index=indexWordCounts(book);expect(index.scenes.map(s=>s.path)).toEqual(['a.md','b.md']);expect(index.groups.map(g=>g.paths)).toEqual([['a.md','b.md'],['a.md','b.md']]);expect(index.groups[1].source).toBe('export.md');
 });
 it('overlays unsaved text even before its background read finishes, then removes discarded changes',async()=>{
  const pending=deferred<{path:string;text:string}>();const reader=core({'a.md':'old','b.md':'one two'});reader.readDocument=vi.fn(async(_id,path)=>path==='a.md'?pending.promise:{path,text:'one two'} as any);
  const counts=createManuscriptWordCounts(()=>{});counts.openScene('stable','a.md','old');counts.changed('one two three four');const load=counts.setManuscript(reader,repo,state());
  expect(wordTotal(counts.snapshot())).toEqual({words:4,pending:1,unavailable:0,scenes:2});pending.resolve({path:'a.md',text:'old'});await load;
  expect(wordTotal(counts.snapshot()).words).toBe(6);counts.clearScene();expect(wordTotal(counts.snapshot()).words).toBe(3);
 });
 it('does not replace a successful save with a late read or include newer unsaved text after discard',async()=>{
  const pending=deferred<{path:string;text:string}>();const reader=core({'b.md':'two'});reader.readDocument=vi.fn(async(_id,path)=>path==='a.md'?pending.promise:{path,text:'two'} as any);
  const counts=createManuscriptWordCounts(()=>{});const load=counts.setManuscript(reader,repo,state());counts.openScene('stable','a.md','one');counts.changed('one new newer');counts.saved('stable','a.md','one new');pending.resolve({path:'a.md',text:'old'});await load;
  expect(wordTotal(counts.snapshot()).words).toBe(4);counts.clearScene();expect(wordTotal(counts.snapshot()).words).toBe(3);
 });
 it('tracks every edited chapter scene, saves exact snapshots, and leaves unchanged scenes alone',async()=>{
  const counts=createManuscriptWordCounts(()=>{});await counts.setManuscript(core({'a.md':'one','b.md':'two'}),repo,state());
  counts.openChapter('stable','__chapter__/outer.md',[{path:'a.md',text:'one'},{path:'b.md',text:'two'}]);
  counts.changedChapter([{path:'a.md',text:'one new'},{path:'b.md',text:'two more words'}]);expect(wordTotal(counts.snapshot()).words).toBe(5);expect(counts.snapshot().activeGroupId).toBe('outer');
  counts.saved('stable','a.md','one new');counts.changedChapter([{path:'a.md',text:'one new newer'},{path:'b.md',text:'two more words'}]);expect(wordTotal(counts.snapshot()).words).toBe(6);
  counts.clearScene();expect(wordTotal(counts.snapshot()).words).toBe(3);
 });
 it('preserves dirty buffers across regrouping and excludes deleted scenes until restored',async()=>{
  const counts=createManuscriptWordCounts(()=>{}),reader=core({'a.md':'one','b.md':'two'});const book=state();await counts.setManuscript(reader,repo,book);counts.openScene('stable','b.md','two');counts.changed('two more');
  const promoted=state();promoted.groups=promoted.groups.filter(g=>g.id!=='outer');promoted.library=promoted.library!.filter(e=>e.id!=='outer').map(e=>({...e,parentId:e.parentId==='outer'?null:e.parentId}));
  await counts.setManuscript(reader,repo,promoted);expect(wordTotal(counts.snapshot()).words).toBe(3);expect(counts.snapshot().index?.groups.find(g=>g.id==='inner')?.paths).toEqual(['b.md']);
  const deleted={...promoted,scenes:promoted.scenes.filter(s=>s.id!=='b')};await counts.setManuscript(reader,repo,deleted);expect(wordTotal(counts.snapshot()).words).toBe(1);expect(counts.snapshot().current?.included).toBe(false);
  counts.clearScene();await counts.setManuscript(reader,repo,book);expect(wordTotal(counts.snapshot()).words).toBe(2);
 });
 it('reports loading and unavailable counts without presenting them as zero, rejects generated/mismatched reads',async()=>{
  const counts=createManuscriptWordCounts(()=>{});const pending=deferred<any>();const reader=core({});reader.readDocument=vi.fn(()=>pending.promise);const load=counts.setManuscript(reader,repo,state());expect(formatWordTotal(wordTotal(counts.snapshot()))).toBe('Counting…');
  pending.resolve({path:'unexpected.md',text:'not valid'});await load;expect(formatWordTotal(wordTotal(counts.snapshot()))).toBe('Count unavailable');
  await counts.setManuscript({...reader,readDocument:async(_id,path)=>({path,text:'generated',generatedCompatibility:true} as any)},repo,state());expect(wordTotal(counts.snapshot()).unavailable).toBe(2);
  counts.openScene('stable','a.md','live available');expect(formatWordTotal(wordTotal(counts.snapshot()))).toBe('2 words (1 unreadable; partial)');
 });
 it('ignores stale results after manuscript switch and stops after destruction',async()=>{
  const counts=createManuscriptWordCounts(()=>{});const pending=deferred<any>();const reader=core({});reader.readDocument=vi.fn(()=>pending.promise);const old=counts.setManuscript(reader,repo,state());await counts.setManuscript(core({'new.md':'new count'}),{...repo,projectKey:'new'},{scenes:[{path:'new.md'}]});pending.resolve({path:'a.md',text:'old old old'});await old;expect(wordTotal(counts.snapshot()).words).toBe(2);
  const late=counts.setManuscript(reader,repo,state());counts.destroy();await late;expect(reader.readDocument).toHaveBeenCalledTimes(2);
 });
 it('uses the existing Unicode/source convention, never the rendered DOM or frontmatter metadata',async()=>{
  const source='\uFEFF---\r\ntitle: excluded metadata\r\n---\r\n# Café naïve don’t l’été 42 — … 🐈\nПривет мир\n**bold words**\n`code words`\n[link words](https://example.com/path)';
  const counts=createManuscriptWordCounts(()=>{});await counts.setManuscript(core({'a.md':source}),repo,{scenes:[{path:'a.md'}]});expect(wordTotal(counts.snapshot()).words).toBe(wordCount(source));expect(wordCount('— ... # ** 🐈')).toBe(0);expect(wordCount('你好世界')).toBeGreaterThan(1);
 });
});

it('does not call an uninitialized library a zero-word manuscript',async()=>{
 const reader=core({}),counts=createManuscriptWordCounts(()=>{});await counts.setManuscript(reader,repo,{...state(),revision:null});expect(counts.snapshot().index).toBeNull();expect(reader.readDocument).not.toHaveBeenCalled();
});
it('recounts unavailable saved scenes while keeping the unsaved editor authoritative',async()=>{
 const files={'a.md':'old'},reader=core(files),counts=createManuscriptWordCounts(()=>{});await counts.setManuscript(reader,repo,state());expect(wordTotal(counts.snapshot()).unavailable).toBe(1);counts.openScene('stable','a.md','old');counts.changed('live more words');Object.assign(files,{'b.md':'restored two'});await counts.refresh();expect(wordTotal(counts.snapshot())).toEqual({words:5,pending:0,unavailable:0,scenes:2});
});
