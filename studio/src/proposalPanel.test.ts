// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { createProposalPanel } from './proposalPanel';
import type { LocalCore, ProposalSummary } from './localCore';
const tick = () => new Promise(r => setTimeout(r, 0));
const proposal = {id: 'p1', path: 'scene.md', baseHash: 'a', replacementHash: 'b', diffHash: 'c', origin: {kind: 'localMcp'}, createdAtMs: 1, baseText: 'Teh', replacementText: 'The'} as unknown as ProposalSummary;
it('repeats a refused Accept inside the Revisions dialog and keeps the entry', async () => {
    document.body.replaceChildren();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    const core = {
        listProposals: vi.fn(async () => ({pending: [proposal], receipts: []})),
        reviewProposal: vi.fn(), reviewProposalRevert: vi.fn(), applyProposalReview: vi.fn(), cancelProposalReview: vi.fn(),
    } as unknown as LocalCore;
    const report = vi.fn();
    // The host refuses to run the action, as it does when the scene has unsaved edits.
    const panel = createProposalPanel(core, {root: document.body, repository: () => ({id: 'repo'} as never), run: async () => 'The scene has unsaved edits.', changed: async () => {}, report});
    await panel.open(); await tick();
    ([...document.querySelectorAll('button')].find(b => b.textContent === 'Accept') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('.revision-next')!.textContent).toContain('Nothing was applied. The scene has unsaved edits.'));
    expect(document.querySelector('.revision-entry[data-status="pending"]')).toBeTruthy();
    expect(core.applyProposalReview).not.toHaveBeenCalled();
});
