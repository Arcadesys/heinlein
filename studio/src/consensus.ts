import type {ReviewEdit} from './localCore';

/** Display-only grouping of a review run's open suggestions. Nothing here decides or applies anything. */
export interface Consensus {
  /** Distinct reviewers that contributed at least one open suggestion. */
  reviewers: string[];
  total: number;
  /** Same change proposed by two or more reviewers. */
  agreed: ReviewEdit[];
  /** Competing replacements for one span, keyed by conflict group; the author must choose. */
  alternatives: ReviewEdit[][];
  /** Proposed by one reviewer, no competing alternative. */
  single: ReviewEdit[];
  /** Agreed suggestions that can be accepted now (source unchanged). */
  acceptableAgreed: ReviewEdit[];
}

export const reviewersOf = (edit: ReviewEdit): string[] => [...new Set((edit.provenance ?? []).map(p => p.displayName))];

export function summarizeConsensus(open: ReviewEdit[]): Consensus {
  const groups = new Map<string, ReviewEdit[]>();
  const agreed: ReviewEdit[] = [], single: ReviewEdit[] = [];
  for (const edit of open) {
    if (edit.conflictGroup) {
      const members = groups.get(edit.conflictGroup) ?? [];
      members.push(edit); groups.set(edit.conflictGroup, members);
    } else if (reviewersOf(edit).length > 1) agreed.push(edit);
    else single.push(edit);
  }
  const names = new Set(open.flatMap(reviewersOf));
  return {
    reviewers: [...names], total: agreed.length + single.length + groups.size, agreed, alternatives: [...groups.values()], single,
    acceptableAgreed: agreed.filter(edit => !edit.sourceStale),
  };
}

/** One sentence for the results header, e.g. "3 reviewers · 7 suggestions · 4 agreed by 2 or more…". */
export function consensusSentence(c: Consensus): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const parts = [c.reviewers.length ? n(c.reviewers.length, 'reviewer') : '', n(c.total, 'suggestion')];
  if (c.agreed.length) parts.push(`${c.agreed.length} agreed by 2 or more reviewers`);
  if (c.alternatives.length) parts.push(`${n(c.alternatives.length, 'span')} with alternatives to choose`);
  if (c.single.length) parts.push(`${c.single.length} from one reviewer`);
  return parts.filter(Boolean).join(' · ');
}

/** How a single suggestion should read on its card. */
export function agreementLabel(edit: ReviewEdit): string {
  const names = reviewersOf(edit);
  if (!names.length) return '';
  return names.length > 1 ? `Agreed by ${names.join(', ')}` : `Only ${names[0]}`;
}

export type Stage = 'ask' | 'run' | 'decide' | 'done';
export const stageLabels: Record<Stage, string> = {ask: 'Ask', run: 'Review run', decide: 'Decide', done: 'Done'};

export function stageOf(state: {running: boolean; hasResult: boolean; waiting: number}): Stage {
  if (state.running) return 'run';
  if (!state.hasResult) return 'ask';
  return state.waiting > 0 ? 'decide' : 'done';
}
