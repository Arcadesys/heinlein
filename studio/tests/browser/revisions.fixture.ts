import '../../src/fonts.bundle';
import '../../src/style.css';
import {mountStudio} from '../../src/studio';
import type {LocalCore, ProposalReceipt, ProposalReview, ReviewResult} from '../../src/localCore';

// Invented prose, memory-only state, and simulated confirmation. No user files,
// native credential store, or provider calls participate in this browser fixture.
const baseline = '# Rain\n\nRain tapped the window. A fox waited — quietly.\n';
let text = baseline, external = 'pending';
const session = {id:'fixture',name:'Synthetic book',manifests:[]};
const origin = {kind:'localMcp' as const,sessionId:'fixture',clientLabel:'Synthetic external agent',identityAssurance:'unverifiedLocalProcess' as const};
const native = {kind:'nativeOpenAi' as const,sessionId:'',clientLabel:'',identityAssurance:'unverifiedProviderMetadata' as const,provider:'openai' as const,model:'synthetic',requestId:'fixture',review:{reviewId:'saved',findingId:'finding',fingerprint:'fixture',competing:[]}};
const saved: ReviewResult = {schemaVersion:2,reviewId:'saved',requestId:'fixture',scope:'scene',model:'synthetic',edits:[{id:'finding',path:'scene.md',fromUtf8:37,toUtf8:43,original:'waited',replacement:'lingered',reason:'Let the pause carry more weight.',role:'editor',status:'pending',proposalId:null}]};
const receipts: ProposalReceipt[] = [{id:'historical',kind:'apply',proposalId:'old',path:'earlier.md',origin,baseHash:'old',replacementHash:'new',diffHash:'diff',baseText:'She walked home.\n',replacementText:'She hurried home.\n',status:'completed',message:null,parentReceiptId:null,createdAtMs:1,revertAvailable:false}];
let exact:ProposalReview|null=null;
const calls:string[]=[];
const doc=(path:string,source=text)=>({path,text:source,contentHash:source,sizeBytes:source.length,frontmatter:null,generatedCompatibility:false});
const core = {
  available:()=>true,pickRepository:async()=>session,recentRepositories:async()=>[],openRecentRepository:async()=>session,
  listDirectory:async()=>[],loadManuscript:async()=>null,readDocument:async(_repo:string,path:string)=>doc(path),
  saveDocument:async(_repo:string,path:string,_hash:string,source:string)=>{text=source;return doc(path);},
  readRecovery:async()=>null,stageRecovery:async(_repo:string,path:string,baseHash:string,source:string)=>({id:'draft',path,baseHash,text:source,updatedAt:0}),discardRecovery:async()=>{},
  setUnsavedChanges:async()=>{},requestClose:async()=>{},onCloseRequested:async()=>()=>{},listSystemFonts:async()=>[],
  listReviews:async()=>structuredClone([saved]),
  listProposals:async()=>({pending:external==='pending'?[{id:'external',path:'scene.md',baseHash:text,replacementHash:'after',diffHash:'diff',origin,createdAtMs:2,baseText:text,replacementText:text.replace('tapped','drummed')}]:[],receipts:structuredClone(receipts)}),
  prepareReviewEdit:async()=>{calls.push('prepare');return {proposalId:'native'};},
  reviewProposal:async(_repo:string,id:string)=>{
    calls.push(`review:${id}`);
    exact={id:'exact',kind:'apply',proposalId:id,path:'scene.md',baseText:text,replacementText:id==='external'?text.replace('tapped','drummed'):text.replace('waited','lingered'),baseHash:text,replacementHash:'after',diffHash:'exact-diff',origin:id==='external'?origin:native,expiresAtMs:Date.now()+300000,parentReceiptId:null};
    return structuredClone(exact);
  },
  applyProposalReview:async()=>{
    calls.push('accept');
    if(!exact||exact.baseText!==text)throw new Error('Source changed');
    text=exact.replacementText;
    if(exact.proposalId==='external')external='applied';else saved.edits[0].status='accepted';
    const receipt:ProposalReceipt={...exact,id:`receipt-${receipts.length}`,status:'completed',message:null,createdAtMs:Date.now(),revertAvailable:false};
    receipts.unshift(receipt);return {receipt,warning:null};
  },
  reviewProposalRevert:async()=>{throw new Error('No live revert in synthetic fixture');},cancelProposalReview:async()=>{exact=null;},
  rejectReviewEdit:async()=>{calls.push('keep-in-app');saved.edits[0].status='rejected';return structuredClone(saved);},
  rejectProposal:async()=>{calls.push('keep-external');external='kept';const receipt:ProposalReceipt={...receipts[0],id:'reject',proposalId:'external',kind:'reject',status:'rejected',path:'scene.md',baseText:text,replacementText:text.replace('tapped','drummed')};receipts.unshift(receipt);return receipt;},
} as unknown as LocalCore;
const app=mountStudio(document.querySelector('#app')!,core);
await app.selectRepository(async()=>session);await app.showDocument('scene.md');
(window as any).revisionsFixture={get text(){return text;},baseline,calls};
