# Repository chat threads

Studio's Questions panel supports saved **Ask** threads. Choose a saved chat to
continue it, or **New chat** to start another. Opening a chat does not send a
request. Closing the panel, switching scenes/accounts, and starting another chat
preserve previously saved files. Sign-in credentials remain in native private
app storage, outside the repository.

## Files and durability

Each thread lives in `.heinlein/chats/<thread UUID>/`:

- `thread.json`: schema version, ID, first-message title and creation time.
- `<request UUID>-question.json`: exact sent question, explicitly captured context,
  selected history, model and a local source-path label.
- `<request UUID>-answer.json`: validated answer, model, request ID and token usage.
- `<request UUID>-error.json`: sanitized failure/cancellation metadata when available.

Files are readable, formatted JSON. They are normal repository files that Git can
track; Studio does not commit, push or share them automatically. Sent context can
contain manuscript excerpts the author explicitly chose. Local path labels never
enter the provider request. No implicit manuscript retrieval occurs.

The native host binds storage to the explicitly selected repository. It saves the
question before inference and the validated answer before reporting success. A
request interrupted by process exit retains its question without inventing an
answer or retrying. Unanswered messages remain visible when the thread reopens.

Records publish through a synced temporary file and an exclusive hard-link create,
followed by directory sync. Existing records cannot be overwritten by duplicate
requests, another app instance or a retry. Descriptor-relative no-follow directory
and file operations reject symlink escapes; reads reject non-files and hard links.
A failed/corrupt read preserves files and blocks accidental context-free sending.
Storage failures do not trigger another model call. Uncertain disk persistence is
reported as a failure, not success. No automatic retention deletion is implemented.

Reading is bounded to 4,096 directory entries, 512 KB per record and 16 MB of event
records per loaded thread. Exceeding a bound reports an error and preserves files;
it never truncates stored history. These are resource limits, not backup guarantees.

## Conversation and authority

The full saved transcript is retained on disk and available when reopening. The
existing provider input budget still applies: at most eight previous messages
(four complete recent turns), fitting the 32,000-byte total input limit. The
history preview explicitly shows what will be sent and what older messages are
omitted. Previous captured context is available in the transcript but is not
silently resent. Unanswered attempts are excluded from history.

Live streamed text remains provisional. Only final validated answers enter the
saved transcript. Current revision suggestions retain their existing separate
proposal/review/author-confirmation flow; they do not become repository Ask
records or gain authority from a saved chat. Manuscripts and canon are unchanged.

## Implementation checkpoint

Route: short design pass in the current context, then bounded workhorse
implementation at requested medium effort. Runtime model/effort switching was
unavailable; no enforcement or substitution is claimed. No agents were delegated.
Usage/cost counters are unavailable; no content telemetry was added.

Native storage is in `repository-core/src/chat.rs`, native transport integration in
`src-tauri/src/chats.rs` and `questions.rs`, and controls/history in
`src/questionPanel.ts`. Tests cover disk reopening, no manuscript writes,
exclusive concurrent publication, corruption/path/link rejection, reopening in a
fresh panel, bounded sent history with full retained history, unanswered records,
new-thread preservation and creation/read failure handling.


Validation checkpoint (2026-10-16):

- All 488 renderer tests passed; a subsequent catalog-refresh continuity fix
  passed 54 focused chat/auth/fuzz checks.
- Required Rust core/auth/question/proposal/local-MCP suites passed, with four
  existing intentional ignores; nine native question tests and 30 authority
  harness tests passed.
- Workspace and authority strict Clippy, Rust formatting, TypeScript/frontend,
  native release build, signature verification and scoped diff checks passed.
- Native first-turn files were read independently from a synthetic Git repo;
  a full process exit/restart restored the exact prior question and answer.
  Git status identified all three records as normal untracked files.

- The final native build preserved the selected thread across a same-account
  model-catalog refresh. A follow-up after restart recalled `paper-boat-27` from
  the first turn, using saved history. Two live synthetic requests total used the
  selected `gpt-6.1-sol`; both sent zero manuscript context.
- Independent readback found five records: one thread, two questions and two
  answers. The follow-up question record contained the exact two-message history.
  The synthetic source remained byte-identical; no credentials appeared in records.
- New chat preserved the old thread, which was then selected and reopened with
  the keyboard. At the existing large text size, thread labels/notes wrapped in
  1200px and approximately 700px native windows, and focus remained visible.
  The window size was restored. Existing global toolbar clipping is outside this
  scoped chat-panel check.
- Local repair bundle: `/Users/arcades/Documents/Codex/heinlein-response-fix/Heinlein Studio.app`.
  The existing updater-enabled installation remains unchanged until integration.
