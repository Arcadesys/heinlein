import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
export interface RecentRepository { id: string; name: string }
export interface RepositorySession extends RecentRepository { projectKey?: string; manifests: string[]; warning?: string | null }
export interface Entry { path: string; name: string; kind: 'directory' | 'file'; sizeBytes: number }
export interface Document { path: string; text: string; sizeBytes: number; frontmatter: string | null; generatedCompatibility: boolean; contentHash: string }
export interface RecoveryDraft { id: string; path: string; baseHash: string; text: string; updatedAt: number; actor?: 'author'; client?: 'studio' }
export interface Chapter { number: number; title: string; path: string; source: string; scenes: {path: string}[] }
export interface Manuscript { path: string; project: string; schemaVersion: number; volumes: {number: number; title: string; path: string; chapters: Chapter[]}[] }
export interface DraftingGroup { id: string; title: string }
export interface DraftingScene { id: string; title: string; path: string; groupId: string | null }
export interface DraftingState {
  manifestPath: string; revision: string | null; project: string;
  groups: DraftingGroup[]; scenes: DraftingScene[];
  untrackedPaths: string[]; missingPaths: string[]; recoveryRequired?: boolean;
}
export type DraftingChange =
  | { kind: 'initialize'; project: string }
  | { kind: 'createScene'; title: string; path: string; groupId?: string | null; beforeId?: string | null }
  | { kind: 'splitScene'; sceneId: string; path: string; title: string; expectedHash: string; byteOffset: number }
  | { kind: 'createGroup'; title: string }
  | { kind: 'moveScene'; sceneId: string; path: string; groupId?: string | null; beforeId?: string | null }
  | { kind: 'reorderScene'; sceneId: string; beforeId: string | null; groupId?: string | null }
  | { kind: 'importRepository'; paths: string[]; destination: string; mode: 'move' | 'copy'; groupId?: string | null; beforeId?: string | null }
  | { kind: 'importExternal'; selectionId: string; destination: string; groupId?: string | null; beforeId?: string | null }
  | { kind: 'reconcile' }
  | { kind: 'recoverInterrupted' }
  | { kind: 'migrateLegacy'; manifestPath: string; project: string };
