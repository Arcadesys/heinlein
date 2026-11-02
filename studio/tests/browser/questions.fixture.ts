import '../../src/fonts.bundle';
import '../../src/style.css';
import {EditorView} from '@codemirror/view';
import {mountStudio} from '../../src/studio';
import type {LocalCore, ProposalReview, QuestionRequest, QuestionRevisionAnswer} from '../../src/localCore';
const session = {id:'fixture',name:'capture-project',manifests:[]};
let source = '# The Last Train\n\nThe station clock stopped at midnight.\n\nMara crossed the empty platform.\nRain tapped the glass roof.\n\nShe waited by the final carriage.\n';
const original = source; const path = 'sample-scene.md';
const hash = async(text:string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const documentFor = async()=>({path,text:source,contentHash:await hash(source),sizeBytes:new TextEncoder().encode(source).length,frontmatter:null,generatedCompatibility:false});
const origin = {kind:'nativeOpenAi' as const,sessionId:'',clientLabel:'',identityAssurance:'unverifiedProviderMetadata' as const,provider:'openai' as const,model:'synthetic',requestId:'synthetic'};
let request: QuestionRequest | null = null, finish: ((answer:QuestionRevisionAnswer)=>void) | null = null;
let proposal: ProposalReview | null = null; let applied = 0, canceled = 0, rejected = 0, sent = 0, reviewed = 0;
const core = {
  available:()=>true,pickRepository:async()=>session,recentRepositories:async()=>[],listDirectory:async()=>[{path,name:path,kind:'file',sizeBytes:source.length}],readDocument:documentFor,loadManuscript:async()=>null,
  saveDocument:async(_repo:string,_path:string,_hash:string,text:string)=>{source=text;return documentFor();},loadDrafting:async()=>null,readRecovery:async()=>null,stageRecovery:async(_repo:string,_path:string,baseHash:string,text:string)=>({id:'recovery',path,baseHash,text,updatedAt:0}),discardRecovery:async()=>{},setUnsavedChanges:async()=>{},requestClose:async()=>{},onCloseRequested:async()=>()=>{},listSystemFonts:async()=>[],
  questionStatus:async()=>({configured:true,model:'synthetic',selectedModel:'synthetic',models:[{slug:'synthetic',displayName:'Synthetic'}],accounts:[{id:'account',label:'Synthetic',signedIn:true,planEnabled:true}],activeAccountId:'account',generation:1,usageLimited:false,signInPending:false,message:'Ready'}),
  askQuestion:async(r:QuestionRequest)=>{sent++;request=r;return new Promise<QuestionRevisionAnswer>(resolve=>{finish=resolve;});},
  suggestQuestionRevision:async(r:QuestionRequest)=>{sent++;request=r;return new Promise<QuestionRevisionAnswer>(resolve=>{finish=resolve;});},
  cancelQuestion:async()=>{canceled++;return true;},
  listProposals:async()=>({pending:[],receipts:[]}),
  reviewProposal:async()=>{reviewed++;if(!proposal)throw new Error('No proposal');return proposal;},
  reviewProposalRevert:async()=>{throw new Error('No revert');},
  cancelProposalReview:async()=>{},
  applyProposalReview:async()=>{applied++;source=proposal!.replacementText;return {receipt:{id:'apply-receipt',kind:'apply',status:'completed',proposalId:proposal!.proposalId,path,baseHash:proposal!.baseHash,replacementHash:proposal!.replacementHash,diffHash:proposal!.diffHash,origin,parentReceiptId:null,message:null,createdAtMs:Date.now(),revertAvailable:false},warning:null};},
  rejectProposal:async(_repo:string,proposalId:string)=>{rejected++;return {id:'reject-receipt',kind:'reject',status:'rejected',proposalId,path,origin};},
} as unknown as LocalCore;
// Synthetic Appearance preferences match the supplied dark, high-contrast reference.
localStorage.setItem('heinlein-studio-appearance-v1', JSON.stringify({theme:'contrast',accent:'gold',width:'wide',leading:'airy',fade:false,focus:false}));
localStorage.setItem('heinlein-studio-fonts-v1', JSON.stringify({text:'JetBrains Mono'}));
const app = mountStudio(document.querySelector<HTMLElement>('#app')!,core);
const ready = app.selectRepository(async()=>session).then(()=>app.showDocument(path));
Object.assign(window,{questionsFixture:{
  ready,
  select(text='Rain tapped the glass roof.') {const view=EditorView.findFromDOM(document.querySelector('.cm-content')!)!;const from=view.state.doc.toString().indexOf(text);view.dispatch({selection:{anchor:from,head:from+text.length},scrollIntoView:true});view.focus();},
  async finish() {if(!request||!finish)throw new Error('No pending request');const replacement='Rain drummed against the glass roof.';proposal={id:'native-review',kind:'apply',proposalId:request.requestId,path,baseHash:await hash(source),replacementHash:await hash(source.replace('Rain tapped the glass roof.',replacement)),diffHash:'synthetic-diff',baseText:source,replacementText:source.replace('Rain tapped the glass roof.',replacement),origin,expiresAtMs:Date.now()+300000,parentReceiptId:null};finish({requestId:request.requestId,text:'One possible revision, ready for your review.',model:'synthetic',incomplete:false,proposalId:request.requestId,replacementText:replacement});finish=null;},
  state:()=>({source,original,applied,canceled,rejected,sent,reviewed}),
}});
