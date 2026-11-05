// Synthetic restart fixture only. No manuscripts, native profiles or provider calls.
import {mountStudio} from '../../src/studio';
import {syntheticProjects} from '../projectBridge';
import type {ReviewResult, LocalCore} from '../../src/localCore';
import '../../src/fonts.bundle';
import '../../src/style.css';
const key = 'heinlein-synthetic-review-recovery';
const initial = syntheticProjects(), seed = initial.state();
seed.lastOpenedProjectId = 'local-a';
seed.projects[0].resume = {path: 'scene.md', sourceHash: initial.hash(seed.documents['local-a']['scene.md']), sceneId: null, anchor: 4, head: 4, scrollTop: 0};
const f = syntheticProjects(seed);
const definition = {id: 'mechanical', version: 1, displayName: 'Mechanical', instructions: 'Advice only.'};
const initialReview: ReviewResult = {
  schemaVersion: 2, reviewId: 'saved-job', requestId: 'interrupted-request', model: 'synthetic-model', scope: 'chapter', projectKey: 'source-key-local-a', edits: [],
  workflow: {accountId: 'synthetic-account', accountGeneration: 1, definitions: [{instanceId: 'reviewer-1', definition, hash: 'a'.repeat(64)}], decisions: [], contextNotice: 'Synthetic saved review.', sources: [{id: 'source', path: 'scene.md', sourceHash: seed.projects[0].resume.sourceHash, readOnly: false, order: 0}], coverage: ['completed', 'running', 'queued'].map((status, i) => ({id: `call-${i}`, sourceIndex: 0, fromUtf8: 0, toUtf8: 8, windowFrom: 0, windowTo: 8, reviewer: 0, status, requestId: status === 'queued' ? null : `old-${i}`, error: null}))},
  readingFeedback: [{coverageId: 'call-0', path: 'scene.md', reviewer: 'Mechanical', feedback: {overview: 'The completed first assessment survives restart.', strengths: [], improvements: []}}],
};
let saved: ReviewResult = JSON.parse(localStorage.getItem(key) ?? JSON.stringify(initialReview));
let attempts = Number(localStorage.getItem(`${key}-attempts`) ?? 0), fresh = 0;
let complete: (() => void) | null = null;
const persist = () => localStorage.setItem(key, JSON.stringify(saved));
Object.assign(f.core, {
  questionStatus: async () => ({configured: true, model: 'synthetic-model', selectedModel: 'synthetic-model', models: [{slug: 'synthetic-model', displayName: 'Synthetic model'}], accounts: [{id: 'synthetic-account', label: 'Synthetic writer', signedIn: true, planEnabled: true}], activeAccountId: 'synthetic-account', generation: 4, usageLimited: false, signInPending: false, message: 'Ready'}),
  reviewDefinitions: async () => [definition], previewReview: async () => [],
  listReviews: async () => [structuredClone(saved)], getReview: async () => structuredClone(saved),
  requestReview: async () => {fresh++; throw Error('Recovery must never start a new review.');},
  continueReview: (async (_repository, reviewId, requestId, _connection, progress) => {
    if (reviewId !== saved.reviewId) throw Error('Wrong saved review');
    attempts++; localStorage.setItem(`${key}-attempts`, String(attempts)); persist();
    progress?.({requestId, completedCalls: 1, totalCalls: 3, reviewer: 0, sourceIndex: 0, chunkIndex: 2, status: 'running', receivedBytes: 0, suggestions: 0});
    return new Promise<ReviewResult>(resolve => {complete = () => {
      saved.requestId = requestId;
      saved.workflow!.coverage.forEach(call => {if (call.status !== 'completed') {call.status = 'completed'; call.requestId = requestId;}});
      persist(); resolve(structuredClone(saved)); complete = null;
    };});
  }) as NonNullable<LocalCore['continueReview']>,
});
const app = mountStudio(document.querySelector('#app')!, f.core);
Object.assign(window, {recoveryFixture: {finish: () => complete?.(), state: () => ({attempts, fresh, saved, documents: f.documents}), app}});
