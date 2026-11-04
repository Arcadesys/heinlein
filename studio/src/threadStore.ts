import type {Chapter, DraftingState, Manuscript, ReviewResult} from './localCore';
export interface ThreadScope {
  kind:'project'|'scene'|'chapter'; id:string; label:string; path?:string; sceneId?:string;
  scenePaths?:string[]; sceneIds?:string[]; chapterIds?:string[];
}
export interface WriterThread {
  id:string; kind:'conversation'|'review'; title:string; scope:ThreadScope;
  status:'open'|'resolved'; updatedAt:number; storageKey?:string; accountId?:string; model?:string; reviewId?:string;
}
const prefix='heinlein.threads.v1:';
const key=(project:string)=>prefix+JSON.stringify(project);
export function readThreads(project:string):WriterThread[] {
  const raw=localStorage.getItem(key(project));if(!raw)return [];
  if(new TextEncoder().encode(raw).length>2_000_000)throw Error('Thread index exceeds its local limit.');
  const list:WriterThread[]=JSON.parse(raw);
  if(!Array.isArray(list)||list.length>2000||list.some(t=>!t||typeof t.id!=='string'||!['conversation','review'].includes(t.kind)||!['open','resolved'].includes(t.status)||typeof t.title!=='string'||!Number.isSafeInteger(t.updatedAt)||!t.scope||!['scene','chapter','project'].includes(t.scope.kind)||typeof t.scope.id!=='string'||typeof t.scope.label!=='string'||(t.kind==='conversation'&&typeof t.storageKey!=='string')))throw Error('Saved thread index is unreadable. It has not been overwritten.');
  if(new Set(list.map(t=>t.id)).size!==list.length||list.some(t=>
    [t.id,t.title,t.scope.id,t.scope.label].some(value=>value.length>4096)||
    [t.scope.path,t.scope.sceneId,t.storageKey,t.accountId,t.model,t.reviewId].some(value=>value!==undefined&&(typeof value!=='string'||value.length>8192))||
    [t.scope.scenePaths,t.scope.sceneIds,t.scope.chapterIds].some(value=>value!==undefined&&(!Array.isArray(value)||value.length>500||value.some(item=>typeof item!=='string'||item.length>4096)))))throw Error('Saved thread index is unreadable. It has not been overwritten.');
  return list;
}
export function putThread(project:string,thread:WriterThread) {
  const list=readThreads(project);const index=list.findIndex(t=>t.id===thread.id);
  if(index<0)list.push(thread);else list[index]=thread;
  const raw=JSON.stringify(list);if(list.length>2000||new TextEncoder().encode(raw).length>2_000_000)throw Error('Thread index is full. Existing threads are retained.');
  localStorage.setItem(key(project),raw);
}
export function setThreadStatus(project:string,id:string,status:WriterThread['status']) {const thread=readThreads(project).find(t=>t.id===id);if(thread)putThread(project,{...thread,status});}
export function matchesThread(thread:WriterThread,scope:ThreadScope) {
  if(scope.kind==='project')return true;
  const own=thread.scope;
  if(own.kind===scope.kind&&own.id===scope.id)return true;
  if(scope.kind==='scene')return own.kind==='scene'&&((own.sceneId&&scope.sceneId)?own.sceneId===scope.sceneId:own.path===scope.path);
  if(own.kind==='scene')return own.sceneId&&scope.sceneIds?scope.sceneIds.includes(own.sceneId):Boolean(own.path&&scope.scenePaths?.includes(own.path));
  return own.kind==='chapter'&&Boolean(scope.chapterIds?.includes(own.id));
}
export function sceneThreadScope(path:string,state:DraftingState|null):ThreadScope {
  const scene=state?.scenes.find(s=>s.path===path);
  return {kind:'scene',id:scene?.id??path,label:scene?.title||path,path,sceneId:scene?.id};
}
export function groupThreadScope(id:string,state:DraftingState):ThreadScope {
  const descendants=new Set([id]);let changed=true;
  while(changed){changed=false;for(const entry of state.library??[])if(entry.kind==='group'&&entry.parentId&&descendants.has(entry.parentId)&&!descendants.has(entry.id)){descendants.add(entry.id);changed=true;}}
  const scenes:DraftingState['scenes']=[];
  if(state.library?.length){const seen=new Set<string>();const walk=(parent:string)=>{if(seen.has(parent))return;seen.add(parent);for(const entry of state.library!)if(entry.parentId===parent){if(entry.kind==='group')walk(entry.id);else{const scene=state.scenes.find(s=>s.id===entry.id);if(scene)scenes.push(scene);}}};walk(id);}
  else scenes.push(...state.scenes.filter(s=>s.groupId&&descendants.has(s.groupId)));
  return {kind:'chapter',id,label:state.groups.find(g=>g.id===id)?.title??id,scenePaths:scenes.map(s=>s.path),sceneIds:scenes.map(s=>s.id),chapterIds:[...descendants]};
}
export function chapterThreadScope(chapter:Chapter):ThreadScope {return {kind:'chapter',id:chapter.source,label:chapter.title,path:chapter.source,scenePaths:chapter.scenes.map(s=>s.path),chapterIds:[chapter.source]};}
export function scopeForReview(record:ReviewResult,state:DraftingState|null,book:Manuscript|null):ThreadScope {
  const paths=record.workflow?.sources.filter(s=>!s.readOnly).map(s=>s.path)??[...new Set(record.edits.map(e=>e.path))];
  if(record.scope==='scene'&&paths.length===1)return sceneThreadScope(paths[0],state);
  if(paths.length){
    const groups=(state?.groups??[]).map(g=>groupThreadScope(g.id,state!));
    const chapters=(book?.volumes.flatMap(v=>v.chapters)??[]).map(chapterThreadScope);
    const candidates=[...groups,...chapters].filter(scope=>paths.every(path=>scope.scenePaths?.includes(path))).sort((a,b)=>(a.scenePaths?.length??0)-(b.scenePaths?.length??0));
    if(candidates[0])return {...candidates[0],scenePaths:paths};
  }
  return {kind:'project',id:'project',label:'Project review',scenePaths:paths};
}

export function removeThread(project:string,id:string){const list=readThreads(project).filter(t=>t.id!==id);localStorage.setItem(key(project),JSON.stringify(list));}
