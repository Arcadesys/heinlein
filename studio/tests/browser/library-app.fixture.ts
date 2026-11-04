import '../../src/fonts.bundle'; import '../../src/style.css';
import {mountStudio} from '../../src/studio';
import type {DraftingState, LocalCore} from '../../src/localCore';
const session={id:'fixture',name:'Synthetic book',manifests:[]};
const state:DraftingState={manifestPath:'ms/manuscript.json',revision:'r',project:'Synthetic book',groups:[{id:'g',title:'Group'}],scenes:[{id:'s',title:'First sheet',path:'ms/first.md',groupId:'g'},{id:'t',title:'Second sheet',path:'ms/second.md',groupId:'g'}],library:[{id:'g',kind:'group',parentId:null},{id:'s',kind:'scene',parentId:'g'},{id:'t',kind:'scene',parentId:'g'}],untrackedPaths:[],missingPaths:[]};
const doc=(path:string,text='Synthetic opening.')=>({path,text,contentHash:'a'.repeat(64),sizeBytes:text.length,frontmatter:null,generatedCompatibility:false});
const core={available:()=>true,pickRepository:async()=>session,recentRepositories:async()=>[],openRecentRepository:async()=>session,listDirectory:async(_id:string,path:string)=>path===''?[{path:'README.md',name:'README.md',kind:'file',sizeBytes:1},{path:'empty',name:'empty',kind:'directory',sizeBytes:0},{path:'writing',name:'writing',kind:'directory',sizeBytes:0},{path:'output.md',name:'output.md',kind:'file',sizeBytes:1}]:path==='writing'?[{path:'writing/story.md',name:'story.md',kind:'file',sizeBytes:1}]:[],readDocument:async(_id:string,path:string)=>({...doc(path),generatedCompatibility:path==='output.md'}),loadManuscript:async()=>null,saveDocument:async(_id:string,path:string,_hash:string,text:string)=>doc(path,text),readRecovery:async()=>null,stageRecovery:async(_id:string,path:string,baseHash:string,text:string)=>({id:'draft',path,baseHash,text,updatedAt:0}),discardRecovery:async()=>{},setUnsavedChanges:async()=>{},requestClose:async()=>{},onCloseRequested:async()=>()=>{},listSystemFonts:async()=>[],questionStatus:async()=>({configured:true,model:'synthetic',selectedModel:'synthetic',models:[{slug:'synthetic',displayName:'Synthetic'}],accounts:[{id:'account',label:'Synthetic',signedIn:true,planEnabled:true}],activeAccountId:'account',generation:1,usageLimited:false,signInPending:false,message:'Ready'}),reviewDefinitions:async()=>[{id:'contextual',version:1,displayName:'Synthetic',instructions:'Synthetic'}],previewReview:async()=>[],requestReview:async()=>{throw new Error('No provider in fixture');},loadDrafting:async()=>state,previewDraftingChange:async()=>({id:'preview',summary:'Changed',changes:[],warnings:[]}),applyDraftingChange:async()=>({state,undoId:'undo'}),undoDraftingChange:async()=>state} as unknown as LocalCore;
// Isolated reference-sheet flow; no author files or provider requests.
if (new URLSearchParams(location.search).has('references')) {
  state.referenceSheets = [{id:'reference',title:'Outstanding outline',path:'ms/reference/outline.md',groupId:'g',reference:true}];
  let pending: import('../../src/localCore').DraftingChange | null = null;
  core.previewDraftingChange = async (_id, _revision, change) => {
    pending = change; return {id:'preview',summary:'Sheet classification changed',changes:[{kind:'index',source:'ms/manuscript.json',destination:'ms/manuscript.json'}],warnings:[]};
  };
  core.applyDraftingChange = async () => {
    if (pending?.kind === 'setSheetReference') {
      const change = pending;
      let sheet = state.scenes.find(sheet => sheet.path === change.path);
      if (!sheet) {
        sheet = state.referenceSheets!.find(sheet => sheet.path === change.path)!;
        state.scenes.push(sheet); state.referenceSheets = [];
        state.library!.push({id:sheet.id,kind:'scene',parentId:sheet.groupId});
      }
      sheet.reference = pending.reference; state.revision += '-next';
    }
    return {state:structuredClone(state),undoId:'undo'};
  };
}
if (new URLSearchParams(location.search).has('long')) {
  for (let index = 0; index < 80; index++) {
    const id = `long-${index}`;
    state.scenes.push({id,title:`Sheet ${index}`,path:`ms/${id}.md`,groupId:'g'});
    state.library!.push({id,kind:'scene',parentId:'g'});
  }
}
if (new URLSearchParams(location.search).has('export')) {
  const calls: {repositoryId:string;filename:string;text:string}[] = [];
  core.saveMarkdownExport = async (repositoryId,filename,text) => {calls.push({repositoryId,filename,text});return true;};
  (window as any).exportFixture = {calls};
}
if (new URLSearchParams(location.search).has('reviewers')) {
  const key = 'synthetic-review-agents';
  core.listCustomReviewers = async () => JSON.parse(localStorage.getItem(key) ?? '[]');
  core.saveCustomReviewer = async draft => {
    const list = await core.listCustomReviewers!(); const previous = list.find(row => row.id === draft.id);
    const saved = {...draft, id: draft.id || `custom-${crypto.randomUUID()}`, version: previous ? previous.version + 1 : 1};
    localStorage.setItem(key, JSON.stringify([...list.filter(row => row.id !== saved.id), saved]));return saved;
  };
  core.deleteCustomReviewer = async id => {const list = (await core.listCustomReviewers!()).filter(row => row.id !== id);localStorage.setItem(key,JSON.stringify(list));return list;};
}
const app=mountStudio(document.querySelector<HTMLElement>('#app')!,core); void app.selectRepository(async()=>session);
