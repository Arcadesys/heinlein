# Local MCP read/proposal slice

This approved implementation slice is deliberately narrower than ADR-001 draft
grants or the v0.2.1 editorial runtime. It adds only explicit project/scene
selection (individual paths or one explicit manuscript index), exact
persisted-scene reads, and optional durable unapproved proposals over
local stdio. It does not introduce draft-write grants, author-channel secrets,
remote workers, release approval, or a canonical-write MCP route.

Launches without a proposal-store argument are read-only: only project listing,
ordered scene listing, and exact scene reads are registered. A manuscript index
selects only its validated tracked members at launch, never untracked files or
other books. The index bytes are pinned and rechecked on each call; index changes
require restarting the explicit selection. Existing per-scene, path, content and
proposal bounds still apply. No runtime tool can enable proposal storage.

See the [server contract](../../studio/crates/local-mcp/README.md) for launch,
tools, privacy bounds, and tests, and the
[proposal store contract](../../studio/crates/proposal-store/README.md) for the
immutable schema, exact comparison/hash representation, and native integration.

The store is additive-only private data outside repositories. Hashes bind exact
bytes but do not authenticate identity or approve a patch. Attribution explicitly
labels client names as unverified. Native Studio owns any subsequent author
review/apply/revert flow, separately revalidating data and source state through
Core. Neither a conversational yes nor an MCP result can authorize that step.

Hash-only snapshots are not the full authored revision/provenance ledger. Path-
derived selection IDs are not stable manuscript IDs. The slice makes those limits
explicit and requires re-selection after moves. It neither claims the complete
private-author-channel ADR nor treats ordinary local process identity as one.
