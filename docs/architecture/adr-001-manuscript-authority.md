# ADR-001: Drafting, Patch Approval, and Release Authority

**Date:** 2026-10-14  
**Status:** Proposed amendment; design only, not implemented.  
**Companion contract:** [Orchestration v0.2.1](orchestration-v0.2.1.md).

## Context

Canonical means authoritative stored text, not editorial consent. Working draft and release-approved describe manuscript snapshots; **patch-approved is an authorization event, not a text state**.

## Decision

**Working draft.** The editable manuscript head. Authors write in Studio or mint a Core-issued, typed `DraftGrant` there, bound to a project, named scenes, authenticated MCP client/session, expiry, and revocation record, and paired to the client through a single-use, short-lived pairing code. Granted saves need no per-save approval but remain unapproved drafts. Core checks the grant and expected revision for every save. Every revision records actor and client ID; Studio lists agent-authored revisions with inspectable diffs and one-click, revision-guarded revert. Revert creates history rather than erasing it. Workers receive a distinct `WorkerGrant` that cannot authorize draft saves; they never receive or exchange it for a `DraftGrant`.

**Patch-approved.** An author action through authenticated Studio authorizes only the displayed patch/hunks, bound to source revision, base hash, diff hash, and a one-time nonce with a short TTL that any change to its bindings invalidates (lifecycle in the companion contract). Applying it creates a working-draft revision, not an approved manuscript state. MCP, workers, and conversational assent cannot approve.

**Release-approved.** Cockpit first displays the count of non-author revisions since the previous release and the scenes they touched, including agent and external changes. Explicit author approval binds a source commit, edition configuration, build-tool versions, and verified artifact hashes through a versioned manifest and annotated Git tag. Core records the tag object ID and matching approval; tag creation alone grants nothing. Names cannot be reused or moved within Heinlein. Changed inputs or artifacts require fresh approval. Patch approval is neither sufficient nor required.

**Authenticated Studio.** Studio/Cockpit's trusted native host uses a separate local IPC channel to Core, bootstrapped through a private inherited socket/pipe handle with a fresh per-launch secret. The handle and secret are excluded from MCP, workers, renderer JavaScript, environment variables, arguments, logs, and shared files. Core checks channel/session authentication and replay guards; MCP exposes no approval or grant-minting route. This assumes uncompromised trusted processes, not protection from an attacker controlling them.

**Persistence and external writers.** Core is Heinlein's only manuscript writer, not the operating system's only writer. Git pulls and other editors are detected and recorded as working-draft revisions with actor `external` and an explicit unknown client when attribution is unavailable. They never imply approval. Core durably journals intent and operation ID, applies file/Git changes, then records completion. Startup reconciliation provides exactly-once logical application, not a shared Git/SQLite transaction; unexpected content stops recovery rather than being overwritten.

## Consequences

Drafting stays local and inference-free. The companion contract defines enforcement and acceptance tests. These are design decisions awaiting review; implementation and adversarial verification remain outstanding.
