import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
export interface RecentRepository { id: string; name: string }
export interface RepositorySession extends RecentRepository { manifests: string[]; warning?: string | null }
export interface Entry { path: string; name: string; kind: 'directory' | 'file'; sizeBytes: number }
export interface Document { path: string; text: string; sizeBytes: number; frontmatter: string | null; generatedCompatibility: boolean; contentHash: string }
export interface Chapter { number: number; title: string; path: string; source: string; scenes: {path: string}[] }
export interface Manuscript { path: string; project: string; schemaVersion: number; volumes: {number: number; title: string; path: string; chapters: Chapter[]}[] }
export interface LocalCore {
  available(): boolean;
  pickRepository(): Promise<RepositorySession | null>;
  recentRepositories(): Promise<RecentRepository[]>;
  openRecentRepository(id: string): Promise<RepositorySession>;
  listDirectory(repositoryId: string, relativePath: string): Promise<Entry[]>;
  readDocument(repositoryId: string, relativePath: string): Promise<Document>;
  loadManuscript(repositoryId: string, relativePath: string): Promise<Manuscript>;
  listSystemFonts(): Promise<string[]>;
  saveDocument(repositoryId: string, relativePath: string, expectedHash: string, text: string): Promise<Document>;
  setUnsavedChanges(dirty: boolean): Promise<void>;
  requestClose(discard: boolean): Promise<void>;
  onCloseRequested(callback: () => void): Promise<() => void>;
}
// Root selection and guarded file writes belong to the native host;
// no credentials, filesystem handles, or absolute root paths enter the renderer.
export const localCore: LocalCore = {
  available: isTauri,
  saveDocument: (repositoryId, relativePath, expectedHash, text) => invoke('save_document', {repositoryId, relativePath, expectedHash, text}),
  setUnsavedChanges: dirty => invoke('set_unsaved_changes', {dirty}),
  requestClose: discard => invoke('request_close', {discard}),
  onCloseRequested: callback => listen('close-requested', callback),
  pickRepository: () => invoke('pick_repository'),
  recentRepositories: () => invoke('recent_repositories'),
  openRecentRepository: id => invoke('open_recent_repository', { id }),
  listDirectory: (repositoryId, relativePath) => invoke('list_directory', { repositoryId, relativePath }),
  readDocument: (repositoryId, relativePath) => invoke('read_document', { repositoryId, relativePath }),
  loadManuscript: (repositoryId, relativePath) => invoke('load_manuscript', { repositoryId, relativePath }),
  listSystemFonts: () => invoke('list_system_fonts'),
};
