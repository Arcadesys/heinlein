// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {StateEffect} from '@codemirror/state';
import {undo,redo} from '@codemirror/commands';
import {assembleChapter,type AssembledChapter} from './assembledChapter';
import {editChapter,chapterEditExtension,createChapterWriter} from './chapterEditing';
import {createEditor} from './editor';
import type {Chapter,Document,LocalCore} from './localCore';
const chapter:Chapter={number:9,title:'Chapter 9',path:'',source:'chapter.md',scenes:[{path:'one.md'},{path:'two.md'}]};
const doc=(path:string,text:string):Document=>({path,text,contentHash:`hash:${text}`,sizeBytes:new TextEncoder().encode(text).length,frontmatter:null,generatedCompatibility:false});
const first='---\r\ntitle: First\r\n---\r\nSame 🦊—punch.\r\nOther line.\n';
const second='Same 🦊—punch.\n';
const initial=()=>assembleChapter(chapter,[doc('one.md',first),doc('two.md',second)]);
let view:ReturnType<typeof createEditor>|undefined;afterEach(()=>{view?.destroy();view=undefined;document.body.replaceChildren();});
it('joins sheets with --- while editing exact source bytes, preserving frontmatter and protected style',()=>{
 const before=initial();expect(before.text).toContain('\n\n---\n\n');
 const at=before.parts[1].from;const after=editChapter(before,[{from:at,to:at+4,insert:'Different'}]);
 expect(after.parts[0].document.text).toBe(first);expect(after.parts[1].document.text).toBe('Different 🦊—punch.\n');
 const a=editChapter(before,[{from:0,to:4,insert:'Clear'}]);expect(a.parts[0].document.text).toBe(first.replace('Same','Clear'));expect(a.parts[1].document.text).toBe(second);
 expect(()=>editChapter(before,[{from:before.parts[0].to,to:before.parts[1].from,insert:''}])).toThrow('breaks');
});
it('undo and redo restore exact per-sheet bytes and reject boundary deletion in the actual editor',()=>{
 let projection:AssembledChapter=initial();const notice=vi.fn();const host=document.createElement('div');document.body.append(host);
 view=createEditor(host,projection.text,()=>{},()=>{});view.view.dispatch({effects:StateEffect.appendConfig.of(chapterEditExtension(projection,p=>projection=p,notice))});
 view.view.dispatch({changes:{from:0,to:4,insert:'New\nparagraph'}});expect(projection.parts[0].document.text).toContain('New\r\nparagraph');
 expect(undo(view.view)).toBe(true);expect(projection.parts[0].document.text).toBe(first);expect(projection.parts[1].document.text).toBe(second);expect(redo(view.view)).toBe(true);
 const before=view.view.state.doc.toString();view.view.dispatch({changes:{from:projection.parts[0].to,to:projection.parts[1].from,insert:''}});expect(view.view.state.doc.toString()).toBe(before);
});
function bridge(){const disk=new Map(initial().parts.map(p=>[p.document.path,p.document]));const drafts=new Map<string,any>();const events:string[]=[];
 const core={readDocument:vi.fn(async(_r:string,path:string)=>disk.get(path)!),stageRecovery:vi.fn(async(_r:string,path:string,baseHash:string,text:string)=>{events.push(`stage:${path}`);const draft={id:`draft-${path}`,path,baseHash,text,updatedAt:0};drafts.set(path,draft);return draft;}),discardRecovery:vi.fn(async(_r:string,path:string)=>{drafts.delete(path);}),saveDocument:vi.fn(async(_r:string,path:string,baseHash:string,text:string)=>{events.push(`save:${path}`);expect(disk.get(path)!.contentHash).toBe(baseHash);const next=doc(path,text);disk.set(path,next);return next;})};return {core:core as unknown as LocalCore,mock:core,disk,drafts,events};}
