# Heinlein local drafting MCP

Minimal local **read/proposal** workflow for an external Claude/Codex MCP client.
This is not granted draft saving or an implementation of the complete ADR-001
authority contract. No client configuration, credentials, persistent access,
network listener, provider call, or background service is installed or required.
MCP transports untrusted manuscript data and pending proposals. Only a later,
separately authenticated/native Studio author flow may apply them through Core.

## Build and explicitly launch

macOS/Linux with Rust and Cargo:

```sh
cd studio
cargo build --locked -p heinlein-local-mcp --release
./target/release/heinlein-local-mcp \
  --repository /absolute/path/to/selected-project \
  --scene ms/scenes/selected-scene.md \
  --proposal-store /absolute/private/path/pending-proposals-v1 \
  --client-label 'Codex local drafting'
```

The command speaks MCP JSON-RPC on stdin/stdout; human diagnostics go to stderr.
Use `--help` for its arguments. Supply `--scene` once for each selected existing
Markdown scene (1–128). Nothing recursively discovers manuscripts or expands
scope. Relative root/store paths, duplicate selections, symlinks, ignored/internal
paths, non-Markdown files and generated compatibility files are rejected. The
proposal-store path must be outside and not contain the repository. There is no
default home-directory scan or environment-driven scope.

When the author elects to set up an MCP client, its stdio launch entry should point
to the built binary and the explicit arguments above. Do not put author secrets,
credentials or approval tokens into arguments or environment. Client-specific
setup is intentionally not installed by this slice. Recommended matching Studio
store: its native `app_data_dir/pending-proposals-v1`. Choose/verify the same path
through the native application; no raw store path is exposed in a tool response.
The client may have its own cloud model/inference charges and data-disclosure
policy: the local MCP server does not make that external client local-only or
sandbox the client's other filesystem/shell tools.

## Workflow

1. `list_projects {}` returns one selected project and its opaque `projectId`
2. `list_scenes {projectId}` returns only explicitly selected relative paths/IDs
3. `read_scene {projectId, sceneId}` returns exact persisted UTF-8 `text`,
   `baseHash`, `snapshotId` and byte count
4. Draft an alternative, preserving authorial choices. Submit
   `propose_scene {projectId, sceneId, snapshotId, baseHash, replacementText}`
5. `list_proposals {projectId}` and
   `get_proposal {projectId, proposalId}` inspect bounded pending proposals
6. Return to Studio for an explicit, complete before/after review. Saving/reconciling
   dirty buffers, protected-style handling, approval, application, and safe revert
   are entirely separate native/Core responsibilities

Every tool schema rejects extra properties; there is no generic file path, URL,
shell, save, grant, pairing, approval, apply, publish, or delete parameter/route.
Tools and instructions are fixed; manuscript text cannot add permissions.
Responses flag proposals as requiring author review and never claim approval.

`sceneId` is a deterministic project/path selection identifier, not a stable
manuscript scene ID. Moving/reordering a path requires a fresh explicit selection.
`baseHash` is SHA-256 of exact persisted bytes, not an authenticated revision
ledger. Snapshot IDs are random per-process latest-read pins; reading a scene
again invalidates its earlier pin. Restarting the server invalidates all pins.
No MCP call reads an unsaved Studio buffer. An external change since the read
rejects proposal submission; an unobserved edit-and-revert (ABA) is not detectable
with hashes. Submission cannot freeze future edits. Studio must always revalidate
at apply time, without silently replacing dirty or intervening work.

## Data and privacy

See [proposal-store contract](../proposal-store/README.md) for exact schemas,
hashing, persistence, limits, and trust assumptions. The first slice compares
**the entire exact before and after scene**, not semantic changes or independently
approvable line hunks. Unknown fields/schema versions or altered hash bindings
fail closed. Nothing normalizes frontmatter, CRLF, whitespace, Unicode, em dashes,
queer/trans/kink/furry content, or intentional prose choices.

`clientLabel` is launch-supplied unverified text, even when it says "Studio" or
"author". `sessionId` is a server-generated attribution ID, not authentication or
a grant. MCP `clientInfo` cannot override it or acquire authority. Records contain
no absolute source/store paths, authentication material, or author approvals.

Only proposals in the selected project and scene allowlist can be returned.
`get_proposal` also checks current Core source access; `list_proposals` omits
sources now ignored, unavailable, or generated. Historical records remain in the
private store for trusted native author reconciliation. Closing the process ends
its read/proposal session; stored proposals survive, still untrusted/unapproved.
No record is automatically pruned. Store capacity failures ask for author-managed
archiving outside MCP rather than deleting history.

Request lines are bounded at 13 MiB before JSON parsing; exact scene and replacement
texts remain bounded at 2 MiB each. Malformed or oversized framing closes the
stdio session. At most four filesystem tool calls run simultaneously; excess
calls receive a retryable busy error. No tool performs network or model work.

## Verification

```sh
cargo test --locked -p repository-core -p proposal-store -p heinlein-local-mcp
cargo clippy --locked -p proposal-store -p heinlein-local-mcp --all-targets -- -D warnings
```

Synthetic tests exercise actual binary stdin/stdout initialization and tools,
exact CRLF text, proposal persistence, forged Studio identity/grant/approval,
unknown fields/tools, unselected paths/proposals, stale/latest-read/restarted
snapshots, root/symlink swaps, current ignore-policy changes, malformed/oversized
messages, and source/dirty-buffer preservation. Store tests cover private modes,
hardlinks, unknown schemas, tampering, staging failures, quota and temp recovery.
No real manuscript or live client configuration is used.

Official protocol/SDK sources consulted:
- https://github.com/modelcontextprotocol/rust-sdk
- https://rust.sdk.modelcontextprotocol.io/
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

The official `rmcp` SDK is pinned to 3.5.1 in Cargo.toml/Cargo.lock. Its bounded
JSON-RPC codec is used instead of its unbounded default stdio reader. No HTTP
transport or OAuth/auth feature is enabled.
