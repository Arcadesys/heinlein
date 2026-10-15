# Studio pass 1: native read-only repository browsing

Date: 2026-10-14. Scope: implement the user-approved first browsing pass.

## Decision

Add a Tauri 2 native host, a small TypeScript renderer, and a Rust read-only
repository library under `studio/`. Keep the Python publisher intact. This is a
foundation for Local Draft Mode, not an implementation of writing or editorial
authority described by ADR-001. No manuscript-mutating command exists.

The native host owns folder selection and the selected repository. Renderer
commands accept repository-session IDs and relative paths; folder selection is
only via native UI or a previously recorded recent-folder ID. Selecting another
root invalidates old session IDs. Filesystem operations run off the UI thread.
Tauri exposes six explicit commands to the bundled main window only; no generic
filesystem, shell, HTTP, or dialog plugin permission is granted to JavaScript.
There is no TCP listener, MCP listener, launch credential or author approval.

A later writing pass must implement the trusted author-channel decisions before
introducing any approval or grant routes. Read access here is not a write grant.

## Untrusted content

Names, paths, manifests, and prose are data. UI preview uses text nodes; Markdown,
HTML, YAML tags, embedded scripts, links and images are never executed or fetched.
Content security policy blocks frames, objects, external resources and form posts.
No Git hooks/configuration or repo-local programs are run when opening a folder.

On macOS/Linux the repository core opens relative to held directory descriptors
with `NOFOLLOW` for each component. It rejects symlinks, traversal, absolute paths,
non-regular files, unsupported/binary text and oversized reads. Hidden files and
common internal/build/credential paths are excluded; applicable `.gitignore`
patterns are read as data. These filters are convenience boundaries, not a claim
to detect every possible secret in author-selected text. A process controlling
the author's OS account remains outside this trust model.

The schema-v1 manuscript adapter preserves declared array order and resolves all
paths under the selected root. It reads source metadata; it does not regenerate
flat files, modify manifests, infer publication status, or change author prose.
No migration is performed for unknown schemas.

Recent-folder preferences contain local paths and IDs, capped at ten entries.
They are stored under the host's app-data directory, never in the manuscript or
repo. They are not synchronized. Folder disappearance is recoverable by picking
the folder again. A malformed preferences file is ignored.

## Acceptance and follow-on

Verify unit/adversarial tests for filesystem guards and manifest identity/order,
renderer tests for cancellation, stale responses, errors, plain-text rendering
and no mutation controls, and native builds on macOS/Linux. Manually smoke-test
folder picker, reopening, keyboard navigation, voice/screen-reader accessibility,
and the real archive. Label mocked, compilation-only and hardware results
separately. Do not claim latency targets without measurements.

Next passes add actual editing and durable save/conflict/recovery behavior only
when separately authorized. They must preserve frontmatter and prose bytes unless
the author edits them, expose unsaved state, and retain offline/inference-free
interaction.

References: [Tauri capabilities](https://v2.tauri.app/security/capabilities/),
[Tauri native dialogs](https://v2.tauri.app/plugin/dialog/),
[ADR-001](adr-001-manuscript-authority.md).
