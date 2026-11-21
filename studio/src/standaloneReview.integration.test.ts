// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import {syntheticDraftBridge} from '../tests/standaloneBridge';
import type {LocalCore,ReviewRequest,ReviewResult,QuestionRequest,ProposalReview,ProposalOutcome} from './localCore';
const cryptoModule='node:crypto';
const {webcrypto,createHash}=await import(cryptoModule) as {webcrypto:Crypto;createHash:(algorithm:string)=>{update:(text:string)=>{digest:(encoding:string)=>string}}};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const source='Exact — café 🦊\nA deliberate fragment.\n';
const ready={configured:true,model:'mock-model',message:'Synthetic ready.',accounts:[{id:'account',label:'Writer',signedIn:true,planEnabled:true}],activeAccountId:'account',models:[{slug:'mock-model',displayName:'Mock model'}],selectedModel:'mock-model',signInPending:false,generation:1,usageLimited:false};
let app:ReturnType<typeof mountStudio>|undefined;
const button=(label:string)=>{const b=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>!b.closest('[hidden]')&&(b.getAttribute('aria-label')??b.textContent)===label);if(!b)throw Error(`Missing ${label}`);return b;};
const view=()=>EditorView.findFromDOM(document.querySelector('.cm-content') as HTMLElement)!;
const settle=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const panel=()=>document.querySelector<HTMLElement>('[aria-label="Heinlein Review"]')!;
function type(text:string){view().dispatch({changes:{from:0,to:view().state.doc.length,insert:text}});}
function shortcut(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}));}
function fixture(){
 const draft=syntheticDraftBridge([],undefined,hash);
 const requestReview=vi.fn(async(request:ReviewRequest):Promise<ReviewResult>=>({reviewId:'review-1',requestId:request.requestId,model:'mock-model',schemaVersion:1,scope:request.scope,edits:[]}));
 const askQuestion=vi.fn(async(request:QuestionRequest)=>({requestId:request.requestId,text:'Synthetic advice',model:'mock-model',incomplete:false}));
 const suggestQuestionRevision=vi.fn(async(request:QuestionRequest)=>({requestId:request.requestId,text:'Synthetic revision',model:'mock-model',incomplete:false,proposalId:'proposal-1',replacementText:'Revised passage.'}));
 const core={...draft.core,questionStatus:vi.fn(async()=>ready),askQuestion,suggestQuestionRevision,cancelQuestion:vi.fn(async()=>true),requestReview,
 reviewDefinitions:vi.fn(async()=>[{id:'mechanical',version:1,displayName:'Mechanical review',instructions:'Preserve author choices.'}]),previewReview:vi.fn(async(request:ReviewRequest)=>[{id:'chunk-1',sourceIndex:0,fromUtf8:0,toUtf8:new TextEncoder().encode(request.snapshots[0].source).length,windowFrom:0,windowTo:new TextEncoder().encode(request.snapshots[0].source).length,reviewer:0,status:'queued',requestId:null,error:null}]),
 rejectProposal:vi.fn<NonNullable<LocalCore['rejectProposal']>>(),listReviews:vi.fn(async()=>[]),listProposals:vi.fn(async()=>({pending:[],receipts:[]})),reviewProposal:vi.fn<NonNullable<LocalCore['reviewProposal']>>(),reviewProposalRevert:vi.fn<NonNullable<LocalCore['reviewProposalRevert']>>(),applyProposalReview:vi.fn<NonNullable<LocalCore['applyProposalReview']>>(),cancelProposalReview:vi.fn(async()=>{}),getReview:vi.fn<NonNullable<LocalCore['getReview']>>(),prepareReviewEdit:vi.fn(async()=>({proposalId:'proposal-1'}))} satisfies LocalCore;
 return {draft,core};
}
async function start(f=fixture(),previousProject=false){app=mountStudio(document.body,f.core);await settle();if(previousProject){await app.selectRepository(async()=>({id:'previous-project',name:'Previous project',projectKey:'previous-key',manifests:[]}));await app.showDocument('old-scene.md');shortcut();await settle();}type(source);return f;}
async function runReview(){button('Preview review').click();await vi.waitFor(()=>expect(button('Run review').disabled).toBe(false));button('Run review').click();}
async function openReview(){button('Review draft').click();await vi.waitFor(()=>expect(panel()?.querySelector<HTMLElement>('.review-connection')?.dataset.state).toBe('ready'));}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);localStorage.clear();document.body.replaceChildren();Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'));};});
afterEach(()=>{app?.destroy();app=undefined;vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('standalone draft review identity',()=>{
 it('captures exact draft text with its own identity after leaving a project, sends only on Run review',async()=>{
  const {draft,core}=await start(undefined,true);await openReview();
  expect(core.requestReview).not.toHaveBeenCalled();expect(core.askQuestion).not.toHaveBeenCalled();expect(core.suggestQuestionRevision).not.toHaveBeenCalled();
  expect(draft.calls.some(c=>c.kind==='reviewSession')).toBe(true);expect(panel().textContent).toContain(source);
  await runReview();await vi.waitFor(()=>expect(core.requestReview).toHaveBeenCalledOnce());
  const request=core.requestReview.mock.calls[0][0],record=[...draft.records.values()][0];
  expect(request).toMatchObject({repositoryId:`draft-review:${record.id}`,scope:'scene',snapshots:[{path:'draft.md',source,sourceHash:hash(source),sceneId:`draft-scene:${record.id}`}]});expect(JSON.stringify(request)).not.toContain('previous-project');expect(draft.externalCalls).toEqual([]);
 });
 it('clears an old review panel when creating another draft and uses a different identity',async()=>{
  const {core}=await start();await openReview();await runReview();await vi.waitFor(()=>expect(core.requestReview).toHaveBeenCalledOnce());
  const first=core.requestReview.mock.calls[0][0];shortcut();await settle();expect(view().state.doc.toString()).toBe('');expect(panel().hidden).toBe(true);
  type('Second independent draft');await openReview();expect(panel().textContent).not.toContain(source);await runReview();await vi.waitFor(()=>expect(core.requestReview).toHaveBeenCalledTimes(2));
  const second=core.requestReview.mock.calls[1][0];expect(second.repositoryId).not.toBe(first.repositoryId);expect(second.snapshots[0].source).toBe('Second independent draft');
 });
 it('opens Revisions for the draft rather than the previous project without dispatching a provider',async()=>{
  const {draft,core}=await start(undefined,true);button('Revisions').click();await vi.waitFor(()=>expect(core.listProposals).toHaveBeenCalled());
  expect(core.listProposals.mock.calls.at(-1)).toEqual([`draft-review:${[...draft.records.values()][0].id}`]);expect(core.askQuestion).not.toHaveBeenCalled();expect(core.requestReview).not.toHaveBeenCalled();expect(core.suggestQuestionRevision).not.toHaveBeenCalled();
 });
 it('sends a selected draft revision only after explicit Send to OpenAI',async()=>{
  const {draft,core}=await start(undefined,true);view().dispatch({selection:{anchor:0,head:5}});button('Heinlein').click();await vi.waitFor(()=>expect(core.questionStatus).toHaveBeenCalled());await settle();
  const question=button('Suggest edits').closest('[aria-label="Drafting questions"]')!.querySelector<HTMLTextAreaElement>('[aria-label="Your drafting question"]')!;question.value='Suggest a clearer opening';question.dispatchEvent(new Event('input'));await settle();
  expect(core.suggestQuestionRevision).not.toHaveBeenCalled();expect(core.askQuestion).not.toHaveBeenCalled();expect(button('Suggest edits').disabled).toBe(false);button('Suggest edits').click();await vi.waitFor(()=>expect(core.suggestQuestionRevision).toHaveBeenCalledOnce());
  const args=core.suggestQuestionRevision.mock.calls[0] as unknown as [unknown,unknown,unknown];expect(args[2]).toMatchObject({repositoryId:`draft-review:${[...draft.records.values()][0].id}`,path:'draft.md',sourceHash:hash(source),selectedText:'Exact'});expect(view().state.doc.toString()).toBe(source);expect(core.applyProposalReview).not.toHaveBeenCalled();
 });
 it('keeps draft agents beside a wide writer and re-enables review after keeping edited text',async()=>{
  vi.stubGlobal('innerWidth',2400);
  const bounds=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(()=>new DOMRect(100,0,900,700));
  const f=fixture();
  f.core.requestReview.mockImplementation(async(request:ReviewRequest)=>({reviewId:'review-save',requestId:request.requestId,model:'mock-model',schemaVersion:1,scope:request.scope,edits:[{id:'edit',path:'draft.md',fromUtf8:0,toUtf8:5,original:'Exact',replacement:'Precise',reason:'Synthetic',role:'editor',status:'pending',proposalId:null}]}));
  const {draft}=await start(f);await openReview();
  expect(document.querySelector<HTMLElement>('.conversation-rail-dock')!.hidden).toBe(false);
  expect(document.querySelector('dialog.conversation-rail-dialog[open]')).toBeNull();
  await runReview();await vi.waitFor(()=>expect(panel().querySelector('button[data-edit-action="accept"]')).not.toBeNull());
  type(source+'An added sentence.');
  const accept=()=>panel().querySelector<HTMLButtonElement>('button[data-edit-action="accept"]')!;
  expect(accept().disabled).toBe(true);button('Keep on this Mac').click();
  await vi.waitFor(()=>expect([...draft.records.values()][0].text).toBe(source+'An added sentence.'));
  await vi.waitFor(()=>expect(accept().disabled).toBe(false));
  expect(f.core.applyProposalReview).not.toHaveBeenCalled();
  bounds.mockRestore();
 });
 it('accepts a native revision into only the draft and refreshes through its existing lease',async()=>{
  const f=fixture();const {core,draft}=await start(f,true);button('Keep on this Mac').click();await settle();
  const record=[...draft.records.values()][0],replacement=source.replace('Exact','Revised');
  const origin={kind:'nativeOpenAi' as const,sessionId:'',clientLabel:'',identityAssurance:'unverifiedProviderMetadata' as const,provider:'openai' as const,model:'mock-model',requestId:'synthetic'};
  const proposal:ProposalReview={id:'authority',kind:'apply',proposalId:'proposal-1',path:'draft.md',baseHash:hash(source),replacementHash:hash(replacement),diffHash:'diff',baseText:source,replacementText:replacement,origin,expiresAtMs:Date.now()+300000,parentReceiptId:null};
  core.listProposals.mockResolvedValue({pending:[{id:proposal.proposalId,path:proposal.path,baseHash:proposal.baseHash,replacementHash:proposal.replacementHash,diffHash:proposal.diffHash,origin,createdAtMs:1,baseText:source,replacementText:replacement}],receipts:[]} as never);
  core.reviewProposal.mockResolvedValue(proposal);
  core.applyProposalReview.mockImplementation(async(repositoryId):Promise<ProposalOutcome>=>{
   expect(repositoryId).toBe(`draft-review:${record.id}`);record.text=replacement;record.textHash=hash(replacement);record.revision++;
   core.listProposals.mockResolvedValue({pending:[],receipts:[]});
   return {receipt:{id:'receipt',kind:'apply',status:'completed',proposalId:proposal.proposalId,path:proposal.path,baseHash:proposal.baseHash,replacementHash:proposal.replacementHash,diffHash:proposal.diffHash,origin,parentReceiptId:null,message:null,createdAtMs:1,revertAvailable:true},warning:null};
  });
  const read=vi.spyOn(core,'readDocument'),save=vi.spyOn(core,'saveDocument');
  button('Revisions').click();await vi.waitFor(()=>expect(button('Accept')).toBeDefined());expect(core.applyProposalReview).not.toHaveBeenCalled();button('Accept').click();await vi.waitFor(()=>expect(view().state.doc.toString()).toBe(replacement));
  expect(core.applyProposalReview).toHaveBeenCalledOnce();expect(draft.calls.filter(c=>c.kind==='refresh')).toHaveLength(1);expect(save).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(core.requestReview).not.toHaveBeenCalled();
 });

});
