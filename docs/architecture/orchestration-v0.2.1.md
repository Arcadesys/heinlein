# Heinlein: Orchestration Architecture v0.2.1

**Status:** FROZEN DESIGN BASELINE (proposed architecture, not implemented)  
**Date:** 2026-10-14  
**Next design milestone:** v0.3 Protocol and Contract Specification  
**Scope:** local-first drafting, hybrid editorial orchestration, persistent findings, explicit author approval, MCP, and publishing provenance.

> Coordinate a hundred disposable editorial minds without confusing their authority with the author's.

## Compatibility with the current repository

Heinlein currently ships a **Python** Markdown-to-publication pipeline, local preview server, editorial hooks, and voice-protection guidance. This specification describes a **future architecture**. Rust is a candidate for native orchestration infrastructure; TypeScript is a candidate for browser UI. Neither is mandated as a rewrite of working code. Preserve the existing publishing behavior using characterization/integration tests if implementing a new core. No code changes are authorized by this document.

## 1. Frozen decisions

| Concern | Contract |
| --- | --- |
| Execution | Local authority and scheduling, with optional explicitly approved remote workers |
| Campaign initiation | Manual by default; scheduled reviews require explicit opt-in |
| Agent lifetime | Workers are ephemeral; their sessions never constitute durable editorial memory |
| Text authority | Agents may read, criticize, converse, and propose; only a displayed, revision-specific, author-approved patch may change approved manuscript text |
| Spending | Adaptive: satisfy declared minimum coverage, prioritize risks, escalate selectively under hard budgets |
| Drafting | Offline-capable, responsive and inexpensive; no AI or remote service in the typing, saving or scene-switch critical path |
| Format | Scene-oriented Markdown as canonical literary content; stable scene IDs and chapter ordering metadata |
| Review state | Durable local findings, conversations, proposals, decisions, coverage and provenance |
| Roles | Arbitrary user-defined, versioned roles; a customizable De-Slopifier is always offered |
| Interfaces | Writing Studio, Publishing Cockpit and MCP share core validation/authorization rules |
| Publications | Builds are traceable to approved text, edition settings, tool versions and artifacts |

Changes to these frozen decisions require an explicit architecture decision record.

## 2. System boundaries

```mermaid
flowchart TD
  A["Author"] --> UI["Writing Studio / Editorial Inbox / Publishing Cockpit"]
  A --> CLIENT["External MCP client"]
  CLIENT --> MCP["MCP adapter"]
  UI --> CORE["Heinlein Core: local authority"]
  MCP --> CORE
  CORE <--> STORE[("Canonical Markdown + Git; durable local review state")]
  CORE --> PLAN["Campaign planner / budget and coverage controller"]
  PLAN --> QUEUE["Durable job queue + bounded context packager"]
  QUEUE --> LOCAL["Ephemeral local workers"]
  QUEUE --> REMOTE["Optional authorized ephemeral remote workers"]
  LOCAL --> VALIDATE["Result schema / evidence validation"]
  REMOTE --> VALIDATE
  VALIDATE --> CORE
  CORE --> GATE["Patch authorization + revision preconditions"]
  GATE --> STORE
  CORE --> BUILD["Reproducible publishing / preflight"]
```

**Control plane vs worker plane:** only the local core may change authority, schedule jobs, commit results, apply approved patches or authorize releases. Workers cannot expand context scope, write canonical text, increase budgets, authorize successors or recursively start new campaigns.

**MCP is an adapter, not an agent or privileged backdoor.** Local UI and MCP clients call the same application service and permission checks. The UI need not internally use MCP as its transport.

## 3. Local Draft Mode: first-class acceptance contract

Typing, scene navigation and local persistence **must not await model inference, network calls, cloud identity, remote queues or editorial campaigns**. Make drafts usable offline. Loading small, relevant context is optional and should be cached or computed locally. Agent help is opt-in and scoped.

