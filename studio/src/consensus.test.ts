import {describe, expect, it} from 'vitest';
import type {ReviewEdit} from './localCore';
import {agreementLabel, consensusSentence, stageOf, summarizeConsensus} from './consensus';

const prov = (displayName: string) => ({instanceId: displayName, definitionId: displayName, definitionVersion: 1, displayName, requestId: 'r', model: 'm', accountId: 'a', accountGeneration: 1});
const edit = (id: string, names: string[], extra: Partial<ReviewEdit> = {}): ReviewEdit => ({
  id, path: 'scene.md', fromUtf8: 0, toUtf8: 1, original: 'a', replacement: 'b', reason: '', role: 'editor', status: 'pending', proposalId: null,
  provenance: names.map(prov), ...extra,
});

describe('review consensus', () => {
  it('separates agreed, alternative and single-reviewer suggestions', () => {
    const c = summarizeConsensus([
      edit('1', ['Line', 'Voice']), edit('2', ['Line']), edit('3', ['Voice'], {conflictGroup: 'g'}), edit('4', ['Line'], {conflictGroup: 'g'}),
      edit('5', ['Line', 'Voice'], {sourceStale: true}),
    ]);
    expect(c.agreed.map(e => e.id)).toEqual(['1', '5']);
    expect(c.acceptableAgreed.map(e => e.id)).toEqual(['1']);
    expect(c.single.map(e => e.id)).toEqual(['2']);
    expect(c.alternatives.map(g => g.map(e => e.id))).toEqual([['3', '4']]);
    expect(c.total).toBe(4);
    expect(c.reviewers.sort()).toEqual(['Line', 'Voice']);
  });

  it('counts a reviewer once and writes plain sentences', () => {
    const c = summarizeConsensus([edit('1', ['Line', 'Line']), edit('2', ['Line'])]);
    expect(c.agreed).toEqual([]);
    expect(consensusSentence(c)).toBe('1 reviewer · 2 suggestions · 2 with one reviewer each');
    expect(consensusSentence(summarizeConsensus([]))).toBe('0 suggestions');
  });

  it('does not imply that every single-reviewer suggestion came from the same reviewer', () => {
    const c = summarizeConsensus([edit('1', ['Line']), edit('2', ['Voice']), edit('3', ['Line'])]);
    expect(consensusSentence(c)).toBe('2 reviewers · 3 suggestions · 3 with one reviewer each');
  });

  it('labels agreement and tolerates missing provenance', () => {
    expect(agreementLabel(edit('1', ['A', 'B']))).toBe('Agreed by A, B');
    expect(agreementLabel(edit('1', ['A']))).toBe('Only A');
    expect(agreementLabel(edit('1', []))).toBe('');
  });

  it('maps review state to a stage', () => {
    expect(stageOf({running: false, hasResult: false, waiting: 0})).toBe('ask');
    expect(stageOf({running: true, hasResult: false, waiting: 0})).toBe('run');
    expect(stageOf({running: false, hasResult: true, waiting: 3})).toBe('decide');
    expect(stageOf({running: false, hasResult: true, waiting: 0})).toBe('done');
  });
});
