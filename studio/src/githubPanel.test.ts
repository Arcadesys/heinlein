// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createGitHubPanel } from './githubPanel';
import type { LocalCore } from './localCore';
import type { GitHubRequest, GitHubResponse, GitHubStatus, GitHubIncoming } from './githubTypes';
let panels: ReturnType<typeof createGitHubPanel>[] = [];
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); }; });
afterEach(() => { panels.forEach(p => p.destroy()); panels = []; document.body.replaceChildren(); });
const tick = () => new Promise(r => setTimeout(r, 0));
const repo = { id: 42, owner: 'example', name: 'story', private: true, defaultBranch: 'main', installationId: 7 };
const workspace = { id: 'workspace', repo, accountId: 9, authBinding: 'opaque', baseOid: 'base', headOid: 'local', remoteOid: null, branch: 'heinlein/story-uuid', pr: null };
const status: GitHubStatus = { auth: { configured: true, account: { id: 9, login: 'writer' }, confirmed: true, pending: null, message: 'GitHub connected. Saving stays local.' }, error: null, workspaces: [], app: { id: 5412628, clientId: 'public', owner: 'Arcadesys', slug: 'heinlein-studio', installUrl: 'https://github.com/apps/heinlein-studio' } };
const incoming: GitHubIncoming = { id: 'incoming', workspaceId: 'workspace', branch: 'main', localHead: 'local', githubHead: 'remote', files: [{ path: 'story.md', kind: 'edit', beforeHash: 'old', afterHash: 'new' }], documents: [{ path: 'story.md', original: 'Original prose', result: 'Candidate prose' }], conflicts: [{ id: 'conflict', label: 'Opening scene', kind: 'prose', original: 'Original prose', yours: 'My prose', github: 'Their prose', resolution: null }], ready: false, treatment: 'No source changes until confirmed.' };
function fixture(selected = true) {
    const session = { id: 'session', name: 'Synthetic', manifests: [], githubWorkspaceId: 'workspace' };
    let problem: string | null = null;
    const request = vi.fn(async (r: GitHubRequest): Promise<GitHubResponse> => { switch (r.action) {
        case 'status': return structuredClone(status);
        case 'workspace': return { workspace, changes: [{ path: 'story.md', kind: 'edit', beforeHash: 'old', afterHash: 'new' }], receipts: [] };
        case 'previewSend': return {id:'send',workspaceId:'workspace',head:'local',files:[{path:'story.md',kind:'edit',beforeHash:'old',afterHash:'new'}],selectedFiles:r.paths.length?[{path:'story.md',kind:'edit',beforeHash:'old',afterHash:'new'}]:[],existingVersions:[{head:'earlier',files:[{path:'earlier.md',kind:'edit',beforeHash:'a',afterHash:'b'}]}],createsVersion:r.paths.length>0,canSend:true,identity:r.identity,message:r.message,kind:'push',repository:repo,account:{id:9,login:'writer'},branch:workspace.branch,base:'main',commits:['earlier'],title:'',body:'',warning:'Sending may run repository automation.'};
        case 'previewVersion': return { id: 'version', workspaceId: 'workspace', head: 'local', files: [{ path: 'story.md', kind: 'edit', beforeHash: 'old', afterHash: 'new' }], identity: r.identity, message: r.message };
        case 'previewOpen': case 'previewListedRepository': return { id: 'open', repository: repo, account: { id: 9, login: 'writer' }, treatment: 'Separate local copy' };
        case 'previewShare': return { id: 'share', workspaceId: 'workspace', head: 'local', files: [], identity: { name: '', email: '' }, message: '', kind: r.kind, repository: repo, account: { id: 9, login: 'writer' }, branch: workspace.branch, base: 'main', commits: ['local'], title: r.title, body: r.body, warning: 'Sending may run repository automation.' };
        case 'previewIncoming': return structuredClone(incoming);
        case 'resolve': return { ...incoming, ready: true, conflicts: [{ ...incoming.conflicts[0], resolution: r.resolution }] };
        case 'confirm': if(r.previewId==='send')return{localVersionSaved:true,receipt:null,message:'Local version saved; upload is not confirmed. Check pending operations.'}; return { id: r.previewId, workspaceId: 'workspace', kind: 'version', status: 'succeeded', head: 'local', message: 'Version saved on this computer.', url: null };
        default: return null;
    } });
    const hooks = { session: () => selected ? session : null, problem: () => problem, settle: vi.fn(async () => { }), select: vi.fn(async (run: () => Promise<unknown>) => { await run(); }), authorAction: vi.fn(async (run: () => Promise<void>) => { await run(); }), incomingChanged: vi.fn(async () => { }) };
    const p = createGitHubPanel({ available: () => true, githubRequest: request } as unknown as LocalCore, hooks);
    panels.push(p);
    document.body.append(p.element);
    const click = async (label: string) => { const b = [...p.element.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label); expect(b, label).toBeDefined(); b!.click(); await tick(); };
    const fill = (label: string, value: string) => { const input = [...p.element.querySelectorAll('label')].find(l => l.textContent === label)!.querySelector('input,textarea') as HTMLInputElement; input.value = value; input.dispatchEvent(new Event('input')); return input; };
    return { p, request, hooks, click, fill, setProblem: (p: string | null) => problem = p };
}
it('opening has no implicit authentication or sharing; local versions select exact files and identity', async () => {
    const f = fixture();
    await f.p.open();
    expect(f.request.mock.calls.map(c => c[0].action)).toEqual(['status', 'workspace']);
    await f.click('Save a local version without sending…');
    await f.click('Preview local version');
    expect(f.request.mock.calls.at(-1)![0]).toMatchObject({ action: 'previewVersion', paths: [] }); // native rejects empty, never add-all
    const check = f.p.element.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    f.fill('Version author name', 'Writer');
    f.fill('Version author email', 'private@users.noreply.github.com');
    f.fill('Version message', 'A deliberate version');
    await f.click('Preview local version');
    expect(f.request.mock.calls.at(-1)![0]).toMatchObject({ action: 'previewVersion', repositoryId: 'session', paths: ['story.md'], identity: { name: 'Writer', email: 'private@users.noreply.github.com' }, message: 'A deliberate version' });
    await f.click('Confirm local version…');
    expect(f.hooks.authorAction).toHaveBeenCalledOnce();
    expect(f.p.element.textContent).toContain('Version saved on this computer.');
    expect(f.request.mock.calls.filter(c => c[0].action === 'previewShare')).toHaveLength(0);
});
it('feedback metadata edits discard the preview and cancellation never sends', async () => { const f = fixture(); await f.p.open(); await f.click('Request feedback with a draft pull request…'); f.fill('Feedback request title', 'First title'); await f.click('Preview GitHub action'); expect(f.p.element.textContent).toContain('Sending may run repository automation.'); f.fill('Feedback request title', 'Changed title'); await tick(); expect(f.p.element.querySelector('[data-github-preview]')).toBeNull(); expect(f.request.mock.calls.some(c => c[0].action === 'confirm')).toBe(false); expect(f.request.mock.calls).toContainEqual([{ action: 'cancel', previewId: 'share' }]); });
it('controls lock while preparation is pending and source changes discard its eventual token', async () => { const f = fixture(); await f.p.open(); await f.click('Request feedback with a draft pull request…'); let finish!: (v: GitHubResponse) => void; f.request.mockImplementationOnce(() => new Promise(resolve => finish = resolve)); await f.click('Preview GitHub action'); expect(f.p.element.querySelector<HTMLInputElement>('input')!.disabled).toBe(true); f.p.sourceChanged(); finish({ id: 'late', ...({} as any) }); await tick(); expect(f.p.element.querySelector('[data-github-preview]')).toBeNull(); expect(f.request.mock.calls).toContainEqual([{ action: 'cancel', previewId: 'late' }]); expect(f.p.element.textContent).toContain('Prepare a new preview'); });
it('incoming prose has labelled panes, no selected choice, and explicit resolution before confirmation', async () => { const f = fixture(); await f.p.open(); await f.click('Review changes on target branch main…'); for (const label of ['Original', 'Your writing', 'GitHub writing'])
    expect(f.p.element.textContent).toContain(label); expect(f.p.element.textContent).toContain('No choice is selected'); expect([...f.p.element.querySelectorAll('button')].some(b => b.textContent === 'Apply this reviewed batch…')).toBe(false); await f.click('Keep mine'); expect(f.request.mock.calls).toContainEqual([{ action: 'resolve', repositoryId: 'session', previewId: 'incoming', conflictId: 'conflict', resolution: { choice: 'mine', result: null } }]); f.fill('Version author name', 'Writer'); f.fill('Version author email', 'private@example.test'); await f.click('Apply this reviewed batch…'); expect(f.hooks.incomingChanged).toHaveBeenCalledOnce(); expect(f.request.mock.calls).toContainEqual([{ action: 'confirm', repositoryId: 'session', previewId: 'incoming', identity: { name: 'Writer', email: 'private@example.test' } }]); });
