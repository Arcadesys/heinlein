import { describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn(async () => null), isTauri: vi.fn(() => true)}));
import { invoke } from '@tauri-apps/api/core';
import { localCore } from './localCore';
describe('local Core bridge contract', () => {
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
});
