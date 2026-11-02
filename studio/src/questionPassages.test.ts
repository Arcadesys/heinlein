// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createQuestionPanel, type QuestionPanelHooks} from './questionPanel';
import type {LocalCore, ProposalReview, QuestionRequest, QuestionStatus} from './localCore';
import type {SelectionQuestionState} from './selectionQuestion';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
const ready: QuestionStatus = {configured:true,model:'synthetic',selectedModel:'synthetic',models:[{slug:'synthetic',displayName:'Synthetic'}],accounts:[{id:'account',label:'Synthetic',signedIn:true,planEnabled:true}],activeAccountId:'account',generation:1,usageLimited:false,signInPending:false,message:'Ready'};
const origin = {kind:'nativeOpenAi' as const,sessionId:'',clientLabel:'',identityAssurance:'unverifiedProviderMetadata' as const,provider:'openai' as const,model:'synthetic',requestId:'request'};
function deferred<T>() {let resolve!: (value:T)=>void; const promise = new Promise<T>(yes=>{resolve=yes;}); return {promise,resolve};}
let panel: ReturnType<typeof createQuestionPanel>; let state: SelectionQuestionState;
const changed = vi.fn(); const focus = vi.fn();
const btn = (name:string) => [...document.querySelectorAll('button')].find(n=>n.textContent===name)!;
const write = (value='Can this sentence feel more immediate?') => {const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Your message"]')!; input.value=value; input.dispatchEvent(new Event('input'));};
const bridge = () => ({available:()=>true,questionStatus:vi.fn(async()=>ready),cancelQuestion:vi.fn(async()=>true),askQuestion:vi.fn(async(r:QuestionRequest)=>({requestId:r.requestId,text:'Advice only',model:'synthetic',incomplete:false})),suggestQuestionRevision:vi.fn(async(r:QuestionRequest)=>({requestId:r.requestId,text:'One possible revision.',model:'synthetic',incomplete:false,proposalId:r.requestId,replacementText:'Rain drummed against the glass roof.'})),rejectProposal:vi.fn(async(_repo:string,id:string)=>({id:'receipt',kind:'reject',status:'rejected',proposalId:id,origin}))});
async function start(core=bridge(), review: NonNullable<QuestionPanelHooks['reviewRevision']>=vi.fn(async()=>{})) {
  panel=createQuestionPanel(core as unknown as LocalCore,{current:()=>({...state,canCapture:!state.busy}),selectionState:()=>state,focusEditor:focus,reviewRevision:review,passages:{changed,select:(from,to)=>{state={...state,from,to};}},prepareRevision:async()=>{}});
  document.body.append(panel.element); panel.openSelection({...state,canCapture:true});
  write(); await vi.waitFor(()=>expect(btn('Ask').disabled).toBe(false)); return core;
}
async function revision() {write();btn('Suggest rewrite').click();await vi.waitFor(()=>expect(btn('Apply…')).toBeDefined());}
const fullApply = () => panel.element.querySelector<HTMLButtonElement>('.question-full-review button.primary');
beforeEach(async()=>{
  vi.stubGlobal('crypto',webcrypto);document.body.replaceChildren();changed.mockClear();focus.mockClear();
  const source='The station clock stopped.\r\nRain tapped the glass roof.\r\nShe waited — alone.';
  const hash=await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  state={repositoryId:'repo',path:'scene.md',sceneId:'scene',documentEpoch:1,revision:0,source,sourceHash:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join(''),from:source.indexOf('Rain'),to:source.indexOf('\r\nShe'),readOnly:false,recoveryPending:false,busy:false,detached:false};
});
afterEach(()=>{panel?.destroy();vi.unstubAllGlobals();});
describe('passage-linked Questions',()=>{
  it('retains background requests and reopens without stealing focus on completion',async()=>{
    const core=bridge();const waiting=deferred<Awaited<ReturnType<typeof core.askQuestion>>>();core.askQuestion.mockImplementation(()=>waiting.promise);await start(core);
    btn('Ask').click();await vi.waitFor(()=>expect(core.askQuestion).toHaveBeenCalledOnce());btn('Collapse').click();expect(core.cancelQuestion).not.toHaveBeenCalled();expect(panel.visible()).toBe(false);
    const writer=document.createElement('button');document.body.append(writer);writer.focus();const request=core.askQuestion.mock.calls[0][0];
    expect(panel.passageItems()[0].label).toBe('Asking…');waiting.resolve({requestId:request.requestId,text:'Advice only',model:'synthetic',incomplete:false});
    await vi.waitFor(()=>expect(panel.passageItems()[0].label).toBe('Answer ready'));expect(document.activeElement).toBe(writer);
    panel.activatePassage(panel.passageItems()[0].id);expect(panel.visible()).toBe(true);expect(panel.element.textContent).toContain('Advice only');
  });
  it('keeps multiple passages and restores the exact original range after caret movement',async()=>{
    await start();await revision();const first=panel.passageItems()[0].id;
    state={...state,from:0,to:10};panel.stateChanged();expect(panel.openSelection({...state,canCapture:true})).toBe(true);write('Another passage');
    expect(panel.passageItems()).toHaveLength(2);panel.activatePassage(first);
    expect(state.source.slice(state.from,state.to)).toBe('Rain tapped the glass roof.');expect(btn('Apply…').disabled).toBe(false);
    expect(panel.element.querySelector('[aria-label="Original passage"]')?.textContent).toBe('Rain tapped the glass roof.');
  });
  it('invalidates source edits even after edit and undo and keeps a stale picker entry',async()=>{
    await start();await revision();state={...state,revision:2};panel.stateChanged();
    expect(panel.passageItems()[0].stale).toBe(true);expect(btn('Apply…').disabled).toBe(true);expect(panel.element.textContent).toContain('Source changed');
  });
  it('cancels and ignores delayed results after a document change',async()=>{
    const core=bridge();const waiting=deferred<Awaited<ReturnType<typeof core.askQuestion>>>();core.askQuestion.mockImplementation(()=>waiting.promise);await start(core);btn('Ask').click();await vi.waitFor(()=>expect(core.askQuestion).toHaveBeenCalled());const request=core.askQuestion.mock.calls[0][0];
    state={...state,path:'other.md'};panel.stateChanged();waiting.resolve({requestId:request.requestId,text:'Late answer',model:'synthetic',incomplete:false});await Promise.resolve();
    expect(core.cancelQuestion).toHaveBeenCalled();expect(panel.passageItems()).toHaveLength(0);expect(panel.element.textContent).not.toContain('Late answer');
  });
  it('distinguishes explicit cancellation from collapse',async()=>{
    const core=bridge();const waiting=deferred<Awaited<ReturnType<typeof core.askQuestion>>>();core.askQuestion.mockImplementation(()=>waiting.promise);await start(core);btn('Ask').click();await vi.waitFor(()=>expect(core.askQuestion).toHaveBeenCalled());btn('Cancel request').click();expect(core.cancelQuestion).toHaveBeenCalledOnce();
  });
  it('dismisses through the existing receipt command',async()=>{const core=await start();await revision();btn('Dismiss').click();await vi.waitFor(()=>expect(core.rejectProposal).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(panel.passageItems()[0].label).toBe('Answer ready'));expect(state.source).toContain('Rain tapped');});
  it('presents whole-scene review in the pane and collapse cancels review only',async()=>{
    const review=vi.fn(async(_id:string,_snapshot:unknown,_guard:()=>string|null,presenter?:(view:ProposalReview)=>Promise<boolean>)=>{await presenter!({id:'review',kind:'apply',proposalId:'proposal',path:'scene.md',baseText:state.source,replacementText:state.source.replace('tapped','drummed'),baseHash:'base',replacementHash:'new',diffHash:'diff',origin} as ProposalReview);});
    const core=await start(bridge(),review);await revision();btn('Apply…').click();await vi.waitFor(()=>expect(fullApply()).not.toBeNull());
    expect(document.querySelector('dialog')).toBeNull();expect(panel.element.querySelector('[aria-label="Original full scene"]')?.textContent).toBe(state.source);
    btn('Collapse').click();await vi.waitFor(()=>expect(fullApply()).toBeNull());expect(core.cancelQuestion).not.toHaveBeenCalled();
  });
  it('goes straight to native confirmation when the whole-scene change is exactly the passage diff shown',async()=>{
    let presented:boolean|undefined;
    const review=vi.fn(async(_id:string,_snapshot:unknown,_guard:()=>string|null,presenter?:(view:ProposalReview)=>Promise<boolean>)=>{presented=await presenter!({id:'review',kind:'apply',proposalId:'proposal',path:'scene.md',baseText:state.source,replacementText:state.source.replace('Rain tapped the glass roof.','Rain drummed against the glass roof.'),baseHash:'base',replacementHash:'new',diffHash:'diff',origin} as ProposalReview);});
    await start(bridge(),review);await revision();btn('Apply…').click();await vi.waitFor(()=>expect(presented).toBe(true));expect(fullApply()).toBeNull();
  });
  it('shows the full comparison on request even when it matches',async()=>{
    const review=vi.fn(async(_id:string,_snapshot:unknown,_guard:()=>string|null,presenter?:(view:ProposalReview)=>Promise<boolean>)=>{await presenter!({id:'review',kind:'apply',proposalId:'proposal',path:'scene.md',baseText:state.source,replacementText:state.source.replace('Rain tapped the glass roof.','Rain drummed against the glass roof.'),baseHash:'base',replacementHash:'new',diffHash:'diff',origin} as ProposalReview);});
    await start(bridge(),review);await revision();btn('Show full scene comparison').click();await vi.waitFor(()=>expect(fullApply()).not.toBeNull());btn('Back').click();await vi.waitFor(()=>expect(fullApply()).toBeNull());
  });
  it('retains drafts per passage and bounds the number of retained passage sessions',async()=>{
    await start();const first=panel.passageItems()[0].id;write('First draft');
    state={...state,from:0,to:3};panel.openSelection({...state,canCapture:true});write('Second draft');
    panel.activatePassage(first);expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Your message"]')!.value).toBe('First draft');
    for(let i=1;i<=6;i++){state={...state,from:i,to:i+2};panel.openSelection({...state,canCapture:true});await Promise.resolve();}
    expect(panel.passageItems().length).toBeLessThanOrEqual(4);
  });
  it('preserves a durable chat binding through collapse without rereading a different thread',async()=>{
    const core=Object.assign(bridge(),{listChatThreads:vi.fn(async()=>[]),createChatThread:vi.fn(async()=>({id:'chat',title:'Synthetic chat'})),readChatThread:vi.fn()});
    await start(core);btn('Ask').click();await vi.waitFor(()=>expect(core.askQuestion).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(panel.passageItems()[0].label).toBe('Answer ready'));
    btn('Collapse').click();panel.open();expect(core.createChatThread).toHaveBeenCalledOnce();expect(core.readChatThread).not.toHaveBeenCalled();expect(panel.element.textContent).toContain('Advice only');
  });

});