function edited(){const before=initial();return editChapter(before,[{from:0,to:4,insert:'First'},{from:before.parts[1].from,to:before.parts[1].from+4,insert:'Second'}]);}
it('stages all changed sheets before guarded saves, and persists the original source paths only',async()=>{
 const f=bridge(),writer=createChapterWriter(f.core,'repo',initial());writer.changed(edited());expect(await writer.save()).toBe(true);
 expect(f.events.slice(0,4)).toEqual(['stage:one.md','stage:two.md','save:one.md','save:two.md']);expect(f.disk.get('one.md')!.text).toBe(first.replace('Same','First'));expect(f.disk.get('two.md')!.text).toBe(second.replace('Same','Second'));expect(writer.dirty()).toBe(false);expect(f.drafts.size).toBe(0);
});
it('preflights every sheet before writing and retains recovery on an external conflict',async()=>{
 const f=bridge(),writer=createChapterWriter(f.core,'repo',initial());writer.changed(edited());f.disk.set('two.md',doc('two.md','External change.'));
 await expect(writer.save()).rejects.toThrow('changed on disk');expect(f.mock.saveDocument).not.toHaveBeenCalled();expect(f.drafts.size).toBe(2);expect(writer.dirty()).toBe(true);
});
it('retains unsaved sheets after a partial failure and retries without overwriting already saved sheets',async()=>{
 const f=bridge(),writer=createChapterWriter(f.core,'repo',initial());writer.changed(edited());const save=f.mock.saveDocument.getMockImplementation()!;
 f.mock.saveDocument.mockImplementation(async(r,p,h,t)=>{if(p==='two.md')throw Error('Disk full');return save(r,p,h,t);});await expect(writer.save()).rejects.toThrow('Disk full');expect(f.disk.get('one.md')!.text).toContain('First');expect(f.disk.get('two.md')!.text).toBe(second);expect(writer.view().parts[1].document.text).toContain('Second');
 f.mock.saveDocument.mockImplementation(save);expect(await writer.save()).toBe(true);expect(f.disk.get('two.md')!.text).toContain('Second');
});
it('preserves newer typing during an in-flight save and stages it against the new hash',async()=>{
 const f=bridge(),writer=createChapterWriter(f.core,'repo',initial());let finish!:(value:Document)=>void;let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);const save=f.mock.saveDocument.getMockImplementation()!;
 f.mock.saveDocument.mockImplementationOnce(async(r,p,h,t)=>{const saved=await save(r,p,h,t);started();return new Promise(resolve=>finish=()=>resolve(saved));});
 const a=editChapter(initial(),[{from:0,to:4,insert:'Old'}]);writer.changed(a);const pending=writer.save();await ready;writer.changed(editChapter(a,[{from:0,to:3,insert:'Newest'}]));finish(f.disk.get('one.md')!);expect(await pending).toBe(false);expect(f.drafts.get('one.md').text).toContain('Newest');expect(f.drafts.get('one.md').baseHash).toBe(f.disk.get('one.md')!.contentHash);expect(await writer.save()).toBe(true);expect(f.disk.get('one.md')!.text).toContain('Newest');
});
it('clears obsolete recovery when all edits are undone before leaving',async()=>{
 const f=bridge(),writer=createChapterWriter(f.core,'repo',initial());writer.changed(edited());await writer.stage();writer.changed(initial());await writer.stage();expect(f.drafts.size).toBe(0);expect(f.mock.saveDocument).not.toHaveBeenCalled();
});
it('reports exact successful saves before cleanup errors, never newer typing or failed sheets',async()=>{
 const f=bridge(),saved=vi.fn(),writer=createChapterWriter(f.core,'repo',initial(),saved);writer.changed(edited());
 f.mock.discardRecovery.mockRejectedValueOnce(Error('Cleanup failed'));await expect(writer.save()).rejects.toThrow('Cleanup failed');expect(saved).toHaveBeenCalledOnce();expect(saved.mock.calls[0][0]).toEqual(f.disk.get('one.md'));
 const before=writer.view(),next=editChapter(before,[{from:0,to:5,insert:'Newer unsaved'}]);writer.changed(next);expect(saved.mock.calls[0][0].text).not.toContain('Newer unsaved');
});