Provisional measurable targets (not measurements): p95 editor input response <= 50 ms; p95 cached scene switch <= 150 ms; default provider inference cost per ordinary draft edit/save/switch = **$0**. Define platform and test conditions in v0.3. Autosave durability and error reporting require explicit tests. Active review swarms must yield resources to draft mode or pause.

An MCP tool for local reading/saving may itself be inference-free inside Heinlein, although the external AI client may incur model charges.

## 4. Manuscript and editorial entities

- **ManuscriptSnapshot:** immutable snapshot ID, source Git revision/content hashes, ordered stable scene IDs, dependency/fact-index version.
- **Campaign:** author authorization or opted-in schedule, target snapshot, roles/versions, scope, coverage floor, privacy policy, monetary/token/concurrency caps, status, accounting.
- **Job:** durable ID, idempotency key, task and role versions, context bundle hash, snapshot, allowed tools, provider policy, lease/attempts, outcome.
- **Finding:** ID, provenance, evidence with text anchors and snapshot, impact/severity, claim and alternatives, dedupe links, disposition.
- **Conversation:** persistent author/agent messages, dynamically generated choices, free-form author comments, discussion and decision history.
- **Patch:** candidate ID, linked finding(s), exact hunks/diff, expected source revision, alternatives, approvals, application result, verification state.
- **RoleDefinition / EditorialPolicy:** independently versioned instructions, scope, allowed context/tools, output/eval contract, budget and protected choices.
- **EditionBuild:** exact approved source and configuration, build-tool versions, artifact hashes and preflight outcomes.

Separate the lifecycles of a finding, its conversation, and its candidate patches. One finding may have several alternative patches; approving one must not erase rejected options or the discussion.

## 5. Editorial campaign flow

```mermaid
flowchart TD
  A["Manual request or opted-in schedule"] --> B["Pin immutable manuscript snapshot"]
  B --> C["Plan role coverage, context, privacy and budget"]
  C --> D["Reuse valid cache / deterministic checks"]
  D --> E["Queue bounded uncovered tasks"]
  E --> F["Ephemeral local or authorized remote critics"]
  F --> G["Validate evidence, consolidate and preserve disagreement"]
  G --> H["Persist finding inbox and coverage ledger"]
  H --> I{"Author action"}
  I -->|"Discuss / custom response"| J["Persistent finding conversation"]
  J --> I
  I -->|"Request alternatives"| K["Generate proposed exact diffs"]
  K --> I
  I -->|"Approve shown patch/hunks"| L{"Source revision still matches?"}
  L -->|"No"| M["Mark stale; require new diff and approval"]
  M --> I
  L -->|"Yes"| N["Apply transactionally exactly once"]
  N --> O["Targeted regression verification"]
  O --> H
  I -->|"Dismiss / intentional"| P["Record durable authorial decision"]
```

Agents produce **claims and evidence** first. Patch proposals are separate work. The author can accept a suggested option, request investigation, explain an intentional choice, reject, or type a custom response. No text entered in a conversational message counts as patch authorization.

**Mandatory visible diffs:** present old/new text and context; support hunk-level authorization where hunks are independent; for multiple edits show a cumulative diff. Patches must fail closed on stale source revisions. Never silently merge or rewrite approved work.

## 6. Ephemeral worker contracts

A task is self-contained: immutable input/context references, role/instruction version, declared output schema, permissions, provider/runner restrictions, budget and deadline. Workers return findings or proposals plus evidence; only core validation can commit them. Worker memory is not authoritative; persistence resides with the core.

Use durable leases and stable job IDs. Lost workers may be retried without duplicating accepted findings, conversations or patch applications. Cancellation stops new dispatch, preserves completed results and releases unused budget. Partial completion must remain observable.

Remote workers receive only approved scoped manuscript material, short-lived credentials, no unrestricted local filesystem access and no permission to expand their task. Default project privacy is local-only. A remote provider/runner policy must be explicit and auditable.

## 7. Adaptive spending and coverage

Schedule deterministically where possible. AI can recommend prioritization but cannot authorize spend or tool access.

