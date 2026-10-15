# Pending proposal storage

This crate stores **untrusted, unapproved** exact whole-scene replacement
proposals. It never writes manuscript files, approves changes, issues capabilities,
or changes a dirty editor buffer. It is not an authored revision ledger.

## Native integration API

- `ProposalStore::open(private_absolute_path)` opens/creates a private directory
- `submit(&repository, relative_scene_path, expected_base_hash, replacement_text,
  ProposalOrigin::local_mcp(session_id, client_label))` creates one immutable record
- `list(&repository)` returns bounded `ProposalSummary` values without scene text
- `get(&repository, proposal_id)` returns the exact `PendingProposal`
- `PendingProposal::validate()` checks schema, values, and content hashes only

Recommended Studio location: `app_data_dir/pending-proposals-v1`, outside every
manuscript repository. MCP requires that path explicitly at launch. Opening a
store does not set up client configuration, credentials, or background access.
Only the native host/launch command selects a store path; no tool takes one.

Schema 1 uses camelCase: `schemaVersion`, `id` (UUIDv4), `projectKey` (opaque Core
repository key), `path` (relative Markdown), `baseHash`, `replacementHash`,
`diffHash`, `baseText`, `replacementText`, `origin`, and `createdAtMs`. Summaries
omit both text fields. No absolute path is serialized. `origin` contains
`kind: "localMcp"`, a server-generated `sessionId`, a `clientLabel`, and
`identityAssurance: "unverifiedLocalProcess"`. All client labels are unverified,
even if a label says "Studio" or "author". Session IDs provide attribution, not
authentication, approval, grants, or authority. Dates are informational only.

The proposal is a **single whole-scene exact before/after comparison**, not a
semantic diff. Text is never normalized, including CRLF, frontmatter, Unicode,
protected em dashes, or trailing whitespace. Each text hash is lowercase SHA-256
of its exact UTF-8 bytes. `diffHash` is lowercase SHA-256 of the UTF-8 bytes of the
compact JSON array `["heinlein-replace-scene-v1", path, baseText, replacementText]`
as serialized by serde_json, with that exact order and no additional whitespace.
This representation binds all replacement bytes; it is not an author signature.

A Studio reviewer must retain the validated record, display the entire exact
before/after comparison and unverified source attribution, revalidate current
source/access and clean-buffer state, then independently perform a trusted native
author approval with the displayed ID/hash bindings. Protected-style rules and
explicit overrides belong to that author gate. A raw record, hash, client label,
conversation, or MCP tool result can never substitute for approval. Keep apply
and revert receipts separately; do not delete or relabel the proposal as author
written. Revert must check the exact applied base and preserve later work.

## Storage and failure contract

macOS/Linux only. Component-by-component descriptor-relative opens reject
symlinks. The final directory must be current-user-owned mode 0700; records must
be owned regular single-link mode-0600 files. The selected repository and store
cannot overlap. Mutex plus advisory directory flock serialize cooperating
processes. Atomic temporary-file write, file fsync, rename, and directory fsync
make acknowledged records durable on filesystems honoring those operations.
Record IDs are freshly generated and never reused or overwritten through this
API. Post-rename sync failure reports `StorageUncertain`; inspect before retrying.

Every read rejects unknown schemas, extra fields, wrong project/record identity,
modified text/hashes, unsafe files, or unsupported origin types. Stored source
text remains untrusted even when hashes are correct. Native `list`/`get` preserve
historical proposals after the source moves, disappears, or becomes ignored;
this is for explicit author reconciliation, not permission to apply them. MCP
additionally filters by its launch selection and current Core read/privacy checks.

Limits are 256 records and 64 MiB across the store, 2 MiB per UTF-8 text, and a
bounded JSON escaping allowance. Storage refuses further proposals when full;
there is no automatic pruning, archive, delete, shell, or generic file API. A
future author-controlled archive UI can preserve records without relaxing this
bound. Recognizable incomplete private temporary files are discarded on reopen,
never promoted as proposals. Directory swaps, corrupt records, and unknown files
fail closed. Hash-only source checks cannot detect an unobserved edit-and-revert
(ABA), and submitting a proposal cannot freeze a concurrently edited source.
Studio/Core must recheck before any application.

These controls assume an uncompromised trusted host and local OS account. Private
permissions are not encryption or protection against a malicious same-user
process that can alter application code/files. This store contains no approval
secrets and makes no authenticity claim about its contents.

All tests use synthetic text; no real manuscript is read or changed.
