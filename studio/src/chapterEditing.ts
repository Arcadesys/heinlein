import {StateEffect,StateField,EditorState,type Extension,type Transaction} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {invertedEffects} from '@codemirror/commands';
import {assembleChapter,type AssembledChapter} from './assembledChapter';
import {applyRawChanges} from './editor';
import type {LocalCore,RecoveryDraft} from './localCore';
export interface ChapterChange {from:number;to:number;insert:string}
export function editChapter(before:AssembledChapter,changes:ChapterChange[]):AssembledChapter {
  const perScene=new Map<string,ChapterChange[]>();
  for(const change of changes){
    const part=before.parts.find(p=>change.from>=p.from&&change.to<=p.to);
    if(!part)throw Error('The --- breaks separate source sheets. Edit within a sheet; use Library actions to change sheet structure.');
    const list=perScene.get(part.document.path)??[];
    list.push({from:part.bodyFrom+change.from-part.from,to:part.bodyFrom+change.to-part.from,insert:change.insert});perScene.set(part.document.path,list);
  }
  return assembleChapter(before.chapter,before.parts.map(part=>({...part.document,text:perScene.has(part.document.path)?applyRawChanges(part.document.text,perScene.get(part.document.path)!):part.document.text})));
}
export function chapterEditExtension(initial:AssembledChapter,changed:(chapter:AssembledChapter)=>void,notice:(message:string)=>void):Extension {
  const restore=StateEffect.define<AssembledChapter>();
  const edits=(tr:Transaction)=>{const changes:ChapterChange[]=[];tr.changes.iterChanges((from,to,_a,_b,insert)=>changes.push({from,to,insert:insert.toString()}));return changes;};
  const field=StateField.define<AssembledChapter>({create:()=>initial,update:(before,tr)=>{
    const snapshot=tr.effects.find(e=>e.is(restore));
    if(snapshot?.is(restore)&&snapshot.value.text===tr.newDoc.toString())return snapshot.value;
    return tr.docChanged?editChapter(before,edits(tr)):before;
  }});
  return [field,EditorState.transactionFilter.of(tr=>{
    if(!tr.docChanged)return tr;
    const snapshot=tr.effects.find(e=>e.is(restore));if(snapshot?.is(restore)&&snapshot.value.text===tr.newDoc.toString())return tr;
    try{const after=editChapter(tr.startState.field(field),edits(tr));if(after.text!==tr.newDoc.toString())throw Error('This edit changes a protected sheet boundary.');return tr;}
    catch(error){queueMicrotask(()=>notice(error instanceof Error?error.message:String(error)));return [];}
  }),invertedEffects.of(tr=>tr.docChanged?[restore.of(tr.startState.field(field))]:[]),EditorView.updateListener.of(update=>{if(update.docChanged)changed(update.state.field(field));})];
}
/** Per-sheet optimistic writes, with every changed sheet staged before any manuscript write. */
export function createChapterWriter(core:LocalCore,repositoryId:string,initial:AssembledChapter) {
  const baseline=new Map(initial.parts.map(p=>[p.document.path,p.document]));
  const drafts=new Map<string,RecoveryDraft>();let current=initial;let queue=Promise.resolve();
  const pending=()=>current.parts.filter(p=>p.document.text!==baseline.get(p.document.path)?.text);
  const run=<T>(work:()=>Promise<T>)=>{const result=queue.then(work);queue=result.then(()=>{},()=>{});return result;};
  async function stage(){for(const part of pending()){const base=baseline.get(part.document.path)!;drafts.set(base.path,await core.stageRecovery(repositoryId,base.path,base.contentHash,part.document.text));}
    for(const [path,draft] of drafts)if(!pending().some(p=>p.document.path===path)){await core.discardRecovery(repositoryId,path,draft.id);drafts.delete(path);}
  }
  return {
    changed(value:AssembledChapter){current=value;},
    view(){return assembleChapter(current.chapter,current.parts.map(p=>({...p.document,contentHash:baseline.get(p.document.path)!.contentHash})));},
    dirty:()=>pending().length>0,
    stage:()=>run(stage),
    save:()=>run(async()=>{
      await stage();const snapshots=pending().map(p=>({...p.document}));
      for(const doc of snapshots){const disk=await core.readDocument(repositoryId,doc.path);if(disk.contentHash!==baseline.get(doc.path)!.contentHash)throw Error(`The source sheet changed on disk: ${doc.path}. The chapter buffer and recovery drafts are retained.`);}
      for(const doc of snapshots){const saved=await core.saveDocument(repositoryId,doc.path,baseline.get(doc.path)!.contentHash,doc.text);baseline.set(doc.path,saved);const draft=drafts.get(doc.path);if(draft){await core.discardRecovery(repositoryId,doc.path,draft.id);drafts.delete(doc.path);}}
      // Edits made during a save get a recovery draft against the new disk hashes.
      await stage();return pending().length===0;
    }),
    discard:()=>run(async()=>{for(const [path,draft] of drafts){await core.discardRecovery(repositoryId,path,draft.id);drafts.delete(path);}}),
  };
}