1. Record mandatory coverage floors for the campaign. Full-book deterministic checks may be cheap; semantic roles may explicitly permit sampling.
2. Cache clean results as well as findings. Cache keys must include text/context dependencies, role version, relevant policy/eval versions and model configuration.
3. Run cheap validators and economical screening where suitable.
4. Escalate selectively for high-risk defects, contradictions, ambiguous results and recently modified dependencies.
5. Enforce hard maximum spend, tokens, concurrency, time and retries. Reserve capacity for escalation if configured.
6. Report planned, cached, completed, skipped, failed and unresolved coverage, never labeling a partially sampled or exhausted campaign as fully clean.

Multiple agreeing models do not establish truth. Preserve disagreement with source evidence and avoid treating correlated output as independent votes.

## 8. Roles and authorial policy

The role registry accepts arbitrary specialist definitions. **De-Slopifier** is bundled and configurable: literal/regex/rate-based patterns evaluated cheaply, semantic patterns evaluated only when needed, and protected patterns/approved exceptions. A rejected suggestion does not automatically become project canon; authors explicitly approve durable rule changes.

For the existing author profile, **em dashes are protected**, not a generic AI-writing signal. Intentional fragments, repetitions, interruptions and difficult subject matter must not be indiscriminately sanitized. Consult the existing repository `AGENTS.md` and editorial voice profile; an individual author's policy is not a global default.

## 9. MCP capability surface (conceptual)

- **Resources:** project catalog, scene and chapter snapshots, scoped context/fact sheets, role/policy definitions, finding histories, coverage and build reports.
- **Tools:** list/open projects and scenes, read/write working drafts with expected revisions, open/resume sessions, create/list roles, start/status/cancel campaigns, list/get findings, reply to findings, propose/get patches and exact diffs, approve patch/hunks with author capabilities, build/preflight editions.
- **Prompts:** draft scene, review scene, discuss finding, evaluate alternatives and publication preflight.

Permission tiers are capabilities, not identity labels: reader/critic, proposer, working-draft writer, author approver, publisher. An agent cannot impersonate the author, and an MCP client may not bypass revisions or privacy rules. Local clients should not require a public server; exposing remote access is a separate consent/security decision.

## 10. Release and production boundaries

Freeze an explicitly approved manuscript revision for each edition. A publishing build consumes a pinned source, layout/edition configuration and build environment. Store hashes of generated PDF/EPUB/etc. Artifacts must be traceable to inputs; page/layout QA can raise findings without rewriting approved prose. The author may waive editorial warnings but not an integrity failure that makes a release untrustworthy.

## 11. Failure and adversarial acceptance scenarios

| Scenario | Required invariant |
| --- | --- |
| Worker exits halfway | Retry from durable job state without duplicates |
| Author edits scene mid-campaign | Original reviews remain pinned, impacted findings/checks marked stale |
| Two critics disagree | Retain both claims/evidence and explain uncertainty |
| Budget exhausted | Halt further dispatch; show cost and incomplete coverage |
| Remote runner disappears | Reclaim lease, retry only if permissions and budget allow |
| Author intentionally keeps a passage | Persist scope/version of the authorial decision; avoid automatic rediscovery |
| Patch approved twice | At-most-once manuscript mutation |
| Source changed after diff | Reject stale approval; produce new visible diff |
| Role/policy changes | New version; no reinterpretation of past campaigns |
| Verification finds regression | Report finding; never silently roll back or overwrite authorial text |
| Cloud unavailable while drafting | Editor, scene switching and local saves remain usable |
| Build fails after approval | Preserve source and report failure; no release of invalid output |

## 12. Frozen invariants

1. Manuscript text is never silently changed by agents.
2. Every proposed edit has an inspectable exact diff.
3. Approved text changes require a specific, authenticated, revision-bound author action.
4. Every finding is anchored to evidence and a snapshot.
5. Agent execution is ephemeral; editorial memory is durable.
6. Workers cannot elevate privilege, expand budgets or self-schedule.
7. Job retry and patch application are idempotent.
8. Coverage is honest about skipped, sampled and failed work.
9. Protected stylistic choices outrank generic editorial heuristics.
10. Local draft operations do not depend on inference or remote availability.
11. Publication artifacts are traceable to exact approved inputs.
12. Author decisions remain reviewable, including intentionally unmodified text.
13. Failure recovery does not sacrifice state consistency.
14. External MCP access observes the same authorization boundaries as the UI.

