import {syntheticMove,syntheticGroupIssue} from './manuscriptMoveModel';
// Synthetic projects for production-renderer tests. No real files/accounts/network.
import type {LocalCore,RepositorySession,Document,RecoveryDraft,DraftingState,DraftingChange} from '../src/localCore';
import type {Project,ProjectRequest,ProjectResponse} from '../src/projects';
import type {StandaloneDraft} from '../src/standaloneDrafts';
import {syntheticDraftBridge} from './standaloneBridge';
export type ProjectSeed={projects:Project[];documents:Record<string,Record<string,string>>;drafts:StandaloneDraft[];unknownWorkspaces?:string[];manuscripts?:Record<string,DraftingState>};
export function syntheticProjects(seed?:ProjectSeed,persist?:(state:ProjectSeed)=>void){
 const copy=<T>(v:T):T=>structuredClone(v);
 const projects:Project[]=copy(seed?.projects??[
  {id:'local-a',name:'Novel A',revision:1,kind:'local',workspaceId:null,resume:null,unavailable:null,github:null},
  {id:'local-b',name:'Essay collection',revision:1,kind:'local',workspaceId:null,resume:null,unavailable:null,github:null},
  {id:'github-a',name:'Novel B',revision:1,kind:'managed',workspaceId:'workspace-a',resume:null,unavailable:null,github:{owner:'example',repository:'novel-b',accountId:9,branch:'story/novel-b'}},
  {id:'github-b',name:'Novel C',revision:1,kind:'managed',workspaceId:'workspace-b',resume:null,unavailable:null,github:{owner:'another-author',repository:'novel-c',accountId:19,branch:'revision/novel-c'}},
 ]);
 const documents=copy(seed?.documents??Object.fromEntries(projects.map(p=>[p.id,{'scene.md':`# ${p.name}\r\nExact — e\u0301 🦊 writing.\nEnding.\r\n`}]))) as Record<string,Record<string,string>>;
 const manuscripts:Record<string,DraftingState>=copy(seed?.manuscripts??{});
 const draftingCalls:string[]=[];const draftingPlans=new Map<string,{session:string;project:string;epoch:number;revision:string|null;change:DraftingChange;plannedState?:DraftingState;sourceHashes:Record<string,string>}>();let failDrafting=false;
 const emptyManuscript=(p:Project):DraftingState=>({manifestPath:'ms/manuscript.json',revision:null,project:p.name,groups:[],scenes:[],untrackedPaths:['scene.md'],missingPaths:[],recoveryRequired:false});
 const unknownWorkspaces=new Set(seed?.unknownWorkspaces??[]);
 const requests:ProjectRequest[]=[],externalCalls:string[]=[],githubCalls:string[]=[];
 const recovery=new Map<string,RecoveryDraft>(),sessions=new Map<string,string>();
 let serial=0,active:string|null=null,dirty=false,epoch=0;
 const plans=new Map<string,{project:Project;origin:string|null;epoch:number}>();
 let failSave=false,failTarget:string|null=null,holdPreview:((resolve:()=>void)=>void)|null=null;
 const draft=syntheticDraftBridge(seed?.drafts,()=>save());
 const state=():ProjectSeed=>({projects:copy(projects),documents:copy(documents),drafts:copy([...draft.records.values()]),unknownWorkspaces:[...unknownWorkspaces],manuscripts:copy(manuscripts)});
 function save(){persist?.(state());}
 function project(id:string){const p=projects.find(p=>p.id===id);if(!p)throw Error('Unknown synthetic project');return p;}
 function selected(id:string){if(id!==active)throw Error('Synthetic project session changed');return project(sessions.get(id)!);}
 const hash=(text:string)=>{let h=2166136261;for(const c of text)h=Math.imul(h^c.codePointAt(0)!,16777619);return `synthetic-hash-${(h>>>0).toString(16)}-${text.length}`;};
 function doc(p:Project,path:string):Document{const text=documents[p.id]?.[path];if(text===undefined)throw Error('Synthetic document missing');return{path,text,contentHash:hash(text),sizeBytes:new TextEncoder().encode(text).length,frontmatter:null,generatedCompatibility:false};}
 function session(p:Project):RepositorySession{const id=`project-session-${++serial}`;sessions.set(id,p.id);active=id;const h=p.resume;const resume=h&&documents[p.id]?.[h.path]!==undefined&&hash(documents[p.id][h.path])===h.sourceHash?h:null;return{id,name:p.name,projectKey:`source-key-${p.id}`,projectId:p.id,projectRevision:p.revision,githubWorkspaceId:p.workspaceId,manifests:[],resume:copy(resume),warning:h&&!resume?'The last document changed. Open it from Writing.':null};}
 const core:LocalCore={...draft.core,
  async projectRequest(r:ProjectRequest):Promise<ProjectResponse>{requests.push(copy(r));switch(r.action){
   case'list':return copy(projects);
   case'settings':return{...copy(project(r.id)),writingLocation:`/Synthetic/${project(r.id).kind==='local'?'Writing':'Managed copies'}/${r.id}`};
   case'rename':{const p=project(r.id);if(p.revision!==r.revision)throw Error('Project settings changed');if(!r.name.trim())throw Error('Enter a project name');p.name=r.name.trim();p.revision++;save();return copy(p);}
   case'saveResume':{const p=selected(r.repositoryId);if(dirty||p.id!==r.projectId||p.revision!==r.revision||doc(p,r.resume.path).contentHash!==r.resume.sourceHash)throw Error('Writing or project metadata changed');p.resume=copy(r.resume);p.revision++;save();return copy(p);}
   case'previewOpen':{const p=project(r.id);if(p.unavailable||failTarget===r.id)throw Error('Synthetic target unavailable; current writing retained');if(dirty)throw Error('Keep current writing first');const id=`project-plan-${++serial}`;plans.set(id,{project:copy(p),origin:active,epoch});if(holdPreview){const hold=holdPreview;holdPreview=null;await new Promise<void>(resolve=>hold(resolve));}return{id};}
   case'cancel':plans.delete(r.previewId);return null;
   case'activate':{const p=plans.get(r.previewId);plans.delete(r.previewId);if(!p||p.origin!==active||p.epoch!==epoch||dirty||p.project.revision!==project(p.project.id).revision)throw Error('Project switch became stale');return session(project(p.project.id));}
  }},
  pickRepository:async()=>session(project('local-a')),
  recentRepositories:async()=>[],openRecentRepository:async()=>{throw Error('Use the project library');},
  listDirectory:async(id,path)=>{const p=selected(id);if(path)return[];return Object.entries(documents[p.id]).map(([path,text])=>({path,name:path,kind:'file' as const,sizeBytes:new TextEncoder().encode(text).length}));},
  readDocument:async(id,path)=>doc(selected(id),path),
  saveDocument:async(id,path,expected,text)=>{const p=selected(id);if(failSave)throw Error('Synthetic disk is full; writing retained');if(doc(p,path).contentHash!==expected)throw Error('Synthetic source changed');documents[p.id][path]=text;save();return doc(p,path);},
  loadDrafting:async id=>{const p=selected(id);return copy(manuscripts[p.id]??emptyManuscript(p));},
  previewDraftingChange:async(id,revision,change)=>{const p=selected(id),m=manuscripts[p.id]??emptyManuscript(p);draftingCalls.push('preview');if(dirty||m.revision!==revision||failDrafting)throw Error('Synthetic manuscript changed or unavailable');if(change.kind==='createScene'&&(!change.path.startsWith('ms/')||change.path.includes('..')||documents[p.id][change.path]!==undefined||change.groupId&&!m.groups.some(g=>g.id===change.groupId)))throw Error('Scene destination unavailable');if(!['createScene','createGroup','initialize','reorderGroup','placeScene'].includes(change.kind))throw Error('Unsupported synthetic manuscript action');const token=`structure-${++serial}`,plannedState=change.kind==='reorderGroup'||change.kind==='placeScene'?syntheticMove(m,change):undefined;draftingPlans.set(token,{session:id,project:p.id,epoch,revision,change:copy(change),plannedState,sourceHashes:Object.fromEntries(Object.entries(documents[p.id]).map(([path,text])=>[path,hash(text)]))});if(plannedState)return{id:token,summary:change.kind==='reorderGroup'?'Move the group and all its scenes':'Move scene with destination membership',changes:JSON.stringify([m.groups,m.scenes])===JSON.stringify([plannedState.groups,plannedState.scenes])?[]:[{kind:'reading order',source:'ms/manuscript.json',destination:'ms/manuscript.json'}],warnings:[`Reading order after move: ${plannedState.scenes.map(s=>s.title).join(' → ')}`,`Group slots: ${plannedState.groups.map(g=>g.title).join(' → ')}`]};return{id:token,summary:change.kind==='createGroup'?`Add chapter “${change.title}”`:change.kind==='createScene'?`Add empty scene “${change.title}”`:'Create manuscript',changes:[{kind:change.kind,source:null,destination:change.kind==='createScene'?change.path:'ms/manuscript.json'}],warnings:[]};},
  applyDraftingChange:async(id,token)=>{const plan=draftingPlans.get(token);draftingPlans.delete(token);const p=selected(id),m=manuscripts[p.id]??emptyManuscript(p);draftingCalls.push('apply');if(!plan||plan.session!==id||plan.project!==p.id||plan.epoch!==epoch||dirty||plan.revision!==m.revision||failDrafting)throw Error('Synthetic stale manuscript change refused');if(Object.entries(plan.sourceHashes).some(([path,expected])=>hash(documents[p.id][path])!==expected))throw Error('Synthetic source changed since preview');const c=plan.change;if(plan.plannedState){plan.plannedState.revision=`manifest-${++serial}`;manuscripts[p.id]=plan.plannedState;save();return{state:copy(plan.plannedState),undoId:null};}if(c.kind==='initialize'){m.project=c.project;}else if(c.kind==='createGroup')m.groups.push({id:`chapter-${++serial}`,title:c.title});else if(c.kind==='createScene'){if(documents[p.id][c.path]!==undefined)throw Error('No overwrite');documents[p.id][c.path]='';m.scenes.push({id:`scene-${++serial}`,title:c.title,path:c.path,groupId:c.groupId??null});}m.groupMoveIssue=syntheticGroupIssue(m);m.revision=`manifest-${++serial}`;manuscripts[p.id]=m;save();return{state:copy(m),undoId:null};},
  undoDraftingChange:async()=>{throw Error('Synthetic undo is not available');},
  readRecovery:async(id,path)=>copy(recovery.get(`${selected(id).id}:${path}`)??null),
  stageRecovery:async(id,path,baseHash,text)=>{const key=`${selected(id).id}:${path}`,d={id:`recovery-${++serial}`,path,baseHash,text,updatedAt:1};recovery.set(key,d);return copy(d);},
  discardRecovery:async(id,path,receipt)=>{const key=`${selected(id).id}:${path}`;if(recovery.get(key)?.id!==receipt)throw Error('Recovery changed');recovery.delete(key);},
  setUnsavedChanges:async v=>{dirty=v;if(v)epoch++;},
  requestClose:async()=>{if(dirty)throw Error('Keep writing first');},
  githubRequest:async r=>{githubCalls.push(r.action);if(r.action==='localProjects')return[];if(r.action==='localProject'){const p=selected(r.repositoryId);if(p.workspaceId&&unknownWorkspaces.has(p.workspaceId))throw Error('Previous Send outcome is unknown; use explicit reconciliation in this project');return p.workspaceId?{workspaceId:p.workspaceId,branch:p.github!.branch,uncommitted:true,unsentVersion:true,lastSendRecorded:false}:null;}externalCalls.push(`GitHub:${r.action}`);throw Error('Synthetic preview is offline. No GitHub connection or remote action was attempted.');},
  askQuestion:async()=>{externalCalls.push('provider');throw Error('No synthetic provider authority');},
 };
 return{core,projects,documents,draft,requests,externalCalls,githubCalls,state,manuscripts,draftingCalls,seedMovement(){const p=project('local-a');const groups=[{id:'group-opening',title:'Opening'},{id:'group-middle',title:'Middle'},{id:'group-empty',title:'Empty chapter'},{id:'group-ending',title:'Ending'}];const scenes=[{id:'scene-lead',title:'Prelude',path:'ms/prelude.md',groupId:null},{id:'scene-arrival',title:'Arrival',path:'ms/arrival.md',groupId:'group-opening'},{id:'scene-meeting',title:'Meeting',path:'ms/meeting.md',groupId:'group-opening'},{id:'scene-bridge',title:'Bridge',path:'ms/bridge.md',groupId:'group-middle'},{id:'scene-finale',title:'Finale',path:'ms/finale.md',groupId:'group-ending'},{id:'scene-tail',title:'Afterword',path:'ms/afterword.md',groupId:null}];for(const scene of scenes)documents[p.id][scene.path]=`${scene.title} — e\u0301 🦊\r\nExact source.\n`;manuscripts[p.id]={...emptyManuscript(p),revision:'movement-initial',groups,scenes,groupMoveIssue:null};save();},seedManuscript(id:string){const p=project(id);manuscripts[id]={...emptyManuscript(p),revision:'manifest-initial'};save();},setFailDrafting(value:boolean){failDrafting=value;},setUnknownSend(workspaceId:string){unknownWorkspaces.add(workspaceId);save();},get active(){return active;},setFailSave(value:boolean){failSave=value;},setFailTarget(id:string|null){failTarget=id;},holdPreview(fn:(resolve:()=>void)=>void){holdPreview=fn;},doc,hash};
}
