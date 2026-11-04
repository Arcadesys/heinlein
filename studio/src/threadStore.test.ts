// @vitest-environment jsdom
import {beforeEach,expect,it,vi,afterEach} from 'vitest';
import {readThreads,putThread,setThreadStatus,matchesThread,sceneThreadScope,groupThreadScope,scopeForReview,type WriterThread} from './threadStore';
import type {DraftingState,ReviewResult} from './localCore';
beforeEach(()=>localStorage.clear());afterEach(()=>vi.restoreAllMocks());
const state:DraftingState={manifestPath:'ms/index.json',revision:'r',project:'Book',groups:[{id:'nine',title:'Chapter 9'},{id:'ten',title:'Chapter 10'},{id:'nested',title:'Nested group'}],scenes:[{id:'a',path:'a.md',title:'First scene',groupId:'nine'},{id:'b',path:'b.md',title:'Second scene',groupId:'nested'},{id:'c',path:'c.md',title:'Other scene',groupId:'ten'}],library:[{id:'nine',kind:'group',parentId:null},{id:'nested',kind:'group',parentId:'nine'},{id:'ten',kind:'group',parentId:null},{id:'a',kind:'scene',parentId:'nine'},{id:'b',kind:'scene',parentId:'nested'},{id:'c',kind:'scene',parentId:'ten'}],missingPaths:[],untrackedPaths:[]};
const thread=(id:string,scope=sceneThreadScope('a.md',state)):WriterThread=>({id,kind:'conversation',title:`Discussion ${id}`,scope,status:'open',updatedAt:1,storageKey:`saved-${id}`});
it('aggregates chapter and descendant scene threads, excluding other chapters and project chat',()=>{
 const nine=groupThreadScope('nine',state);expect(nine.scenePaths).toEqual(['b.md','a.md']);
 const rows=[thread('a'),thread('b',sceneThreadScope('b.md',state)),{...thread('review',nine),kind:'review' as const,reviewId:'r'},thread('c',sceneThreadScope('c.md',state)),thread('project',{kind:'project',id:'project',label:'Project'})];
 expect(rows.filter(t=>matchesThread(t,nine)).map(t=>t.id)).toEqual(['a','b','review']);
 expect(rows.filter(t=>matchesThread(t,sceneThreadScope('a.md',state))).map(t=>t.id)).toEqual(['a']);
});
it('follows stable scene identity through renames and current hierarchy after moves',()=>{
 const row=thread('a');const moved=structuredClone(state);moved.scenes[0].path='renamed.md';moved.scenes[0].groupId='ten';moved.library!.find(e=>e.id==='a')!.parentId='ten';
 expect(matchesThread(row,sceneThreadScope('renamed.md',moved))).toBe(true);expect(matchesThread(row,groupThreadScope('ten',moved))).toBe(true);expect(matchesThread(row,groupThreadScope('nine',moved))).toBe(false);
});
it('keeps local open/resolved states and project isolation across reload',()=>{
 putThread('book',thread('a'));setThreadStatus('book','a','resolved');expect(readThreads('book')[0].status).toBe('resolved');expect(readThreads('other')).toEqual([]);setThreadStatus('book','a','open');expect(readThreads('book')[0].status).toBe('open');
});
it('does not overwrite corrupt indexes or the previous index after a failed write',()=>{
 putThread('book',thread('a'));const key=localStorage.key(0)!;const before=localStorage.getItem(key);vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('Quota');});expect(()=>putThread('book',thread('b'))).toThrow();expect(localStorage.getItem(key)).toBe(before);vi.restoreAllMocks();localStorage.setItem(key,'broken');expect(()=>putThread('book',thread('b'))).toThrow();expect(localStorage.getItem(key)).toBe('broken');
});
it('review ownership excludes read-only context and uses the smallest containing section',()=>{
 const record={scope:'chapter',edits:[],workflow:{sources:[{path:'a.md',readOnly:false},{path:'b.md',readOnly:false},{path:'c.md',readOnly:true}]}} as unknown as ReviewResult;
 expect(scopeForReview(record,state,null)).toMatchObject({id:'nine',label:'Chapter 9',scenePaths:['a.md','b.md']});
 record.scope='scene';record.workflow!.sources=record.workflow!.sources.slice(0,1);expect(scopeForReview(record,state,null)).toMatchObject({kind:'scene',id:'a'});
});

it('keeps chapter discussions with their section while aggregating nested-section discussions',()=>{
 const nested=thread('nested-review',groupThreadScope('nested',state));expect(matchesThread(nested,groupThreadScope('nine',state))).toBe(true);
 const chapter=thread('chapter-nine',groupThreadScope('nine',state));const moved=structuredClone(state);for(const entry of moved.library!)if(entry.parentId==='nine')entry.parentId='ten';
 expect(matchesThread(chapter,groupThreadScope('ten',moved))).toBe(false);
});
