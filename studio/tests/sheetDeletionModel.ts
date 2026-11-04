import type {DraftingChange, DraftingState, LocalCore, RecoveryDraft} from '../src/localCore';

/** Synthetic renderer boundary only; Core tests exercise actual filesystem deletion. */
export function sheetDeletionModel() {
  const session = {id:'synthetic-deletion',name:'Synthetic book',manifests:[]};
  const original: DraftingState = {manifestPath:'ms/manuscript.json',revision:'r1',project:'Synthetic book',groups:[],
    scenes:[{id:'first',title:'First sheet',path:'ms/first.md',groupId:null},{id:'second',title:'Second sheet',path:'ms/second.md',groupId:null}],
    referenceSheets:[{id:'outline',title:'Outline',path:'ms/reference/outline.md',groupId:null,reference:true}],
    library:[{id:'first',kind:'scene',parentId:null},{id:'second',kind:'scene',parentId:null}],untrackedPaths:[],missingPaths:[]};
  let state = structuredClone(original), pending: Extract<DraftingChange,{kind:'deleteSheet'}> | null = null;
  let recovery: RecoveryDraft | null = null;
  let undo: {state:DraftingState;path:string;text:string} | null = null;
  const files = new Map([['ms/first.md','First—é 🐾.\r\nExact first sheet.'],['ms/second.md','Second sheet—keep exact.'],['ms/reference/outline.md','Synthetic reference notes.']]);
  const calls = {preview:0,apply:0,undo:0,save:0};
  function document(path:string) {
    const text=files.get(path); if(text===undefined)throw Error('Synthetic file missing');
    return {path,text,contentHash:`hash:${text}`,sizeBytes:new TextEncoder().encode(text).length,frontmatter:null,generatedCompatibility:false};
  }
  const core:LocalCore = {
    available:()=>true,pickRepository:async()=>session,recentRepositories:async()=>[],openRecentRepository:async()=>session,
    listDirectory:async()=>[],listSystemFonts:async()=>[],loadManuscript:async()=>{throw Error('No synthetic legacy manuscript');},readDocument:async(_id,path)=>document(path),
    saveDocument:async(_id,path,hash,text)=>{if(hash!==document(path).contentHash)throw Error('Synthetic source changed');calls.save++;files.set(path,text);return document(path);},
    readRecovery:async(_id,path)=>recovery?.path===path?recovery:null,
    stageRecovery:async(_id,path,baseHash,text)=>recovery={id:'synthetic-recovery',path,baseHash,text,updatedAt:0},
    discardRecovery:async()=>{recovery=null;},setUnsavedChanges:async()=>{},requestClose:async()=>{},onCloseRequested:async()=>()=>{},
    loadDrafting:async()=>structuredClone(state),
    previewDraftingChange:async(_id,revision,change)=>{
      if(change.kind!=='deleteSheet'||revision!==state.revision)throw Error('Synthetic stale preview');
      pending=change;calls.preview++;
      return {id:'delete-preview',summary:`Delete sheet “${[...state.scenes,...state.referenceSheets??[]].find(s=>s.path===change.path)?.title}”`,
        changes:[{kind:'deleteSheet',source:change.path,destination:null}],
        warnings:['Deletes this sheet’s Markdown file from this Mac and removes it from the library. Undo is available during this session. Links to this sheet are not rewritten.']};
    },
    applyDraftingChange:async()=>{
      if(!pending)throw Error('Synthetic preview missing');calls.apply++;
      const path=pending.path;undo={state:structuredClone(state),path,text:document(path).text};files.delete(path);
      const sheet=state.scenes.find(s=>s.path===path);
      state={...state,revision:'r2',scenes:state.scenes.filter(s=>s.path!==path),referenceSheets:state.referenceSheets?.filter(s=>s.path!==path),library:state.library?.filter(e=>e.id!==sheet?.id)};
      pending=null;return {state:structuredClone(state),undoId:'delete-undo'};
    },
    undoDraftingChange:async()=>{if(!undo||files.has(undo.path))throw Error('Synthetic undo conflict');calls.undo++;files.set(undo.path,undo.text);state=undo.state;undo=null;return structuredClone(state);},
  };
  return {core,session,files,calls};
}
