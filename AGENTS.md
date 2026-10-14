# Heinlein editorial agent guidance

Heinlein turns author-controlled manuscripts into publication artifacts. Editorial tools are **advisory only**: show findings with evidence and preserve the source until the author explicitly approves a revision. Do not silently edit a manuscript, rewrite authorial choices, publish, or alter canon.

- **Never flag, normalize, remove, or replace em dashes** as an AI-writing marker. They are protected authorial style.
- Deliberate fragments, repetition, profanity, one-line paragraphs, and interruptions may be expressive rather than errors.
- Flag template contrasts and stacked short sentences only in context, not as blanket prohibitions.
- Follow `editorial/voice-guardian/protected-choices.json`, `voice-profile.md`, and author feedback when evaluating Austen's voice. These are an **opt-in author profile**, not defaults for all Heinlein users.
- Protect queer, trans, kink, and furry content from sanitizing edits.
- Editing is not a publication gate. Structural integrity checks may block an unsafe build; stylistic recommendations must not.
- Use the archive's canon and manuscript source for facts rather than inventing corrections.

Use `python3 tools/unslop.py check FILE` for inexpensive advisory lint; use `python3 tools/voice_guardian.py review FILE` for an optional model-backed review (requires configured Claude or Codex CLI). All editorial results require author judgment.