it('dirty/recovery blocks action preparation and native unavailable has an explicit state', async () => { const f = fixture(); await f.p.open(); f.setProblem('Resolve recovery first.'); await f.click('Review changes on target branch main…'); expect(f.p.element.textContent).toContain('Resolve recovery first.'); expect(f.request.mock.calls.some(c => c[0].action === 'previewIncoming')).toBe(false); });
it('Escape returns focus and stale load after project change cannot restore old data', async () => { const f = fixture(false); const opener = document.createElement('button'); document.body.append(opener); opener.focus(); await f.p.open(); f.p.element.dispatchEvent(new Event('cancel', { cancelable: true })); expect(f.p.element.open).toBe(false); expect(document.activeElement).toBe(opener); });
it('reading-order conflicts show scene names with advanced IDs collapsed',async()=>{const {createGitHubConflictPanel}=await import('./githubConflictPanel');const p=createGitHubConflictPanel({id:'order',kind:'order',label:'Scene reading order',original:'["one","two"]',yours:'["two","one"]',github:'["one","two"]',resolution:null},async()=>{}, {one:'Opening (ms/1.md)',two:'Ending (ms/2.md)'});document.body.append(p.element);expect(p.element.querySelector('details pre')!.textContent).toBe('1. Opening (ms/1.md)\n2. Ending (ms/2.md)');const advanced=[...p.element.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Custom structure result (advanced)')!;expect(advanced.open).toBe(false);});
it.each(['incoming','version'] as const)('selected %s recovery remains reachable when workspace loading rejects',async kind=>{
    const f=fixture();const original=f.request.getMockImplementation()!;
    f.request.mockImplementation(async request=>{
        if(request.action==='status')return {...structuredClone(status),workspaces:[{workspace,error:'An interrupted operation needs recovery.',incomingRecovery:kind==='incoming',receipts:kind==='version'?[{id:'prepared-version',workspaceId:workspace.id,kind:'version',status:'prepared',head:'local',message:'Version needs recovery.',url:null}]:[]}]};
        if(request.action==='workspace')throw new Error('An interrupted operation needs recovery.');
        return original(request);
    });
    await f.p.open();
    const recovery=kind==='incoming'?'Recover interrupted update for story…':'Recover local version for story…';
    expect(f.p.element.textContent).toContain('interrupted operation');
    await f.click(recovery);
    expect(f.request.mock.calls).toContainEqual([{action:'recover',workspaceId:workspace.id,operationId:kind==='version'?'prepared-version':null}]);
    await f.click('Close GitHub projects');await f.p.open();
    expect([...f.p.element.querySelectorAll('button')].some(b=>b.textContent===recovery)).toBe(true);
    expect(f.request.mock.calls.some(([request])=>request.action==='previewVersion'||request.action==='previewShare')).toBe(false);
});
it('connected writers can load granted repositories and select one through a bound preview',async()=>{
    const f=fixture(false);const original=f.request.getMockImplementation()!;
    f.request.mockImplementation(async r=>r.action==='repositories'?{id:'list',account:status.auth!.account!,repositories:[repo],unavailable:0}:original(r));
    await f.p.open();await f.click('Load repositories');
    await f.click('Preview example/story…');
    expect(f.request.mock.calls).toContainEqual([{action:'previewListedRepository',listId:'list',repositoryId:42}]);
    expect(f.p.element.textContent).toContain('Open this GitHub repository?');
    expect(f.hooks.select).not.toHaveBeenCalled();
    await f.click('Open repository…');expect(f.hooks.select).toHaveBeenCalledOnce();
});
it('repository access is separate from sign-in, with empty/error and explicit refresh paths',async()=>{
    const f=fixture(false);const original=f.request.getMockImplementation()!;let attempt=0;
    f.request.mockImplementation(async r=>{if(r.action!=='repositories')return original(r);if(attempt++===0)return {id:'empty-list',account:status.auth!.account!,repositories:[],unavailable:1};throw new Error('GitHub has limited requests. Wait, then explicitly check again.');});
    await f.p.open();await f.click('Load repositories');expect(f.p.element.textContent).toContain('No available repositories yet');expect(f.p.element.textContent).toContain('Organization approval or SSO');
    await f.click('Choose repositories for Heinlein on GitHub');expect(f.request.mock.calls).toContainEqual([{action:'openLink',kind:'install'}]);
    await f.click('Refresh repository list');expect(f.p.element.textContent).toContain('GitHub has limited requests');
    expect(f.request.mock.calls.some(([r])=>['connect','signOut','confirmOpen'].includes(r.action))).toBe(false);
});
it.each(['close','source','account'] as const)('a delayed repository list cannot restore stale %s authority',async change=>{
    const f=fixture(false);await f.p.open();let finish!:(v:GitHubResponse)=>void;
    f.request.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));await f.click('Load repositories');
    if(change==='source')f.p.sourceChanged();
    else if(change==='close')f.p.clear();
    finish({id:'late-list',account:{id:change==='account'?999:9,login:'writer'},repositories:[repo],unavailable:0});await tick();
    expect([...f.p.element.querySelectorAll('button')].some(b=>b.textContent==='Preview example/story…')).toBe(false);
    expect(f.request.mock.calls).toContainEqual([{action:'cancel',previewId:'late-list'}]);
});
it('an unconfirmed account cannot list repositories and a stale selected preview never opens',async()=>{
    const f=fixture(false);const original=f.request.getMockImplementation()!;
    f.request.mockImplementation(async r=>r.action==='status'?{...structuredClone(status),auth:{...status.auth!,confirmed:false}}:original(r));
    await f.p.open();expect(f.p.element.textContent).toContain('Use this GitHub account…');expect(f.p.element.textContent).not.toContain('Load repositories');
    f.request.mockImplementation(async r=>r.action==='repositories'?{id:'list',account:status.auth!.account!,repositories:[repo],unavailable:0}:original(r));
    await f.p.open();await f.click('Load repositories');let finish!:(v:GitHubResponse)=>void;
    f.request.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));await f.click('Preview example/story…');
    f.p.sourceChanged();finish({id:'late-open',repository:repo,account:status.auth!.account!,treatment:'Separate local copy'});await tick();
    expect(f.p.element.textContent).not.toContain('Open this GitHub repository?');expect(f.hooks.select).not.toHaveBeenCalled();
    expect(f.request.mock.calls).toContainEqual([{action:'cancel',previewId:'late-open'}]);
});
it('unavailable secure store offers read-only retry without OAuth, signout or credential replacement',async()=>{
 const f=fixture(false);const original=f.request.getMockImplementation()!;let locked=true;
 f.request.mockImplementation(async r=>{if(r.action==='status'&&locked)return{...structuredClone(status),auth:null,error:'Secure credential access was cancelled. Saved connection retained.'};if(r.action==='retrySaved'){locked=false;return status.auth;}return original(r);});
 await f.p.open();expect(f.p.element.textContent).toContain('Saved connection retained');expect(f.p.element.textContent).not.toContain('Connect GitHub…');await f.click('Retry saved GitHub connection');expect(f.p.element.textContent).toContain('Load repositories');expect(f.request.mock.calls.some(([r])=>r.action==='connect'||r.action==='signOut')).toBe(false);
});
it('working branch preview requires explicit confirmation through the save/selection barrier',async()=>{
 const f=fixture();const original=f.request.getMockImplementation()!;
 f.request.mockImplementation(async r=>{
  if(r.action==='branches')return [{name:workspace.branch,head:'local',local:true,defaultBranch:false},{name:'main',head:'base',local:false,defaultBranch:true}];
  if(r.action==='previewBranch')return {id:'branch-plan',workspaceId:workspace.id,account:{id:9,login:'writer'},repository:repo,fromBranch:workspace.branch,branch:r.name,startingBranch:r.startingBranch,head:'local',base:'main',files:[],treatment:'Retain all local commits.'};
  return original(r);
 });
 await f.p.open();await f.click('Choose or create a working branch…');f.fill('New working branch name','revision/ending');await f.click('Preview branch change');
 expect(f.request.mock.calls.at(-1)![0]).toMatchObject({action:'previewBranch',name:'revision/ending',create:true});expect(f.hooks.select).not.toHaveBeenCalled();
 await f.click('Confirm local branch change…');expect(f.hooks.select).toHaveBeenCalledOnce();expect(f.request.mock.calls).toContainEqual([{action:'confirm',repositoryId:'session',previewId:'branch-plan',identity:null}]);
});
it('ready and merge remain separate with persistent disabled reasons and no accidental merge request',async()=>{
 const f=fixture();const original=f.request.getMockImplementation()!;
 const pr={number:1,url:'https://github.com/example/story/pull/1',state:'open',merged:false,draft:true,head:workspace.branch,base:'main'};
 f.request.mockImplementation(async r=>{
  if(r.action==='workspace')return {workspace:{...workspace,pr},changes:[],receipts:[]};
  if(r.action==='pullStatus')return {detail:{pull:pr,nodeId:'PR_test',head:'local',base:'base',stack:'standalone'},readyAllowed:true,mergeAllowed:false,reason:'No proof that account bypass is disabled. Open on GitHub.',checks:'Checks unknown.'};
  if(r.action==='previewPullAction')return {id:'ready-plan',kind:r.kind,account:{id:9,login:'writer'},repository:repo,detail:{pull:pr,nodeId:'PR_test',head:'local',base:'base',stack:'standalone'},method:r.method,warning:'No merge or new commits.'};
  return original(r);
 });
 await f.p.open();await f.click('Pull request status and actions…');
 const merge=[...f.p.element.querySelectorAll('button')].find(b=>b.textContent==='Preview single pull request merge…')!;expect(merge.disabled).toBe(true);expect(merge.getAttribute('aria-describedby')).toBe('github-merge-unavailable');
 await f.click('Refresh pull request status');expect([...f.p.element.querySelectorAll('button')].find(b=>b.textContent===merge.textContent)!.disabled).toBe(true);
 await f.click('Mark draft ready for review…');expect(f.p.element.textContent).toContain('No merge or new commits.');expect(f.request.mock.calls.filter(([r])=>r.action==='previewPullAction')).toHaveLength(1);
 await f.click('Confirm ready for review…');expect(f.request.mock.calls).toContainEqual([{action:'confirm',repositoryId:'session',previewId:'ready-plan',identity:null}]);
});
it('a delayed branch list cannot replace a changed view or writing',async()=>{
 const f=fixture();const original=f.request.getMockImplementation()!;let resolve!:(v:GitHubResponse)=>void;
 f.request.mockImplementation(r=>r.action==='branches'?new Promise(done=>resolve=done):original(r));
 await f.p.open();void f.click('Choose or create a working branch…');await tick();f.p.sourceChanged();resolve([{name:'main',head:'base',local:false,defaultBranch:true}]);await tick();expect(f.p.element.textContent).not.toContain('New working branch name');
 expect(f.request.mock.calls.some(([r])=>r.action==='previewBranch')).toBe(false);
});