## 13. Open design decisions (not implementation blockers)

- Batch approval: permitted when exact cumulative diffs and included patches are presented.
- Cross-project policies: explicit versioned profile import/opt-in, never silent.
- Follow-up agents: scheduler-controlled escalation only, inside the original budget.
- Unresolved editorial warnings: explicit author waiver can permit publishing; integrity failures remain blocking.
- Detailed scene schema, transaction/event semantics, cache invalidation, context minimization, and worker protocol remain to be specified.

## 14. v0.3: Protocol and Contract Specification (next, not yet frozen)

Produce language-agnostic, reviewable contracts with example JSON messages **but no implementation code**:

1. Schemas and identifiers for snapshots, campaigns, jobs, findings, conversations, patches and role/policy versions.
2. Event names, persistence semantics, state-transition guards and idempotency.
3. MCP tool/resource/prompt definitions, sessions, permissions and error contracts.
4. Worker input/output, leasing, cancellation, heartbeats, retries and remote privacy policy.
5. Exact diff, stale-revision, hunk approval and atomic application rules.
6. Budget accounting, coverage reporting, cache invalidation and escalation thresholds.
7. Offline draft-mode performance benchmarks and write/durability guarantees.
8. Contract tests and a full sequence diagram from review request through verified patch and reproducible build.

**Review request for Claude:** challenge trust boundaries, races between draft saves and patch approvals, schema evolution, failure recovery, cache correctness, the cost of local Draft Mode, and how v0.3 should formalize the contracts. Distinguish actual repo behavior from planned future architecture. Do not write implementation code until the author accepts the protocol design.

---

# Appendix A: Architectural walkthrough and delivery slices

This appendix is **design detail for review**, not a change to the frozen decisions above. Sequence and topology diagrams are illustrative and intentionally avoid implementation-specific transports. Each slice must be reversible, testable, and demonstrably useful without requiring the next slice.

## A1. Why these boundaries exist

Heinlein has three time scales: (1) a keystroke or local scene save, (2) a focused assistant interaction, and (3) a long-running editorial campaign. They must not share blocking execution paths. The durable local authority receives authenticated commands, checks revisions, records events, and coordinates workers. Ephemeral workers cannot hold exclusive locks on the draft editor.

```mermaid
flowchart LR
  subgraph FAST["Interactive fast path: no inference dependency"]
    ED["Editor / local MCP client"] --> SAVE["Revision-checked local draft save"]
    SAVE --> FILES[("Canonical scene Markdown / local state")]
  end
  subgraph ASYNC["Asynchronous editorial work"]
    ENTRY["Author launches campaign"] --> PLAN["Pin snapshot, privacy, coverage, budget"]
    PLAN --> QUEUE[("Persistent queue")]
    QUEUE --> WORK["Ephemeral critic / proposer"]
    WORK --> RESULTS["Validate + persist findings"]
    RESULTS --> INBOX["Finding inbox + conversations"]
    INBOX --> DIFF["Exact diff + author approval"]
    DIFF --> APPLY["Revision-checked apply"]
    APPLY --> FILES
  end
  FILES -. "snapshot read only" .-> PLAN
```

### Drafting latency isolation

Input, selection, undo/redo and render cannot depend on filesystem sync, agent completion or network. Draft edits enter the editor's local change buffer; persistence is scheduled and durable failure is surfaced. Saving via MCP and via UI uses the same expected-revision guards. Background workers operate on snapshots, never on live editor buffers. Resource contention is measurable: throttle CPU-intensive local reviews and avoid unbounded indexing while the user is typing.

**Proposed benchmark gates:** steady-state p95 keystroke response <= 50 ms and cached scene navigation <= 150 ms on a defined reference machine and reference manuscript; ordinary edits trigger zero provider calls; disconnected network cannot break a local save. Until benchmark methodology is defined, these are targets, not promises of achieved performance.

