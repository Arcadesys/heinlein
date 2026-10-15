# Studio pass 3: local autosave, recovery, and writing feedback

This slice extends the plain Markdown editor on main 0059f7f. It implements a
bounded portion of Slice 1b from orchestration-v0.2.1.md. It does not introduce
agent grants, editorial approval, publication, or Git commands.

## Persistence contract

Typing stays in the editor immediately. A coalescing timer schedules off-input-path
native work after 600 ms idle, with a 5-second maximum scheduling wait while
typing continuously. Slow or failed filesystem operations can exceed that interval. First, Core durably stages an exact UTF-8 recovery snapshot in private
application data. Then the existing expected-hash save boundary attempts atomic
replacement of the manuscript. Only the matching recovery snapshot ID can be
cleared after a successful manuscript save. A late completion cannot delete a
newer snapshot or mark newer typing saved.

A durable snapshot and a saved manuscript are different states. The interface
must show pending, recovering, saving, saved, and blocked/error states accurately.
A crash before the debounce or durable snapshot completes may lose recent typing;
this slice makes no zero-keystroke-loss promise. Forced termination cannot be made
safe by the window-close guard alone.

External file changes keep the expected-hash guard active. The recoverable buffer
may continue to be staged, but the manuscript is never overwritten automatically
on conflict. Reopening offers explicit recovery/discard; recovery loads a working
buffer and does not establish editorial approval. Unknown external authorship
stays unknown. Generated compatibility manuscripts remain read-only.

Recovery data is scoped to the selected canonical repository and relative scene
path. It survives application restart without relying on ephemeral renderer
session IDs. Renderer code receives an opaque stable project key for local goal
accounting, never an absolute filesystem path. A scene is claimed for recovery
when opened for editing; another Studio process must wait for its owner to exit
and recheck recovery before editing it. Other scenes remain available.

This is one latest recovery snapshot per scene, with stable identity and guarded
cleanup. A browsable revision history, authenticated author-command protocol, and
editorial approval ledger remain later slices.

## Daily writing feedback

Typewriter sounds are opt-in and synthesized locally. Counts exclude opening
frontmatter. Scene counts update with the buffer; manuscript counts load in the
background and must say when incomplete.

The default daily target is 1,000 words, using the computer's local calendar date.
Progress counts new words above each scene's daily high-water count. Deletions do
not reduce credited progress. Undo, redo, recovery, loading, and retyping up to an
already reached peak cannot manufacture additional credit. This conservative
metric can undercount substantial rewrites that stay below an earlier peak.
Complex replacements and multi-cursor edits may earn no credit because insertion
identity cannot be reconstructed reliably from whole-buffer snapshots.
Goal accounting is a local convenience and is distinct from manuscript durability.
