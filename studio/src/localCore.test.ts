import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn(async () => null), isTauri: vi.fn(() => true)}));
import { invoke } from '@tauri-apps/api/core';
import { localCore } from './localCore';
describe('local Core bridge contract', () => {
  beforeEach(() => vi.mocked(invoke).mockClear());
  it('uses guarded writes and narrow close commands', async () => {
    await localCore.saveDocument('session', 'scene.md', 'sha256', 'exact text');
    await localCore.setUnsavedChanges(true); await localCore.requestClose(true);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['save_document', {repositoryId: 'session', relativePath: 'scene.md', expectedHash: 'sha256', text: 'exact text'}],
      ['set_unsaved_changes', {dirty: true}], ['request_close', {discard: true}],
    ]);
  });
  it('uses session-scoped recovery commands and compare-and-delete identifiers', async () => {
    await localCore.readRecovery('session', 'scene.md');
    await localCore.stageRecovery('session', 'scene.md', 'base', 'exact\r\ntext');
    await localCore.discardRecovery('session', 'scene.md', 'draft-id');
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['read_recovery', {repositoryId: 'session', relativePath: 'scene.md'}],
      ['stage_recovery', {repositoryId: 'session', relativePath: 'scene.md', expectedHash: 'base', text: 'exact\r\ntext'}],
      ['discard_recovery', {repositoryId: 'session', relativePath: 'scene.md', recoveryId: 'draft-id'}],
    ]);
  });
  it('uses only the six read-only host commands with session-scoped relative paths', async () => {
    await localCore.pickRepository();
    await localCore.recentRepositories();
    await localCore.openRecentRepository('recent-id');
    await localCore.listDirectory('session-id', 'book');
    await localCore.readDocument('session-id', 'book/scene.md');
    await localCore.loadManuscript('session-id', 'book/scene-manifest.json');
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['pick_repository'], ['recent_repositories'],
      ['open_recent_repository', {id: 'recent-id'}],
      ['list_directory', {repositoryId: 'session-id', relativePath: 'book'}],
      ['read_document', {repositoryId: 'session-id', relativePath: 'book/scene.md'}],
      ['load_manuscript', {repositoryId: 'session-id', relativePath: 'book/scene-manifest.json'}],
    ]);
  });
  it('uses revision-guarded drafting previews and opaque apply, undo, and picker tokens', async () => {
    await localCore.loadDrafting!('session');
    await localCore.previewDraftingChange!('session', 'manifest-hash', {kind: 'reorderScene', sceneId: 'stable-id', beforeId: null});
    await localCore.previewDraftingChange!('session', null, {kind: 'initialize', project: 'New manuscript'});
    await localCore.applyDraftingChange!('session', 'opaque-preview');
    await localCore.undoDraftingChange!('session', 'opaque-undo');
    await localCore.pickDraftingImport!('session');
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['load_drafting', {repositoryId: 'session'}],
      ['preview_drafting_change', {repositoryId: 'session', expectedRevision: 'manifest-hash', change: {kind: 'reorderScene', sceneId: 'stable-id', beforeId: null}}],
      ['preview_drafting_change', {repositoryId: 'session', expectedRevision: null, change: {kind: 'initialize', project: 'New manuscript'}}],
      ['apply_drafting_change', {repositoryId: 'session', previewId: 'opaque-preview'}],
      ['undo_drafting_change', {repositoryId: 'session', undoId: 'opaque-undo'}],
      ['pick_drafting_import', {repositoryId: 'session'}],
    ]);
  });

});

describe('native-only proposal review bridge', () => {
  it('passes only selected-session IDs and exact displayed binding for author confirmation', async () => {
    vi.mocked(invoke).mockClear();
    const binding = {reviewId: 'review', proposalId: 'proposal', baseHash: 'base', replacementHash: 'replacement', diffHash: 'diff'};
    await localCore.listProposals!('session'); await localCore.reviewProposal!('session', 'proposal');
    await localCore.applyProposalReview!('session', binding); await localCore.cancelProposalReview!('session', 'review'); await localCore.reviewProposalRevert!('session', 'receipt');
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['list_proposals', {repositoryId: 'session'}], ['review_proposal', {repositoryId: 'session', proposalId: 'proposal'}],
      ['apply_proposal_review', {repositoryId: 'session', binding}], ['cancel_proposal_review', {repositoryId: 'session', reviewId: 'review'}],
      ['review_proposal_revert', {repositoryId: 'session', receiptId: 'receipt'}],
    ]);
  });
});
