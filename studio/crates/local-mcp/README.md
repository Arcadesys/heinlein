# Heinlein local drafting MCP

Local saved manuscript access for an external Codex/Claude MCP client. Fixed CLI
selections are read-only by default; Studio's explicit project grant permits
reads and pending revision proposals. Only the native author review/apply flow
can change writing. The server has no network listener, model calls, credential
setup, approval, publishing or manuscript-save tool.

## Connect from Studio

1. Open a project. A scene does not need to be open or saved first.
2. Choose **Codex connection…** in the project navigator, the Project actions
   menu, or the global More menu.
3. Choose **Connect Codex** once and confirm the native setup prompt. This uses
   the installed Studio executable's bounded headless stdio mode; no separate
   server build is needed. It updates only Codex's `heinlein` MCP entry.
4. Choose **Allow this project** and confirm the named project. Start a new
   Codex chat after first-time client setup. Ordinary scene/file changes and
   later explicit project selections use the same connection without another
   registration.

If the CLI is unavailable, **Manual setup command** contains the exact quoted
command for this executable and private profile directory. Copy that command
rather than guessing installation or Application Support paths. Setup status
verifies configuration, not a live client session or inference request. Client
configuration is changed only by the explicit native-confirmed setup action.

One explicitly selected project is shared at a time. Granting another replaces
that selection; **Disconnect project access** revokes it. Saved proposals remain
available for native author review. Project grants and client configuration live
outside the app bundle and survive application updates at a stable installation
path, bundle ID and profile location.

Project access includes eligible saved UTF-8 Markdown throughout that project,
including references and new or renamed files. Hidden/private-internal paths,
credentials/secrets paths, `.gitignore` exclusions, symbolic links, generated
compatibility copies, non-UTF-8 files and files over 2 MiB stay excluded. Catalogs
are bounded to 4,096 sources, 20,000 scanned entries and 64 MiB of source metadata
sizes. Tracked scenes follow manuscript order, then other sources follow path
order. Unsaved buffers are never read. Continued source proposals still require
an exact fresh read and native author review before any application.

Existing version-1 per-file approvals stay limited until the author chooses
**Allow this project**. That explicit grant writes version 2; older servers fail
closed rather than misreading it as broader access. Reconfigure/restart an older
client with the updated Studio executable. Opening this panel or installing an
update does not expand existing permissions.

Revocation, selection changes and tool calls share the existing private filesystem
lock. Stale confirmation cannot overwrite newer revocation. Membership/order
changes invalidate cached read pins, and repository identity is checked against
both the held directory descriptor and the selected path. A directory replacement
cannot turn a saved grant into access to a different project.

## Standalone server (advanced)

The standalone binary also supports `--studio-selection PRIVATE_ABSOLUTE_DIRECTORY`
for the same explicit Studio grants. Do not combine it with fixed-selection flags.
Fixed selections below retain their 128-scene bound and do not expand automatically.

macOS/Linux with Rust and Cargo:

```sh
cd studio
cargo build --locked -p heinlein-local-mcp --release
./target/release/heinlein-local-mcp \
  --repository /absolute/path/to/selected-project \
  --manuscript ms/manuscript.json \
  --client-label 'Codex local drafting'
```

Without `--proposal-store`, only `list_projects`, `list_scenes`, and `read_scene`
exist. No proposal directory is opened or created. Suggestions can be discussed in
conversation without giving the agent a manuscript mutation capability.

The command speaks MCP JSON-RPC on stdin/stdout; human diagnostics go to stderr.
Use `--help` for its arguments. Choose one scope:

- `--manuscript ms/manuscript.json` selects the tracked scenes in Studio's v2
  index, in manuscript order. Untracked files are excluded; missing scenes or
  pending structural recovery must be resolved in Studio first.
- `--manuscript book/scene-manifest.json` selects scenes from one validated legacy
  v1 index, in volume/chapter/scene order. Generated chapter copies are excluded.
- Supply `--scene` once for each selected existing Markdown scene instead.

Selections contain 1–128 scenes. Manuscript selection and individual scene flags
cannot be combined. Nothing discovers other manuscripts or expands scope.
The selected index is hash-pinned at launch and rechecked on every tool call;
changing it requires restarting the client connection. Ordinary scene edits remain
readable without restarting. Index reads are bounded to 2 MiB.
Relative root/store paths, duplicate selections, symlinks, ignored/internal
paths, non-Markdown files and generated compatibility files are rejected. The
proposal-store path must be outside and not contain the repository. There is no
default home-directory scan or environment-driven scope.

### Connect a local agent

After building, register a stdio server in Codex (substitute the absolute binary
and selected manuscript project paths):

```sh
codex mcp add heinlein -- /absolute/path/to/heinlein/studio/target/release/heinlein-local-mcp \
  --repository /absolute/path/to/selected-project \
  --manuscript ms/manuscript.json --client-label Codex
```

For clients with a JSON `mcpServers` configuration, the equivalent entry is:

```json
{
  "mcpServers": {
    "heinlein": {
      "command": "/absolute/path/to/heinlein/studio/target/release/heinlein-local-mcp",
      "args": [
        "--repository", "/absolute/path/to/selected-project",
        "--manuscript", "ms/manuscript.json",
        "--client-label", "Local writing agent"
      ]
    }
  }
}
```

Reconnect/restart the client after registration. Ask the agent to list the
selected manuscript's scenes and read the relevant ones before giving feedback.
Each client launches its own process; it does not connect to a shared network port.

To enable the existing Studio proposal workflow, add
`--proposal-store /absolute/private/path/pending-proposals-v1` to the server
arguments. Use Studio's own proposal directory to see suggestions there. The agent
can then submit a replacement bound to its latest exact scene read. Only Studio's
separate author review/apply flow can change the manuscript. The agent cannot
enable proposals through a tool call, approve its own suggestion, or save text.

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

1. `list_projects {}` returns one selected project, its opaque `projectId`, and
   `accessMode` (`readOnly` or `readAndPropose`)
2. `list_scenes {projectId}` returns only selected relative paths/IDs, in launch
   selection or manuscript order
3. `read_scene {projectId, sceneId}` returns exact persisted UTF-8 `text`,
   `baseHash`, `snapshotId` and byte count
4. With proposal storage enabled, draft an alternative, preserving authorial choices. Submit
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
manuscript scene ID. Fixed CLI scope changes require a fresh explicit selection.
Studio project catalogs refresh automatically, invalidating old read snapshots
when their membership or order changes.
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
read-only tool denial without storage creation, both manuscript index formats,
manuscript order, scope invalidation on index changes, exact CRLF text,
proposal persistence, forged Studio identity/grant/approval,
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
