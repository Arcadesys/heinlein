import {expect, it, vi} from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({Channel: class {}, invoke: vi.fn(async () => null), isTauri: () => true}));
import {invoke} from '@tauri-apps/api/core';
import {localCore, type ReviewRequest} from './localCore';
import capability from '../src-tauri/capabilities/repository-browser.json';
import config from '../src-tauri/tauri.conf.json';

it('authorizes the production Whole scene bridge in the bundled main window', async () => {
  expect(config.app.security.capabilities).toContain(capability.identifier);
  expect(capability.windows).toEqual(['main']);
  vi.mocked(invoke).mockClear();
  const request: ReviewRequest = {requestId: 'synthetic-request', repositoryId: 'repo', scope: 'scene', snapshots: []};
  const connection = {accountId: 'synthetic-account', model: 'synthetic-model', generation: 1};
  await localCore.reviewDefinitions!();
  await localCore.previewReview!(request);
  await localCore.listReviews!('repo');
  await localCore.requestReview!(request, connection);
  await localCore.getReview!('repo', 'review');
  await localCore.continueReview!('repo', 'review', 'request', connection);
  await localCore.chooseReviewEdit!('repo', 'review', 'edit');
  await localCore.prepareReviewEdit!('repo', 'review', 'edit');
  await localCore.rejectReviewEdit!('repo', 'review', 'edit');
  await localCore.approveReviewEdit!('repo', 'review', 'edit');
  for (const [command] of vi.mocked(invoke).mock.calls) {
    expect(capability.permissions, `${command} must be callable by Whole scene`).toContain(`allow-${command.replaceAll('_', '-')}`);
  }
});