## A2. Editorial request through verified change: sequence diagram

```mermaid
sequenceDiagram
  autonumber
  actor Author
  participant UI as Writing Studio or MCP Client
  participant Core as Local Heinlein Core
  participant DB as Durable State
  participant Sched as Scheduler
  participant Critic as Ephemeral Critic
  participant Editor as Ephemeral Proposer
  Author->>UI: Start scoped review
  UI->>Core: Request campaign with budget / policy
  Core->>DB: Freeze snapshot + save campaign and jobs
  Core->>Sched: Dispatch bounded job plan
  Sched->>Critic: Minimal context + versioned role contract
  Critic-->>Core: Finding + quoted evidence + source references
  Core->>DB: Validate and commit result idempotently
  Critic--xCritic: Exit / discard session
  Core-->>UI: Finding available
  Author->>UI: Choose an option or enter free text
  UI->>Core: Append discussion message
  Core->>DB: Persist conversation
  Author->>UI: Request patch alternative
  Core->>Editor: Bounded proposal task on pinned source
  Editor-->>Core: Candidate patch
  Editor--xEditor: Exit
  Core->>DB: Store patch and exact diff
  Core-->>UI: Display contextual before/after diff
  Author->>UI: Explicitly approve specified patch/hunks
  UI->>Core: Apply with expected source revision
  alt expected source still matches and authority valid
    Core->>DB: Record approval and apply atomically
    Core->>Sched: Schedule targeted verification
  else source changed or auth invalid
    Core-->>UI: Reject / mark stale / require new diff
  end
  Sched-->>Core: Verified findings / regression results
  Core->>DB: Record outcome and coverage
  Core-->>UI: Show applied revision and verification status
```

**Review challenge:** the diagram says “atomically,” but Git file writes and SQLite transactions are not one shared transaction. v0.3 must specify recoverable intent journaling, commit order, startup reconciliation, and exactly-once *logical* patch application rather than claiming cross-store atomicity for free.

## A3. Worker lease and replay state

```mermaid
stateDiagram-v2
  [*] --> Queued
  Queued --> Leased: scheduler assigns bounded lease
  Leased --> Succeeded: validated result committed
  Leased --> Retryable: timeout / transient failure
  Retryable --> Queued: permitted retry with same identity
  Leased --> Failed: permanent invalid output
  Queued --> Cancelled: campaign cancelled
  Retryable --> Cancelled: campaign cancelled
  Failed --> [*]
  Cancelled --> [*]
  Succeeded --> [*]
```

A late result after lease expiration must not blindly overwrite the winning attempt. Retries carry stable job IDs plus unique attempt IDs; the core checks the lease epoch and idempotency key. Duplicate findings can be linked but never silently dropped if the claims materially differ.

## A4. Vertical slices: proposed implementation order

### Slice 0: Characterize and protect existing behavior

**User value:** Heinlein's existing Python publication flow keeps working throughout the evolution.

**Scope:** inventory current CLI formats, frontmatter, preview server, templates, writer rules and tests; assemble golden input/output cases and fixture projects. Define an ADR ledger that distinguishes frozen requirements from current code.

**Demo:** build the same example using the existing CLI; show deterministic structural assertions and render comparisons.

**Exit gate:** current build and preview behavior is understood and testable; no new service is required. **Non-goals:** rewrite to Rust, new editor, agent swarms.

### Slice 1: Scene library + fast local Draft Mode

**User value:** create/open/reorder scenes as small Markdown segments, edit without inference or cloud connectivity, and recover saves.

**Scope:** stable scene IDs, manifest and scene metadata, filesystem import/export to existing manuscript builds, local editor or minimal UI, autosave, conflict detection and crash-recovery rules; external file modifications are recognized.

**Demo:** import one story; split into scenes; reorder scenes without renaming all files; write offline; restart; produce the same publication as pre-split source (allowing defined normalization).

