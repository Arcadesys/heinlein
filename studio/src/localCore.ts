import type {UpdateStatus} from './updatePanel';
import type {GitHubRequest,GitHubResponse} from './githubTypes';
import type {FirstStoryState, PublishingMetadata, PublishingCopy} from './firstStory';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
export interface RecentRepository { id: string; name: string }
export interface RepositorySession extends RecentRepository { projectKey?: string; manifests: string[]; warning?: string | null; githubWorkspaceId?: string | null }
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
export type ProposalOrigin =
  | { kind: 'localMcp'; sessionId: string; clientLabel: string; identityAssurance: 'unverifiedLocalProcess' }
  | { kind: 'nativeOpenAi'; sessionId: string; clientLabel: string; identityAssurance: 'unverifiedProviderMetadata'; provider: 'openai'; model: string; requestId: string; review?:{reviewId:string;findingId:string;fingerprint:string;competing:string[]} };
export interface ProposalSummary { id: string; path: string; baseHash: string; replacementHash: string; diffHash: string; origin: ProposalOrigin; createdAtMs: number }
export interface ProposalReview { id: string; kind: 'apply' | 'revert'; proposalId: string; path: string; baseHash: string; replacementHash: string; diffHash: string; baseText: string; replacementText: string; origin: ProposalOrigin; expiresAtMs: number; parentReceiptId: string | null }
export interface ProposalBinding { reviewId: string; proposalId: string; baseHash: string; replacementHash: string; diffHash: string }
export interface ProposalReceipt { id: string; kind: 'apply' | 'revert' | 'reject'; proposalId: string; path: string; baseHash: string; replacementHash: string; diffHash: string; origin: ProposalOrigin; parentReceiptId: string | null; status: 'completed' | 'failed' | 'uncertain' | 'rejected'; message: string | null; createdAtMs: number; revertAvailable: boolean }
export interface ProposalListing { pending: ProposalSummary[]; receipts: ProposalReceipt[] }
export interface ProposalOutcome { receipt: ProposalReceipt; warning: string | null }
export interface QuestionAccount { id: string; label: string; signedIn: boolean; planEnabled: boolean }
export interface QuestionModel { slug: string; displayName: string }
export interface QuestionStatus {
  configured: boolean; model: string | null; message: string;
  accounts: QuestionAccount[]; activeAccountId: string | null; models: QuestionModel[];
  selectedModel: string | null; signInPending: boolean; generation: number; usageLimited: boolean;
}
export interface QuestionConnection { generation: number; accountId: string; model: string }
export interface QuestionMessage { role: 'user' | 'assistant'; text: string }
export interface QuestionRequest { requestId: string; question: string; context: string; history: QuestionMessage[] }
export interface QuestionRevisionTarget { repositoryId: string; path: string; sourceHash: string; fromUtf8: number; toUtf8: number; selectedText: string }
export interface QuestionRevisionAnswer extends QuestionAnswer { proposalId: string; replacementText: string }
export interface QuestionAnswer { requestId: string; text: string; model: string; inputTokens?: number | null; outputTokens?: number | null; incomplete: boolean }
export interface ReviewSnapshot { path: string; source: string; sourceHash: string;sceneId?:string|null }
export interface ReviewerDefinition {id:string; version:number; displayName:string; instructions:string}
export interface ReviewOptions {reviewers:string[]; context:ReviewSnapshot[]; contextNote:string; ranges:{path:string;fromUtf8:number;toUtf8:number}[];reviewId?:string|null}
export interface ReviewCoverage {contextRanges?:{sourceIndex:number;fromUtf8:number;toUtf8:number}[];id:string; sourceIndex:number;fromUtf8:number;toUtf8:number;windowFrom:number;windowTo:number;reviewer:number;status:string;requestId:string|null;error:string|null}
export interface ReviewRequest { requestId: string; repositoryId: string; scope: 'scene' | 'chapter'; snapshots: ReviewSnapshot[]; workflow?:ReviewOptions|null }
export interface ReviewEdit { location?:{line:number;column:number}; id: string; path: string; fromUtf8: number; toUtf8: number; original: string; replacement: string; reason: string; role: 'proofreader' | 'editor'; status: 'pending' | 'prepared' | 'accepted' | 'rejected' | 'supersededByAuthorChoice' | 'blockedByAppliedDecision'; proposalId: string | null; fingerprint?:string;comments?:string[];provenance?:{instanceId:string;definitionId:string;definitionVersion:number;displayName:string;requestId:string;model:string;accountId:string;accountGeneration:number}[];patch?:string;patchHash?:string;conflictGroup?:string|null;selected?:boolean;sourceStale?:boolean }
export interface ReviewResult { reviewId: string; requestId: string; model: string; schemaVersion: 1|2; revision?:number;projectKey?:string|null; scope: 'scene' | 'chapter'; edits: ReviewEdit[]; workflow?:{definitions:{instanceId:string;definition:ReviewerDefinition;hash:string}[];coverage:ReviewCoverage[];sources:{id:string;path:string;sourceHash:string;readOnly:boolean;order:number}[];decisions:{findingId:string;kind:string;competing:string[];proposalId:string|null}[];accountId:string;accountGeneration:number;contextNotice:string}|null }
export interface LocalCore {
  available(): boolean;
  updateRequest?(action: 'status'|'check'|'schedule'):Promise<UpdateStatus>;
  githubRequest?(request: GitHubRequest): Promise<GitHubResponse>;
  loadFirstStory?(repositoryId: string): Promise<FirstStoryState>;
  saveFirstStory?(repositoryId: string, guide: FirstStoryState, markProof: boolean): Promise<FirstStoryState>;
  resetFirstStory?(repositoryId: string): Promise<FirstStoryState | null>;
  previewPublishingCopy?(repositoryId: string, metadata: PublishingMetadata): Promise<PublishingCopy | null>;
  confirmPublishingCopy?(repositoryId: string, previewId: string): Promise<boolean>;
  requestReview?(request: ReviewRequest, connection: QuestionConnection): Promise<ReviewResult>;
  reviewDefinitions?():Promise<ReviewerDefinition[]>;
  previewReview?(request:ReviewRequest):Promise<ReviewCoverage[]>;
  listReviews?(repositoryId:string):Promise<ReviewResult[]>;
  chooseReviewEdit?(repositoryId:string,reviewId:string,editId:string):Promise<ReviewResult>;
  approveReviewEdit?(repositoryId:string,reviewId:string,editId:string):Promise<ProposalOutcome|null>;
  continueReview?(repositoryId:string,reviewId:string,requestId:string,connection:QuestionConnection):Promise<ReviewResult>;
  prepareReviewEdit?(repositoryId: string, reviewId: string, editId: string): Promise<{proposalId: string}>;
  rejectReviewEdit?(repositoryId: string, reviewId: string, editId: string): Promise<ReviewResult>;
  getReview?(repositoryId: string, reviewId: string): Promise<ReviewResult>;
  questionStatus?(): Promise<QuestionStatus>;
  askQuestion?(request: QuestionRequest, connection: QuestionConnection): Promise<QuestionAnswer>;
  suggestQuestionRevision?(request: QuestionRequest, connection: QuestionConnection, target: QuestionRevisionTarget): Promise<QuestionRevisionAnswer>;
  cancelQuestion?(requestId: string): Promise<boolean>;
  connectQuestionAccount?(options: {allowChatgptPlan: boolean; accountId?: string}): Promise<QuestionStatus>;
  cancelQuestionSignIn?(): Promise<void>;
  selectQuestionAccount?(accountId: string): Promise<QuestionStatus>;
  selectQuestionModel?(slug: string): Promise<QuestionStatus>;
  refreshQuestionConnection?(): Promise<QuestionStatus>;
  signOutQuestionAccount?(accountId?: string): Promise<QuestionStatus>;
  openQuestionUsage?(): Promise<void>;
  listProposals?(repositoryId: string): Promise<ProposalListing>;
  rejectProposal?(repositoryId: string, proposalId: string): Promise<ProposalReceipt>;
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
  finishQuitRequest?():Promise<void>;
  onQuitRefused?(callback:(message:string)=>void):Promise<()=>void>;
  onCloseRequested(callback: () => void): Promise<() => void>;
}
// Root selection and guarded file writes belong to the native host;
// no credentials, filesystem handles, or absolute root paths enter the renderer.
export const localCore: LocalCore = {
  available: isTauri,
  updateRequest: action=>invoke('update_request',{action}),
  githubRequest: request => invoke('github_request', {request}),
  loadFirstStory: repositoryId => invoke('load_first_story', {repositoryId}),
  saveFirstStory: (repositoryId, guide, markProof) => invoke('save_first_story', {repositoryId, guide, markProof}),
  resetFirstStory: repositoryId => invoke('reset_first_story', {repositoryId}),
  previewPublishingCopy: (repositoryId, metadata) => invoke('preview_publishing_copy', {repositoryId, metadata}),
  confirmPublishingCopy: (repositoryId, previewId) => invoke('confirm_publishing_copy', {repositoryId, previewId}),
  requestReview: (request, connection) => invoke('request_review', {request, connection}),
  reviewDefinitions:()=>invoke('review_definitions'),
  previewReview:request=>invoke('preview_review',{request}),
  listReviews:repositoryId=>invoke('list_reviews',{repositoryId}),
  chooseReviewEdit:(repositoryId,reviewId,editId)=>invoke('choose_review_edit',{repositoryId,reviewId,editId}),
  approveReviewEdit:(repositoryId,reviewId,editId)=>invoke('approve_review_edit',{repositoryId,reviewId,editId}),
  continueReview:(repositoryId,reviewId,requestId,connection)=>invoke('continue_review',{repositoryId,reviewId,requestId,connection}),
  prepareReviewEdit: (repositoryId, reviewId, editId) => invoke('prepare_review_edit', {repositoryId, reviewId, editId}),
  rejectReviewEdit: (repositoryId, reviewId, editId) => invoke('reject_review_edit', {repositoryId, reviewId, editId}),
  getReview: (repositoryId, reviewId) => invoke('get_review', {repositoryId, reviewId}),
  questionStatus: () => invoke('question_status'),
  askQuestion: (request, connection) => invoke('ask_question', {request, connection}),
  suggestQuestionRevision: (request, connection, target) => invoke('suggest_question_revision', {request, connection, target}),
  cancelQuestion: requestId => invoke('cancel_question', {requestId}),
  connectQuestionAccount: options => invoke('connect_question_account', options),
  cancelQuestionSignIn: () => invoke('cancel_question_sign_in'),
  selectQuestionAccount: accountId => invoke('select_question_account', {accountId}),
  selectQuestionModel: slug => invoke('select_question_model', {slug}),
  refreshQuestionConnection: () => invoke('refresh_question_connection'),
  signOutQuestionAccount: accountId => invoke('sign_out_question_account', {accountId: accountId ?? null}),
  openQuestionUsage: () => invoke('open_question_usage'),
  listProposals: repositoryId => invoke('list_proposals', {repositoryId}),
  rejectProposal: (repositoryId, proposalId) => invoke('reject_proposal', {repositoryId, proposalId}),
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
  finishQuitRequest:()=>invoke('quit_request_finished'),
  onQuitRefused:callback=>listen<string>('quit-refused',event=>callback(event.payload)),
  onCloseRequested: callback => listen('close-requested', callback),
  pickRepository: () => invoke('pick_repository'),
  recentRepositories: () => invoke('recent_repositories'),
  openRecentRepository: id => invoke('open_recent_repository', { id }),
  listDirectory: (repositoryId, relativePath) => invoke('list_directory', { repositoryId, relativePath }),
  readDocument: (repositoryId, relativePath) => invoke('read_document', { repositoryId, relativePath }),
  loadManuscript: (repositoryId, relativePath) => invoke('load_manuscript', { repositoryId, relativePath }),
  listSystemFonts: () => invoke('list_system_fonts'),
};
