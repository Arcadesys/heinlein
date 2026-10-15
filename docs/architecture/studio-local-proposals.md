# Studio local MCP proposal review

This is a bounded, local first slice of [ADR-001](adr-001-manuscript-authority.md).
It implements whole-scene proposals and explicit author-confirmed application.
It does **not** implement DraftGrant/WorkerGrant pairing, authenticated MCP client
identity, the private Core IPC transport, a full revision ledger, or release
approval. No MCP operation can approve, apply, revert, save a draft, or mint a grant.

## Author workflow

1. Open the repository in native Studio and save the current scene. Resolve any
   open recovery decision first.
2. A separately launched [local MCP server](../../studio/crates/local-mcp/README.md)
   can read explicitly selected persisted scenes and submit untrusted proposals.
   The author must configure that process explicitly; Studio does not install a
   client, alter client configuration, start a server, or transmit credentials.
3. Select **MCP proposals**, then **Review proposal**. Studio shows the entire
   exact source and replacement side by side, including frontmatter, whitespace,
   CRLF source bytes, Unicode, and protected punctuation. Source/client strings
   are rendered as plain text, never executable markup. The panes preserve the
   stored strings; visual line wrapping is not a text transformation.
4. **Continue to native confirmation** opens a separate operating-system dialog.
   It identifies the retained scene, proposal, hashes, and unverified client/session.
   Only confirming that native dialog permits the retained operation to proceed.
5. Studio reopens the applied scene cleanly and exposes its local operation receipt.
   **Review revert** shows a new exact before/after review and native confirmation.
   Revert is available only for completed applies from the current Studio session,
   and only while the current source still matches that apply's replacement hash.

Client labels, session IDs, proposal timestamps, and recomputable hashes are not
identity authentication or author consent. Both review and receipts call that
attribution unverified. Author confirmation is recorded separately. Application
changes the working draft only; it does not approve a release.

## Authority and concurrency

The trusted native host retains a complete validated proposal snapshot with a
random one-use review ID, repository session, project key, and monotonic five-minute
expiry. The renderer echoes only the review/proposal IDs and exact base,
replacement, and whole-scene diff hashes. The native confirmation text is built
from the retained snapshot. A changed on-disk proposal cannot substitute different
bytes after review. Wrong bindings, repository/session changes, expiration, dirty
notifications, canceled confirmation, and prior attempts invalidate authority.
The base is never silently rebased to a newer source revision.

The UI refuses review while the current editor is dirty, saving, staging recovery,
has unresolved recovery, or is handling a save/discard dialog. It pauses editing,
autosave, navigation, and close for the review/application interval, while keeping
the native dirty flag truthful. Unexpected late editor events are retained and
cause the post-apply refresh to stop with autosave paused, rather than replacing
newer author text.

The actual native `MutationGate` allows ordinary save, recovery staging, and
recovery discard to overlap through reader guards. Author proposal and structural
operations use an exclusive writer guard. Dirty notifications update an atomic
flag and epoch without waiting on filesystem I/O or a native dialog. The epoch is
checked before and after native confirmation, and again after Core stages/fsyncs
the replacement immediately before its commit checks. This preserves recovery staging
during a slow ordinary manuscript save.

`Repository::save_with_clean_recovery` acquires the repository save mutex before
its recovery clean-path gate, matching existing Core lock order. It rejects pending
recovery atomically with the guarded save. It retains Core's expected-hash checks,
private scene ownership, descriptor-relative path protection, generated-source and
manifest checks, and pending structural-transaction protection. External writers
can still make a proposal stale. Hashes cannot detect an edit-and-revert (ABA) that
returns the bytes to the identical base; this is not a revision ledger.

## Private persistence and failure handling

The native host chooses two sibling directories in its application-data directory:

- `pending-proposals-v1`: the shared untrusted proposal store
- `proposal-receipts-v1`: native operation intents and completion records

Both are outside the manuscript repository. The native-selected application-data
path is not accepted from renderer input. A local MCP launch must explicitly name
the matching absolute proposal-store directory. No source/store root or credentials
are added to proposal records.

Receipt directories are private, owner-checked, symlink-free, descriptor-bound,
and created with parent-directory fsync. Receipt files use exclusive creation and
private mode, reject hardlinks, and are never overwritten or pruned automatically.
The store bounds 256 operations, 512 intent/result files, and 128 MiB, and reserves
completion capacity before source writes. Records retain exact reviewed bytes,
hash bindings, original unverified attribution, author-confirmation marker, and
revert-parent ID. The list shown in Studio omits the full stored source text and
shows the operation, hashes, attribution, and status.

An immutable intent must be durable before Core can write source. A distinct
immutable completion follows the save. An intent write failure prevents the save.
An uncertain Core save or failed completion write returns an explicit uncertain
outcome. An intent without a completion blocks blind retry after restart. Invalid,
partial, unsafe, or orphan records fail closed. There is no automatic replay,
rollback, deletion, or repair after a crash. Preserve the records and inspect
current source before preparing a new proposal or performing manual recovery.

Revert produces a new operation/receipt and retains the original. Stored records
are never capabilities: even valid-looking forged receipt JSON cannot mint apply
or revert authority. Restarted Studio can display history but cannot reconstruct a
revert capability from those files. Uncertain operations deliberately offer no
one-click revert. These local operation receipts are not an authenticated revision
ledger and do not claim protection against a process controlling the trusted host
or the user's account.

## Verification and limits

The test-only Cargo harness compiles the exact native authority, receipt, and
mutation-gate modules, without GTK/Tauri:

```sh
cargo test --locked --manifest-path studio/crates/proposal-authority-test-harness/Cargo.toml
cargo clippy --locked --manifest-path studio/crates/proposal-authority-test-harness/Cargo.toml --all-targets -- -D warnings
cd studio
npm test
npm run build
```

The 24 focused native-module tests cover exact-byte application and attribution;
all five binding mismatches; changed proposal files; dirty invalidation; pending
recovery before/after review; stale/generated source; one-shot and TTL/session
guards; double apply; intent/completion failures; guarded revert and intervening
edits; restart and forged-receipt authority rejection; private storage, symlinks,
partial records; concurrent recovery staging; late dirty changes during source staging; and opposing Core save lock order.

Renderer verification passes 135 tests, including 12 new proposal integration
tests and a bridge contract test. TypeScript and Vite production build pass. These
checks cover literal text rendering, exact IPC bindings, dirty/recovery/save races,
cancellation, stale results, clean reopen, late-edit preservation, attributed
receipts, and guarded-revert presentation. The existing Vite chunk-size advisory
remains.

A full native `cargo check -p heinlein-studio --offline` was attempted. It stops
before application compilation because this Linux executor lacks `dbus-1.pc`
(`libdbus-1-dev`). No system packages were installed. The focused authority harness
is not a substitute for compiling the Tauri wrapper or manually verifying its
native confirmation dialogs, close behavior, and packaged macOS/Linux app.
