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

Repository discovery uses only the confirmed user token's `/user/installations`
and `/user/installations/{id}/repositories` GET endpoints, filtered to the expected
App and required installation/user permissions. Both endpoints paginate in fixed
100-item pages; discovery caps each stream at ten pages, total requests at fifty,
and unique eligible repositories at 1,000. It fails explicitly rather than
silently truncating; URL entry remains available. Duplicate IDs are deduplicated,
conflicting grants/metadata fail closed, and archived/disabled/empty repositories
are unavailable. Response bodies, temporary clone tokens and credentials never
enter list DTOs or errors. Empty, access/SSO, rate-limit and network states offer
explicit access management/refresh without reconnecting or changing permissions.
The returned native list token expires after five minutes and binds account,
connection, repository/installation IDs and source generation. Selection consumes
that token, revalidates current metadata/access by immutable ID, and creates the
existing single-use open preview. Native confirmation and clone/source barriers
remain required. No `/user/repos`, credential fallback or automatic install occurs.

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
content are rejected. The complete supported tree is represented by shared immutable OID/mode/size
entries. Previews share unchanged payloads. Untouched binary assets and executable
modes are preserved exactly in local commits; assets do not become editable prose.
Materialization validates and writes one raw blob at a time. Limits are 16,384 files,
32 MiB per passive blob, 256 MiB complete tree, depth 32, 2 MiB per editable document
and 32 MiB hydrated editor text. Fetch remains capped at 100 MiB received pack bytes
and 50,000 objects. Private object storage is checked before/after fetch at 512 MiB
and 60,000 filesystem entries; this is a bounded check rather than a streaming disk
quota during libgit2 decompression. Largest-blob allocation and Git metadata remain
part of peak memory. A synthetic 96 MiB asset tree measured approximately 96 MB peak
RSS on this Mac; this is evidence for that fixture, not a universal memory promise.
Budget errors identify phase, category, observed count and cap without source text.
Failed opens clean only the new unpublished workspace UUID, never an existing copy. Unsupported
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
showing account, repository visibility, explicitly authorized working branch, base and exact files /
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
fallback, force push, branch deletion, release or distribution command.

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

## Explicit working branches and PR actions

Choose a starting branch, then create a named working branch or select a previously
retained branch. Default is a starting point only. Ref validation, expected local
and remote OIDs, account binding, saved-file/recovery barriers and native one-shot
confirmation precede changes. A versioned capability book records authorized refs
and each branch's head, remote receipt, PR and base. Legacy catalog-v1 projects load
without rewriting IDs/roots or inferring new branch authority. Unknown/corrupt
capability versions refuse operations and preserve originals. Whole-tree switching
uses a staged tree, fsynced journal and retained backup; restart finishes the same
transaction without fetching or discarding unsent commits. Untracked writing or
uncertain remote operations block switching. No implicit reset, stash or deletion.

Commit selects exact saved files. Send is separate. Draft PR and ready PR creation
are distinct explicit actions; a creation timeout is reconciled by its operation
marker, never replayed. Mark draft ready is separate again. GraphQL ready has no
head CAS: head/PR identity are checked before and after; unknown outcomes remain
read-only recoverable and do not trigger a retry.

V1's merge seam is the synchronous single-PR expected-head endpoint, never async,
queue/automerge submission or an alternate endpoint after refusal. Known, missing
or malformed stack state and queue/rule/identity uncertainty block the action.
Only an explicitly proved account/repository/head/base no-bypass capability may
reach mutation. **The current production App connection has no established
no-bypass proof, so in-app merge is unavailable with an Open on GitHub action.**
Mock-provider merge tests establish refusal/reconciliation behavior, not production
permission or live merge acceptance. No new scopes or fallback actor are requested.
Check details are unknown rather than green. Target/head are revalidated before
confirmation, but GitHub's endpoint offers no atomic base-tip/retarget CAS; the
reviewed head and named target are the consent boundary. A timeout is read back
from PR state and merge commit without attributing the mutation to Heinlein or
resending it. Local branches and source remain intact after a reported merge.

Incoming prose/manifest conflicts retain explicit author choices. Remote passive
asset or mode mutations currently refuse with an actionable unsupported-tree
message; they are never silently omitted or flattened. Opening the repository and
retaining those assets is distinct from merging asset changes in this version.