**Exit gate:** no provider calls for type/save/switch; benchmark p95 latency; crash test with unsaved changes and obvious recovery UI; preserve Markdown without lossy round-trip. **Non-goals:** full custom publishing cockpit, swarm engine.

### Slice 2: MCP-first draft access

**User value:** an authorized external assistant can find, read and save a scoped working scene without loading the whole book.

**Scope:** local MCP resources and tools for project/scene discovery, open-session, scoped context, expected-revision draft save; authorization scopes and local-only transport; capability denial and error contracts.

**Demo:** edit a scene in UI, read through MCP, save a new working-draft revision with a correct revision token; replay a stale save and observe a conflict rather than lost text; use the editor offline.

**Exit gate:** UI and MCP observe identical local state and guards; no AI required inside Heinlein to perform MCP file operations; unauthorized clients cannot read other projects. **Non-goals:** remote public MCP exposure.

### Slice 3: Durable editorial findings and discussion

**User value:** review a finding, select generated choices, type a custom instruction, dismiss it, and return tomorrow to the same conversation.

**Scope:** SQLite-backed findings, provenance, conversation threads, issue/intentional dispositions, versioned authorial policy, read-only reviewer role; import results from a fixture or a single bounded worker.

**Demo:** run a continuity critic on Scene 18, compare evidence to Scene 23, discuss the issue, store “intentional” explanation, restart and verify the decision persists.

**Exit gate:** no critic can modify canonical text; rejection is durable but appropriately scoped; erroneous agent claims are never automatically promoted to canon. **Non-goals:** large swarm, automatic patching.

### Slice 4: Diff-first patch workflow

**User value:** see exact revisions, approve one hunk or decline an alternative, and never lose an intervening manual edit.

**Scope:** patches as distinct objects, line/context anchors, full before/after diff, competing patch alternatives, explicit author approval capability, stale-source detection, application journal and targeted verification event.

**Demo:** approve a single visible hunk, reject another, then intentionally edit the source before approving a stale patch; stale approval fails and shows a refreshed proposal, not a silent merge.

**Exit gate:** replayed approval does not double-edit; app crashes during file write have deterministic recovery; approved source provenance is auditable. **Non-goals:** inferred approvals from plain-text chat.

### Slice 5: Ephemeral single-worker execution + eval fixture

**User value:** run a role such as De-Slopifier with a known cost ceiling, collect source-anchored claims, discard the worker, and preserve results.

**Scope:** task envelopes, provider adapters, bounded context, role versions, validation, deterministic regex/rule scanning, opt-in semantic scan, cancellation and per-job spend; a small evaluation corpus.

**Demo:** run De-Slopifier against a test scene with author-configured “It's not X, it's Y” and punchy-fragment heuristics; verify protected em dashes are never flagged by the bundled author profile. Kill the agent mid-run, retry safely, reopen persistent results.

**Exit gate:** ephemeral workers have no canonical write permission; repeat inputs reuse eligible cached checks; results include quality and token/spend telemetry. **Non-goals:** mass parallelism.

### Slice 6: Campaign scheduler + adaptive swarm

**User value:** author initiates an editorial campaign with arbitrary roles and a hard budget; progress, quality and partial coverage stay intelligible.

**Scope:** durable queue, leases, scheduler-only fan-out, provider tiers, concurrency controls, cache dependencies, risk-based escalation, sample-vs-complete coverage reporting and cancellation. Begin local-only, then add allowlisted remote runners with explicit privacy consent.

**Demo:** run 3 distinct critic roles across a small book; deliberately fail one worker, exhaust a tiny budget and change a source scene; show resumed jobs, incomplete coverage honesty, invalidation and precise cost ledger.

**Exit gate:** no unbounded spend or recursive dispatch; workers respect author privacy; local editor stays responsive during heavy review. **Non-goals:** unbounded swarm size as a product goal.

### Slice 7: Publishing Cockpit + immutable releases

**User value:** use approved source to preview, inspect and package a print or ebook edition with traceable artifacts.

