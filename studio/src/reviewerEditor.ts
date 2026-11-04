import type { CustomReviewer, LocalCore } from './localCore';

export const reviewerTemplates: {name: string; text: string}[] = [
    {name: 'Emotional punch', text: 'Find the moments that should hit hardest. Point out where a beat is rushed, undercut by a joke, or explained instead of felt, and where the emotional turn lands softly.'},
    {name: 'Explaining what you just wrote', text: 'Find places where the narration or dialogue explains something the scene has already shown, restates a beat, or tells the reader what to feel right after the moment landed.'},
    {name: 'Pacing', text: 'Note where the scene drags or rushes. Point to passages that slow momentum without earning it and beats that deserve more room.'},
    {name: 'Sensory grounding', text: 'Note stretches where the reader has no sense of place, body, or sensation, and where grounding detail would help without slowing the scene.'},
];
export const blankReviewer = (): CustomReviewer => ({id: '', version: 1, displayName: '', description: '', instructions: '', output: 'notes'});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; }
function button(text: string, action: () => void, cls = '') { const n = el('button', text, cls); n.type = 'button'; n.onclick = action; return n; }
const failure = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;

/** The one reviewer editor, used inline in the review panel and in the Review agents dialog. */
export function reviewerEditorForm(core: LocalCore, draft: CustomReviewer, on: {saved(reviewer: CustomReviewer): void | Promise<void>; deleted?(): void | Promise<void>; cancel(): void}) {
    const form = el('div', '', 'review-agent-editor');
    form.setAttribute('role', 'group');
    form.setAttribute('aria-label', draft.id ? 'Edit reviewer' : 'New reviewer');
    form.append(el('h3', draft.id ? 'Edit reviewer' : 'New reviewer', 'review-label'));
    const nameLabel = el('label', 'Name', 'review-note');
    const name = el('input', '', 'review-agent-name');
    name.type = 'text'; name.maxLength = 60; name.value = draft.displayName;
    name.oninput = () => { draft.displayName = name.value; };
    nameLabel.append(name);
    const areaLabel = el('label', 'What to look for, in plain language', 'review-note');
    const area = el('textarea');
    area.maxLength = 2000; area.rows = 5; area.value = draft.instructions;
    area.oninput = () => { draft.instructions = area.value; };
    areaLabel.append(area);
    if (!draft.id) {
        const startLabel = el('label', 'Start from', 'review-note');
        const select = el('select');
        const blank = el('option', 'Blank');
        blank.value = '';
        select.append(blank);
        reviewerTemplates.forEach((t, i) => { const o = el('option', t.name); o.value = String(i); select.append(o); });
        select.onchange = () => {
            const t = reviewerTemplates[Number(select.value)];
            if (!t) return;
            draft.displayName = t.name; draft.instructions = t.text;
            name.value = t.name; area.value = t.text;
        };
        startLabel.append(select);
        form.append(startLabel);
    }
    form.append(nameLabel, areaLabel);
    const output = el('fieldset', '', 'review-agent-output');
    output.append(el('legend', 'What it should say', 'review-label'));
    for (const [value, text] of [['notes', 'Notes only'], ['notes_and_edits', 'Notes and suggested edits']] as const) {
        const label = el('label', '', 'review-target');
        const radio = el('input');
        radio.type = 'radio'; radio.name = 'review-agent-output'; radio.checked = draft.output === value;
        radio.onchange = () => { draft.output = value; };
        label.append(radio, el('span', text));
        output.append(label);
    }
    form.append(output, el('p', 'Always on: advisory only, em dashes and your content choices protected. Your text can narrow what a reviewer looks for, not loosen these rules.', 'review-scope-detail'));
    const message = el('p', '', 'review-scope-detail');
    message.setAttribute('role', 'status');
    const actions = el('div', '', 'review-agent-actions');
    actions.append(button('Save reviewer', () => { void (async () => {
        if (!draft.displayName.trim() || !draft.instructions.trim()) { message.textContent = 'Give the reviewer a name and describe what to look for.'; return; }
        try { await on.saved(await core.saveCustomReviewer!({...draft})); }
        catch (error) { message.textContent = failure(error, 'The reviewer could not be saved.'); }
    })(); }), button('Cancel', on.cancel, 'review-note-toggle'));
    if (draft.id && on.deleted && core.deleteCustomReviewer) actions.append(button('Delete reviewer', () => { void (async () => {
        if (!window.confirm(`Delete ${draft.displayName || 'this reviewer'}? Past reviews keep their own copy.`)) return;
        try { await core.deleteCustomReviewer!(draft.id); await on.deleted!(); }
        catch (error) { message.textContent = failure(error, 'The reviewer could not be deleted.'); }
    })(); }, 'review-note-toggle'));
    form.append(actions, message);
    return form;
}

/** Review agents dialog: list, create, edit, duplicate and delete reviewers that every project shares. */
export function createReviewerManager(core: LocalCore, root: HTMLElement) {
    let dialog: HTMLDialogElement | null = null;
    async function open() {
        if (dialog || !core.listCustomReviewers || !core.saveCustomReviewer) return;
        const d = document.createElement('dialog');
        dialog = d;
        d.className = 'appearance-dialog review-agents-dialog';
        d.setAttribute('aria-label', 'Review agents');
        const body = el('div', '', 'review-agents-body');
        const close = button('Return to writing', () => finish());
        const finish = () => { if (d.open && typeof d.close === 'function') d.close(); d.remove(); dialog = null; };
        d.addEventListener('cancel', e => { e.preventDefault(); finish(); });
        d.append(el('h2', 'Review agents'), close, el('p', 'Reviewers you define here are available in every project. Each review run still sends only the text you choose.', 'review-scope-detail'), body);
        root.append(d);
        if (d.showModal) d.showModal(); else d.setAttribute('open', '');
        const show = async (editing?: CustomReviewer) => {
            let list: CustomReviewer[] = [];
            try { list = await core.listCustomReviewers!(); } catch { body.replaceChildren(el('p', 'Reviewers could not be loaded.', 'drafting-warning')); return; }
            if (!dialog) return;
            if (editing) {
                const back = async () => { await show(); };
                body.replaceChildren(reviewerEditorForm(core, editing, {saved: back, deleted: back, cancel: () => { void show(); }}));
                body.querySelector<HTMLElement>('.review-agent-name')?.focus();
                return;
            }
            const rows = el('ul', '', 'review-agents-list');
            if (!list.length) rows.append(el('li', 'No custom reviewers yet. Create one to start from a template such as Emotional punch.', 'review-scope-detail'));
            for (const r of list) {
                const row = el('li', '', 'review-agents-row');
                const label = el('span', '', 'review-agents-name');
                label.append(el('strong', r.displayName), el('span', ` · ${r.output === 'notes' ? 'notes only' : 'notes and edits'} · v${r.version}`, 'review-scope-detail'));
                row.append(label,
                    button('Edit', () => { void show({...r}); }, 'review-note-toggle'),
                    button('Duplicate', () => { void (async () => { await core.saveCustomReviewer!({...r, id: '', version: 1, displayName: `${r.displayName} copy`.slice(0, 60)}); await show(); })(); }, 'review-note-toggle'));
                row.lastElementChild!.setAttribute('aria-label', `Duplicate ${r.displayName}`);
                row.children[1].setAttribute('aria-label', `Edit ${r.displayName}`);
                rows.append(row);
            }
            body.replaceChildren(rows, button('+ New reviewer', () => { void show(blankReviewer()); }, 'review-chip-toggle review-chip-new'));
        };
        await show();
        close.focus();
    }
    return {open, isOpen: () => dialog !== null};
}
