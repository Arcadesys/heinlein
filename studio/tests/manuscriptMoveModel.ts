// Mock-native model for production-renderer fixtures; real planner tested in Rust.
import type {DraftingState,DraftingChange} from '../src/localCore';
export function syntheticGroupIssue(m:DraftingState):string|null {
 for(const g of m.groups){const at=m.scenes.flatMap((s,i)=>s.groupId===g.id?[i]:[]);if(at.length&&at.at(-1)!-at[0]+1!==at.length)return`“${g.title}” has interleaved members. Use Move scene; nothing was normalized.`;}
 const seen=m.scenes.filter((s,i,a)=>s.groupId!==null&&(i===0||a[i-1].groupId!==s.groupId)).map(s=>s.groupId);
 const wanted=m.groups.filter(g=>m.scenes.some(s=>s.groupId===g.id)).map(g=>g.id);
 return seen.join('|')===wanted.join('|')?null:'Group order and reading order differ. Use Move scene.';
}
export function syntheticMove(m:DraftingState,change:DraftingChange):DraftingState {
 const next=structuredClone(m),anchor=(id:string)=>{if(syntheticGroupIssue(next))throw Error(syntheticGroupIssue(next)!);const i=next.groups.findIndex(g=>g.id===id);if(i<0)throw Error('Unknown group');return next.groups.slice(i+1).flatMap(g=>next.scenes.filter(s=>s.groupId===g.id)).at(0)?.id??null;};
 const insert=(scene:DraftingState['scenes'][number],before:string|null)=>{const at=before===null?next.scenes.length:next.scenes.findIndex(s=>s.id===before);if(at<0)throw Error('Unknown scene anchor');next.scenes.splice(at,0,scene);};
 if(change.kind==='reorderGroup'){
  const from=next.groups.findIndex(g=>g.id===change.groupId);if(from<0)throw Error('Unknown group');if(change.beforeGroupId===change.groupId)return next;
  const group=next.groups.splice(from,1)[0],to=change.beforeGroupId===null?next.groups.length:next.groups.findIndex(g=>g.id===change.beforeGroupId);if(to<0)throw Error('Unknown group target');next.groups.splice(to,0,group);
  if(next.groups.map(g=>g.id).join('|')===m.groups.map(g=>g.id).join('|'))return next;
  if(syntheticGroupIssue(m))throw Error(syntheticGroupIssue(m)!);
  const moved=next.scenes.filter(s=>s.groupId===group.id);next.scenes=next.scenes.filter(s=>s.groupId!==group.id);const before=anchor(group.id);for(const scene of moved)insert(scene,before);
 }else if(change.kind==='placeScene'){
  const from=next.scenes.findIndex(s=>s.id===change.sceneId);if(from<0)throw Error('Unknown source scene');const scene=next.scenes[from],d=change.destination;let before:string|null=null;
  if(d.kind==='before'||d.kind==='after'){
   const target=next.scenes.find(s=>s.id===d.sceneId);if(!target||target.groupId!==d.groupId)throw Error('Scene target or membership changed');if(target.id===scene.id)return next;next.scenes.splice(from,1);const i=next.scenes.findIndex(s=>s.id===target.id);before=d.kind==='before'?target.id:next.scenes[i+1]?.id??null;scene.groupId=d.groupId;
  }else if(d.kind==='groupEnd'){
   if(!next.groups.some(g=>g.id===d.groupId))throw Error('Unknown destination group');const members=next.scenes.filter(s=>s.groupId===d.groupId);if(members.length===1&&members[0].id===scene.id)return next;if(!members.length&&syntheticGroupIssue(m))throw Error(syntheticGroupIssue(m)!);next.scenes.splice(from,1);before=members.length?next.scenes[next.scenes.map(s=>s.groupId).lastIndexOf(d.groupId)+1]?.id??null:anchor(d.groupId);scene.groupId=d.groupId;
  }else{next.scenes.splice(from,1);scene.groupId=null;}
  insert(scene,before);
 }else throw Error('Unsupported synthetic movement');
 next.groupMoveIssue=syntheticGroupIssue(next);return next;
}
