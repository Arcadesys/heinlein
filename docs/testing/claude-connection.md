# Claude connection: validation notes

Claude can answer Ask, Suggest revision and Review in Heinlein Studio, using an
Anthropic API key. This note records what was checked automatically, and what
still needs a real Mac and a real key.

## Checked automatically (no network, synthetic keys)

| Area | Where | What it proves |
|---|---|---|
| Request conversion | `crates/drafting-questions/src/anthropic.rs` tests | Only the author-previewed text is sent. No tools, no thinking override. Unsupported schema keywords are stripped and still enforced on the answer. |
| Stream decoding | same | Every chunk boundary, CRLF and UTF-8 split decodes the same way. Reasoning and fallback blocks never become answer text. Refusal, length limit, tool use and interrupted streams never become accepted answers. |
| Errors | same | 401, 402, 404, 429, 529 and stream errors map to fixed Claude wording. Provider text never appears. |
| Review retries | `review_workflow.rs` tests | Claude "overloaded" is retried like a 503. A rejected key or billing problem stops the batch. |
| Key storage | `crates/claude-auth` tests | The key is checked before saving, kept only in the vault, absent from status and settings files, and removed on sign-out. Leases end on any change. |
| Native binding | `src-tauri/src/questions.rs` test | Send runs only on the exact key, model and generation the author saw. Proposals record a `nativeAnthropic` origin. |
| Panel | `src/questionPanel.claude.test.ts` | The key field appears only after choosing Claude and is cleared at once. Send names Claude, and the disclosure names Anthropic. |
| Layout and accessibility | `tests/browser/claude-connection.pw.ts` | The card at 100% and 200% text, desktop and narrow: no serious axe findings, targets at least 44px, no sideways scroll, manuscript does not move. |

## Still needs a real Mac and key

1. Save a real Anthropic API key, then confirm it appears in Keychain Access under
   `me.thearcades.heinlein.studio.claude`.
2. Ask about a passage, Suggest a revision, and run Review chapter on Claude.
3. Switch back to ChatGPT and send once, to confirm the two connections stay
   independent.
4. Remove the key, then confirm the Keychain entry is gone.
