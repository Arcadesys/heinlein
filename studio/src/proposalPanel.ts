import type { LocalCore, ProposalReview, ProposalReceipt, RepositorySession } from './localCore';
import {createProposalDiff} from './proposalDiff';
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
  /** Resolves to the reason when the host refused to start the action. */
  run(action: () => Promise<void>): Promise<string | void>;
  changed(path: string): Promise<void>;
  report(message: string, error?: boolean): void;
  applied?(receiptId: string): void;
  /** Opens a saved in-app review on its scene so the writer can decide with the full review context. */
  openReview?(reviewId: string, path: string): Promise<void> | void;
}
export function createProposalPanel(core: LocalCore, hooks: Hooks) {
  const supported = Boolean(core.listProposals && core.reviewProposal && core.reviewProposalRevert && core.applyProposalReview && core.cancelProposalReview);
  const dialogs = new Map<HTMLDialogElement, () => void>();
  let version = 0;
  let disposed = false;
  let loading = false;
  let filter: 'all' | 'pending' | 'history' = 'all';
  let query = '';
  let progressNote = '';
  let progressError = false;
  // The status bar sits behind the Revisions dialog, so the last outcome is repeated inside it.
  let lastReport: {message: string; error: boolean} | null = null;
  const say = (message: string, error = false) => { lastReport = {message, error}; hooks.report(message, error); };
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
  async function change(id: string, kind: 'apply' | 'revert', guard?: () => string | null, presenter?: (view: ProposalReview) => Promise<boolean>, prepare?: () => Promise<string>): Promise<boolean> {
    const repositoryId = hooks.repository()?.id; const current = version;
    if (!repositoryId || disposed) return false;
    let applied = false, ran = false;
    lastReport = null;
    const refused = await hooks.run(async () => {
      ran = true;
      let view: ProposalReview | null = null;
      let submitted = false;
      try {
        const before = guard?.(); if (before) throw new Error(before);
        if (prepare) id = await prepare();
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        view = kind === 'apply' ? await core.reviewProposal!(repositoryId, id) : await core.reviewProposalRevert!(repositoryId, id);
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        const loaded = guard?.(); if (loaded) throw new Error(loaded);
        if (!await (presenter ?? review)(view)) { say('Review canceled. The manuscript was not changed.'); return; }
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        const reviewed = guard?.(); if (reviewed) throw new Error(reviewed);
        submitted = true;
        const outcome = await core.applyProposalReview!(repositoryId, {reviewId: view.id, proposalId: view.proposalId, baseHash: view.baseHash, replacementHash: view.replacementHash, diffHash: view.diffHash});
        if (disposed || current !== version || repositoryId !== hooks.repository()?.id) return;
        if (!outcome) { say('Native confirmation canceled. The manuscript was not changed.'); return; }
        if (outcome.receipt.status !== 'failed') await hooks.changed(outcome.receipt.path);
        say(outcome.warning ?? `${kind === 'revert' ? 'Proposal reverted' : 'Proposal applied'} to ${outcome.receipt.path}. An attributed local receipt has been kept.`, outcome.receipt.status !== 'completed');
        applied = !outcome.warning && outcome.receipt.status === 'completed';
        if(kind==='apply'&&!outcome.warning&&outcome.receipt.status==='completed'){lastApplied={receiptId:outcome.receipt.revertAvailable?outcome.receipt.id:'',path:outcome.receipt.path};if(outcome.receipt.revertAvailable)hooks.applied?.(outcome.receipt.id);}
      } catch (error) {
        say(`Proposal operation stopped: ${String(error)}${submitted ? ' Check the local receipts and current source before any retry.' : ''}`, true);
      } finally {
        if (view) await core.cancelProposalReview!(repositoryId, view.id).catch(() => {});
      }
    });
    if (!ran) say(`Nothing was applied. ${typeof refused === 'string' ? refused : 'Save your scene and resolve any local recovery, then accept again.'}`, true);
    return applied;
  }
  function receiptItem(receipt: ProposalReceipt, node: HTMLDialogElement) {
    const item = el('article', '', 'proposal-receipt');
    if (receipt.baseText !== undefined && receipt.replacementText !== undefined) item.append(createProposalDiff(receipt.baseText, receipt.replacementText));
    const metadata = el('details'); metadata.append(el('summary', 'Technical details'));
    metadata.append(el('h3', `${receipt.kind === 'reject' ? 'Reject' : receipt.kind === 'revert' ? 'Revert' : 'Apply'} · ${receipt.path} · ${receipt.status}`), el('p', attribution(receipt.origin)),
      el('p', `Author action: ${receipt.kind === 'reject' ? 'Studio explicit rejection' : receipt.authorAction === 'studioAuthorAccept' ? 'Studio Accept' : 'Studio native confirmation'} · Receipt: ${receipt.id}`), el('p', `Proposal: ${receipt.proposalId}`),
      el('p', `Base: ${receipt.baseHash}`, 'path'), el('p', `Replacement: ${receipt.replacementHash}`, 'path'), el('p', `Diff: ${receipt.diffHash}`, 'path'));
    if (receipt.parentReceiptId) metadata.append(el('p', `Reverts receipt: ${receipt.parentReceiptId}`));
    item.append(metadata);
    if (receipt.message) item.append(el('p', receipt.message, receipt.status === 'completed' ? 'muted' : 'drafting-warning'));
    if (receipt.revertAvailable) item.append(button('Review revert', () => { remove(node); void change(receipt.id, 'revert'); }));
    return item;
  }
  type Tab = 'decide' | 'done';
  let tab: Tab = 'decide';
  let progressUndo = '';
  let lastApplied: {receiptId: string; path: string} | null = null;
  const snippet = (text: string, max = 90) => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
  const sourceKind = (r: Revision) => r.review ? 'review' : r.proposal?.origin.kind === 'localMcp' ? 'external' : 'suggestion';
  function who(r: Revision) {
    const named = r.review?.edit.provenance?.map(p => p.displayName).filter(Boolean) ?? [];
    if (named.length) return [...new Set(named)].join(', ');
    if (r.review) return 'Heinlein review';
    return r.proposal?.origin.kind === 'localMcp' ? (r.proposal.origin.clientLabel || 'External suggestion') : 'Heinlein suggestion';
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
      const count = el('p', '', 'revision-count'); count.setAttribute('role', 'status');
      const search = el('input'); search.type = 'search'; search.placeholder = 'Find a scene or phrase'; search.value = query; search.setAttribute('aria-label', 'Find revisions');
      search.hidden = !query;
      const searchToggle = button('Search', () => { search.hidden = !search.hidden; if (!search.hidden) search.focus(); });
      searchToggle.setAttribute('aria-label', 'Search revisions');
      const toolbar = el('div', '', 'revision-toolbar');
      toolbar.append(count, searchToggle, button('Close', close));
      node.append(toolbar, search);
      const progress = el('div', '', 'revision-next'); progress.setAttribute('role', 'status');
      if (progressNote) {
        progress.append(el('span', progressNote));
        if (progressError) progress.classList.add('drafting-warning');
        if (progressUndo) { const receiptId = progressUndo; progress.append(button('Undo', () => { remove(node); void change(receiptId, 'revert'); }, 'revision-undo')); }
      }
      progressNote = ''; progressError = false; progressUndo = '';
      node.append(progress);
      function loadFailure(message: string, reason: unknown) {
        const box = el('div', '', 'revision-load-error');
        box.append(el('p', message, 'drafting-warning'), button('Try again', () => {close(); void open();}));
        const details = el('details'); details.append(el('summary', 'Load error details'), el('pre', String(reason))); box.append(details);
        node.append(box);
      }
      if (proposalResult.status === 'rejected') loadFailure('External proposals and revision history could not be loaded.', proposalResult.reason);
      if (reviewResult.status === 'rejected') loadFailure('Saved in-app reviews could not be loaded.', reviewResult.reason);
      const tabs = el('div', '', 'revision-filters'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Filter revisions');
      const content = el('div', '', 'revision-list');
      const footer = el('div', '', 'revision-progress');
      const tabButtons = (['decide', 'done'] as const).map(value => {
        const control = button('', () => { tab = value; openId = null; render(); });
        tabs.append(control); return {value, control};
      });
      search.addEventListener('input', () => {query = search.value; openId = null; render();});
      let openId: string | null = null;
      function render() {
        const pending = revisions.filter(r => r.status === 'pending');
        const done = revisions.filter(r => r.status !== 'pending');
        tabButtons.forEach(({value, control}) => {
          control.textContent = `${value === 'decide' ? 'To decide' : 'Done'} ${value === 'decide' ? pending.length : done.length}`;
          control.setAttribute('aria-pressed', String(value === tab));
        });
        const match = (r: Revision) => [r.path, r.reason, r.before, r.after, who(r)].join('\n').toLocaleLowerCase().includes(query.toLocaleLowerCase());
        const shown = (tab === 'decide' ? pending : done).filter(match);
        node.dataset.pending = String(pending.length);
        const scenes = new Set(pending.map(r => r.path)).size;
        count.textContent = !revisions.length ? 'No saved revisions' : pending.length ? `${pending.length} to decide in ${scenes} ${scenes === 1 ? 'scene' : 'scenes'}` : 'All decided';
        footer.replaceChildren();
        if (revisions.length) {
          const bar = el('div', '', 'revision-bar'); const fill = el('div'); fill.style.width = `${Math.round(100 * done.length / revisions.length)}%`; bar.append(fill);
          footer.append(bar, el('span', `${done.length} of ${revisions.length} decided`));
        }
        content.replaceChildren();
        if (!shown.length) content.append(el('p', query ? 'No revisions match your search.' : tab === 'decide' ? (revisions.length ? 'Nothing left to decide.' : 'No saved revisions for this project.') : 'Nothing decided yet.', 'muted'));
        if (tab === 'decide') {
          shown.sort((a, b) => a.path.localeCompare(b.path));
          if (!openId || !shown.some(r => r.id === openId)) openId = shown[0]?.id ?? null;
          let group: HTMLElement | null = null, last = '';
          for (const revision of shown) {
            if (revision.path !== last) {
              last = revision.path;
              const n = shown.filter(r => r.path === last).length;
              group = el('section', '', 'revision-group');
              group.append(el('h3', `${last} · ${n} to decide`, 'path'));
              content.append(group);
            }
            const item = revisionItem(revision, node, render, revision.id === openId, () => { openId = openId === revision.id ? null : revision.id; render(); });
            group!.append(item);
          }
        } else for (const revision of shown) content.append(revisionItem(revision, node, render, true));
      }
      if (!revisions.some(r => r.status === 'pending') && revisions.length) tab = 'done';
      node.append(tabs, content, footer, el('p', 'Revision records retain local decisions, not an authenticated revision ledger.', 'muted')); render();
      display(node, close);
    } catch (error) { hooks.report(`Revisions could not be loaded: ${String(error)}`, true); }
    finally { if (current === version) loading = false; }
  }
  function revisionItem(revision: Revision, node: HTMLDialogElement, render: () => void, expanded: boolean, toggle?: () => void) {
    const item = el('article', '', 'proposal-entry revision-entry'); item.dataset.revisionId = revision.id;
    item.dataset.status = revision.status; item.dataset.source = sourceKind(revision);
    const body = el('div', '', 'revision-body');
    if (toggle) {
      const head = button('', toggle, 'revision-toggle');
      head.setAttribute('aria-expanded', String(expanded));
      head.append(el('span', who(revision), 'revision-who'), el('span', snippet(revision.reason ?? revision.before ?? ''), 'revision-gist'));
      item.append(head);
      body.hidden = !expanded;
    } else item.append(el('h3', revision.path, 'path'));
    item.append(body);
    const state = el('p', revision.status === 'pending' ? '' : `${revisionStatus[revision.status]} · ${who(revision)}`, 'revision-state');
    state.hidden = revision.status === 'pending';
    body.append(state);
    if (revision.receipt) {body.append(receiptItem(revision.receipt, node)); return item;}
    if (toggle) body.append(el('p', who(revision), 'revision-by'));
    if (revision.refreshed) body.append(el('p', 'Updated comparison · your saved edits elsewhere in the scene are preserved.'));
    if (revision.unavailable) body.append(el('p', revision.unavailable, 'drafting-warning'));
    if (revision.reason) body.append(el('p', revision.reason, 'revision-reason'));
    if (revision.before !== undefined && revision.after !== undefined) body.append(createProposalDiff(revision.before, revision.after));
    else body.append(el('p', 'Open the full comparison to see the exact changes.'));
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
      const refreshAfter = async (operation: Promise<boolean | void>) => {
        lastApplied = null;
        const applied = await operation;
        if (!node.isConnected || repositoryId !== hooks.repository()?.id || disposed) return;
        const scroll = node.scrollTop;
        const waiting = Math.max(0, Number(node.dataset.pending ?? 0) - 1);
        if (!applied && lastReport) { progressNote = lastReport.message; progressError = lastReport.error; }
        const result = lastApplied as {receiptId: string; path: string} | null;
        if (applied) {
          progressNote = `Applied to ${result?.path ?? revision.path}. Your text is updated.${waiting ? ` ${waiting} left to decide.` : ' All decided.'}`;
          progressUndo = result?.receiptId ?? '';
        }
        remove(node); await open();
        const refreshed = [...dialogs.keys()].find(dialog => dialog.classList.contains('revisions-dialog'));
        if (refreshed) {
          refreshed.scrollTop = scroll;
          const next = refreshed.querySelector<HTMLElement>('.revision-entry[data-status="pending"]');
          const target = next?.querySelector<HTMLButtonElement>('.revision-actions button:not(:disabled)') ?? refreshed.querySelector<HTMLButtonElement>('.revision-actions button:not(:disabled)');
          target?.focus({preventScroll: true});
          if (applied) (next ?? refreshed.querySelector('.revision-next'))?.scrollIntoView?.({block: 'nearest'});
        }
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
    }, 'primary');
    accept.disabled = Boolean(revision.unavailable || (revision.review && !core.prepareReviewEdit)
      || (revision.proposal && (revision.before === undefined || revision.after === undefined)));
    actions.append(accept);
    if (revision.review && core.rejectReviewEdit) actions.append(button('Keep mine', () => {void keepReview(revision, item, render);}));
    else if (revision.proposal && core.rejectProposal) actions.append(button('Keep mine', () => {void reject(revision.proposal!.id, item, receipt => {
      revision.status = 'kept';
      revision.receipt = {...receipt, baseText:receipt.baseText ?? revision.before, replacementText:receipt.replacementText ?? revision.after};
      render();
    });}));
    const more = el('details', '', 'revision-more');
    more.append(el('summary', 'More'));
    const menu = el('div', '', 'revision-more-menu');
    const full = button('Full comparison', () => {
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
    full.disabled = accept.disabled; menu.append(full);
    if (revision.review && hooks.openReview) {
      const {reviewId} = revision.review;
      menu.append(button('Open in review', () => {remove(node); void Promise.resolve(hooks.openReview!(reviewId, revision.path)).catch(error => hooks.report(`The review could not be opened: ${String(error)}`, true));}));
    }
    if (revision.proposal) {
      const source = el('details'); source.append(el('summary', 'Suggestion source'), el('p', attribution(revision.proposal.origin))); menu.append(source);
    }
    more.append(menu); actions.append(more);
    body.append(actions); return item;
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
