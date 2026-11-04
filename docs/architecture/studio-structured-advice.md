# Shared Ask and Review responses

Ask and Review request the same strict provider schema, `heinlein_advice_v2`,
defined in `studio/crates/drafting-questions/src/structured.rs`:

- `schemaVersion: 2`
- `answer`: a direct answer or overall reading assessment
- `strengths`: zero or more justified strengths
- `findings`: zero or more objects with `text`, verbatim `evidence`, and `editIds`
- `edits`: zero or more objects with `id`, `sceneIndex`, `original`, `replacement`,
  `reason`, and `role`

The arrays have bounded maximum sizes of 32, with no required count. A finding
may have no linked edits. This allows broader editorial advice and a clean review
without manufacturing changes. Evidence must occur in supplied source/context;
linked IDs must identify real edits in this response.

The provider never supplies offsets in v2. Heinlein finds each nonempty `original`
verbatim in its captured scene, requires exactly one occurrence (including checks
for overlapping occurrences), then calculates UTF-8 byte offsets. Missing,
ambiguous, out-of-scope, overlapping, no-op, frontmatter-changing, and otherwise
unsafe targets fail validation. Insertions use an existing exact-text anchor.
Review batches translate offsets from the captured window to the original scene
using their existing local window bookkeeping.

Ask uses its explicit context as scene 0, stays read-only, and renders findings,
evidence and optional diff chips. Its validated JSON stays in the existing local
conversation text field, so history can restore it without new apply authority.
Partial JSON is not streamed into the answer UI; incomplete structured answers
are rejected without repair or automatic retries. Older saved Markdown answers
remain readable.

Review maps the shared response to the existing saved review record. Finding
quotes persist as optional `evidence` on reading improvements; existing review
IDs, native author confirmation, stale-source checks, and proposal authority are
unchanged. The legacy v1 response parser remains validated for compatibility;
new requests always specify v2 without offset fields. Suggest edits retains its
existing separate proposal contract and exact-text anchoring.

Verification uses synthetic fixtures only. No manuscript, provider account,
publication, or installed application update is needed to run these checks.
