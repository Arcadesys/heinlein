# Repository core (explicit scene saves)

`repository-core` is a native-host library. It supports explicit revision-guarded Markdown draft saves, but has no patch,
approval, grant, release, publishing, network, shell, Git mutation, or model-provider API. Selecting
a repository does not import, copy, or alter its manuscript files.

## API

- `Repository::open(absolute_path)` opens a host-selected root; `root()` and `name()`
  are host-only identity helpers, not renderer path-selection capabilities
- `list(relative_directory)` returns directory-first sorted `Entry` values; `""`
  denotes the root
- `read(relative_document)` returns exact UTF-8 text and byte count, raw frontmatter
  interior (JSON or YAML, without interpretation), SHA-256 `contentHash`, and a compatibility-source flag
- `save(relative_document, expected_hash, text)` atomically replaces an existing
  non-generated Markdown file after checking the loaded revision
- `discover()` returns sorted repository-relative `scene-manifest.json` paths
- `manuscript(relative_manifest)` validates schema version 1, preserves volume,
  chapter and scene array order, and returns repository-relative paths

DTO field names serialize as camelCase. `Error` implements safe path-free Display
messages. No absolute repository path appears in document, listing, or manuscript
DTOs. The host must never expose `open` or `root` directly to renderer arguments.

The manifest reader supports the real Singularity Log `volumes[].chapters[].scenes`
structure and recognizes both `sources[].path` and chapter `source` as generated
compatibility documents, including when their manifest is ignored by browsing.
It requires referenced files/directories to exist and be accessible. Scene paths
must be inside their chapter; chapters must be inside their volume; duplicate
scene references fail closed. Schema versions other than 1 are rejected. Other
manifest fields are not interpreted. The compatibility flag reports the manifest's
classification, not a cryptographic freshness or release-approval claim.

## Safety and limits

macOS/Linux are the first supported platforms. Non-Unix opens fail explicitly.
Every component of an absolute selected root and subsequent relative opens is
walked through directory descriptors with `O_NOFOLLOW`. Symlinks, including links
inside the same repository, are rejected. Root choices containing OS aliases such
as macOS `/var` or `/tmp` need the real, non-symlink path (for example `/private/...`).
Subsequent access remains anchored to the opened root descriptor.

Absolute paths, `..`, `.`, empty path segments, backslashes, colons, control
characters and paths over 4096 bytes are rejected. Files with unrepresentable
names are skipped during enumeration. Hidden entries, common build/cache trees,
known secret directories/filenames and credential/key extensions are excluded.
This is a conservative filename filter, not a content-based secret scanner: a
secret stored in an ordinary permitted manuscript name is still ordinary text.
Regular UTF-8 text with an approved extension is required; NUL/control-byte binary
content, devices, sockets, FIFOs and oversized files are not read as documents.

Repository and ancestor `.gitignore` files are read using the same no-follow
handles, with a 64 KiB limit. Invalid, oversized or symlinked ignore files fail
closed. Global ignore files, `.git/info/exclude`, Git configuration and external
programs are never consulted. Outer exclusions take priority over nested
negations; hidden/secret exclusions can never be re-included. Ignore rules are
not a substitute for an operating-system permission boundary.

- File reads: 2 MiB, including a bounded read that catches concurrent growth
- Manifest reads: 8 MiB; ignore files: 64 KiB
- Directory enumeration: 4096 raw entries, including excluded entries
- Recursive discovery: 20,000 visible entries, maximum 32 path components
- Manifest tree: 10,000 volumes/chapters/scenes

Limits return explicit errors rather than partial trees. Native hosts should keep
a repository open if optional discovery exceeds a limit, show that warning, and
allow individual directory navigation. No file watcher or snapshot transaction is
claimed: externally edited regular files can change between list/read operations.
Descriptor traversal prevents symlink escapes but does not claim isolation from a
privileged process, mount replacement, or an attacker controlling the OS account.

## Validation

From `studio/`:

```
cargo test -p repository-core
cargo clippy -p repository-core --all-targets -- -D warnings
HEINLEIN_ARCHIVE_ROOT=/absolute/non-symlink/archive/root \
  cargo test -p repository-core --test read_only real_archive_acceptance -- --ignored
```

Deterministic seeded state-machine tests run with the ordinary suite using small
CI defaults. See [core fuzz campaigns](../../../docs/testing/core-fuzz.md) for
replay instructions, larger opt-in campaigns, invariants, and recorded coverage.

The optional archive test reads the private fixture in place and asserts 95 scenes,
frontmatter availability and source classification. The fixture is not bundled.
Synthetic tests cover raw CRLF/Unicode preservation, traversal, excluded paths,
nested ignores, symlinks, a concurrent symlink replacement, FIFO rejection,
binary/oversize reads, bounded listings/depth and manifest ordering/validation.

## Save contract and limits

Saves accept `.md` and `.markdown` only, apply all browsing path/content guards,
and never create missing source documents. Generated compatibility sources are
protected by both `sources[].path` and chapter `source` declarations. Ancestor
manifests are checked even if ignored; malformed or unknown schemas deny writes.
No frontmatter parsing, Markdown serialization, newline normalization, BOM removal,
or editorial transformation occurs. Unchanged text returns without writing or
changing file metadata. Stale hashes fail even for otherwise unchanged requests.

The Core serializes its saves, stages exact UTF-8 bytes in an exclusive, mode-0600
same-directory temporary through a held no-follow directory descriptor, restores
the original permission bits, syncs the file, rechecks source hash and inode,
then renames and syncs the parent. Read-only source modes are respected. A failure
before rename leaves the source untouched and cleans the temporary. An error
syncing the directory after rename is reported distinctly as durability uncertain:
the replacement has occurred and the user must reload before retrying. The manuscript save itself is not a revision ledger and provides no backup,
ACL/xattr preservation or Windows write support. Studio now stages separate
host-private recovery snapshots as described below. Interrupted manuscript saves
may leave a hidden temporary.

The final hash/inode check detects observed external edits, including edits during
staging. This is not an OS-wide compare-and-swap: another process can write between
the final check and rename. No protection against a malicious process controlling
the same OS account or moving held directories is claimed. No-op, repeated CRLF
and frontmatter saves, stale bases, generated sources, unsafe paths, read-only
files, injected staging failure, and staging-time external edits are tested with
synthetic files only; private manuscript fixtures are never written by tests.

## Durable recovery snapshots (Studio pass 3)

The trusted host opens `RecoveryStore::open(app_data / "draft-recovery-v1")`.
The directory is outside the selected repository and never passed from renderer
arguments. `Repository::project_key()` is a stable SHA-256 of the canonical root
path for recovery/preferences, separate from the random repository-session token;
it grants no authority. Moving a repository changes this identity.

- `read(&repository, relative_path)` claims scene ownership and returns an optional `RecoveryDraft`
- `stage(&repository, relative_path, expected_hash, text)` persists exact UTF-8
  before the guarded manuscript save, returning a new opaque snapshot ID
- `discard(&repository, relative_path, recovery_id)` deletes only the matching
  snapshot; a stale completion cannot erase a newer draft

Snapshots contain `id`, `path`, `baseHash`, exact `text`, `updatedAt` (Unix
milliseconds), `actor: "author"`, and `client: "studio"`. The native IPC has only
these three bounded operations. The stored versioned record additionally binds
the opaque canonical repository key. No absolute paths occur inside the record.
The actor/client fields identify this local Studio path, not authenticated grants
or editorial/release approval. This is one current recovery snapshot per document,
not a historical revision ledger or implementation of the full ADR contract.

