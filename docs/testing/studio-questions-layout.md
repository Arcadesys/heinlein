# Questions pane layout checkpoint

Outcome: make saved conversations readable and follow-ups reachable at large text sizes, while preserving explicit context sharing and author revision approval.

Route: bounded workhorse implementation with a user-requested big-thinky UX review. Scope is renderer layout, labels, focus and shortcut handling; native transport and chat storage are unchanged.

The conversation now comes before the composer and account settings. Saved chats, new chat, Reply and Close questions remain in an opaque sticky header. Reply reaches the composer after a long answer. Ordinary answers use upright UI text and the pane's single scroll surface. Exact outbound context/history, message receipts, connection settings and storage guidance remain available in disclosures. Capturing context or requesting a revision opens the outbound preview.

Below 1400 CSS pixels, Questions becomes a dedicated dialog with a keyboard focus boundary. Wider windows dock it beside the editor. The repository navigator is hidden while Questions is open and its prior preference is retained. App navigation shortcuts cannot move focus behind the dedicated view; active author dialogs retain precedence.

## Verification, 2026-10-16

- Full renderer suite: 490 tests passed across 27 files after the layout and focus changes.
- Subsequent focused integration suite: 22 tests passed, including dedicated-view shortcuts and author-dialog precedence.
- After the native review exposed a saved-picker focus handoff, the panel and integration suites passed all 54 tests with explicit deferred focus restoration.
- Native release build passed after the final shortcut guard change.
- Native UX review passed at 700, 1200 and 1600 pixel window widths: reflow, dedicated/docked layout, upright answers, opaque header, Reply focus, outbound disclosure and keyboard close/shortcut behavior. The final saved-picker regression also passed: Down/Return switches threads and the next Tab reaches New chat inside Questions. Screen-reader speech and numerical contrast were not measured.
- The six pre-existing synthetic chat/source files in `/private/tmp/heinlein-chat-smoke` retained their SHA-256 fingerprints. An additional offline long-answer fixture was used for layout review. No model request or manuscript revision was made during this layout verification.

The repair app is a local build. These checks do not establish updater or released-app delivery.