export interface DraftingFileChange { kind: string; source: string | null; destination: string | null }
export interface DraftingPreview { id: string; summary: string; changes: DraftingFileChange[]; warnings: string[] }
export interface DraftingResult { state: DraftingState; undoId: string | null }
export interface DraftingSelection { id: string; files: {name: string; sizeBytes: number}[] }
export interface ProposalOrigin { kind: 'localMcp'; sessionId: string; clientLabel: string; identityAssurance: 'unverifiedLocalProcess' }
export interface ProposalSummary { id: string; path: string; baseHash: string; replacementHash: string; diffHash: string; origin: ProposalOrigin; createdAtMs: number }
export interface ProposalReview { id: string; kind: 'apply' | 'revert'; proposalId: string; path: string; baseHash: string; replacementHash: string; diffHash: string; baseText: string; replacementText: string; origin: ProposalOrigin; expiresAtMs: number; parentReceiptId: string | null }
export interface ProposalBinding { reviewId: string; proposalId: string; baseHash: string; replacementHash: string; diffHash: string }
export interface ProposalReceipt { id: string; kind: 'apply' | 'revert'; proposalId: string; path: string; baseHash: string; replacementHash: string; diffHash: string; origin: ProposalOrigin; parentReceiptId: string | null; status: 'completed' | 'failed' | 'uncertain'; message: string | null; createdAtMs: number; revertAvailable: boolean }
export interface ProposalListing { pending: ProposalSummary[]; receipts: ProposalReceipt[] }
export interface ProposalOutcome { receipt: ProposalReceipt; warning: string | null }
export interface LocalCore {
  available(): boolean;
  listProposals?(repositoryId: string): Promise<ProposalListing>;
  reviewProposal?(repositoryId: string, proposalId: string): Promise<ProposalReview>;
  reviewProposalRevert?(repositoryId: string, receiptId: string): Promise<ProposalReview>;
  applyProposalReview?(repositoryId: string, binding: ProposalBinding): Promise<ProposalOutcome | null>;
  cancelProposalReview?(repositoryId: string, reviewId: string): Promise<void>;
  loadDrafting?(repositoryId: string): Promise<DraftingState>;
  previewDraftingChange?(repositoryId: string, expectedRevision: string | null, change: DraftingChange): Promise<DraftingPreview>;
  applyDraftingChange?(repositoryId: string, previewId: string): Promise<DraftingResult>;
  undoDraftingChange?(repositoryId: string, undoId: string): Promise<DraftingState>;
  pickDraftingImport?(repositoryId: string): Promise<DraftingSelection | null>;
  onDraftingImportError?(callback: (message: string) => void): Promise<() => void>;
  onDraftingFilesDropped?(callback: (selection: DraftingSelection) => void): Promise<() => void>;
  pickRepository(): Promise<RepositorySession | null>;
  recentRepositories(): Promise<RecentRepository[]>;
  openRecentRepository(id: string): Promise<RepositorySession>;
  listDirectory(repositoryId: string, relativePath: string): Promise<Entry[]>;
  readDocument(repositoryId: string, relativePath: string): Promise<Document>;
  loadManuscript(repositoryId: string, relativePath: string): Promise<Manuscript>;
  listSystemFonts(): Promise<string[]>;
  saveDocument(repositoryId: string, relativePath: string, expectedHash: string, text: string): Promise<Document>;
  readRecovery(repositoryId: string, relativePath: string): Promise<RecoveryDraft | null>;
  stageRecovery(repositoryId: string, relativePath: string, expectedHash: string, text: string): Promise<RecoveryDraft>;
  discardRecovery(repositoryId: string, relativePath: string, recoveryId: string): Promise<void>;
  setUnsavedChanges(dirty: boolean): Promise<void>;
  requestClose(discard: boolean): Promise<void>;
  onCloseRequested(callback: () => void): Promise<() => void>;
}
// Root selection and guarded file writes belong to the native host;
// no credentials, filesystem handles, or absolute root paths enter the renderer.
export const localCore: LocalCore = {
  available: isTauri,
  listProposals: repositoryId => invoke('list_proposals', {repositoryId}),
  reviewProposal: (repositoryId, proposalId) => invoke('review_proposal', {repositoryId, proposalId}),
  reviewProposalRevert: (repositoryId, receiptId) => invoke('review_proposal_revert', {repositoryId, receiptId}),
  applyProposalReview: (repositoryId, binding) => invoke('apply_proposal_review', {repositoryId, binding}),
  cancelProposalReview: (repositoryId, reviewId) => invoke('cancel_proposal_review', {repositoryId, reviewId}),
  loadDrafting: repositoryId => invoke('load_drafting', {repositoryId}),
  previewDraftingChange: (repositoryId, expectedRevision, change) => invoke('preview_drafting_change', {repositoryId, expectedRevision, change}),
  applyDraftingChange: (repositoryId, previewId) => invoke('apply_drafting_change', {repositoryId, previewId}),
  undoDraftingChange: (repositoryId, undoId) => invoke('undo_drafting_change', {repositoryId, undoId}),
  pickDraftingImport: repositoryId => invoke('pick_drafting_import', {repositoryId}),
  onDraftingImportError: callback => listen<string>('drafting-import-error', event => callback(event.payload)),
  onDraftingFilesDropped: callback => listen<DraftingSelection>('drafting-files-dropped', event => callback(event.payload)),
  saveDocument: (repositoryId, relativePath, expectedHash, text) => invoke('save_document', {repositoryId, relativePath, expectedHash, text}),
  readRecovery: (repositoryId, relativePath) => invoke('read_recovery', {repositoryId, relativePath}),
  stageRecovery: (repositoryId, relativePath, expectedHash, text) => invoke('stage_recovery', {repositoryId, relativePath, expectedHash, text}),
  discardRecovery: (repositoryId, relativePath, recoveryId) => invoke('discard_recovery', {repositoryId, relativePath, recoveryId}),
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
