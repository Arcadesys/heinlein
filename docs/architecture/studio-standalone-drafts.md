# Standalone drafts: write now, choose a destination later

A fresh Studio window offers an editable blank page. Typing authorizes local
preservation only. There is no initial folder, title, project or account choice.
`Drafts` finds active and discarded documents independently of recent projects;
untouched blank placeholders do not clutter the list. No retention deadline,
automatic purge or storage eviction applies. Physical storage failures remain
visible and preserve the last good version.

## S1 — Native preservation and writer authority

`repository-core::standalone` stores versioned raw UTF-8 records under native
app-data `standalone-drafts-v1`. Records include an opaque native UUID, monotonic
revision, text/hash, optional label, active/discarded state and placement receipts.
The directory is excluded from project selection and GitHub sources. No source
sidecar, credential, provider request or permanent destination is created by
writing. The list derives from durable records, including recoverable last-good
records; an unavailable item does not hide its siblings.

Descriptor-relative no-follow access, owner-only modes, stable per-draft lock
inodes, process-lifetime exclusive flock leases and revision/hash CAS protect
publication. Current and one last-good snapshot bound normal text overhead.
Publication writes a private temporary, syncs it, atomically links/renames it and
syncs the directory. Only a lease owner can reclaim that draft's interrupted
private temporaries. A separate state proof prevents a damaged discarded record
from silently resurfacing as active. Recovery is visible and read-only until an
explicit native-confirmed last-good repair. A second writer is unavailable; it
can read the kept snapshot and open a different draft.

Local preservation has a separate 64 MiB per-draft resource bound, rather than
the project's 2 MiB scene limit. Oversize failures never truncate or remove the
visible buffer or last good record. File/disk/count failures are explicit.
No claim is made that keystrokes not yet submitted to native storage survive a
crash, or that fsync alone proves hardware power-loss behavior.

## S2 — Editor, close and reversible discard

The editor preserves raw newline styles and untouched bytes. Its debounce has a
five-second maximum wait during continuous typing. Cmd/Ctrl-S keeps the draft on
this Mac without a picker. Native acknowledgement is tied to an exact submitted
revision; a late response cannot mark newer text kept. An uncertain write is
retried with its identical snapshot before newer text is submitted. Navigation
and the existing cooperative normal Quit path await the latest durable snapshot.
Failure keeps writing visible and offers retry; it does not claim Saved or permit
unsafe normal close. The existing project save/recovery path is retained.

Remove draft uses a native, revision-bound confirmation and a durable soft
transition before hiding the item. Discarded drafts retain all text and can be
restored after restart. No permanent deletion is provided. Final discard and
placement temporarily make the editor read-only; cancellation restores writing.
Late saves cannot resurrect a tombstone. Placed copies are independent.

## S3 — Explicit copy placement

Choose a destination offers a new text/Markdown file, a new scene in a supported
existing `ms` project, or a new local project containing one scene. Names are
collected here, never as a prerequisite to writing. The native picker grants
separate destination authority. A native-retained, one-shot preview binds the
writer, durable revision/hash, exact text, destination and manifest transaction.
Edits/settings changes invalidate the preview. The final native Place confirmation
explains that the destination may be shared by its own sync tools. Studio cannot
detect every externally synchronized folder and does not start synchronization,
a Git commit, a push or publication. A known managed GitHub destination requires
its existing selected-workspace authority and edit lock.

Files use descriptor-relative no-replace creation. Existing projects use the
literal-text scene/manifest journal transaction. New projects stage the complete
transaction and publish the folder with no-replace rename. Generated output,
private roots, symlinks, collisions, stale manifests, source revisions and
recovery barriers remain protected. Project-specific scene limits can refuse
placement while the complete standalone draft remains kept.

A private intent is synced before writing; bytes/hash and scene membership are
verified before a receipt is recorded. A lost receipt is reconciled by verifying
the existing result, not repeating a write. Uncertain/partial outcomes block a
blind new placement. Unpublished project stages are retained for inspection;
they are not treated as successful destinations or recursively deleted. The
original is always retained. The editor stays on the original; Open placed copy
is a separate explicit action that first keeps the latest original and switches
to ordinary destination autosave. Receipts identify the exact copied revision,
which can differ from newer original text. No reverse sync exists.

## Evidence boundaries

Core temporary-filesystem tests exercise exact byte placement, state/revision
CAS, atomic publication faults, restart reconciliation and actual second-process
lease exclusion. Native unit tests exercise the production capture gate and
opaque writer contract without real app data. Renderer and Chromium tests use
an explicitly synthetic bridge; browser persistence is not native persistence.
Native OS pickers, actual WebKit IPC/normal-Quit integration, hardware power loss,
VoiceOver and installed-app/Linux GUI acceptance require separate verification.
No live manuscript, account, credential or provider test is needed for these
synthetic checks.

Ordinary `.txt` browsing keeps its read-only behavior. Explicit Open placed copy
can grant text editing for that native-returned session/path; it does not make
unrelated text files editable. Reopening a placed copy reads its current safe
bytes and source-scene membership, so independent later edits are not mistaken
for a request to restore the original receipt snapshot. The original receipt is
immutable. Editor/project file-size limits still apply when opening a large
placed file; the complete private draft and verified copy are retained.