it('incoming review names the selected nondefault PR target without substituting main',async()=>{
 const f=fixture();const original=f.request.getMockImplementation()!;f.request.mockImplementation(async r=>{if(r.action==='workspace')return{workspace:{...workspace,baseBranch:'release'},changes:[],receipts:[]};return original(r);});
 await f.p.open();await f.click('Review changes on target branch release…');expect(f.request.mock.calls).toContainEqual([{action:'previewIncoming',repositoryId:'session',target:'default'}]);
});

it.each([
 'The secure credential store is locked.',
 'Secure credential access was denied.',
 'Secure credential access was cancelled.',
 'The secure credential store is unavailable.',
 'The secure-store record could not be handled safely.',
 'An unknown secure-store failure prevented persistence.',
])('pending renewal shows its sanitized cause and keeps explicit retry: %s',async cause=>{
 const f=fixture(false);const original=f.request.getMockImplementation()!;let pending=true;let attempts=0;
 const context=(detail:string)=>`GitHub renewed the connection, but the renewed sign-in data is not yet saved. ${detail} Keep Heinlein open and choose Retry saved GitHub connection. No stored credential was deleted; do not sign out or reconnect to fix this store error.`;
 f.request.mockImplementation(async r=>{
  if(r.action==='status'&&pending)return{...structuredClone(status),auth:null,error:context(cause)};
  if(r.action==='retrySaved'){if(++attempts===1)throw new Error(context('Secure credential access was cancelled.'));pending=false;return status.auth;}
  return original(r);
 });
 await f.p.open();expect(f.p.element.textContent).toContain(cause);expect(f.p.element.textContent).toContain('Keep Heinlein open');
 expect([...f.p.element.querySelectorAll('button')].some(b=>/Connect GitHub|Reconnect GitHub|Sign out/.test(b.textContent??''))).toBe(false);
 await f.click('Retry saved GitHub connection');expect(f.p.element.querySelector('[role="status"]')?.textContent).toContain('Secure credential access was cancelled.');
 await f.click('Retry saved GitHub connection');expect(f.p.element.textContent).toContain('Load repositories');
 expect(f.request.mock.calls.filter(([r])=>r.action==='retrySaved')).toHaveLength(2);
 expect(f.request.mock.calls.some(([r])=>['connect','poll','signOut','confirmAccount'].includes(r.action))).toBe(false);
});
it('focused Send discloses earlier history and creates no version before consent',async()=>{
 const f=fixture();await f.p.openSend();
 expect(f.p.element.textContent).toContain('earlier.md');expect(f.p.element.textContent).toContain('New edits in unchecked files');
 expect(f.p.element.textContent).not.toContain('Sign out of GitHub');
 f.p.element.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
 f.fill('Name recorded with these changes','Writer');f.fill('Email recorded with these changes','private@example.test');
 expect(f.request.mock.calls.filter(c=>c[0].action==='confirm')).toHaveLength(0);
 await f.click('Send to GitHub…');expect(f.p.element.textContent).toContain('Local version saved; upload is not confirmed');
 expect(f.request.mock.calls.filter(c=>c[0].action==='confirm')).toHaveLength(1);
});
it('Not now cancels without version/upload and returns focus',async()=>{
 const f=fixture();const opener=document.createElement('button');document.body.append(opener);opener.focus();await f.p.openSend();
 await f.click('Not now');expect(f.p.element.open).toBe(false);expect(document.activeElement).toBe(opener);
 expect(f.request.mock.calls.filter(c=>c[0].action==='confirm')).toHaveLength(0);
});
it('a failed save prevents even a Send preview',async()=>{
 const f=fixture();const rejectSave=vi.fn(async()=>false);
 const p=createGitHubPanel({available:()=>true,githubRequest:f.request} as unknown as LocalCore,{...f.hooks,saveForSend:rejectSave});panels.push(p);document.body.append(p.element);await p.openSend();
 expect(rejectSave).toHaveBeenCalledOnce();expect(p.element.textContent).toContain('Nothing was sent');expect(f.request.mock.calls.some(c=>c[0].action==='previewSend'||c[0].action==='confirm')).toBe(false);
});
it('repeated Send clicks stay one-flight while native confirmation is pending',async()=>{
 const f=fixture();await f.p.openSend();const original=f.request.getMockImplementation()!;
 let resolve!:(v:GitHubResponse)=>void;f.request.mockImplementation(r=>r.action==='confirm'?new Promise(done=>resolve=done):original(r));
 const b=[...f.p.element.querySelectorAll('button')].find(b=>b.textContent==='Send to GitHub…')!;b.click();b.click();await tick();
 expect(f.request.mock.calls.filter(c=>c[0].action==='confirm')).toHaveLength(1);
 resolve(null);await tick();await tick();expect(f.p.element.textContent).toContain('Nothing sent');expect(f.p.element.open).toBe(true);expect(document.activeElement).toBe(b);
});
it('changed prior history refuses before confirmation',async()=>{
 const f=fixture();await f.p.openSend();const original=f.request.getMockImplementation()!;
 f.request.mockImplementation(async r=>{const value=await original(r);return r.action==='previewSend'?{...value as any,head:'changed'}:value;});
 await f.click('Send to GitHub…');expect(f.p.element.textContent).toContain('sending details changed');expect(f.request.mock.calls.some(c=>c[0].action==='confirm')).toBe(false);
});
it('a late Send result cannot replace a cleared or changed writing view',async()=>{
 const f=fixture();await f.p.openSend();const original=f.request.getMockImplementation()!;
 let resolve!:(v:GitHubResponse)=>void;f.request.mockImplementation(r=>r.action==='confirm'?new Promise(done=>resolve=done):original(r));
 await f.click('Send to GitHub…');f.p.clear();
 resolve({localVersionSaved:true,receipt:null,message:'Old operation result'});await tick();
 expect(f.p.element.open).toBe(false);expect(f.p.element.querySelector('.send-result')).toBeNull();
});
it('new changes explain missing author details without preparing or confirming a send',async()=>{
 const f=fixture();await f.p.openSend();f.p.element.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
 const previews=f.request.mock.calls.filter(c=>c[0].action==='previewSend').length;
 await f.click('Send to GitHub…');
 expect(f.p.element.textContent).toContain('Add the name and email');expect(f.request.mock.calls.filter(c=>c[0].action==='previewSend')).toHaveLength(previews);
 expect(f.request.mock.calls.some(c=>c[0].action==='confirm')).toBe(false);
 expect([...f.p.element.querySelectorAll('details')].find(d=>d.textContent?.includes('Name and email included with new changes'))!.open).toBe(true);
});
