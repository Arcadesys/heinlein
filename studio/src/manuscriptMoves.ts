import type {DraftingChange,DraftingState,SceneDestination} from './localCore';
export const GROUP_DRAG_TYPE='application/x-heinlein-manuscript-group';
export type MoveSource={kind:'scene'|'group';id:string};
export type MoveTarget={kind:'scene';id:string;side:'before'|'after'}|{kind:'group';id:string;side:'before'|'after'}|{kind:'groupEnd';id:string}|{kind:'ungroupedEnd'}|{kind:'groupEndSlot'};
export function moveIntent(state:DraftingState,source:MoveSource,target:MoveTarget):DraftingChange|null {
 if(source.kind==='group'){
  if(!state.groups.some(g=>g.id===source.id))throw Error('That group is no longer in this manuscript.');
  if(target.kind!=='group'&&target.kind!=='groupEndSlot')throw Error('Choose a group slot for this move.');
  if(target.kind==='group'&&source.id===target.id)return null;
  if(state.groupMoveIssue)throw Error(state.groupMoveIssue);
  const groups=state.groups.filter(g=>g.id!==source.id);let beforeGroupId:string|null=null;
  if(target.kind==='group'){const i=groups.findIndex(g=>g.id===target.id);if(i<0)throw Error('That target group changed.');beforeGroupId=target.side==='before'?target.id:groups[i+1]?.id??null;}
  const next=groups.map(g=>g.id),slot=beforeGroupId?next.indexOf(beforeGroupId):next.length;next.splice(slot,0,source.id);
  if(next.join('|')===state.groups.map(g=>g.id).join('|'))return null;
  return{kind:'reorderGroup',groupId:source.id,beforeGroupId};
 }
 const scene=state.scenes.find(s=>s.id===source.id);if(!scene)throw Error('That scene is no longer in this manuscript.');
 let destination:SceneDestination;
 if(target.kind==='scene'){
  if(target.id===source.id)return null;
  const to=state.scenes.find(s=>s.id===target.id);if(!to)throw Error('That target scene changed.');
  destination={kind:target.side,sceneId:to.id,groupId:to.groupId};
 }else if(target.kind==='groupEnd'){
  if(!state.groups.some(g=>g.id===target.id))throw Error('That group changed.');
  const members=state.scenes.filter(s=>s.groupId===target.id);if(members.length===1&&members[0].id===source.id)return null;
  if(!members.length&&state.groupMoveIssue)throw Error(state.groupMoveIssue);
  destination={kind:'groupEnd',groupId:target.id};
 }else if(target.kind==='ungroupedEnd'){
  if(state.scenes.at(-1)?.id===source.id&&scene.groupId===null)return null;
  destination={kind:'ungroupedEnd'};
 }else throw Error('Choose a scene position or a destination group.');
 return{kind:'placeScene',sceneId:source.id,destination};
}
export function moveTargetLabel(state:DraftingState,target:MoveTarget):string {
 if(target.kind==='scene'){const s=state.scenes.find(s=>s.id===target.id);return`${target.side} “${s?.title??'scene'}” (${state.groups.find(g=>g.id===s?.groupId)?.title??'No chapter'})`;}
 if(target.kind==='group')return`${target.side} group “${state.groups.find(g=>g.id===target.id)?.title??'group'}”`;
 if(target.kind==='groupEnd')return`at the end of “${state.groups.find(g=>g.id===target.id)?.title??'group'}”`;
 return target.kind==='groupEndSlot'?'after the other groups; ungrouped writing stays put':'at the end of the manuscript, without a group';
}
