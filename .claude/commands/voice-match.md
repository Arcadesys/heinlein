---
description: Check whether a draft sounds like Austen wrote it. For external content, AI-drafted material, or anything that needs a voice fingerprint.
argument-hint: <file>
---

Read `$ARGUMENTS` and compare it against the voice rules in the parent `CLAUDE.md` and the reference passages in `editorial/voice-guardian/reference-passages.jsonl`.

This is a fingerprint check, not a line edit. The question is: does this sound like Austen, or does it sound like a polite generic prose generator wearing her name?

**Things that signal it's hers:**
- Short declarative punch, then the longer earned sentence.
- Italics for emphasis on a word or phrase, never decorative.
- Em-dashes for asides and interruptions — used like the way a thought breaks itself off mid-stride.
- Direct, confessional, funny without being precious. Wry then suddenly vulnerable.
- Political edge stated, not hedged. Trans, queer, labor, technology — load-bearing, not background.
- Profanity, fragments, sentences starting with "And" or "But," lowercase asides.
- Specifics over abstraction. The pendant. The locker. The exact count.

**Things that signal it isn't:**
- Hedging ("perhaps," "you might consider," "it could be argued").
- Smooth, evenly-weighted sentences with no rhythm break.
- Adverbs doing work the verb should do.
- "Suddenly," "very," dead "that"s.
- Caveats and qualifications around political claims.
- Generic universalist framings where a specific would land harder.
- Corporate-smooth prose with no rough edges.

Return:

1. **Verdict.** Sounds like her / sounds close but off / doesn't sound like her at all. One sentence.
2. **What's working** — specific lines or moments that read as hers, with file:line.
3. **What's off** — specific lines or moments that don't, with file:line and a brief note about why (which voice rule it breaks).
4. **If it's AI-drafted or external,** suggest one or two adjustments that would move it closest to her voice. Don't rewrite the draft.

If `$ARGUMENTS` is empty or the file doesn't exist, ask which draft to fingerprint.
