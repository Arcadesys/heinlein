import type { LocalCore, ProposalReview, ProposalReceipt, RepositorySession } from './localCore';
import {createProposalDiff} from './proposalDiff';
import {createStageStrip} from './stageStrip';
import {stageOf} from './consensus';
import {collectRevisions, revisionStatus, type Revision} from './revisions';

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
  applied?(receiptId: string): void;
}
export function createProposalPanel(core: LocalCore, hooks: Hooks) {
  const supported = Boolean(core.listProposals && core.reviewProposal && core.reviewProposalRevert && core.applyProposalReview && core.cancelProposalReview);
  const dialogs = new Map<HTMLDialogElement, () => void>();
  let version = 0;
  let disposed = false;
  let loading = false;
  let filter: 'all' | 'pending' | 'history' = 'all';
  let query = '';
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
  const attribution = (origin: ProposalReview['origin']) => origin.kind === 'nativeOpenAi'
    ? `Native OpenAI suggestion · Model: ${origin.model} · Request: ${origin.requestId} · Provider metadata, not authenticated authorship`
    : `Unverified local MCP client: ${origin.clientLabel} · Session: ${origin.sessionId}`;
  function review(view: ProposalReview): Promise<boolean> {
    return new Promise(resolve => {
      const node = dialog(view.kind === 'revert' ? 'Review guarded revert' : 'Review whole-scene proposal');
      node.append(el('p', view.path, 'path'));
      const origin = el('details', '', 'proposal-attribution');
      origin.append(el('summary', 'Suggestion source'), el('p', attribution(view.origin)));
      node.append(origin);
      node.append(createProposalDiff(view.baseText, view.replacementText));
      const fullSource = el('details', '', 'proposal-full-source');
      fullSource.append(el('summary', 'Show full original and replacement'));
      const columns = el('div', '', 'proposal-comparison');
      for (const [title, text] of [['Before · exact current source', view.baseText], ['After · exact replacement', view.replacementText]]) {
        const section = el('section'); section.append(el('h3', title)); const source = el('pre', text, 'source-text'); source.tabIndex = 0; section.append(source); columns.append(section);
      }
      fullSource.append(columns); node.append(fullSource);
      const hashes = el('details', '', 'proposal-bindings');
      hashes.append(el('summary', 'Exact review bindings'), el('p', `Proposal: ${view.proposalId}`), el('p', `Base SHA-256: ${view.baseHash}`), el('p', `Replacement SHA-256: ${view.replacementHash}`), el('p', `Whole-scene diff SHA-256: ${view.diffHash}`));
      node.append(hashes, el('p', 'Accept applies this exact comparison. Changed source or pending recovery will stop the operation.', 'muted'));
      let done = false;
      const finish = (yes: boolean) => { if (done) return; done = true; remove(node); resolve(yes); };
      node.append(button('Cancel', () => finish(false)), button(view.kind === 'revert' ? 'Continue to native confirmation' : 'Accept revision', () => finish(true), 'primary'));
      display(node, () => finish(false));
    });
  }
  async function change(id: string, kind: 'apply' | 'revert', guard?: () => string | null, presenter?: (view: ProposalReview) => Promise<boolean>, prepare?: () => Promise<string>) {
    const repositoryId = hooks.repository()?.id; const current = version;
    if (!repositoryId || disposed) return;
    await hooks.run(async () => {
      let view: ProposalReview | null = null;
      let submitted = false;
      try {
        const before = guard?.(); if (before) throw new Error(before);
        if (prepare) id = await prepare();
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        view = kind === 'apply' ? await core.reviewProposal!(repositoryId, id) : await core.reviewProposalRevert!(repositoryId, id);
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        const loaded = guard?.(); if (loaded) throw new Error(loaded);
        if (!await (presenter ?? review)(view)) { hooks.report('Review canceled. The manuscript was not changed.'); return; }
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        const reviewed = guard?.(); if (reviewed) throw new Error(reviewed);
        submitted = true;
        const outcome = await core.applyProposalReview!(repositoryId, {reviewId: view.id, proposalId: view.proposalId, baseHash: view.baseHash, replacementHash: view.replacementHash, diffHash: view.diffHash});
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        if (!outcome) { hooks.report('Native confirmation canceled. The manuscript was not changed.'); return; }
        if (outcome.receipt.status !== 'failed') await hooks.changed(outcome.receipt.path);
        hooks.report(outcome.warning ?? `${kind === 'revert' ? 'Proposal reverted' : 'Proposal applied'} to ${outcome.receipt.path}. An attributed local receipt has been kept.`, outcome.receipt.status !== 'completed');
        if(kind==='apply'&&!outcome.warning&&outcome.receipt.status==='completed'&&outcome.receipt.revertAvailable)hooks.applied?.(outcome.receipt.id);
      } catch (error) {
        hooks.report(`Proposal operation stopped: ${String(error)}${submitted ? ' Check the local receipts and current source before any retry.' : ''}`, true);
      } finally {
        if (view) await core.cancelProposalReview!(repositoryId, view.id).catch(() => {});
      }
    });
  }
  function receiptItem(receipt: ProposalReceipt, node: HTMLDialogElement) {
    const item = el('article', '', 'proposal-receipt');
    if (receipt.baseText !== undefined && receipt.replacementText !== undefined) item.append(createProposalDiff(receipt.baseText, receipt.replacementText));
    const metadata = el('details'); metadata.append(el('summary', 'Revision record'));
    metadata.append(el('h3', `${receipt.kind === 'reject' ? 'Reject' : receipt.kind === 'revert' ? 'Revert' : 'Apply'} · ${receipt.path} · ${receipt.status}`), el('p', attribution(receipt.origin)),
      el('p', `Author action: ${receipt.kind === 'reject' ? 'Studio explicit rejection' : receipt.authorAction === 'studioAuthorAccept' ? 'Studio Accept' : 'Studio native confirmation'} · Receipt: ${receipt.id}`), el('p', `Proposal: ${receipt.proposalId}`),
      el('p', `Base: ${receipt.baseHash}`, 'path'), el('p', `Replacement: ${receipt.replacementHash}`, 'path'), el('p', `Diff: ${receipt.diffHash}`, 'path'));
    if (receipt.parentReceiptId) metadata.append(el('p', `Reverts receipt: ${receipt.parentReceiptId}`));
    item.append(metadata);
    if (receipt.message) item.append(el('p', receipt.message, receipt.status === 'completed' ? 'muted' : 'drafting-warning'));
    if (receipt.revertAvailable) item.append(button('Review revert', () => { remove(node); void change(receipt.id, 'revert'); }));
    return item;
  }
  async function open() {
    if (!supported || !hooks.repository() || disposed || loading || dialogs.size) return;
    loading = true; const current = version; const repositoryId = hooks.repository()!.id;
    try {
      const [proposalResult, reviewResult] = await Promise.allSettled([
        core.listProposals!(repositoryId), core.listReviews?.(repositoryId) ?? Promise.resolve([]),
      ]);
      if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
      const listing = proposalResult.status === 'fulfilled' ? proposalResult.value : {pending: [], receipts: []};
      const reviews = reviewResult.status === 'fulfilled' ? reviewResult.value : [];
      const revisions = collectRevisions(listing, reviews);
      const node = dialog('Revisions');
      node.classList.add('revisions-dialog');
      const close = () => remove(node);
      const toolbar = el('div', '', 'revision-toolbar');
      toolbar.append(button('Refresh', () => {close(); void open();}), button('Close', close));
      node.append(toolbar);
      const stages = createStageStrip('Revision progress');
      node.append(stages.element);
      node.append(el('p', 'All saved suggestions for this project. Review the before and after, then choose what to keep. Your writing changes only after your confirmation.', 'muted'));
      function loadFailure(message: string, reason: unknown) {
        node.append(el('p', message, 'drafting-warning'));
        const details = el('details'); details.append(el('summary', 'Load error details'), el('pre', String(reason))); node.append(details);
      }
      if (proposalResult.status === 'rejected') loadFailure('External proposals and revision history could not be loaded. Use Refresh above to try again.', proposalResult.reason);
      if (reviewResult.status === 'rejected') loadFailure('Saved in-app reviews could not be loaded. Use Refresh above to try again.', reviewResult.reason);
      const controls = el('div', '', 'revision-filters'); controls.setAttribute('aria-label', 'Filter revisions');
      const content = el('div', '', 'revision-list');
      const count = el('p', '', 'revision-count'); count.setAttribute('role', 'status');
      const search = el('input'); search.type = 'search'; search.placeholder = 'Find a scene or phrase'; search.value = query; search.setAttribute('aria-label', 'Find revisions');
      const filters = (['all', 'pending', 'history'] as const).map(value => {
        const label = value === 'all' ? 'All revisions' : value === 'pending' ? 'Pending' : 'History';
        const control = button(label, () => {filter = value; render();});
        controls.append(control); return {value, control};
      });
      search.addEventListener('input', () => {query = search.value; render();});
      function render() {
        filters.forEach(({value, control}) => control.setAttribute('aria-pressed', String(value === filter)));
        const shown = revisions.filter(revision => (filter === 'all' || (filter === 'pending') === (revision.status === 'pending'))
          && [revision.path, revision.reason, revision.before, revision.after].join('\n').toLocaleLowerCase().includes(query.toLocaleLowerCase()));
        const pending = revisions.filter(r => r.status === 'pending'), scenes = new Set(pending.map(r => r.path)).size;
        count.textContent = `${shown.length} of ${revisions.length} revisions · ${pending.length} pending${pending.length ? ` in ${scenes} ${scenes === 1 ? 'scene' : 'scenes'}` : ''}`;
        // Keep each scene's pending revisions together; the model's own order is otherwise unchanged.
        // Nothing saved yet reads as Ask; open revisions as Decide; all decided as Done.
        const waitingNow = pending.length;
        stages.set(revisions.length ? stageOf({running: false, hasResult: true, waiting: waitingNow}) : 'ask', waitingNow ? `${waitingNow} waiting` : '');
        shown.sort((a, b) => (a.status === 'pending' && b.status === 'pending' ? a.path.localeCompare(b.path) : 0));
        content.replaceChildren();
        if (!shown.length) content.append(el('p', revisions.length ? 'No revisions match this filter.' : 'No saved revisions for this project.'));
        for (const revision of shown) content.append(revisionItem(revision, node, render));
      }
      node.append(controls, search, count, content); render();
      node.append(el('p', 'Revision records retain local decisions, not an authenticated revision ledger.', 'muted'));
      display(node, close);
    } catch (error) { hooks.report(`Revisions could not be loaded: ${String(error)}`, true); }
    finally { if (current === version) loading = false; }
  }
  function revisionItem(revision: Revision, node: HTMLDialogElement, render: () => void) {
    const item = el('article', '', 'proposal-entry revision-entry'); item.dataset.revisionId = revision.id;
    item.dataset.status = revision.status;
    item.append(el('h3', revision.path, 'path'), el('p', `${revisionStatus[revision.status]} · ${revision.source}`, 'revision-state'));
    if (revision.receipt) {item.append(receiptItem(revision.receipt, node)); return item;}
    if (revision.refreshed) item.append(el('p', 'Updated comparison · your saved edits elsewhere in the scene are preserved.'));
    if (revision.unavailable) item.append(el('p', revision.unavailable, 'drafting-warning'));
    if (revision.reason) item.append(el('p', revision.reason));
    if (revision.before !== undefined && revision.after !== undefined) item.append(createProposalDiff(revision.before, revision.after));
    else item.append(el('p', 'Open this revision to see its exact changes.'));
    if (revision.proposal) {
      const source = el('details'); source.append(el('summary', 'Suggestion source'), el('p', attribution(revision.proposal.origin))); item.append(source);
    }
    if (revision.status !== 'pending' && revision.status !== 'outdated') return item;
    const actions = el('div', '', 'revision-actions');
    const accept = button('Accept', () => {
      const repositoryId = hooks.repository()?.id; if (!repositoryId) return;
      node.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input').forEach(control => {control.disabled = true;});
      const displayed = async (view: ProposalReview) => {
        if (revision.proposal) {
          const p = revision.proposal;
          if (view.baseHash !== p.baseHash || view.replacementHash !== p.replacementHash || view.diffHash !== p.diffHash
            || view.baseText !== revision.before || view.replacementText !== revision.after) throw new Error('This revision changed since it was displayed. Refresh and accept the updated comparison.');
        } else if (revision.review) {
          const a = view.origin.kind === 'nativeOpenAi' ? view.origin.review : null;
          if (view.origin.kind !== 'nativeOpenAi' || (revision.review.schemaVersion === 2
            && (!a || a.reviewId !== revision.review.reviewId || a.findingId !== revision.review.edit.id
            || (revision.review.edit.fingerprint && a.fingerprint !== revision.review.edit.fingerprint)))) throw new Error('This suggestion changed since it was displayed. Refresh and accept the updated comparison.');
        }
        return true;
      };
      const refreshAfter = async (operation: Promise<void>) => {
        await operation;
        if (!node.isConnected || repositoryId !== hooks.repository()?.id || disposed) return;
        const scroll = node.scrollTop; remove(node); await open();
        const refreshed = [...dialogs.keys()].find(dialog => dialog.classList.contains('revisions-dialog'));
        if (refreshed) {refreshed.scrollTop = scroll; refreshed.querySelector<HTMLButtonElement>('.revision-actions button:not(:disabled)')?.focus({preventScroll:true});}
      };
      if (revision.review) {
        const {reviewId, edit} = revision.review;
        void refreshAfter(change('', 'apply', undefined, displayed, async () => {
          if (edit.conflictGroup && !edit.selected) {
            if (!core.chooseReviewEdit) throw new Error('Choose this alternative in its saved review first.');
            await core.chooseReviewEdit(repositoryId, reviewId, edit.id);
          }
          return (await core.prepareReviewEdit!(repositoryId, reviewId, edit.id)).proposalId;
        }));
      } else if (revision.proposal) void refreshAfter(change(revision.proposal.id, 'apply', undefined, displayed));
    });
    accept.disabled = Boolean(revision.unavailable || (revision.review && !core.prepareReviewEdit)
      || (revision.proposal && (revision.before === undefined || revision.after === undefined)));
    actions.append(accept);
    const details = button('Details', () => {
      const repositoryId = hooks.repository()?.id; if (!repositoryId) return;
      remove(node);
      if (revision.review) {
        const {reviewId, edit} = revision.review;
        void change('', 'apply', undefined, undefined, async () => {
          if (edit.conflictGroup && !edit.selected) {
            if (!core.chooseReviewEdit) throw new Error('Choose this alternative first.');
            await core.chooseReviewEdit(repositoryId, reviewId, edit.id);
          }
          return (await core.prepareReviewEdit!(repositoryId, reviewId, edit.id)).proposalId;
        });
      } else if (revision.proposal) void change(revision.proposal.id, 'apply');
    });
    details.disabled = accept.disabled; actions.append(details);
    if (revision.review && core.rejectReviewEdit) actions.append(button('Keep mine', () => {void keepReview(revision, item, render);}));
    else if (revision.proposal && core.rejectProposal) actions.append(button('Keep mine', () => {void reject(revision.proposal!.id, item, receipt => {
      revision.status = 'kept';
      revision.receipt = {...receipt, baseText:receipt.baseText ?? revision.before, replacementText:receipt.replacementText ?? revision.after};
      render();
    });}));
    item.append(actions); return item;
  }
  async function keepReview(revision: Revision, item: HTMLElement, render: () => void) {
    const repositoryId = hooks.repository()?.id; const current = version;
    if (!repositoryId || !revision.review || !core.rejectReviewEdit || disposed) return;
    item.querySelectorAll('button').forEach(button => {button.disabled = true;});
    try {
      const {reviewId, edit} = revision.review;
      const updated = await core.rejectReviewEdit(repositoryId, reviewId, edit.id);
      if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
      if (updated.edits.find(value => value.id === edit.id)?.status !== 'rejected') throw new Error('The decision was not confirmed');
      item.querySelector('.revision-actions')?.remove();
      item.querySelector('.revision-state')!.textContent = `Kept mine · ${revision.source}`;
      item.dataset.status = 'kept';
      revision.status = 'kept'; render();
      hooks.report('Kept your text. The suggestion remains in revision history.');
    } catch (error) {if (!disposed && current === version && repositoryId === hooks.repository()?.id) hooks.report(`Decision could not be confirmed: ${String(error)}. Refresh revisions before trying again.`, true);}
  }
  async function reject(id: string, item: HTMLElement, decided: (receipt: ProposalReceipt) => void) {
    const repositoryId = hooks.repository()?.id; const current = version;
    if (!repositoryId || !core.rejectProposal || disposed) return;
    item.querySelectorAll('button').forEach(node => {node.disabled = true;});
    try {
      const receipt = await core.rejectProposal(repositoryId, id);
      if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
      if (receipt.kind !== 'reject' || receipt.status !== 'rejected' || receipt.proposalId !== id) throw new Error('Rejection was not confirmed');
      item.querySelector('.revision-actions')?.remove();
      item.querySelector('.revision-state')!.textContent = 'Kept mine · External proposal'; item.dataset.status = 'kept';
      item.append(el('p', `Immutable local rejection receipt: ${receipt.id}`));
      decided(receipt);
      hooks.report('Suggestion rejected. The manuscript was not changed.');
    } catch (error) {
      if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
      hooks.report(`Rejection could not be confirmed: ${String(error)}. Refresh the local receipts before trying again.`, true);
    }
  }
  return {supported, open, reviewProposal: (id: string, guard?: () => string | null, presenter?: (view: ProposalReview) => Promise<boolean>) => change(id, 'apply', guard, presenter), revert: (receiptId:string)=>change(receiptId,'revert'), clear, destroy() { disposed = true; clear(); }};
}
