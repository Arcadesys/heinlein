import type { LocalCore, ProposalReview, ProposalReceipt, RepositorySession } from './localCore';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function button(label: string, action: () => void, className = '') {
  const node = el('button', label, className); node.type = 'button'; node.addEventListener('click', action); return node;
}
interface Hooks {
  root: HTMLElement;
  repository(): RepositorySession | null;
  run(action: () => Promise<void>): Promise<void>;
  changed(path: string): Promise<void>;
  report(message: string, error?: boolean): void;
}
export function createProposalPanel(core: LocalCore, hooks: Hooks) {
  const supported = Boolean(core.listProposals && core.reviewProposal && core.reviewProposalRevert && core.applyProposalReview && core.cancelProposalReview);
  const dialogs = new Map<HTMLDialogElement, () => void>();
  let version = 0;
  let disposed = false;
  let loading = false;
  function remove(node: HTMLDialogElement) { dialogs.delete(node); node.remove(); }
  function clear() { version++; loading = false; for (const cancel of [...dialogs.values()]) cancel(); }
  function dialog(title: string) {
    const node = el('dialog', '', 'appearance-dialog proposal-dialog'); node.setAttribute('aria-label', title); node.append(el('h2', title)); return node;
  }
  function display(node: HTMLDialogElement, cancel: () => void) {
    dialogs.set(node, cancel); hooks.root.append(node);
    node.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    if (node.showModal) node.showModal(); else node.setAttribute('open', '');
    node.querySelector('button')?.focus();
  }
  const attribution = (origin: ProposalReview['origin']) => `Unverified local MCP client: ${origin.clientLabel} · Session: ${origin.sessionId}`;
  function review(view: ProposalReview): Promise<boolean> {
    return new Promise(resolve => {
      const node = dialog(view.kind === 'revert' ? 'Review guarded revert' : 'Review whole-scene proposal');
      node.append(el('p', view.path, 'path'), el('p', attribution(view.origin), 'proposal-attribution'),
        el('p', 'Client labels, sessions, and proposal contents are untrusted. This changes a working draft only; it does not approve a release.', 'drafting-warning'));
      const columns = el('div', '', 'proposal-comparison');
      for (const [title, text] of [['Before · exact current source', view.baseText], ['After · exact replacement', view.replacementText]]) {
        const section = el('section'); section.append(el('h3', title)); const source = el('pre', text, 'source-text'); source.tabIndex = 0; section.append(source); columns.append(section);
      }
      node.append(columns);
      const hashes = el('details', '', 'proposal-bindings');
      hashes.append(el('summary', 'Exact review bindings'), el('p', `Proposal: ${view.proposalId}`), el('p', `Base SHA-256: ${view.baseHash}`), el('p', `Replacement SHA-256: ${view.replacementHash}`), el('p', `Whole-scene diff SHA-256: ${view.diffHash}`));
      node.append(hashes, el('p', 'This one-use review expires after five minutes. Continue to a separate native author confirmation. Changed source or pending recovery will stop the operation.', 'muted'));
      let done = false;
      const finish = (yes: boolean) => { if (done) return; done = true; remove(node); resolve(yes); };
      node.append(button('Cancel', () => finish(false)), button('Continue to native confirmation', () => finish(true), 'primary'));
      display(node, () => finish(false));
    });
  }
  async function change(id: string, kind: 'apply' | 'revert') {
    const repositoryId = hooks.repository()?.id; const current = version;
    if (!repositoryId || disposed) return;
    await hooks.run(async () => {
      let view: ProposalReview | null = null;
      let submitted = false;
      try {
        view = kind === 'apply' ? await core.reviewProposal!(repositoryId, id) : await core.reviewProposalRevert!(repositoryId, id);
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        if (!await review(view)) { hooks.report('Review canceled. The manuscript was not changed.'); return; }
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        submitted = true;
        const outcome = await core.applyProposalReview!(repositoryId, {reviewId: view.id, proposalId: view.proposalId, baseHash: view.baseHash, replacementHash: view.replacementHash, diffHash: view.diffHash});
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        if (!outcome) { hooks.report('Native confirmation canceled. The manuscript was not changed.'); return; }
        if (outcome.receipt.status !== 'failed') await hooks.changed(outcome.receipt.path);
        hooks.report(outcome.warning ?? `${kind === 'revert' ? 'Proposal reverted' : 'Proposal applied'} to ${outcome.receipt.path}. An attributed local receipt has been kept.`, outcome.receipt.status !== 'completed');
      } catch (error) {
        hooks.report(`Proposal operation stopped: ${String(error)}${submitted ? ' Check the local receipts and current source before any retry.' : ''}`, true);
      } finally {
        if (view) await core.cancelProposalReview!(repositoryId, view.id).catch(() => {});
      }
    });
  }
  function receiptItem(receipt: ProposalReceipt, node: HTMLDialogElement) {
    const item = el('article', '', 'proposal-receipt');
    item.append(el('h3', `${receipt.kind === 'revert' ? 'Revert' : 'Apply'} · ${receipt.path} · ${receipt.status}`), el('p', attribution(receipt.origin)),
      el('p', `Author action: Studio native confirmation · Receipt: ${receipt.id}`), el('p', `Proposal: ${receipt.proposalId}`),
      el('p', `Base: ${receipt.baseHash}`, 'path'), el('p', `Replacement: ${receipt.replacementHash}`, 'path'), el('p', `Diff: ${receipt.diffHash}`, 'path'));
    if (receipt.parentReceiptId) item.append(el('p', `Reverts receipt: ${receipt.parentReceiptId}`));
    if (receipt.message) item.append(el('p', receipt.message, receipt.status === 'completed' ? 'muted' : 'drafting-warning'));
    if (receipt.revertAvailable) item.append(button('Review revert', () => { remove(node); void change(receipt.id, 'revert'); }));
    return item;
  }
  async function open() {
    if (!supported || !hooks.repository() || disposed || loading || dialogs.size) return;
    loading = true; const current = version; const repositoryId = hooks.repository()!.id;
    try {
      const result = await core.listProposals!(repositoryId);
      if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
      const node = dialog('Local MCP proposals and receipts');
      node.append(el('p', 'MCP can read and propose. Only an explicit author action in Studio can apply a reviewed whole-scene change.', 'muted'));
      node.append(el('h3', 'Pending proposals'));
      if (!result.pending.length) node.append(el('p', 'No pending proposals for this repository.'));
      for (const proposal of result.pending) {
        const item = el('article', '', 'proposal-entry');
        item.append(el('p', proposal.path, 'path'), el('p', attribution(proposal.origin)), button('Review proposal', () => { remove(node); void change(proposal.id, 'apply'); }));
        node.append(item);
      }
      node.append(el('h3', 'Local immutable operation receipts'), el('p', 'Receipts retain the original unverified proposal attribution and separate author action. They are local operation records, not an authenticated revision ledger. Revert is available only for confirmed applies from this Studio session, and only while the scene still matches.', 'muted'));
      if (!result.receipts.length) node.append(el('p', 'No local operation receipts for this repository.'));
      for (const receipt of result.receipts) node.append(receiptItem(receipt, node));
      const close = () => remove(node);
      node.append(button('Close', close), button('Refresh', () => { close(); void open(); })); display(node, close);
    } catch (error) { hooks.report(`Proposals could not be loaded: ${String(error)}`, true); }
    finally { if (current === version) loading = false; }
  }
  return {supported, open, clear, destroy() { disposed = true; clear(); }};
}
