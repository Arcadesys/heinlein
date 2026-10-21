# Studio GitHub workspaces

Heinlein can open an existing nonempty github.com repository as a separate managed
copy, save exact-file versions locally, explicitly send versions on an app-owned
branch, request feedback with a draft pull request, and review incoming changes.
Local save, local version, sent version, and feedback request are separate states.
This is an author interface; no model or MCP capability can approve these actions.
The existing local-folder workflow and immutable rc1 release remain independent.

## Account and repository authority

`github-workspace` uses libgit2 objects and HTTPS transport, with fixed-host GitHub
REST calls for identity, permissions, refs and draft pull requests. Native public
configuration identifies the Arcadesys-owned **Heinlein Studio** App (ID 5412628,
client ID `Iv23liSDqUlMHOEM7K9n`, slug `heinlein-studio`). Device flow and expiring
user tokens are enabled. The author installs it for selected repositories, signs
in through GitHub, then confirms the returned account in a native dialog. Effective
user write access and this App's installation with Contents/Pull requests write
permissions are both checked. No App secret or private key belongs in this client.
`HEINLEIN_GITHUB_CLIENT_ID` may override the public client ID; empty or invalid
configuration disables connection. The expected App identity stays fixed.

GitHub access is separate from ChatGPT/model access. Access and refresh credentials
are stored only in the native OS credential store (macOS Keychain; Linux Secret
Service). There is no plaintext or browser-storage fallback. Refresh is serialized,
account checked, and rotated credentials persisted before use. Reauthorization
changes the auth binding; using an existing copy with that account requires an
explicit rebind. Sign-out invalidates current native credential leases and removes
stored credentials, while leaving local writing and versions available offline.
Neither registration nor mock tests establish real installation or sign-in proof.

The renderer uses one typed native command with an allowlisted tagged request.
It receives display metadata and opaque workspace/session/preview/operation IDs,
not tokens, absolute roots, Git arguments or credentials. Plans expire after five
minutes, bind the selected session and editor epoch, and are single use. Native
confirmation is generated from the retained plan. Final execution rechecks clean
editor/recovery state, identity, source hashes and relevant Git OIDs/permissions.
Previews are discarded after author settings, selection or source changes.

## Stable local copy and isolation

App-data siblings `github-sources-v1/<workspace UUID>` and `github-state-v1/` keep
source separate from registry, Git object databases, receipts and private update
backups. GitHub auth has its own sibling `github-auth-v1/` plus OS-store entry.
Registry identity is immutable GitHub repository ID and workspace UUID; owner/name
is refreshable display metadata. Renaming a repository does not move the checkout
or change existing path-based recovery/project keys. Missing or interrupted copies
are blocked, never automatically recloned over drafts. Private account, proposal,
recovery and guide directories cannot be selected as manuscript roots.

Clone/fetch uses anonymous canonical HTTPS remotes and native credential callbacks,
verified TLS, no redirects, no inherited config, no command helpers, no hooks,
external templates, submodule recursion, custom merge drivers, filters or builds.
App-authored config is the sole backend; materialization writes validated raw blobs
without a Git checkout/filter pipeline. Git data lives outside the editable tree.
Symlinks, gitlinks, case/Unicode path collisions, unsafe paths and LFS-dependent
content are rejected. Limits include 4096 files, 2 MiB per blob, 32 MiB materialized
content, depth 32, and 100 MiB received pack bytes/50000 objects. These are transport
and source limits, not a filesystem quota for libgit2's object database. Unsupported
or oversized repositories fail before a registered editable copy is installed.

Private records use owner-only descriptor-anchored directories, bounded JSON,
create-new staging, fsync and atomic rename. Catalog and workspace locks serialize
processes; ordinary managed-source native reads/saves/recovery/structural operations
share the workspace lock. Network planning may fetch objects without replacing
source. Applying incoming changes requires all local manuscript changes already
saved as local versions, so reviewed base/ours/theirs correspond to durable history.

## Versions and sharing

Save a version accepts an explicit nonempty selected set of Markdown files and any
required `ms/manuscript.json` change, author name/email and message. It preserves
unselected files and unrelated tracked blobs. It never adds all files or untracked
secrets. A prepared receipt records the commit object before a compare-and-swap
ref update; restart reconciliation finishes that exact version rather than creating
a duplicate. Local versions and offline reopen need no working network/account.

Send and Request feedback each require a fresh preview plus native confirmation,
showing account, repository visibility, app-owned branch, base and exact files /
versions. The dialog warns that GitHub repository automation may run. Push never
writes the default branch or forces a ref. Before transmission, remote repository
metadata, effective permission, base OID and expected app-branch OID must match.
Draft PR creation never falls back to a ready PR. Later versions continue the same
open feedback branch. Closed/merged feedback requires reviewing current base history
and explicitly starting a new app branch; local versions and old branches remain.
The local branch switch has its own prepared transaction and restart recovery.

An operation receipt is durable before a remote write. Unknown push outcomes use
exact remote-head readback; unknown PR creation uses repo/head/base plus a unique
operation marker. Checking an outcome never sends it again. An unresolved unknown
operation blocks a new share; there is no automatic queue, reconnect retry, account
fallback, force push, branch deletion, merge, release or distribution command.

## Incoming changes and recovery

Incoming review compares a pinned common ancestor, the local app branch and a
fetched app/default head. Unrelated or rewritten history stops. Markdown disjoint
edits may form a visible candidate; same-passage changes require an explicit author
choice. Original, Your writing, GitHub writing and editable Result are labelled,
stacked, keyboard accessible panes. No choice is selected and no conflict markers
are written to source. Every changed file has a full candidate preview.

For schema-v2 ms workspaces, scene/group IDs, paths, titles, group membership,
addition/deletion and reading order are compared semantically. Move plus edit keeps
the stable scene ID. Delete/edit and competing order require author decisions;
independent additions require a complete explicit order. Structural custom results
use validated JSON with existing IDs. Invalid combinations, collisions, unsupported
nonmanuscript changes and legacy manifests stop without writing source; the existing
local-folder workflow remains available. Groups remain organizational.

`repository-core::workspace_update` is a narrowly separate multi-file transaction,
not a reinterpretation of the existing drafting journal. It validates the entire
candidate and expected source hashes before applying descriptor-relative guarded
transitions under save/recovery locks. Private before/after backups precede writes.
The native transaction binds source application, merge-version ref and registry.
Any pending transaction blocks normal reopen. Explicit recovery restores known
original files or recognizes a fully completed version after finalization; unknown
external edits preserve the backup and remain blocked. Interrupted recovery itself
can be resumed. New edits invalidate guide proof and source-bound UI previews.

## Evidence boundary

Normal Studio CI includes the new crate tests, native authority tests, renderer
unit tests and real Chromium desktop/320px browser tests with axe and 200% reflow.
Tests use synthetic repositories, credentials stores, HTTP responses and renderer
hosts. Browser fixtures are test-only entrypoints and absent from production bundles.
They prove their stated layers, not native OS credential dialogs, live installation,
actual GitHub pushes/PRs, screen-reader behavior, Linux runtime or physical power-loss
acceptance. Those require a separately authorized disposable repository and native
manual acceptance; no live remote mutation is part of this implementation pass.
