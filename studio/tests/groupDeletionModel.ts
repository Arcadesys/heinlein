import type {DraftingChange,DraftingState} from '../src/localCore';
import {sheetDeletionModel} from './sheetDeletionModel';

/** Synthetic metadata boundary; production filesystem behavior is checked by Core tests. */
export function groupDeletionModel() {
  const base=sheetDeletionModel();
  let state:DraftingState={manifestPath:'ms/manuscript.json',revision:'g1',project:'Synthetic book',
    groups:[{id:'parent',title:'Parent group'},{id:'target',title:'Draft group'},{id:'nested',title:'Nested group'},{id:'empty',title:'Empty group'}],
    scenes:[{id:'first',title:'First sheet',path:'ms/first.md',groupId:'target'},{id:'second',title:'Second sheet',path:'ms/second.md',groupId:'nested'}],
    referenceSheets:[{id:'outline',title:'Outline',path:'ms/reference/outline.md',groupId:'target',reference:true}],
    library:[{id:'parent',kind:'group',parentId:null},{id:'target',kind:'group',parentId:'parent'},
      {id:'nested',kind:'group',parentId:'target'},{id:'first',kind:'scene',parentId:'target'},
      {id:'second',kind:'scene',parentId:'nested'},{id:'empty',kind:'group',parentId:null}],untrackedPaths:[],missingPaths:[]};
  let pending:Extract<DraftingChange,{kind:'deleteGroup'}>|null=null,undo:DraftingState|null=null;
  const calls={preview:0,apply:0,undo:0};
  base.core.loadDrafting=async()=>structuredClone(state);
  base.core.previewDraftingChange=async(_id,revision,change)=>{
    if(change.kind!=='deleteGroup'||revision!==state.revision)throw Error('Synthetic stale group preview');
    pending=change;calls.preview++;
    return {id:'group-preview',summary:`Delete group “${state.groups.find(g=>g.id===change.groupId)?.title}”`,
      changes:[{kind:'deleteGroup',source:null,destination:null}],
      warnings:['Keeps all sheets and nested groups. They move up one level in the same order. No sheet files are deleted or moved. Undo is available during this session.']};
  };
  base.core.applyDraftingChange=async()=>{
    if(!pending)throw Error('Synthetic group preview missing');calls.apply++;undo=structuredClone(state);
    const id=pending.groupId,parent=state.library!.find(e=>e.id===id)!.parentId;
    state={...state,revision:'g2',groups:state.groups.filter(g=>g.id!==id),
      scenes:state.scenes.map(s=>s.groupId===id?{...s,groupId:parent}:s),referenceSheets:state.referenceSheets?.map(s=>s.groupId===id?{...s,groupId:parent}:s),
      library:state.library!.filter(e=>e.id!==id).map(e=>e.parentId===id?{...e,parentId:parent}:e)};
    pending=null;return {state:structuredClone(state),undoId:'group-undo'};
  };
  base.core.undoDraftingChange=async()=>{if(!undo)throw Error('Synthetic group undo missing');calls.undo++;state=undo;undo=null;return structuredClone(state);};
  return {...base,groupCalls:calls};
}
