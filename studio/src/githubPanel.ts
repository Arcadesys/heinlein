import type { LocalCore, RepositorySession } from './localCore';
import type { GitHubRequest, GitHubStatus, GitHubAuth, GitHubProject, GitHubOpen, GitHubVersion, GitHubShare, GitHubIncoming, GitHubIdentity, GitHubReceipt, GitHubRepositories } from './githubTypes';
import { createGitHubConflictPanel } from './githubConflictPanel';
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const e = document.createElement(tag); e.textContent = text; return e; };
type Options = {
    session(): RepositorySession | null;
    problem(): string | null;
    settle(): Promise<void>;
    select(run: () => Promise<RepositorySession | null>): Promise<void>;
    authorAction(run: () => Promise<void>): Promise<void>;
    incomingChanged(): Promise<void>;
};
export function createGitHubPanel(core: LocalCore, options: Options) {
    const element = node('dialog');
    element.className = 'github-panel';
    element.setAttribute('aria-labelledby', 'github-panel-title');
    const message = node('p');
    message.setAttribute('role', 'status');
    const body = node('section');
    let opener: HTMLElement | null = null;
    let busy = false;
    let generation = 0;
    let source = 0;
    let plan: string | null = null;
    let snapshot: GitHubStatus | null = null;
    let project: GitHubProject | null = null;
    const identity: GitHubIdentity = { name: '', email: '' };
    let versionMessage = '';
    let feedbackTitle = '';
    let feedbackBody = '';
    let url = '';
    async function request<T>(r: GitHubRequest) { if (!core.githubRequest)
        throw new Error('GitHub projects are available in the native Heinlein app.'); return await core.githubRequest(r) as T; }
    function cancelPlan() { if (plan) {
        const id = plan;
        plan = null;
        void request({ action: 'cancel', previewId: id }).catch(() => { });
    } }
    function valid(view: number, revision: number) { return element.open && view === generation && revision === source; }
    function controls(disabled: boolean) { element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button').forEach(e => e.disabled = disabled); element.toggleAttribute('aria-busy', disabled); }
    async function act(run: () => Promise<void>) { if (busy)
        return; busy = true; controls(true); try {
        await run();
    }
    catch (error) {
        message.textContent = String(error);
    }
    finally {
        busy = false;
        controls(false);
    } }
    function button(text: string, run: () => Promise<void>) { const b = node('button', text); b.type = 'button'; b.disabled = busy; b.addEventListener('click', () => { void act(run); }); return b; }
    function field(text: string, value: string, update: (v: string) => void, multi = false, invalidate = true) { const label = node('label', text); const input = multi ? node('textarea') : node('input'); input.value = value; input.maxLength = multi ? 4000 : 500; input.addEventListener('input', () => { update(input.value); if (invalidate) {
        cancelPlan();
        body.querySelector('[data-github-preview]')?.remove();
    } }); label.append(input); return label; }
    function heading(text: string) { delete body.dataset.githubIncoming; body.replaceChildren(); const h = node('h3', text); h.tabIndex = -1; body.append(h); return h; }
    function focus() { body.querySelector<HTMLElement>('h3')?.focus(); body.scrollIntoView?.({ block: 'start' }); }
    function files(changes: {
        path: string;
        kind: string;
    }[]) { const ul = node('ul'); for (const f of changes)
        ul.append(node('li', `${f.kind}: ${f.path}`)); return ul; }
    function authorFields() { body.append(node('p', 'Confirm the name and email recorded on each version. Use a GitHub privacy email if you prefer. These are separate from your assistant account.'), field('Version author name', identity.name, v => identity.name = v, false, false), field('Version author email', identity.email, v => identity.email = v, false, false)); }
    function session() { const s = options.session(); if (!s?.githubWorkspaceId)
        throw new Error('Open a GitHub project first.'); return s; }
    async function prepare<T extends {
        id: string;
    }>(r: GitHubRequest) { await options.settle(); const problem = options.problem(); if (problem)
        throw new Error(problem); const view = generation, revision = source; const p = await request<T>(r); if (!valid(view, revision)) {
        await request({ action: 'cancel', previewId: p.id });
        throw new Error('Writing or project changed. Prepare a new preview.');
    } cancelPlan(); plan = p.id; return p; }
    async function load() {
        const view=generation;
        const selected=options.session();
        const value=await request<GitHubStatus>({action:'status'});
        if(view!==generation||!element.open)return;
        let selectedProject:GitHubProject|null=null;
        let selectedError:string|null=null;
        if(selected?.githubWorkspaceId){
            try { selectedProject=await request<GitHubProject>({action:'workspace',repositoryId:selected.id}); }
            catch(error){ selectedError=String(error); }
        }
        // An unavailable selected copy must not hide status/recovery controls.
        // Keep awaited results local until their original view is still current.
        if(view!==generation||!element.open)return;
        snapshot=value;project=selectedProject;
        renderHome();
        if(selectedError)message.textContent=`The selected copy could not reopen. Use the recovery controls below when available. ${selectedError}`;
    }
    function account(auth: GitHubAuth | null) {
        body.append(node('h4', 'GitHub account'), node('p', auth?.message ?? snapshot?.error ?? 'GitHub is unavailable. Local writing remains available.'));
        if (auth?.pending) {
            const p = auth.pending;
            body.append(node('p', `Enter code ${p.userCode} at GitHub. Return here after approving access.`), button('Open GitHub device page', async () => { await request({ action: 'openLink', kind: 'device' }); }), button('Check sign-in', async () => { snapshot!.auth = await request<GitHubAuth>({ action: 'poll' }); renderHome(); }));
        }
        else if (auth?.account && !auth.confirmed) {
            body.append(node('p', `GitHub reports ${auth.account.login} (ID ${auth.account.id}).`), button('Use this GitHub account…', async () => { const a = await request<GitHubAuth | null>({ action: 'confirmAccount', userId: auth.account!.id }); if (a)
                snapshot!.auth = a; renderHome(); }));
        }
        else if (auth?.configured && !auth.confirmed)
            body.append(button('Connect GitHub…', async () => { snapshot!.auth = await request<GitHubAuth>({ action: 'connect' }); renderHome(); }));
        if (auth?.account || auth?.pending)
            body.append(button('Sign out of GitHub', async () => { cancelPlan(); snapshot!.auth = await request<GitHubAuth>({ action: 'signOut' }); renderHome(); }));
        body.append(button('Choose repositories for Heinlein on GitHub', async () => { await request({ action: 'openLink', kind: 'install' }); }), node('p', 'Heinlein Studio is the Arcadesys GitHub App. Install it only for repositories you choose. GitHub access is separate from AI or assistant access.'));
    }
    async function previewRepository(action:GitHubRequest) {
        const p=await prepare<GitHubOpen>(action);
        heading('Open this GitHub project?');
        body.append(node('p',`${p.repository.owner}/${p.repository.name} · ${p.repository.private?'Private':'Public'} · account ${p.account.login}`),node('p',p.treatment),button('Open separate local copy…',async()=>{
            await options.select(()=>request<RepositorySession|null>({action:'confirmOpen',previewId:p.id}));plan=null;close();
        }),button('Cancel repository preview',async()=>{renderHome();}));focus();
    }
    function repositoryChooser() {
        body.append(node('h4','Open a GitHub project'),node('p','Sign-in and repository access are separate. Choose only the repositories you want Heinlein to access on GitHub, then load the list here. Only repositories you can write to are offered.'));
        const result=node('section');result.setAttribute('aria-label','Available GitHub repositories');
        const refresh=button('Load repositories',async()=>{
            result.replaceChildren(node('p','Loading repositories granted to Heinlein…'));
            refresh.textContent='Refresh repository list';
            try {
                const p=await prepare<GitHubRepositories>({action:'repositories'});
                if(p.account.id!==snapshot?.auth?.account?.id||!snapshot.auth.confirmed){cancelPlan();throw new Error('GitHub account changed. Confirm the account and refresh the list.');}
                result.replaceChildren();
                if(!p.repositories.length)result.append(node('p','No available repositories yet. Choose repositories for Heinlein on GitHub, select only the ones you want, and then refresh this list. Organization approval or SSO may also be required.'));
                else {
                    result.append(node('p',`Choose a repository for ${p.account.login}. Nothing is opened until you review and confirm.`));
                    const list=node('ul');
                    for(const repo of p.repositories){const item=node('li');item.append(node('p',`${repo.owner}/${repo.name} · ${repo.private?'Private':'Public'}`),button(`Preview ${repo.owner}/${repo.name}…`,()=>previewRepository({action:'previewListedRepository',listId:p.id,repositoryId:repo.id})));list.append(item);}
                    result.append(list);
                }
                if(p.unavailable)result.append(node('p','Some repositories or installations are unavailable because access is limited, the repository is archived, or it has no default branch. Check access on GitHub or use another repository.'));
            }catch(error){
                if(element.open&&result.isConnected){result.replaceChildren(node('p',String(error)),node('p','Check repository access on GitHub, then refresh this list. You can also paste a repository URL below.'));}
            }
        });
        body.append(refresh,result);
    }
    function renderHome() {
        cancelPlan();
        heading('GitHub projects');
        message.textContent = '';
        if (!core.githubRequest || !core.available()) {
            body.append(node('p', 'Open the native Heinlein app to connect GitHub. Your local folders still work.'));
            return;
        }
        if (!snapshot)
            return;
        if (project) {
            const w = project.workspace;
            body.append(node('p', `${w.repo.owner}/${w.repo.name} · ${w.repo.private ? 'Private' : 'Public'}`), node('p', 'Saved on this computer is separate from Version saved and Sent to GitHub.'), node('p', `Local version: ${w.headOid.slice(0, 12)}. ${w.remoteOid === w.headOid ? 'This version was sent to GitHub.' : 'Local versions may not have been sent.'} ${w.pr ? `Feedback request #${w.pr.number}: ${w.pr.state}${w.pr.draft ? ' (draft)' : ''}.` : ''}`), button('Save a version on this computer…', async () => renderVersion()), button('Send local versions to GitHub…', async () => renderShare('push')), button('Request feedback with a draft pull request…', async () => renderShare('feedback')), button('Review changes on the feedback branch…', () => incoming('feedback')), button('Review changes on the original branch…', () => incoming('default')), node('p', 'After feedback is closed or merged, first review the original branch, then start a fresh feedback branch. Your local versions are retained.'), button('Start a fresh feedback branch…', async () => { await options.authorAction(async () => { await request({ action: 'freshBranch', repositoryId: session().id }); }); await load(); }));
            if(w.pr)body.append(button(`Open feedback request #${w.pr.number}`,async()=>{await request({action:'openFeedback',repositoryId:session().id});}));
            for (const r of project.receipts) {
                body.append(node('p', `${r.kind}: ${r.status}. ${r.message}`));
                if (r.status === 'unknown')
                    body.append(button('Check this operation on GitHub', async () => { const receipt = await request<GitHubReceipt>({ action: 'reconcile', repositoryId: session().id, operationId: r.id }); message.textContent = receipt.message; await load(); }));
            }
        }
        account(snapshot.auth);
        if (snapshot.auth?.confirmed) {
            repositoryChooser();
            const fallback=node('details');fallback.append(node('summary','Open by repository URL instead'),field('GitHub repository URL',url,v=>url=v),button('Preview repository…',()=>previewRepository({action:'previewOpen',url})));
            body.append(fallback);
        }
        if (snapshot.workspaces.length) {
            body.append(node('h4', 'Copies on this computer'), node('p', 'Open these copies offline. Missing copies are never cloned over your writing.'));
            for (const item of snapshot.workspaces) {
                const w = item.workspace;
                body.append(node('p', `${w.repo.owner}/${w.repo.name}${item.error ? ': ' + item.error : ''}`));
                if (!item.error)
                    body.append(button(`Open ${w.repo.owner}/${w.repo.name} locally`, async () => { await options.select(() => request<RepositorySession>({ action: 'reopen', workspaceId: w.id })); close(); }));
                if (item.incomingRecovery || item.branchRecovery)
                    body.append(button(`Recover interrupted update for ${w.repo.name}…`, async () => { await request({ action: 'recover', workspaceId: w.id, operationId: null }); await load(); }));
                for (const r of item.receipts.filter(r => r.kind === 'version' && r.status === 'prepared'))
                    body.append(button(`Recover local version for ${w.repo.name}…`, async () => { await request({ action: 'recover', workspaceId: w.id, operationId: r.id }); await load(); }));
                if (snapshot.auth?.confirmed)
                    body.append(button(`Confirm account and repository for ${w.repo.name}…`, async () => { await request({ action: 'previewRebind', workspaceId: w.id }); await load(); }));
            }
        }
        focus();
    }
    function previewBox() { body.querySelector('[data-github-preview]')?.remove(); const box = node('section'); box.dataset.githubPreview = ''; box.setAttribute('aria-label', 'GitHub action preview'); body.append(box); return box; }
    function renderVersion() {
        cancelPlan();
        heading('Save a version locally');
        const s = session();
        const selected = new Set<string>();
        body.append(node('p', 'Select exactly which saved writing files belong in this version. Unchecked files stay on this computer. A version is a named point in your local history.'));
        for (const change of project!.changes) {
            const label = node('label', `${change.kind}: ${change.path}`);
            const check = node('input');
            check.type = 'checkbox';
            check.addEventListener('change', () => { if (check.checked)
                selected.add(change.path);
            else
                selected.delete(change.path); cancelPlan(); body.querySelector('[data-github-preview]')?.remove(); });
            label.prepend(check);
            body.append(label);
        }
        authorFields();
        body.append(field('Version message', versionMessage, v => versionMessage = v), button('Preview local version', async () => { const p = await prepare<GitHubVersion>({ action: 'previewVersion', repositoryId: s.id, paths: [...selected], identity: { ...identity }, message: versionMessage }); const box = previewBox(); box.append(files(p.files), node('p', `${p.identity.name} <${p.identity.email}> — ${p.message}`), button('Confirm local version…', () => finish(p.id, false))); }), button('Back to GitHub project', load));
        focus();
    }
    function renderShare(kind: 'push' | 'feedback') { cancelPlan(); heading(kind === 'push' ? 'Send versions to GitHub' : 'Request feedback'); const s = session(); body.append(node('p', kind === 'push' ? 'Only saved local versions are sent. Unversioned writing stays here.' : 'A draft pull request asks for feedback on versions already sent. It does not merge or publish the story.')); if (kind === 'feedback')
        body.append(field('Feedback request title', feedbackTitle, v => feedbackTitle = v), field('Feedback request description', feedbackBody, v => feedbackBody = v, true)); body.append(button('Preview GitHub action', async () => { const p = await prepare<GitHubShare>({ action: 'previewShare', repositoryId: s.id, kind, title: feedbackTitle, body: feedbackBody }); const box = previewBox(); box.append(node('h4', `${p.repository.owner}/${p.repository.name} · ${p.repository.private ? 'Private' : 'Public'} · ${p.account.login}`), node('p', `Working branch: ${p.branch}. Base: ${p.base}. ${p.commits.length} versions.`), files(p.files), node('p', p.warning)); if (kind === 'feedback')
        box.append(node('p', p.title), node('pre', p.body)); box.append(button(kind === 'push' ? 'Confirm sending versions…' : 'Confirm draft feedback request…', () => finish(p.id, false)), button('Cancel this preview', async () => { cancelPlan(); box.remove(); })); }), button('Back to GitHub project', load)); focus(); }
    async function incoming(target: 'feedback' | 'default') { const p = await prepare<GitHubIncoming>({ action: 'previewIncoming', repositoryId: session().id, target }); renderIncoming(p); }
    function renderIncoming(p: GitHubIncoming) {
        heading('Review incoming GitHub changes');
        body.dataset.githubIncoming = '';
        body.append(node('p', p.treatment), files(p.files));
        for (const conflict of p.conflicts) {
            body.append(createGitHubConflictPanel(conflict, async (resolution) => { await act(async () => { const view = generation, revision = source; const next = await request<GitHubIncoming>({ action: 'resolve', repositoryId: session().id, previewId: p.id, conflictId: conflict.id, resolution }); if (!valid(view, revision))
                throw new Error('Writing changed. Review incoming changes again.'); renderIncoming(next); focus(); }); }, p.referenceLabels).element);
        }
        for (const doc of p.documents) {
            const details = node('details');
            details.append(node('summary', `Review proposed file: ${doc.path}`));
            for (const [label, text] of [['Current saved writing', doc.original], ['Proposed result', doc.result]])
                details.append(node('h4', label ?? ''), node('pre', text ?? '(deleted)'));
            body.append(details);
        }
        if (p.ready) {
            body.append(node('p', 'Every conflict has an explicit choice. Check the full result before applying this local version.'));
            authorFields();
            body.append(button('Apply this reviewed batch…', () => finish(p.id, true)));
        }
        else
            body.append(node('p', 'Resolve every listed conflict before applying. Cancel keeps your current writing.'));
        body.append(button('Cancel incoming changes', async () => { cancelPlan(); await load(); }));
        focus();
    }
    async function finish(id: string, incoming: boolean) { if (plan !== id)
        throw new Error('Preview this action again.'); const s = session(); let receipt: GitHubReceipt | null = null; await options.authorAction(async () => { receipt = await request<GitHubReceipt | null>({ action: 'confirm', repositoryId: s.id, previewId: id, identity: incoming ? { ...identity } : null }); plan = null; if (receipt && incoming)
        await options.incomingChanged(); }); await load(); message.textContent = receipt ? (receipt as GitHubReceipt).message : 'Action canceled. Prepare a new preview to continue.'; }
    function close() { generation++; cancelPlan(); element.close(); opener?.focus(); }
    element.addEventListener('cancel', e => { e.preventDefault(); if (!busy)
        close(); });
    element.addEventListener('close', () => { generation++; cancelPlan(); });
    function shell() { element.replaceChildren(); const title = node('h2', 'GitHub projects'); title.id = 'github-panel-title'; title.tabIndex = -1; const exit = button('Close', async () => close()); exit.setAttribute('aria-label', 'Close GitHub projects'); element.append(title, message, exit, body); }
    return { element, async open() { opener = document.activeElement as HTMLElement; generation++; shell(); element.showModal(); await act(load); element.querySelector<HTMLElement>('h2')?.focus(); }, clear() { generation++; source++; cancelPlan(); project = null; snapshot = null; if (element.open)
            element.close(); }, sourceChanged() { source++; cancelPlan(); if (element.open) {
            if (body.dataset.githubIncoming !== undefined) {
                heading('Writing changed');
                body.append(button('Prepare another GitHub action', load));
            }
            body.querySelector('[data-github-preview]')?.remove();
            message.textContent = 'Writing changed. Save locally, then prepare a new GitHub preview.';
        } }, destroy() { generation++; cancelPlan(); element.remove(); } };
}
