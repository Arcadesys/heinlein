// @vitest-environment jsdom
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createProposalPanel} from './proposalPanel';
import {collectRevisions} from './revisions';
import type {LocalCore, ProposalReceipt, ProposalReview, ReviewResult} from './localCore';

const origin = {kind: 'localMcp' as const, sessionId: 'external-session', clientLabel: 'External agent', identityAssurance: 'unverifiedLocalProcess' as const};
const nativeOrigin = {kind:'nativeOpenAi' as const,sessionId:'',clientLabel:'',identityAssurance:'unverifiedProviderMetadata' as const,provider:'openai' as const,model:'test',requestId:'request',review:{reviewId:'saved',findingId:'finding',fingerprint:'fingerprint',competing:[]}};
const view: ProposalReview = {id:'exact-review', kind:'apply', proposalId:'external', path:'scene.md', baseHash:'current-base', replacementHash:'current-after', diffHash:'current-diff',
  baseText:'Rain tapped — 🦊.\r\n', replacementText:'Rain drummed — 🦊.\r\n', origin, expiresAtMs:Date.now()+300000, parentReceiptId:null};
const proposal = {...view, id:'external', createdAtMs:1};
const edit = {id:'finding', path:'scene.md', fromUtf8:5, toUtf8:11, original:'tapped', replacement:'pattered', reason:'A different rhythm.', role:'editor' as const, status:'pending' as const, proposalId:null};
const saved: ReviewResult = {reviewId:'saved',requestId:'old-request',model:'test',schemaVersion:2,scope:'scene',edits:[edit]};
const receipt: ProposalReceipt = {id:'receipt',kind:'apply',proposalId:'previous',path:'earlier.md',baseHash:'before',replacementHash:'after',diffHash:'diff',origin,parentReceiptId:null,status:'completed',message:null,createdAtMs:1,revertAvailable:false,
  baseText:'Old <script>literal</script> words.\r\n',replacementText:'New <script>literal</script> words.\r\n'};
