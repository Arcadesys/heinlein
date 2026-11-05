# Review consolidation validation

## Fix

- Consolidation receives the actual original/replacement text for every proposed
  patch, including unlinked suggestions. IDs stay paired with their report's
  feedback across same-batch calls, later batches, and saved-review reopening.
- Native provenance matches the exact request and reviewer instance. Deduplicated
  patches remain attributed to each contributing call. The wire uses source
  indices and omits native paths, offsets, account identity, and apply authority.
- The final pass remains advisory and must return empty findings and edits.
- Advisory prose follows JSON Schema's 2,000-character limit in Rust and the
  renderer, including Unicode characters represented by multiple UTF-8 bytes or
  UTF-16 code units. Exact patch text and whole request/response byte caps remain
  unchanged. No output is silently truncated.
- Call details identify malformed, overlong, or oversized assessments. The
  contribution summary now says “with one reviewer each” instead of implying
  that every suggestion came from the same reviewer.

## Local checks

Validated on macOS against the existing PR #120 branch, without the unrelated
local startup-recovery work:

- Full renderer suite: 95 files, 1,155 tests.
- Drafting/provider crate: 99 tests.
- Native review-state harness: 21 tests.
- Native questions/progress: 10 tests.
- Production TypeScript/Vite build.
- Strict clippy for drafting-questions and heinlein-studio, all targets.
- Chapter/background-review Chromium regressions at desktop and narrow widths.
- Git diff whitespace checks.

Regression coverage includes same/later-batch patch transmission, canonical
IDs after reopen, shared patch provenance, unlinked patches, advice-only reports,
legacy insertions/deletions, request overflow without truncation, and ASCII,
accented, and astral-character boundaries at 2,000/2,001 characters. Existing
patch safety and model/format rejection tests remain in place.

Node 26's experimental global storage conflicts with the test DOM. Renderer
checks use `NODE_OPTIONS=--no-experimental-webstorage` so jsdom owns storage.
The isolated browser worktree needs local dependency files rather than symlinks
outside Vite's allowed root.

## Boundaries

Synthetic responses and read-only inspection established the contract bug. Raw
historical failed responses were not retained, so their precise invalid field
cannot be recovered. No live provider call or retry, manuscript change, saved
review mutation, application install/restart, or native VoiceOver acceptance was
performed. Existing author decisions remain untouched.
