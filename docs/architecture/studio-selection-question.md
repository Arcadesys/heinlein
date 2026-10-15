# Studio selection questions

This is an author-controlled local copy/paste workflow for asking about a highlighted
passage. It is not a live ChatGPT integration. OpenAI's documented
[Work with Apps on macOS](https://help.openai.com/en/articles/10119604-work-with-apps-on-macos)
supports specific applications; it does not document a custom Heinlein handoff.
Studio creates no endpoint, credentials, provider configuration, grants, or network
requests. It does not claim to send a question or receive a provider response.

## Author workflow

1. Highlight a nonempty passage in an editable scene and open **Ask about selection**.
   The dialog explicitly identifies its manual copy/paste behavior and disconnected
   provider status. It shows the exact captured selection and its local bindings.
2. Write a question. Optionally include nearby context, bounded to 600 UTF-16 units
   on each side within this scene. That context is shown when opted in. The complete
   prompt is inspectable before copying. No other manuscript files are read.
3. Explicitly choose **Copy prompt for ChatGPT**, then paste into ChatGPT yourself.
   Merely selecting text, opening the dialog, or typing a question performs no copy.
   The operating system may sync the clipboard. If clipboard permission or access
   fails, **Select prompt for manual copy** provides an ordinary system-copy fallback.
   Manual browser copying can normalize line endings.
4. Paste only the proposed replacement into the plain-text input. The input uses LF
   line endings; source outside the selection is untouched. Explanation or Markdown
   fences are not silently stripped. Arbitrary source, questions, and responses are
   rendered inertly as plain text.
5. Choose **Review replacement** to see the selected source and replacement side by
   side. Edits after review invalidate it. An explicitly edited-to-empty replacement
   has a deletion warning. Only **Apply reviewed replacement** changes the editor.
   Cancel and Escape close without applying. Application follows the existing
   editor/Core autosave and recovery path, including guarded on-disk hash checks.

## Bindings and rejection

The immutable snapshot retains repository session, relative path, optional stable
scene ID, document generation, editor edit revision, exact raw source, UTF-16 range,
UTF-8 byte range, selected text, and a SHA-256 of the current buffer. SHA-256 uses
local Web Crypto and fails closed if unavailable. UTF-8 encoding is checked for
unpaired surrogates; selection boundaries cannot split Unicode surrogate pairs or
CRLF pairs. The model never parses or reconstructs Markdown/frontmatter.

The persisted Core hash is retained as provenance, not used as the only stale
check: successful autosave of the identical buffer must not invalidate the dialog.
Changed bytes, edit-and-undo revisions, selection changes, different documents,
scene identity changes, repository sessions, or document generations reject the
response. Read-only, unresolved recovery, detached, and busy states reject capture,
copy, review, and application. The caller rechecks synchronously immediately before
the editor transaction; this is a local UI guard, not a new Core capability.

The exact proposed splice is compared against the intended displayed prefix,
replacement, and suffix. A raw CR/LF join that would merge separate displayed line
breaks is rejected rather than silently normalized. The author can expand the
selection to include the adjacent line ending and start a new question.

A reviewed replacement is consumed before the apply callback. Repeat clicks cannot
apply twice. An unexpected apply exception leaves the dialog blocked and asks the
author to inspect the editor; it does not retry an uncertain change. Async hash or
clipboard completions cannot reopen a canceled/destroyed dialog or update another
scene's dialog. In-memory snapshots are released on close. There is no persisted
question history, hidden full-manuscript prompt, new file writer, provider identity
claim, native proposal receipt, or publication/release approval.

## Integration contract

`createSelectionQuestionPanel` receives current raw selection/state, a synchronous
atomic editor apply callback, and status reporting. The caller converts CodeMirror
positions with `rawOffset`, exposes only one nonempty range, maps all native/editor
busy and recovery conditions, and increments the edit revision for every buffer
change, including history changes. It closes the panel on document/session changes.
The callback validates `selectionQuestionProblem` once more, then applies the exact
reviewed `nextSource` through the normal editor transaction path. It does not call a
new file writer. Optional clipboard injection is for tests, not provider transport.

Focused tests cover CRLF/Unicode bytes and hashing, changed selection/source/session,
edit-and-undo revisions, saved-buffer acknowledgements, unsafe newline joins,
review-before-apply, repeated clicks, literal HTML, context opt-in, clipboard failure,
cancellation, delayed results, and read-only/recovery/busy/detached guards.

Validation: 53 focused model/dialog tests, 3 Studio integration tests, and the full
230-test renderer suite pass; TypeScript/Vite production build passes. Native
macOS keyboard, screen-reader, clipboard, and dialog behavior remain unverified.
