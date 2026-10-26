export interface GitHubLocalEvidence {workspaceId:string;branch:string;uncommitted:boolean;unsentVersion:boolean;lastSendRecorded:boolean;}
export interface GitHubLocalProject { workspaceId:string; name:string; branch:string; unavailable:string|null; }
/** Safe GitHub DTOs only. Native owns credentials, roots and executable operations. */
import type { RepositorySession } from './localCore';
export interface GitHubUser {
    id: number;
    login: string;
}
export interface GitHubAuth {
    configured: boolean;
    account: GitHubUser | null;
    confirmed: boolean;
    pending: {
        userCode: string;
        verificationUri: string;
        expiresAt: number;
        nextPollAt: number;
    } | null;
    message: string;
}
export interface GitHubRepo {
    id: number;
    owner: string;
    name: string;
    private: boolean;
    defaultBranch: string;
    installationId: number;
}
export interface GitHubRepositories {
    id: string;
    account: GitHubUser;
    repositories: GitHubRepo[];
    unavailable: number;
}
export interface GitHubWorkspace {
    id: string;
    repo: GitHubRepo;
    accountId: number;
    authBinding: string;
    baseBranch?: string | null;
    baseOid: string;
    headOid: string;
    remoteOid: string | null;
    branch: string;
    pr: {
        number: number;
        url: string;
        state: string;
        merged: boolean;
        draft: boolean;
        head: string;
        base: string;
    } | null;
}
export interface GitHubReceipt {
    id: string;
    workspaceId: string;
    kind: string;
    status: string;
    head: string;
    message: string;
    url: string | null;
}
export interface GitHubStatus {
    auth: GitHubAuth | null;
    error: string | null;
    workspaces: {
        workspace: GitHubWorkspace;
        error: string | null;
        incomingRecovery: boolean;
        branchRecovery?: boolean;
        receipts: GitHubReceipt[];
    }[];
    app: {
        id: number;
        clientId: string;
        slug: string;
        owner: string;
        installUrl: string;
    };
}
export interface GitHubChange {
    path: string;
    kind: string;
    beforeHash: string | null;
    afterHash: string | null;
}
export interface GitHubIdentity {
    name: string;
    email: string;
}
export interface GitHubResolution {
    choice: 'mine' | 'github' | 'combined';
    result: string | null;
}
export interface GitHubConflict {
    id: string;
    label: string;
    kind: string;
    original: string;
    yours: string;
    github: string;
    resolution: GitHubResolution | null;
}
export interface GitHubIncoming {
    id: string;
    workspaceId: string;
    branch: string;
    localHead: string;
    githubHead: string;
    files: GitHubChange[];
    conflicts: GitHubConflict[];
    ready: boolean;
    treatment: string;
    referenceLabels?: Record<string,string>;
    documents: {
        path: string;
        original: string | null;
        result: string | null;
    }[];
}
export interface GitHubVersion {
    id: string;
    workspaceId: string;
    head: string;
    files: GitHubChange[];
    identity: GitHubIdentity;
    message: string;
}
export interface GitHubShare extends GitHubVersion {
    kind: string;
    repository: GitHubRepo;
    account: GitHubUser;
    branch: string;
    base: string;
    commits: string[];
    title: string;
    body: string;
    warning: string;
}
export interface GitHubSend extends Omit<GitHubShare, 'identity' | 'message'> {
    selectedFiles: GitHubChange[];
    existingVersions: {head:string;files:GitHubChange[]}[];
    createsVersion:boolean;
    canSend:boolean;
    identity:GitHubIdentity|null;
    message:string;
}
export interface GitHubSendOutcome {localVersionSaved:boolean;receipt:GitHubReceipt|null;message:string;}
export interface GitHubOpen {
    id: string;
    repository: GitHubRepo;
    account: GitHubUser;
    treatment: string;
}
export interface GitHubProject {
    workspace: GitHubWorkspace;
    changes: GitHubChange[];
    receipts: GitHubReceipt[];
}
export type GitHubRequest = {action:'localProject';repositoryId:string} | {
    action: 'localProjects' | 'status' | 'connect' | 'poll' | 'signOut' | 'repositories' | 'retrySaved';
} | {
    action: 'previewListedRepository';
    listId: string;
    repositoryId: number;
} | {
    action: 'confirmAccount';
    userId: number;
} | {
    action: 'openLink';
    kind: 'install' | 'device';
} | {
    action: 'previewOpen';
    url: string;
} | {
    action: 'confirmOpen' | 'cancel';
    previewId: string;
} | {
    action: 'reopen' | 'previewRebind';
    workspaceId: string;
} | {
    action: 'workspace' | 'freshBranch' | 'openFeedback' | 'branches' | 'pullStatus';
    repositoryId: string;
} | {
    action: 'previewBranch';
    repositoryId: string;
    startingBranch: string;
    name: string;
    create: boolean;
} | {
    action: 'previewPullAction';
    repositoryId: string;
    kind: 'ready' | 'merge';
    method: string;
} | {
    action: 'previewVersion';
    repositoryId: string;
    paths: string[];
    identity: GitHubIdentity;
    message: string;
} | {
    action: 'previewSend';
    repositoryId:string; paths:string[]; identity:GitHubIdentity|null; message:string;
} | {
    action: 'previewShare';
    repositoryId: string;
    kind: 'push' | 'feedback' | 'pullRequest';
    title: string;
    body: string;
} | {
    action: 'previewIncoming';
    repositoryId: string;
    target: 'feedback' | 'default';
} | {
    action: 'resolve';
    repositoryId: string;
    previewId: string;
    conflictId: string;
    resolution: GitHubResolution;
} | {
    action: 'confirm';
    repositoryId: string;
    previewId: string;
    identity: GitHubIdentity | null;
} | {
    action: 'reconcile';
    repositoryId: string;
    operationId: string;
} | {
    action: 'recover';
    workspaceId: string;
    operationId: string | null;
};
export type GitHubResponse = GitHubLocalEvidence | GitHubLocalProject[] | GitHubStatus | GitHubAuth | GitHubRepositories | GitHubProject | GitHubOpen | GitHubVersion | GitHubShare | GitHubSend | GitHubSendOutcome | GitHubIncoming | GitHubReceipt | GitHubWorkspace | GitHubBranchChoice[] | GitHubBranchPreview | GitHubPullStatus | GitHubPullPreview | RepositorySession | null;

export interface GitHubBranchChoice { name:string; head:string; local:boolean; defaultBranch:boolean; }
export interface GitHubBranchPreview { id:string; workspaceId:string; account:GitHubUser; repository:GitHubRepo; fromBranch:string; branch:string; startingBranch:string; head:string; base:string; files:GitHubChange[]; treatment:string; }
export interface GitHubPullDetail { pull:NonNullable<GitHubWorkspace['pr']>; nodeId:string; head:string; base:string; stack:string; }
export interface GitHubPullStatus { detail:GitHubPullDetail; readyAllowed:boolean; mergeAllowed:boolean; reason:string; checks:string; }
export interface GitHubPullPreview { id:string; kind:string; account:GitHubUser; repository:GitHubRepo; detail:GitHubPullDetail; method:string; warning:string; }
