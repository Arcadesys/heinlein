# Studio pass 2: explicit local editing

Builds on main 16d88b6, retaining PR15 fonts, zoom, and collapsible panels.
Python publishing is untouched. Markdown scenes use CodeMirror 6 as plain source.
Frontmatter remains editable source; no parsing/reserialization occurs on save.
Non-Markdown and generated compatibility manuscripts remain read-only.

## Save boundary

Only repository-core writes files. Every read provides SHA-256 contentHash;
explicit save submits the opaque repository session, relative path, expectedHash,
and exact UTF-8 buffer. Core revalidates containment, symlinks, generated-source
status, size, hash, and inode, then uses a same-directory exclusive temporary file
and atomic rename with mode preservation. No-op saves leave bytes untouched.
See the core README for external-writer TOCTOU and post-rename durability limits.

The renderer retains unsaved buffers through read/write errors and conflicts.
Navigation and every native close request pass through Save/Discard/Keep editing.
Pending saves block navigation; multiple dialog actions cannot bypass this.
Edits during a save stay dirty. A native close freezes interaction until its
handshake ends and checks the edit revision again. This is no crash-recovery
promise; process crashes and forced termination can lose unsaved edits.

CodeMirror's normalized positions map back to raw newline offsets. Untouched
spans preserve original line endings and unknown metadata. Newly inserted lines
use the document's first newline convention. Undo to the initial or latest saved
revision restores exact bytes; other edited/reinserted lines may adopt that
convention. Save never reconstructs the file from frontmatter objects.

## Interface and security

Save (Cmd/Ctrl+S), undo/redo, find (Cmd/Ctrl+F), wrapping, large text, font choices,
visible focus, and high contrast are local. No inference/network requirement.
Production CSP allows inline styles because CodeMirror generates style elements;
script policy remains self-only, manuscript text is never injected as HTML, and
network connections remain restricted to native IPC. No generic filesystem,
shell, network, MCP, or generic close capability is granted to the renderer.

## Validation and limits

Core fixtures/temp files only; original writing-archive is never opened for edits.
Renderer uses mocked IPC. Native compilation and physical keyboard/screen-reader
QA remain required on a machine with Tauri desktop dependencies before release.
There is no autosave, recovery journal, Git workflow, or agent grant in this slice.