const tick = async () => {await new Promise(resolve => setTimeout(resolve, 0));};
const button = (name:string) => [...document.querySelectorAll('button')].find(node=>node.textContent === name)!;
function setup(openReview?: (reviewId: string, path: string) => void) {
  const core = {
    listProposals:vi.fn(async()=>({pending:[proposal],receipts:[receipt]})),listReviews:vi.fn(async()=>[saved]),
    reviewProposal:vi.fn(async(_repo:string,id:string):Promise<ProposalReview>=>({...view,proposalId:id,origin:id==='prepared'?nativeOrigin:origin})),reviewProposalRevert:vi.fn(async()=>view),
    applyProposalReview:vi.fn(async()=>({receipt:{...receipt,path:'scene.md'},warning:null})),cancelProposalReview:vi.fn(async()=>{}),
    prepareReviewEdit:vi.fn(async()=>({proposalId:'prepared'})),chooseReviewEdit:vi.fn(async()=>saved),
    rejectReviewEdit:vi.fn(async()=>({...saved,edits:[{...edit,status:'rejected' as const}]})),
    rejectProposal:vi.fn(async()=>({...receipt,kind:'reject' as const,status:'rejected' as const,proposalId:'external'})),
  };
  const changed = vi.fn(async()=>{}), report = vi.fn();
  const panel = createProposalPanel(core as unknown as LocalCore,{root:document.body,repository:()=>({id:'repo',name:'Book',manifests:[]}),run:async action=>{await action();},changed,report,openReview});
  return {core,panel,changed,report};
}
beforeEach(()=>document.body.replaceChildren());
describe('one revisions list',()=>{
  it('puts Refresh above a loading error and retries without touching the manuscript',async()=>{
    const {core,panel,changed}=setup();
    core.listProposals.mockRejectedValueOnce(new Error('Specific storage error'));
    await panel.open();
    const dialog=document.querySelector('[aria-label="Revisions"]')!;
    expect(dialog.querySelector('h2 + .revision-toolbar button')?.textContent).toBe('Refresh');
    expect(dialog.textContent).toContain('Use Refresh above');
    expect(dialog.querySelector('details pre')?.textContent).toBe('Error: Specific storage error');
    button('Refresh').click();await tick();
    expect(core.listProposals).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('.revision-entry')).toHaveLength(3);
    expect(core.applyProposalReview).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();panel.destroy();
  });
  it('keeps stale, already-present, and duplicate records in history without reviving decisions',()=>{
    const fresh={...proposal,id:'fresh',createdAtMs:5};
    const old={...proposal,id:'old',createdAtMs:1};
    const stale={...proposal,id:'stale',baseHash:'old-base',unavailable:'This proposed passage also changed; reconcile the overlapping edits first'};
    const present={...proposal,id:'present',unavailable:'These changes are already present in the current scene'};
    const rows=collectRevisions({pending:[old,stale,present,fresh],receipts:[]},[{...saved,edits:[{...edit,sourceStale:true}]}]);
    expect(rows.filter(row=>row.status==='pending').map(row=>row.id)).toEqual(['fresh']);
    expect(rows.find(row=>row.id==='old')?.status).toBe('superseded');
    expect(rows.find(row=>row.id==='stale')?.status).toBe('outdated');
    expect(rows.find(row=>row.id==='present')?.status).toBe('satisfied');
    expect(rows.find(row=>row.review)?.status).toBe('outdated');
    expect(old.createdAtMs).toBe(1); // Classification never edits the records.
  });
  it('shows external, in-app, and historical before/after diffs with filters and literal text',async()=>{
    const {core,panel}=setup(); await panel.open();
    expect(document.querySelectorAll('.revision-entry')).toHaveLength(3);
    expect(document.querySelectorAll('.question-diff-remove')).toHaveLength(3);
    expect(document.querySelectorAll('.question-diff-add')).toHaveLength(3);
    expect(document.querySelectorAll('del.question-diff-remove')).toHaveLength(3);
    expect(document.querySelectorAll('ins.question-diff-add')).toHaveLength(3);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('.proposal-receipt')?.textContent).toContain('<script>literal</script>');
    expect(core.prepareReviewEdit).not.toHaveBeenCalled(); expect(core.applyProposalReview).not.toHaveBeenCalled();
    button('Pending').click(); expect(document.querySelectorAll('.revision-entry')).toHaveLength(2);
    button('History').click(); expect(document.querySelectorAll('.revision-entry')).toHaveLength(1);
    button('All revisions').click();
    const search=document.querySelector<HTMLInputElement>('[aria-label="Find revisions"]')!;
    search.value='rhythm'; search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.revision-entry')).toHaveLength(1);
    expect(document.querySelector('.revision-count')?.textContent).toBe('1 of 3 revisions · 2 pending in 1 scene');
    panel.destroy();
  });
  it.each(['external','in-app'])('accepts the displayed %s diff with one click and no second confirmation',async kind=>{
    const {core,panel,changed}=setup(); await panel.open();
    const entry=document.querySelector<HTMLElement>(kind==='external'?'[data-revision-id="external"]':'[data-revision-id=\'["saved","finding"]\']')!;
    const accept=[...entry.querySelectorAll('button')].find(b=>b.textContent==='Accept')!;
    accept.click(); accept.click(); await tick();
    expect(core.prepareReviewEdit).toHaveBeenCalledTimes(kind==='external'?0:1);
    if(kind==='in-app') expect(core.prepareReviewEdit).toHaveBeenCalledWith('repo','saved','finding');
    expect(document.querySelector('[aria-label="Review whole-scene proposal"]')).toBeNull();
    expect(core.applyProposalReview).toHaveBeenCalledWith('repo',{reviewId:view.id,proposalId:kind==='external'?'external':'prepared',baseHash:view.baseHash,replacementHash:view.replacementHash,diffHash:view.diffHash});
    expect(core.applyProposalReview).toHaveBeenCalledOnce();
    expect(document.querySelector('.revisions-dialog')).not.toBeNull();
    // The dialog reloads on the next pending revision and says so; it never applies that one for the author.
    expect(document.querySelector('.revision-next')?.textContent).toContain('Applied. Showing the next one: 1 revision still waiting');
    expect(document.activeElement?.closest('[data-status="pending"]')).not.toBeNull();
    expect(changed).toHaveBeenCalledWith('scene.md'); panel.destroy();
  });
  it('offers Back to review only for in-app findings and opens that review without deciding anything',async()=>{
    const openReview=vi.fn();
    const {core,panel}=setup(openReview); await panel.open();
    const external=document.querySelector('[data-revision-id="external"]')!;
    expect([...external.querySelectorAll('button')].some(b=>b.textContent==='Back to review')).toBe(false);
    const inApp=[...document.querySelectorAll('.revision-entry')].find(e=>e.textContent?.includes('In-app review'))!;
    [...inApp.querySelectorAll('button')].find(b=>b.textContent==='Back to review')!.click();await tick();
    expect(openReview).toHaveBeenCalledWith('saved','scene.md');
    expect(document.querySelector('.revisions-dialog')).toBeNull();
    expect(core.applyProposalReview).not.toHaveBeenCalled(); expect(core.rejectReviewEdit).not.toHaveBeenCalled(); panel.destroy();
  });
  it('refuses an unseen replacement after the displayed diff changes',async()=>{
    const {core,panel,report}=setup();await panel.open();
    core.reviewProposal.mockResolvedValue({...view,replacementText:'Different unseen words.',replacementHash:'changed'});
    const entry=document.querySelector('[data-revision-id="external"]')!;
    [...entry.querySelectorAll('button')].find(b=>b.textContent==='Accept')!.click();await tick();
    expect(core.applyProposalReview).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.stringContaining('changed since it was displayed'),true);panel.destroy();
  });
  it('also accepts legacy in-app findings through their native prepared-edit binding',async()=>{
    const {core,panel}=setup();
    const {review: _review, ...legacyOrigin}=nativeOrigin;
    core.listReviews.mockResolvedValue([{...saved,schemaVersion:1}]);
    core.reviewProposal.mockResolvedValue({...view,proposalId:'prepared',origin:legacyOrigin});
    await panel.open();
    const entry=[...document.querySelectorAll('.revision-entry')].find(e=>e.textContent?.includes('In-app review'))!;
    [...entry.querySelectorAll('button')].find(b=>b.textContent==='Accept')!.click();await tick();
    expect(core.prepareReviewEdit).toHaveBeenCalledWith('repo','saved','finding');
    expect(core.applyProposalReview).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-label="Review whole-scene proposal"]')).toBeNull();panel.destroy();
  });
  it.each(['external','in-app'])('keeps the author text for %s and updates filters without applying',async kind=>{
    const {core,panel}=setup(); await panel.open(); button('Pending').click();
    const entries=[...document.querySelectorAll('.revision-entry')];
    const entry=entries.find(e=>e.textContent?.includes(kind==='external'?'External proposal':'In-app review'))!;
    [...entry.querySelectorAll('button')].find(b=>b.textContent==='Keep mine')!.click(); await tick();
    expect(document.querySelectorAll('.revision-entry')).toHaveLength(1);
    expect(document.querySelector('.revision-count')?.textContent).toBe('1 of 3 revisions · 1 pending in 1 scene');
    button('History').click(); expect(document.querySelectorAll('.revision-entry')).toHaveLength(2);
    expect(core.applyProposalReview).not.toHaveBeenCalled(); expect(core.prepareReviewEdit).not.toHaveBeenCalled(); panel.destroy();
  });
  it('deduplicates prepared and decided in-app proposals by their finding identity',()=>{
    const native={kind:'nativeOpenAi' as const,sessionId:'',clientLabel:'',identityAssurance:'unverifiedProviderMetadata' as const,provider:'openai' as const,model:'test',requestId:'request',review:{reviewId:'saved',findingId:'finding',fingerprint:'fingerprint',competing:[]}};
    const nativeProposal={...proposal,id:'prepared',origin:native};
    expect(collectRevisions({pending:[nativeProposal],receipts:[]},[saved])).toHaveLength(1);
    const completed={...receipt,proposalId:'prepared',origin:native};
    const rows=collectRevisions({pending:[nativeProposal],receipts:[completed]},[{...saved,edits:[{...edit,status:'accepted',proposalId:'prepared'}]}]);
    expect(rows).toHaveLength(1); expect(rows[0].receipt).toBe(completed);
  });
  it('shows available sources when one list fails and never fabricates missing revisions',async()=>{
    const {core,panel}=setup();core.listReviews.mockRejectedValue(new Error('unavailable'));await panel.open();
    expect(document.body.textContent).toContain('Saved in-app reviews could not be loaded');
    expect(document.querySelectorAll('.revision-entry')).toHaveLength(2);
    panel.destroy();
  });
  it('requires an explicit choice and a new exact review for conflicting alternatives',async()=>{
    const {core,panel}=setup();core.listReviews.mockResolvedValue([{...saved,edits:[{...edit,conflictGroup:'alternatives',selected:false}]}]);await panel.open();
    const entry=[...document.querySelectorAll('.revision-entry')].find(e=>e.textContent?.includes('In-app review'))!;
    [...entry.querySelectorAll('button')].find(b=>b.textContent==='Details')!.click();await tick();
    expect(core.chooseReviewEdit).toHaveBeenCalledWith('repo','saved','finding');
    expect(core.chooseReviewEdit.mock.invocationCallOrder[0]).toBeLessThan(core.prepareReviewEdit.mock.invocationCallOrder[0]);
    button('Cancel').click();await tick();expect(core.applyProposalReview).not.toHaveBeenCalled();panel.destroy();
  });
});
