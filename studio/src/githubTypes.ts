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
export type GitHubRequest = {
    action: 'status' | 'connect' | 'poll' | 'signOut' | 'repositories' | 'retrySaved';
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
    action: 'workspace' | 'freshBranch' | 'openFeedback';
    repositoryId: string;
} | {
    action: 'previewVersion';
    repositoryId: string;
    paths: string[];
    identity: GitHubIdentity;
    message: string;
} | {
    action: 'previewShare';
    repositoryId: string;
    kind: 'push' | 'feedback';
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
export type GitHubResponse = GitHubStatus | GitHubAuth | GitHubRepositories | GitHubProject | GitHubOpen | GitHubVersion | GitHubShare | GitHubIncoming | GitHubReceipt | GitHubWorkspace | RepositorySession | null;