**Scope:** reuse existing Python publishing pipeline initially; edition settings, build identity, EPUB/PDF QA, layout diagnostics, hash/provenance and explicit release workflow.

**Demo:** produce PDF and EPUB from frozen approved manuscript, identify one layout/preflight defect, fix layout configuration without changing prose, and produce a versioned release manifest.

**Exit gate:** release build is reproducible as far as toolchain permits; failures do not mutate manuscript; author waivers for editorial warnings are logged. **Non-goals:** replacing working rendering stack without demonstrated need.

## A5. Dependency graph between slices

```mermaid
flowchart TD
  S0["0: Baseline characterization"] --> S1["1: Scene library and Draft Mode"]
  S1 --> S2["2: MCP draft operations"]
  S1 --> S3["3: Finding inbox and conversations"]
  S3 --> S4["4: Exact diff and patch approval"]
  S3 --> S5["5: Ephemeral reviewer and evals"]
  S5 --> S6["6: Budget-aware swarm"]
  S4 --> S7["7: Publishing Cockpit and releases"]
  S0 --> S7
  S6 -. "advanced review integration" .-> S7
```

**Pragmatic sequencing note:** establish end-to-end vertical value early. A basic publication build already exists; Slice 7 enhances, rather than delays, that function. MCP draft access may be implemented in parallel with the findings UI once Slice 1's scene and revision contracts are stable.

## A6. Cross-slice contract table

| Capability | First owner | Guard / test |
| --- | --- | --- |
| Stable scene IDs and ordering | Slice 1 | Reorder does not invalidate identity |
| Local revision preconditions | Slice 1 | Stale write rejects without data loss |
| MCP auth and bounded scene context | Slice 2 | Unauthorized scope denied |
| Durable finding provenance | Slice 3 | Restart maintains anchored claims |
| Authorial decision memory | Slice 3 | Rejection not silently elevated to global rule |
| Exact diff and approval | Slice 4 | No hidden edit; stale diff rejected |
| Worker boundary / role contracts | Slice 5 | Critic denied canonical writes |
| Idempotent job execution | Slice 5 → 6 | Crash/retry duplicate-free |
| Coverage, budgets, adaptive escalation | Slice 6 | Hard spend cap, honest incomplete review |
| Release snapshot and artifact hashes | Slice 7 | Rebuild provenance tracked |

## A7. What Claude should try to break

1. **Save/approval race:** the editor has unsaved buffer changes while an MCP client submits a patch against the last persisted revision. Must approval require quiescence, a buffer-inclusive revision token, or a source conflict?
2. **Split-brain state:** SQLite says “patch applied” but the Markdown file was not durably written, or vice versa. Define journaling and recovery ordering.
3. **Stale dependency cache:** Scene 18 is unchanged, but a fact learned in Scene 23 moved to Scene 17. Which continuity results are invalidated?
4. **Correlated critic consensus:** many similar models agree on a false issue. What's the evidentiary escalation policy?
5. **Privacy envelope:** does a remote context bundle disclose the character bible, confidential unpublished drafts, or embedded credentials beyond necessity?
6. **Semantic De-Slopifier exceptions:** can a broad author rule wrongly suppress genuine narrative defects? How are exceptions scoped and audited?
7. **Budget accounting:** provider timeouts and retries can incur charges despite no result. How are reserved, estimated and actual spend reconciled?
8. **MCP permission confusion:** can an assistant's natural-language “yes” be mistaken for an authenticated author patch approval?
9. **Markup preservation:** does rich-text round-tripping mutate Markdown extensions, emphasis, punctuation or intentional formatting?
10. **Desktop responsiveness:** can background Rust/Python parsing, Git operations or local model inference starve the editor process?
11. **Release consistency:** what guarantees link approved manuscript source to the exact rendered output under changing fonts/Chrome/pandoc?
12. **Backward-compatible migration:** can the current Python CLI remain first-class while a new orchestration core is introduced incrementally?

**v0.3 deliverable:** resolve these questions in protocol/state-transition contracts and example payloads, plus test cases. Do not build the worker runtime or editor until the contracts are reviewed.
