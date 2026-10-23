import { createEditor } from './editor';
import type { LocalCore, RepositorySession } from './localCore';
export interface StandaloneDraft {
    schemaVersion: 1;
    id: string;
    revision: number;
    label: string | null;
    text: string;
    textHash: string;
    state: 'active' | 'discarded';
    updatedAt: number;
    placements: {
        id: string;
        kind: string;
        destination: string;
        sourceRevision: number;
        sourceHash: string;
        sceneId: string | null;
        completedAt: number;
    }[];
}
export interface DraftSummary {
    id: string;
    label: string | null;
    revision: number;
    textHash: string;
    state: string;
    updatedAt: number;
    preview: string;
    warning: string | null;
}
export interface DraftOpened {
    handle: string | null;
    loaded: {
        draft: StandaloneDraft;
        warning: string | null;
        recoveryRequired: boolean;
    };
    readOnlyReason?: string | null;
    pending: unknown[];
}
export interface DraftPreview {
    token: string;
    destination: string;
    revision: number;
    text: string;
    hash: string;
}
export type DraftRequest = {
    kind: 'list';
} | {
    kind: 'create';
    text: string;
} | {
    kind: 'open';
    id: string;
} | {
    kind: 'release';
    handle: string;
} | {
    kind: 'save';
    handle: string;
    revision: number;
    hash: string;
    text: string;
} | {
    kind: 'discard' | 'restore' | 'repair';
    handle: string;
    revision: number;
    hash: string;
} | {
    kind: 'preview';
    handle: string;
    revision: number;
    hash: string;
    destination: string;
    name: string;
    title: string;
    project: string;
} | {
    kind: 'place' | 'cancelPreview';
    token: string;
} | {
    kind: 'reconcile';
    handle: string;
} | {
    kind: 'openPlaced';
    handle: string;
    operation: string;
};
export type DraftResponse = DraftSummary[] | DraftOpened | StandaloneDraft | DraftPreview | {
    session: RepositorySession;
    path: string;
} | null;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const n = document.createElement(tag); n.textContent = text; return n; };
const btn = (label: string, act: () => void) => { const b = node('button', label); b.type = 'button'; b.addEventListener('click', act); return b; };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
export const DRAFT_DELAY = 600, DRAFT_MAX_WAIT = 5000;
export function createStandaloneDrafts(core: LocalCore, hooks: {
    root: HTMLElement;
    parent: HTMLElement;
    dirty: (value: boolean) => void;
    sync: () => Promise<unknown>;
    leave: () => Promise<boolean>;
    beforeMount?: () => void;
    modeChanged?:(active:boolean)=>void;
    openCopy: (session: RepositorySession, path: string) => Promise<void>;
}) {
    let active = false, session: DraftOpened | null = null, editor: ReturnType<typeof createEditor> | null = null, text = '', kept = '', epoch = 0, edit = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, maxTimer: ReturnType<typeof setTimeout> | undefined, flight: Promise<boolean> | null = null, failed: string | null = null;
    let pending: {
        revision: number;
        hash: string;
        text: string;
    } | null = null, preview: DraftPreview | null = null, view: HTMLElement | null = null, status: HTMLElement | null = null, busy = false, dead = false;
    const supported = Boolean(core.standalone && core.available());
    const send = async <T>(r: DraftRequest) => await core.standalone!(r) as T;
    const cancelTimers = () => { clearTimeout(timer); clearTimeout(maxTimer); timer = undefined; maxTimer = undefined; };
    const report = (message: string) => {
        if (failed)
            view?.querySelector('details')?.setAttribute('open', '');
        if (status) {
            status.textContent = message;
            status.classList.toggle('error', Boolean(failed));
        }
    };
    const dirty = () => text !== kept || Boolean(pending);
    function discardPreview() {
        if (preview) {
            void send({ kind: 'cancelPreview', token: preview.token }).catch(() => { });
            preview = null;
        }
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(() => void flush(), DRAFT_DELAY); maxTimer ??= setTimeout(() => { maxTimer = undefined; void flush(); }, DRAFT_MAX_WAIT); }
    function changed(raw: string) { text = raw; edit++; failed = null; discardPreview(); hooks.dirty(dirty()); report(dirty() ? 'Keeping on this Mac…' : 'Kept on this Mac'); schedule(); }
    async function flush(): Promise<boolean> {
        if (!active)
            return true;
        cancelTimers();
        if (flight) {
            if (!await flight)
                return false;
            return dirty() ? flush() : true;
        }
        if (session?.loaded.recoveryRequired || session?.readOnlyReason || session?.loaded.draft.state === 'discarded') {
            if (dirty()) {
                failed = 'This draft is read-only. Keep this window open; restore or recover it before editing.';
                report(failed);
                return false;
            }
            return true;
        }
        if (!dirty())
            return true;
        const myEpoch = epoch;
        flight = (async () => {
            try {
                await hooks.sync();
                if (!session) {
                    session = await send<DraftOpened>({ kind: 'create', text: '' });
                    kept = '';
                }
                if (!session.handle)
                    throw Error('This draft has no writer lease. Keep this window open.');
                while (active && epoch === myEpoch && dirty()) {
                    const base = session.loaded.draft;
                    // Retry the identical uncertain request before submitting any later buffer.
                    pending ??= { revision: base.revision, hash: base.textHash, text };
                    const submitted = pending;
                    const saved = await send<StandaloneDraft>({ kind: 'save', handle: session.handle, ...submitted });
                    if (epoch !== myEpoch || !active)
                        return false;
                    session.loaded.draft = saved;
                    kept = submitted.text;
                    pending = null;
                    editor?.markSaved(submitted.text);
                    hooks.dirty(dirty());
                    await hooks.sync();
                }
                failed = null;
                report('Kept on this Mac');
                return true;
            }
            catch (e) {
                failed = `Not kept yet: ${errorText(e)} Keep this window open and use Retry keeping on this Mac.`;
                hooks.dirty(true);
                report(failed);
                return false;
            }
        })();
        const result = await flight;
        flight = null;
        return result;
    }
    function detach(keepHandle?: string) {
        cancelTimers();
        discardPreview();
        epoch++;
        active = false;
        hooks.modeChanged?.(false);
        editor?.destroy();
        editor = null;
        view = null;
        status = null;
        const handle = session?.handle;
        session = null;
        pending = null;
        if (handle && handle !== keepHandle)
            void send({ kind: 'release', handle }).catch(() => { });
    }
    function mount(opened: DraftOpened | null = null) {
        detach(opened?.handle ?? undefined);
        hooks.beforeMount?.();
        active = true;
        hooks.modeChanged?.(true);
        session = opened;
        text = opened?.loaded.draft.text ?? '';
        kept = text;
        edit = 0;
        failed = null;
        view = node('div');
        view.className = 'page standalone-page';
        const title = node('h2', opened?.loaded.draft.label ?? 'Untitled draft');
        title.tabIndex = -1;
        status = node('p', opened?.loaded.warning ?? opened?.readOnlyReason ?? (text ? 'Kept on this Mac' : 'Start writing. Your draft stays on this Mac.'));
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const toolbar = node('div');
        toolbar.className = 'standalone-toolbar';
        toolbar.append(btn('Keep on this Mac', () => void flush()), btn('Choose a destination…', () => void destination()));
        const actions = node('details');
        actions.className = 'standalone-actions';
        actions.append(node('summary', 'Draft actions'), btn('Drafts', () => void list()), btn('New draft', () => void newDraft()), btn('Retry keeping on this Mac', () => void flush()), btn('Remove draft…', () => void transition('discard')));
        toolbar.append(actions);
        if (opened?.loaded.recoveryRequired)
            actions.append(btn('Use recoverable version…', () => void transition('repair')));
        if (opened?.loaded.draft.state === 'discarded')
            toolbar.append(btn('Restore draft', () => void transition('restore')));
        if (opened?.pending.length)
            toolbar.append(btn('Check previous placement', () => void reconcile()));
        for (const receipt of opened?.loaded.draft.placements ?? [])
            actions.append(btn(`Open placed copy: ${receipt.destination.split('/').pop()}`, () => void openCopy(receipt.id)));
        const body = node('div');
        body.className = 'standalone-editor';
        view.append(title, status, toolbar, body, node('p', 'Choosing a destination makes an independent copy. Nothing is uploaded or shared by keeping this draft here.'));
        hooks.parent.replaceChildren(view);
        editor = createEditor(body, text, raw => changed(raw), () => void flush());
        const readOnly = Boolean(opened?.readOnlyReason || opened?.loaded.recoveryRequired || opened?.loaded.draft.state === 'discarded');
        editor.setEditable(!readOnly);
        hooks.dirty(false);
        if (!readOnly)
            editor.view.focus();
        else
            title.focus();
    }
    async function newDraft() {
        if (busy || !await hooks.leave())
            return;
        mount();
    }
    function dialog(label: string) { const d = node('dialog'); d.className = 'appearance-dialog standalone-dialog'; d.setAttribute('aria-label', label); d.append(node('h2', label)); hooks.root.append(d); return d; }
    function show(d: HTMLDialogElement) {
        if (d.showModal)
            d.showModal();
        else
            d.setAttribute('open', '');
        d.querySelector<HTMLElement>('button,input,select')?.focus();
    }
    async function list() {
        if (busy)
            return;
        busy = true;
        try {
            const rows = await send<DraftSummary[]>({ kind: 'list' });
            const d = dialog('Drafts on this Mac');
            d.append(node('p', 'These drafts have no expiry. Discarded drafts can be restored.'));
            const close = () => { d.remove(); editor?.view.focus(); };
            d.append(btn('Back to writing', close), btn('New draft', () => { close(); void newDraft(); }));
            for (const state of ['active', 'discarded', 'unavailable']) {
                const items = rows.filter(r => r.state === state);
                if (!items.length)
                    continue;
                d.append(node('h3', state === 'discarded' ? 'Discarded drafts' : state === 'unavailable' ? 'Needs recovery' : 'Your drafts'));
                for (const row of items) {
                    const line = node('div');
                    line.className = 'draft-list-item';
                    const open = btn(`${row.label ?? 'Untitled draft'} · ${new Date(row.updatedAt).toLocaleString()} · ${row.preview}`, () => void (async () => {
                        if (!await flush())
                            return;
                        try {
                            const opened = await send<DraftOpened>({ kind: 'open', id: row.id });
                            close();
                            mount(opened);
                        }
                        catch (e) {
                            report(errorText(e));
                        }
                    })());
                    if (row.id === session?.loaded.draft.id)
                        open.disabled = true;
                    line.append(open);
                    if (row.warning)
                        line.append(node('p', row.warning));
                    d.append(line);
                }
            }
            if (!rows.length)
                d.append(node('p', 'No kept drafts yet. Start writing in the blank page.'));
            d.addEventListener('cancel', e => { e.preventDefault(); close(); });
            show(d);
        }
        catch (e) {
            report(errorText(e));
        }
        finally {
            busy = false;
        }
    }
    async function transition(kind: 'discard' | 'restore' | 'repair') {
        if (busy)
            return;
        busy = true;
        try {
            if (kind === 'discard' && !await flush())
                return;
            if (!session?.handle) {
                if (!text) {
                    mount();
                    return;
                }
                throw Error('Reopen this draft to obtain its writer lease.');
            }
            const source = session.loaded.draft;
            const generation = edit;
            editor?.setEditable(false);
            const result = await send<StandaloneDraft | null>({ kind, handle: session.handle, revision: source.revision, hash: source.textHash });
            if (!result)
                return;
            if (edit !== generation) {
                failed = 'The draft changed during this action. Keep the visible text; reopen Drafts to compare.';
                report(failed);
                return;
            }
            if (kind === 'discard') {
                mount();
                report('Draft removed from the list. Restore it from Discarded drafts.');
            }
            else
                mount({ ...session, loaded: { draft: result, warning: null, recoveryRequired: false } });
        }
        catch (e) {
            failed = errorText(e);
            report(failed);
        }
        finally {
            busy = false;
            if (active && session?.loaded.draft.state === 'active' && !session.loaded.recoveryRequired && !session.readOnlyReason)
                editor?.setEditable(true);
        }
    }
    async function reconcile() {
        if (!session?.handle || busy)
            return;
        busy = true;
        try {
            const d = await send<StandaloneDraft>({ kind: 'reconcile', handle: session.handle });
            session.loaded.draft = d;
            report('Placement checked. The original draft is retained.');
        }
        catch (e) {
            report(errorText(e));
        }
        finally {
            busy = false;
        }
    }
    async function openCopy(operation: string) {
        if (busy || !await flush() || !session?.handle)
            return;
        busy = true;
        try {
            const copy = await send<{
                session: RepositorySession;
                path: string;
            }>({ kind: 'openPlaced', handle: session.handle, operation });
            await hooks.openCopy(copy.session, copy.path);
        }
        catch (e) {
            report(errorText(e));
        }
        finally {
            busy = false;
        }
    }
    async function destination() {
        if (busy || !await flush())
            return;
        let settingsGeneration = 0;
        const d = dialog('Choose a destination');
        d.append(node('p', 'Place an independent copy. Your standalone draft stays here; later edits are not synchronized. A chosen folder may share files through its own sync tools.'));
        const field = (label: string, input: HTMLInputElement | HTMLSelectElement) => { const l = node('label', label); l.append(input); d.append(l); return input; };
        const choice = node('select');
        for (const [value, label] of [['file', 'New text or Markdown file'], ['existingProject', 'New scene in an existing Heinlein project'], ['newProject', 'New Heinlein project']]) {
            const o = node('option', label);
            o.value = value;
            choice.append(o);
        }
        field('Destination type', choice);
        const name = field('Scene filename / new project folder name', node('input')) as HTMLInputElement;
        name.value = 'draft.md';
        const title = field('Scene title (does not change your text)', node('input')) as HTMLInputElement;
        title.value = 'Untitled scene';
        const project = field('New project name', node('input')) as HTMLInputElement;
        project.value = 'My project';
        const updateFields = () => {
            name.parentElement!.hidden = choice.value === 'file';
            title.parentElement!.hidden = choice.value === 'file';
            project.parentElement!.hidden = choice.value !== 'newProject';
            name.parentElement!.firstChild!.textContent = choice.value === 'newProject' ? 'New project folder name' : 'New scene filename';
            if (choice.value === 'newProject' && name.value === 'draft.md')
                name.value = 'My story';
            if (choice.value === 'existingProject' && name.value === 'My story')
                name.value = 'draft.md';
        };
        choice.addEventListener('change', updateFields);
        updateFields();
        const result = node('div');
        d.append(result);
        const cancel = () => { discardPreview(); d.remove(); editor?.view.focus(); };
        d.append(btn('Cancel', cancel));
        const prepare = btn('Choose location and preview…', () => void (async () => {
            if (busy)
                return;
            busy = true;
            try {
                if (!await flush())
                    return;
                await hooks.sync();
                if (!session?.handle)
                    throw Error('Type something before placing a draft.');
                const generation = edit, myEpoch = epoch, settings = settingsGeneration;
                discardPreview();
                const p = await send<DraftPreview | null>({ kind: 'preview', handle: session.handle, revision: session.loaded.draft.revision, hash: session.loaded.draft.textHash, destination: choice.value, name: name.value, title: title.value, project: project.value });
                if (!p)
                    return;
                if (generation !== edit || settings !== settingsGeneration || myEpoch !== epoch || !d.isConnected) {
                    void send({ kind: 'cancelPreview', token: p.token });
                    throw Error('The draft changed. Keep it and preview again.');
                }
                preview = p;
                const snapshot = node('pre', p.text);
                snapshot.className = 'standalone-snapshot';
                result.replaceChildren(node('p', `Copy revision ${p.revision} to ${p.destination}`), snapshot, btn('Place copy…', () => void place(d, p)));
            }
            catch (e) {
                result.replaceChildren(node('p', errorText(e)));
            }
            finally {
                busy = false;
            }
        })());
        d.append(prepare);
        for (const input of [choice, name, title, project])
            input.addEventListener('input', () => { settingsGeneration++; discardPreview(); result.replaceChildren(node('p', 'Settings changed. Preview again.')); });
        d.addEventListener('cancel', e => { e.preventDefault(); cancel(); });
        show(d);
    }
    async function place(d: HTMLDialogElement, p: DraftPreview) {
        if (busy || preview !== p)
            return;
        busy = true;
        cancelTimers();
        editor?.setEditable(false);
        const generation = edit;
        try {
            await hooks.sync();
            if (dirty())
                throw Error('Your draft changed. Keep it and preview again.');
            const saved = await send<StandaloneDraft | null>({ kind: 'place', token: p.token });
            preview = null;
            if (!saved)
                return;
            if (session) {
                session.loaded.draft = saved;
            }
            const receipt = saved.placements.at(-1)!;
            d.replaceChildren(node('h2', 'Copy placed'), node('p', `Verified copy: ${receipt.destination}. Your original stays here. Later edits are independent.`), btn('Keep editing original', () => { d.remove(); editor?.view.focus(); }), btn('Open placed copy', () => { d.remove(); void openCopy(receipt.id); }));
            if (generation !== edit)
                report('Copy placed. Newer original edits are still being kept here.');
            else
                report('Copy placed; original retained on this Mac.');
        }
        catch (e) {
            failed = errorText(e);
            report(failed);
            d.append(node('p', `${failed} Use Check previous placement before trying another copy.`), btn('Check previous placement', () => { d.remove(); void reconcile(); }));
        }
        finally {
            busy = false;
            editor?.setEditable(true);
            if (dirty())
                schedule();
        }
    }
    return { supported, get active() { return active; }, get text() { return text; }, flush, mount, list, newDraft, detach, async start() {
            mount();
            try {
                const rows = await send<DraftSummary[]>({ kind: 'list' });
                const row = rows.find(r => r.state === 'active');
                if (row && active && !edit && !session) {
                    const myEpoch = epoch;
                    const opened = await send<DraftOpened>({ kind: 'open', id: row.id });
                    if (active && !edit && epoch === myEpoch)
                        mount(opened);
                    else if (opened.handle)
                        await send({ kind: 'release', handle: opened.handle });
                }
            }
            catch (e) {
                report(`Drafts could not be restored: ${errorText(e)}. Your visible page is unchanged.`);
            }
        }, destroy() { dead = true; detach(); }, get dead() { return dead; } };
}
