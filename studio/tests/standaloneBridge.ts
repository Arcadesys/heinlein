// Synthetic test storage only. No production import, filesystem, account or network.
import type { LocalCore, RepositorySession } from '../src/localCore';
import type { DraftRequest, DraftResponse, DraftOpened, DraftPreview, StandaloneDraft } from '../src/standaloneDrafts';
export function syntheticDraftBridge(seed: StandaloneDraft[] = [], persist?: (drafts: StandaloneDraft[]) => void) {
    const records = new Map(seed.map(d => [d.id, structuredClone(d)]));
    const leases = new Map<string, string>();
    let serial = seed.length, plan: DraftPreview | null = null;
    let copyPath='placed.md';
    const calls: DraftRequest[] = [];
    const externalCalls: string[] = [];
    let holdSave: ((resume: () => void) => void) | null = null, holdPreview: ((resume: () => void) => void) | null = null, failSave = false, dirty = false;
    let close: (() => void) | null = null;
    const save = () => persist?.([...records.values()]);
    const hash = (text: string) => `synthetic-${text}`;
    const copy = <T>(v: T): T => structuredClone(v);
    const opened = (d: StandaloneDraft): DraftOpened => { const handle = `handle-${++serial}`; leases.set(handle, d.id); return { handle, loaded: { draft: copy(d), warning: null, recoveryRequired: false }, pending: [] }; };
    const get = (handle: string) => {
        const d = records.get(leases.get(handle) ?? '');
        if (!d)
            throw Error('Expired writer lease');
        return d;
    };
    const unavailable = async (): Promise<never> => { throw Error('Synthetic fixture has no native/provider authority'); };
    const session: RepositorySession = { id: 'synthetic-copy', name: 'Independent synthetic copy', manifests: [] };
    const core: LocalCore = { available: () => true, githubRequest: async r => { if(r.action==='localProjects')return []; if(r.action==='localProject')return null; externalCalls.push('github'); return unavailable(); }, askQuestion: async () => { externalCalls.push('provider'); return unavailable(); }, pickRepository: async () => null, recentRepositories: async () => [], openRecentRepository: unavailable, listDirectory: async () => [], readDocument: async (_id, path) => ({ path, text: 'placed text', contentHash: 'synthetic', sizeBytes: 11, frontmatter: null, generatedCompatibility: false }), loadManuscript: unavailable, listSystemFonts: async () => [], saveDocument: unavailable, readRecovery: async () => null, stageRecovery: unavailable, discardRecovery: unavailable, setUnsavedChanges: async (v) => { dirty = v; }, requestClose: async () => {
            if (dirty)
                throw Error('Not kept');
        }, onCloseRequested: async (fn) => { close = fn; return () => { close = null; }; }, standalone: async (request: DraftRequest): Promise<DraftResponse> => {
            calls.push(copy(request));
            switch (request.kind) {
                case 'list': return [...records.values()].filter(d => d.text || d.state === 'discarded').map(d => ({ id: d.id, label: d.label, revision: d.revision, textHash: d.textHash, state: d.state, updatedAt: d.updatedAt, preview: d.text.slice(0, 100), warning: null }));
                case 'create': {
                    const d: StandaloneDraft = { schemaVersion: 1, id: `draft-${++serial}`, revision: 1, label: null, text: request.text, textHash: hash(request.text), state: 'active', updatedAt: Date.now(), placements: [] };
                    records.set(d.id, d);
                    save();
                    return opened(d);
                }
                case 'open': {
                    const d = records.get(request.id);
                    if (!d)
                        throw Error('Missing draft');
                    return opened(d);
                }
                case 'release':
                    leases.delete(request.handle);
                    return null;
                case 'save': {
                    if (holdSave)
                        await new Promise<void>(resolve => { const h = holdSave; holdSave = null; h!(resolve); });
                    if (failSave) {
                        failSave = false;
                        throw Error('Synthetic disk full');
                    }
                    const d = get(request.handle);
                    if (d.state !== 'active')
                        throw Error('Discarded');
                    if (d.revision === request.revision + 1 && d.text === request.text)
                        return copy(d);
                    if (d.revision !== request.revision || d.textHash !== request.hash)
                        throw Error('Stale revision');
                    d.text = request.text;
                    d.textHash = hash(request.text);
                    d.revision++;
                    d.updatedAt = Date.now();
                    save();
                    return copy(d);
                }
                case 'discard':
                case 'restore':
                case 'repair': {
                    const d = get(request.handle);
                    if (request.kind === 'discard' && !window.confirm('Remove this draft? Restore it from Discarded drafts.'))
                        return null;
                    if (d.revision !== request.revision || d.textHash !== request.hash)
                        throw Error('Stale revision');
                    d.state = request.kind === 'discard' ? 'discarded' : 'active';
                    d.revision++;
                    save();
                    return copy(d);
                }
                case 'preview': {
                    const d = get(request.handle);
                    const p = { token: `preview-${++serial}`, destination: `/synthetic/${request.destination}/${request.name}`, revision: d.revision, text: d.text, hash: d.textHash };
                    if (holdPreview)
                        await new Promise<void>(resolve => { const h = holdPreview; holdPreview = null; h!(resolve); });
                    plan = p;
                    return copy(p);
                }
                case 'cancelPreview':
                    plan = null;
                    return null;
                case 'place': {
                    if (!plan || plan.token !== request.token)
                        throw Error('Expired preview');
                    if (!window.confirm('Place independent copy?'))
                        return null;
                    const d = [...records.values()].find(d => d.revision === plan!.revision && d.textHash === plan!.hash);
                    if (!d)
                        throw Error('Stale revision');
                    d.placements.push({ id: `copy-${++serial}`, kind: 'file', destination: plan.destination, sourceRevision: d.revision, sourceHash: d.textHash, sceneId: null, completedAt: Date.now() });
                    d.revision++;
                    plan = null;
                    save();
                    return copy(d);
                }
                case 'reconcile': return copy(get(request.handle));
                case 'openPlaced': return { session, path: copyPath };
            }
        } };
    return { core, calls, records, externalCalls, setCopyPath(path:string){copyPath=path;}, get dirty() { return dirty; }, get close() { return close; }, holdNextSave(fn: (resume: () => void) => void) { holdSave = fn; }, holdNextPreview(fn: (resume: () => void) => void) { holdPreview = fn; }, failNextSave() { failSave = true; } };
}
