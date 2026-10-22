// Synthetic browser-only native host. No filesystem, credentials or provider calls.
// This file is never imported by production entrypoints.
import { mountStudio } from '../../src/studio';
import type { LocalCore, RepositorySession, RecoveryDraft } from '../../src/localCore';
import type { GitHubAuth, GitHubRequest, GitHubResponse, GitHubReceipt, GitHubIncoming } from '../../src/githubTypes';
import '../../src/fonts.bundle';
import '../../src/style.css';
let text = 'Synthetic local draft — exact author words.\n';
let versioned = 'Original synthetic story.\n';
let hash = 'saved-1';
let dirty = false;
let recovery: RecoveryDraft | null = null;
const repo = { id: 42, owner: 'example', name: 'synthetic-story', private: true, defaultBranch: 'main', installationId: 7 };
const workspace = { id: 'synthetic-workspace', repo, accountId: 9, authBinding: 'synthetic-binding', baseOid: 'base', headOid: 'local', remoteOid: null as string | null, branch: 'heinlein/story-synthetic', pr: null as null | {
        number: number;
        url: string;
        state: string;
        merged: boolean;
        draft: boolean;
        head: string;
        base: string;
    } };
const session: RepositorySession = { id: 'synthetic-session', name: 'example/synthetic-story', manifests: [], githubWorkspaceId: workspace.id };
let opened = false;
let receipts: GitHubReceipt[] = [];
let auth: GitHubAuth = { configured: true, account: null, confirmed: false, pending: null, message: 'Synthetic host: no real GitHub connection, files or OS authority.' };
const calls: GitHubRequest[] = [];
Object.assign(window, { githubFixture: { calls, workspace, synthetic: true } });
const change = () => ({ path: 'story.md', kind: 'edit', beforeHash: 'versioned', afterHash: hash });
let incoming: GitHubIncoming = { id: 'synthetic-incoming', workspaceId: workspace.id, branch: workspace.branch, localHead: 'local', githubHead: 'incoming', files: [change()], ready: false, treatment: 'Synthetic candidate. No real files or remote repositories exist.', documents: [{ path: 'story.md', original: text, result: 'Author-approved candidate' }], conflicts: [{ id: 'synthetic-conflict', label: 'Opening scene', kind: 'prose', original: 'Original synthetic story.', yours: text, github: 'GitHub synthetic revision.', resolution: null }] };
const unavailable = async (): Promise<never> => { throw new Error('Synthetic browser host has no native filesystem or OS account authority.'); };
async function githubRequest(r: GitHubRequest): Promise<GitHubResponse> {
    calls.push(structuredClone(r));
    switch (r.action) {
        case 'status': return { auth, error: null, workspaces: opened ? [{ workspace, error: null, incomingRecovery: false, receipts }] : [], app: { id: 5412628, clientId: 'synthetic-public', owner: 'Arcadesys', slug: 'heinlein-studio', installUrl: 'https://github.com/apps/heinlein-studio' } };
        case 'connect':
            auth = { ...auth, pending: { userCode: 'SYNTHETIC', verificationUri: 'https://github.com/login/device', expiresAt: 9999999999, nextPollAt: 0 }, message: 'Synthetic code only. No real sign-in.' };
            return auth;
        case 'poll':
            auth = { ...auth, pending: null, account: { id: 9, login: 'synthetic-writer' }, message: 'Synthetic account awaits confirmation.' };
            return auth;
        case 'confirmAccount':
            auth = { ...auth, confirmed: true, message: 'Synthetic GitHub connected. Saving stays local.' };
            return auth;
        case 'signOut':
            auth = { ...auth, account: null, confirmed: false, pending: null };
            return auth;
        case 'previewOpen': return { id: 'synthetic-open', repository: repo, account: auth.account!, treatment: 'Separate synthetic copy. No filesystem access.' };
        case 'confirmOpen':
        case 'reopen':
            opened = true;
            return session;
        case 'workspace': return { workspace, changes: text === versioned ? [] : [change()], receipts };
        case 'previewVersion':
            if (!r.paths.length || !r.identity.name || !r.identity.email || !r.message)
                throw new Error('Select files and confirm your name, email and version message.');
            return { id: 'synthetic-version', workspaceId: workspace.id, head: workspace.headOid, files: [change()], identity: r.identity, message: r.message };
        case 'previewShare': return { id: r.kind, workspaceId: workspace.id, head: workspace.headOid, files: [change()], identity: { name: '', email: '' }, message: '', kind: r.kind, repository: repo, account: auth.account!, branch: workspace.branch, base: 'main', commits: [workspace.headOid], title: r.title, body: r.body, warning: 'Sending may run repository-configured automation. This fixture never sends anything.' };
        case 'previewIncoming':
            incoming = { ...incoming, ready: false, conflicts: incoming.conflicts.map(c => ({ ...c, resolution: null })) };
            return incoming;
        case 'resolve':
            incoming = { ...incoming, ready: true, conflicts: incoming.conflicts.map(c => ({ ...c, resolution: r.resolution })), documents: [{ path: 'story.md', original: text, result: r.resolution.choice === 'mine' ? text : r.resolution.choice === 'github' ? 'GitHub synthetic revision.' : r.resolution.result }] };
            return incoming;
        case 'confirm': {
            if (dirty || recovery)
                throw new Error('Resolve synthetic local save/recovery first.');
            if (r.previewId === 'synthetic-version') {
                versioned = text;
                workspace.headOid += '-version';
            }
            if (r.previewId === 'push')
                workspace.remoteOid = workspace.headOid;
            if (r.previewId === 'feedback')
                workspace.pr = { number: 1, url: 'https://github.com/example/synthetic-story/pull/1', state: 'open', merged: false, draft: true, head: workspace.branch, base: 'main' };
            if (r.previewId === 'synthetic-incoming') {
                text = incoming.documents[0].result ?? '';
                hash += '-incoming';
                versioned = text;
            }
            const receipt = { id: r.previewId, workspaceId: workspace.id, kind: r.previewId, status: 'succeeded', head: workspace.headOid, message: r.previewId === 'push' ? 'Synthetic versions sent.' : r.previewId === 'feedback' ? 'Synthetic draft feedback request created.' : 'Synthetic local version saved. Nothing sent.', url: null };
            receipts = [receipt, ...receipts];
            return receipt;
        }
        default: return null;
    }
}
const core: LocalCore = { available: () => true, githubRequest, pickRepository: unavailable, recentRepositories: async () => [], openRecentRepository: unavailable, listSystemFonts: async () => [], listDirectory: async () => [{ path: 'story.md', name: 'story.md', kind: 'file', sizeBytes: text.length }], loadManuscript: unavailable, readDocument: async (_id, path) => ({ path, text, contentHash: hash, sizeBytes: text.length, frontmatter: null, generatedCompatibility: false }), saveDocument: async (_id, path, _expected, source) => { text = source; hash += '-saved'; return { path, text, contentHash: hash, sizeBytes: text.length, frontmatter: null, generatedCompatibility: false }; }, readRecovery: async () => recovery, stageRecovery: async (_id, path, baseHash, source) => recovery = { id: 'synthetic-recovery', path, baseHash, text: source, updatedAt: 1 }, discardRecovery: async () => { recovery = null; }, setUnsavedChanges: async (v) => { dirty = v; }, requestClose: async () => { }, onCloseRequested: async () => () => { }, loadDrafting: async () => ({ manifestPath: 'ms/manuscript.json', revision: null, project: null, groups: [], scenes: [], untrackedPaths: ['story.md'], missingPaths: [], recoveryRequired: false }) };
mountStudio(document.querySelector<HTMLElement>('#app')!, core);
// AO's preview can start directly at the real production panel on this synthetic host.
if (new URLSearchParams(location.search).has('github')) document.querySelector<HTMLButtonElement>('.github-entry')?.click();
