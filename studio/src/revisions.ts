import type {ProposalListing, ProposalReceipt, ProposalSummary, ReviewEdit, ReviewResult} from './localCore';

/** A single presentation model; apply authority remains in the native host. */
export interface Revision {
  id: string;
  path: string;
  before?: string;
  after?: string;
  status: 'pending' | 'applied' | 'kept' | 'superseded' | 'outdated' | 'satisfied' | 'failed' | 'uncertain' | 'reverted';
  source: string;
  reason?: string;
  unavailable?: string | null;
  refreshed?: boolean;
  proposal?: ProposalSummary;
  receipt?: ProposalReceipt;
  review?: {reviewId: string; schemaVersion: 1 | 2; edit: ReviewEdit};
}

export function collectRevisions(listing: ProposalListing, reviews: ReviewResult[]): Revision[] {
  const rows: Revision[] = [];
  const decided = new Set(listing.receipts.map(r => r.proposalId));
  const reviewed = new Set<string>();
  const key = (reviewId: string, findingId: string) => JSON.stringify([reviewId, findingId]);
  const attributed = new Set(listing.receipts.flatMap(r => r.origin.kind === 'nativeOpenAi' && r.origin.review
    ? [key(r.origin.review.reviewId, r.origin.review.findingId)] : []));
  for (const review of reviews) for (const edit of review.edits) {
    reviewed.add(key(review.reviewId, edit.id));
    if ((edit.proposalId && decided.has(edit.proposalId)) || attributed.has(key(review.reviewId, edit.id))) continue;
    rows.push({id: key(review.reviewId, edit.id), path: edit.path, before: edit.original, after: edit.replacement,
      status: edit.status === 'accepted' ? 'applied' : edit.status === 'rejected' ? 'kept'
        : ['supersededByAuthorChoice', 'blockedByAppliedDecision'].includes(edit.status) ? 'superseded' : edit.sourceStale ? 'outdated' : 'pending',
      source: 'In-app review', reason: edit.reason, review: {reviewId: review.reviewId, schemaVersion: review.schemaVersion, edit},
      unavailable: edit.sourceStale ? 'This passage changed outside this review. Request a fresh review for this source.' : null});
  }
  const latest = new Map<string, ProposalSummary>();
  for (const proposal of [...listing.pending].sort((a, b) => b.createdAtMs - a.createdAtMs)) {
    if (decided.has(proposal.id)) continue;
    const a = proposal.origin.kind === 'nativeOpenAi' ? proposal.origin.review : null;
    if (a && reviewed.has(key(a.reviewId, a.findingId))) continue;
    const identity = JSON.stringify([proposal.path, proposal.baseHash, proposal.replacementHash]);
    const newer = latest.get(identity);
    const duplicate = newer && proposal.baseText !== undefined && proposal.replacementText !== undefined
      && newer.baseText === proposal.baseText && newer.replacementText === proposal.replacementText;
    const status = proposal.unavailable?.includes('already present') ? 'satisfied' : proposal.unavailable ? 'outdated' : duplicate ? 'superseded' : 'pending';
    if (status === 'pending') latest.set(identity, proposal);
    rows.push({id: proposal.id, path: proposal.path, before: proposal.baseText, after: proposal.replacementText,
      status, source: proposal.origin.kind === 'localMcp' ? 'External proposal' : 'In-app suggestion',
      reason: duplicate ? 'A newer proposal contains this exact change.' : undefined,
      unavailable: proposal.unavailable, refreshed: proposal.refreshed, proposal});
  }
  for (const receipt of listing.receipts) {
    rows.push({id: receipt.id, path: receipt.path, before: receipt.baseText, after: receipt.replacementText,
      status: receipt.status === 'rejected' ? 'kept' : receipt.status === 'failed' ? 'failed'
        : receipt.status === 'uncertain' ? 'uncertain' : receipt.kind === 'revert' ? 'reverted' : 'applied',
      source: receipt.origin.kind === 'localMcp' ? 'External proposal' : 'In-app suggestion', receipt});
  }
  return rows.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
}

export const revisionStatus: Record<Revision['status'], string> = {
  pending: 'Pending', applied: 'Applied', kept: 'Kept mine', superseded: 'Superseded', outdated: 'Out of date', satisfied: 'Already in your text', failed: 'Failed', uncertain: 'Needs inspection', reverted: 'Reverted',
};