Staging validates the allowed existing Markdown source and generated-source
metadata, but intentionally does not require its hash to match `baseHash`:
external changes must block manuscript replacement, not protection of buffered
text. `Repository::save` retains its existing guards and never deletes recovery.
The caller compares recovery base/text to the current file and presents a visible
restore/conflict choice; it must not silently apply recovery. After a confirmed
save, only the matching recovery ID may be cleared. Recovery reading/discarding
does not require the source to still exist, so the storage API retains access to
an old snapshot without following a newly introduced source symlink.

The snapshot directory is opened component-by-component with `O_NOFOLLOW`,
created with mode 0700, and verified as private and owned by the current user.
Files must be regular, single-link, owned, mode-0600 records. Threads and separate
host processes serialize storage operations with a mutex plus advisory directory
flock. Additionally, recovery read/stage/discard acquire a nonblocking per-scene
ownership lock held for the lifetime of the host store. Recovery read claims the
scene before returning a draft or absence, so a second live instance gets a visible
busy error before it can expose an editor. It may still browse the source and work
on other scenes. After the first owner exits, a new owner must successfully read
an existing recovery snapshot before replacing or deleting it; repeated stale
Save retries cannot overwrite unobserved recovery. Stable empty
mode-0600 lock files remain after clearing a snapshot; locks release on exit or
crash and are never unlinked while potentially held. At most 4096 scene ownership
handles are retained per store. Each write uses a mode-0600 exclusive temp file, file fsync, descriptor-
relative atomic rename, then directory fsync; the held directory is checked
against its canonical path before commit. Before-rename errors preserve the last
complete snapshot; post-mutation sync errors report durability uncertainty.
Malformed records, unknown schemas, and unsafe storage are reported explicitly
and never silently replaced. First open removes only recognizable incomplete temp
names under the store lock and never promotes them as completed snapshots.

Text remains bounded at 2 MiB. JSON reads have a bounded allowance for escaping;
record identity, revision hash, relative path, content, and attribution are checked
on every read. Private permissions are not encryption. These guarantees assume a
local filesystem honoring rename/fsync and an uncompromised OS account; they do
not exclude privileged writers, malicious same-user processes, or hardware loss.
A crash before a snapshot finishes can lose edits since the last acknowledged
snapshot. Disk-full or permission errors must remain visibly unsaved in the UI.

Synthetic tests include process SIGKILL after durable acknowledgment and reopen,
failed staging, source save failure, conflict preservation, exact CRLF/frontmatter,
stale deletion across store handles, repository/path isolation, generated-source
protection, private storage, corrupt records, symlinks/hardlinks, and directory
replacement during staging. No private manuscript fixture is edited.

Opt-in synthetic timing (100 approximately 23 KiB buffers):

```
cargo test --locked -p repository-core --test recovery \
  benchmark_durable_autosave -- --ignored --nocapture
```

This reports p50/p95 durable snapshot cost (including file and directory fsync)
and full stage + guarded manuscript save + CAS-clear cost. It measures the local
filesystem/build only, not keystroke latency or a cross-platform performance SLA.

## Explicit `ms/` drafting structure

`load_drafting` is read-only. The native-host-only `preview_drafting` produces a
non-serializable plan; `apply_drafting` accepts that exact plan and returns a
one-step guarded undo. The renderer receives only a preview ID and relative-path
summary. All commands bind the selected repository session, and preview requires
the loaded manifest revision. `ms/manuscript.json` is a separate camelCase
schema-version-2 index with a project UUID, optional named UUID groups, and a flat
ordered array of `{id, title, path, groupId}` scenes. Array position is order;
file names never encode it. A move preserves its scene ID; a copy gets a new ID.

Only eligible Markdown files recursively inside `ms/` are manuscript members.
External filesystem additions/removals appear as untracked/missing paths; explicit
Reconcile adds new IDs and removes missing entries, preserving IDs and order for
remaining scenes. It never creates or deletes scene text. Initializing an empty
manuscript creates only its index; new scenes are empty files. Groups are optional
labels and do not create directories. Legacy v1 parsing stays unchanged. Explicit
legacy import creates a separate draft by copying the original scene hierarchy
and order into `ms/`; it never rewrites the legacy index or moves its members.
Moving a scene still referenced by a legacy v1 index is refused.

