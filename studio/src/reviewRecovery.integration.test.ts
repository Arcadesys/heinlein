// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import {syntheticProjects} from '../tests/projectBridge';
import type {LocalCore, ReviewResult} from './localCore';
const apps: ReturnType<typeof mountStudio>[] = [];
beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute('open', '');};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute('open');};
  document.body.replaceChildren(document.createElement('main'));
});
afterEach(() => {apps.splice(0).forEach(app => app.destroy());});
function fixture() {
  const initial = syntheticProjects();
  const seed = initial.state();
  seed.lastOpenedProjectId = 'local-a';
  seed.projects[0].resume = {path: 'scene.md', sourceHash: initial.hash(seed.documents['local-a']['scene.md']), sceneId: null, anchor: 4, head: 4, scrollTop: 0};
  const f = syntheticProjects(seed);
  let saved: ReviewResult = {
    schemaVersion: 2, reviewId: 'saved-job', requestId: 'interrupted-request', model: 'model', scope: 'chapter', projectKey: 'source-key-local-a', edits: [],
    workflow: {accountId: 'account', accountGeneration: 1, definitions: [], decisions: [], contextNotice: 'Synthetic saved review.', sources: [{id: 'source', path: 'scene.md', sourceHash: seed.projects[0].resume.sourceHash, readOnly: false, order: 0}], coverage: ['completed', 'running', 'queued'].map((status, i) => ({id: `call-${i}`, sourceIndex: 0, fromUtf8: 0, toUtf8: 8, windowFrom: 0, windowTo: 8, reviewer: 0, status, requestId: status === 'queued' ? null : `old-${i}`, error: null}))},
    readingFeedback: [{coverageId: 'call-0', path: 'scene.md', reviewer: 'Mechanical', feedback: {overview: 'Saved assessment.', strengths: [], improvements: []}}],
  };
  const initialSource = JSON.stringify(f.documents);
  const continuation = vi.fn<NonNullable<LocalCore['continueReview']>>(async (_repo, _review, requestId) => {
    saved = {...structuredClone(saved), requestId};
    saved.workflow!.coverage.forEach(c => {if (c.status !== 'completed') {c.status = 'completed'; c.requestId = requestId;}});
    return structuredClone(saved);
  });
  const request = vi.fn<NonNullable<LocalCore['requestReview']>>();
  Object.assign(f.core, {
    questionStatus: vi.fn(async () => ({configured: true, model: 'model', selectedModel: 'model', models: [{slug: 'model', displayName: 'Model'}], accounts: [{id: 'account', label: 'Writer', signedIn: true, planEnabled: true}], activeAccountId: 'account', generation: 4, usageLimited: false, signInPending: false, message: 'Ready'})),
    reviewDefinitions: async () => [], previewReview: async () => [],
    listReviews: async (repositoryId: string) => repositoryId === f.active ? [structuredClone(saved)] : [], getReview: async () => structuredClone(saved),
    continueReview: continuation, requestReview: request,
  });
  const app = mountStudio(document.body.firstElementChild as HTMLElement, f.core);apps.push(app);
  return {...f, app, continuation, request, initialSource, getActive: () => f.active, saved: () => saved};
}
it('resumes outstanding jobs automatically when the last project reopens, preserving writer position and source', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.continuation).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(document.querySelector('.review-completion-toast')?.textContent).toContain('1 interrupted review finished'));
  expect(f.continuation.mock.calls[0][0]).toBe(f.getActive());
  expect(f.continuation.mock.calls[0][1]).toBe('saved-job');
  expect(f.saved().workflow!.coverage[0].requestId).toBe('old-0');
  expect(f.request).not.toHaveBeenCalled();
  expect(JSON.stringify(f.documents)).toBe(f.initialSource);
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
  expect(view.state.selection.main.anchor).toBe(4);
  expect(document.querySelector<HTMLElement>('.heinlein-review-panel')!.hidden).toBe(true);
  expect(f.saved().readingFeedback![0].feedback.overview).toBe('Saved assessment.');
});
it('does not recover the old project after a newer project selection wins startup', async () => {
  const f = fixture();
  await f.app.selectRepository(async () => ({id: 'manual-project', projectKey: 'manual', name: 'Manual project', manifests: []}));
  // The synthetic bridge rejects this unregistered session before review dispatch.
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.continuation).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  expect(JSON.stringify(f.documents)).toBe(f.initialSource);
});
