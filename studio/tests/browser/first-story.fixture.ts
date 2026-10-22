// Synthetic browser-only host. Never imported by production. No files/providers.
import {mountStudio} from '../../src/studio';
import {emptyFirstStory, invalidateFirstStory, type FirstStoryState} from '../../src/firstStory';
import type {LocalCore, DraftingState, RecoveryDraft} from '../../src/localCore';
import '../../src/fonts.bundle';import '../../src/style.css';
const key = 'heinlein-first-story-synthetic-fixture';
const session = {id:'synthetic-first-story',name:'Synthetic story folder',projectKey:'synthetic-only',manifests:[]};
let text = 'Synthetic scene — exact author words.\n\nTHE END.\n'; let revision = 'saved-1';let recovery: RecoveryDraft | null = null;let dirty = false;
let closeRequest=()=>{};let quitRefused=(message:string)=>{void message;};
const records = {previews:0, confirmations:0, reviews:0, quits:0, cancellations:0};
Object.assign(window,{quitFixture:{close:()=>closeRequest(),refuse:()=>quitRefused("Synthetic new save needs attention.")}});Object.assign(window,{firstStoryFixtureRecords:records});
const drafting: DraftingState = {manifestPath:'ms/manuscript.json',revision:'manifest',project:'Synthetic story',groups:[],scenes:[{id:'first',title:'Opening',path:'ms/z.md',groupId:null}],untrackedPaths:[],missingPaths:[],recoveryRequired:false};
function load(): FirstStoryState {const saved = JSON.parse(localStorage.getItem(key) ?? 'null') ?? emptyFirstStory();if (saved.sourceRevision !== revision || dirty) {invalidateFirstStory(saved);saved.sourceRevision = dirty ? null : revision;}return saved;}
const unavailable = async (): Promise<never> => {throw new Error('Synthetic fixture: no filesystem, provider, account or native OS authority.');};
const core: LocalCore = {
  available:()=>true,pickRepository:async()=>session,recentRepositories:async()=>[],openRecentRepository:unavailable,listDirectory:async()=>[],loadManuscript:unavailable,listSystemFonts:async()=>[],
  readDocument:async(_id,path)=>({path,text,contentHash:revision,sizeBytes:text.length,frontmatter:null,generatedCompatibility:false}),
  saveDocument:async(_id,path,_hash,source)=>{text=source;revision+='-saved';return {path,text,contentHash:revision,sizeBytes:text.length,frontmatter:null,generatedCompatibility:false};},
  readRecovery:async()=>recovery,stageRecovery:async(_id,path,baseHash,source)=>recovery={id:'recovery',path,baseHash,text:source,updatedAt:1},discardRecovery:async()=>{recovery=null;},
  setUnsavedChanges:async value=>{dirty=value;},requestClose:async()=>{records.quits++;},finishQuitRequest:async()=>{records.cancellations++;},onQuitRefused:async callback=>{quitRefused=callback;return ()=>{};},onCloseRequested:async callback=>{closeRequest=callback;return ()=>{};},loadDrafting:async()=>drafting,
  loadFirstStory:async()=>load(),saveFirstStory:async(_id,state,proof)=>{const saved=structuredClone(state);saved.revision=String(Date.now());saved.sourceRevision=dirty?null:revision;if(proof){if(dirty||recovery)throw new Error('Save and resolve recovery first.');saved.proofRevision=revision;saved.steps[4]='done';}localStorage.setItem(key,JSON.stringify(saved));return saved;},
  resetFirstStory:async()=>{if(!window.confirm('Synthetic native reset confirmation. No manuscript files exist.'))return null;const state={...emptyFirstStory(),enabled:true};localStorage.setItem(key,JSON.stringify(state));return state;},
  previewPublishingCopy:async(_id,metadata)=>{if(dirty||recovery)throw new Error('Save and resolve recovery first.');if(!metadata.title||!metadata.author||!metadata.rights||!metadata.freePlayApproved||!metadata.noCoverApproved)throw new Error('Supply metadata and approve imprint/no-cover choices.');records.previews++;return {destination:'Synthetic selected parent / '+metadata.folderName,preview:{id:'synthetic-plan',sourceRevision:revision,manifestRevision:'manifest',sources:[{id:'first',title:'Opening',path:'ms/z.md',contentHash:revision,sizeBytes:text.length}],manuscript:text,config:JSON.stringify(metadata),treatment:'Synthetic preview — no filesystem access. In production this is an exact, ordered, one-way copy; no overwrite or reverse sync.',folderName:metadata.folderName}};},
  confirmPublishingCopy:async()=>{records.confirmations++;return window.confirm('Synthetic native creation confirmation. No files will be written.');},
};
const app=mountStudio(document.querySelector<HTMLElement>('#app')!,core);
const params=new URLSearchParams(location.search);
const ready=params.has('draft')?app.selectRepository(async()=>session).then(()=>app.showDocument('ms/z.md')):Promise.resolve();
if(params.has('guide'))void ready.then(()=>document.querySelector<HTMLButtonElement>('.first-story-entry')?.click());