The first import slice accepts individual `.md`/`.markdown` files, not directory
imports. Native OS picker/drop events capture approved paths privately; renderer
requests supply an opaque selection ID, never absolute paths. External sources
are revalidated before apply and never deleted. Ancestor v1 metadata still blocks
external compatibility-source imports. Copy/move preserves exact UTF-8 bytes,
including CRLF, unknown metadata and authorial punctuation. Moves retain Unix
permission bits; copied/new files use mode 0600. ACLs/xattrs are not preserved.

Directory-changing transfers and external imports refuse recognized link-capable
syntax rather than rewriting text or silently breaking assets: square brackets,
HTML/autolink `<`, case/whitespace-insensitive CSS `url(`, recognized YAML resource
keys, and unsupported opening TOML `+++` metadata. A leading UTF-8 BOM is ignored
only for detection. This deliberately conservative subset can reject absolute
links or ordinary bracket prose; it is not a complete Markdown/HTML/Pandoc asset
resolver. Same-directory rename and reorder preserve relative outgoing paths;
preview still warns that incoming filename references require author review.
Linked assets are never copied automatically.

Plans compare the manifest bytes, `ms/` membership, source hashes and every
changed file snapshot before applying. Destinations are exclusively published
through descriptor-relative hard-link creation; no existing destination is
silently replaced. Each changed file is staged and fsynced before publication;
only the expected index revision is atomically replaced. Symlink components,
excluded paths, invalid text, malformed authority metadata, stale previews,
case-fold name collisions and read-only source modes fail closed. Repository
structure operations have a root advisory lock, and the ordinary save mutex
serializes same-host saves with them.

Before changing files, Core durably stores the exact before/after transaction
journal at `.heinlein-drafting-transaction.json` in the repository and an exact
journal-hash receipt in the native-private RecoveryStore. Repository content by
itself never authorizes rollback. Journal edit shape, version, repository binding,
paths, content bounds, permissions and index schemas are validated. Runtime
failures roll back only matching revisions. Abrupt interruption leaves a visible
`recoveryRequired` state: ordinary saves and snapshot staging stop until an
explicit rollback preview/apply. Rollback requires the matching private receipt
and every current file to match a recorded before/after snapshot. Missing receipt,
tampered journal or unexpected edits stop safely for manual recovery. Both forms
of recovery preserve source bytes rather than infer the author's intent.

Structural operations hold recovery storage locks across mutation and claim both
source and destination paths. Any pending draft or other live scene owner blocks
the operation, including missing-source or stale-destination snapshots. Ordinary
native saves use `save_with_recovery`: they briefly claim/validate process-lifetime
ownership, then release snapshot locks before manuscript I/O. The native store is
shared via Arc, so newer recovery snapshots can still stage while a save fsync is
pending. These do not become new permissions or authenticated agent grants.

Undo compares all affected after-snapshots and the current index/membership before
restoring prior bytes. It cannot erase a later author edit. Undo is single-step
and current-process; interrupted rollback has no undo because it must never recreate
a partial transaction; the durable journal is for interrupted operations, not a
browsable revision history. Empty directories created during an operation may
remain after rollback/undo; Core never recursively deletes them. Any completion
or rollback durability uncertainty is reported explicitly and requires refresh.
The system does not claim OS-wide compare-and-swap or protection from a malicious
same-account/privileged process, filesystem failure, or moving a held directory.

Imports are bounded to 256 selected files and 32 MiB of changed scene snapshots
(before plus after); individual scenes remain bounded to 2 MiB. All new tests use
synthetic temporary fixtures, including actual SIGKILL after durable journal
publication, authenticated reopen rollback, invalid/corrupt receipts, injected
partial-operation failure, safe undo, stale files/membership, generated sources,
legacy preservation, recovery conflicts, link-bearing sources and source/destination
symlinks. No manuscript fixture is modified and no publishing/export route exists.
