# Voice Guardian

An editor that learns what *this writer* means by good writing. It doesn't teach her what an AI thinks good writing looks like.

It asks one question: **does this passage keep the things that make the writer sound like herself?** For revisions, it also asks: **did the edit damage anything that was already working?** Every judgment cites published passages. It's advisory. It never rewrites.

Based on Dot's proposal (October 2026).

---

## Pieces

| File | What it is |
|---|---|
| `voice-profile.md` | The fingerprint: rhythm, narrator, register shifts, specificity, punctuation, what generic AI revision looks like here |
| `reference-passages.jsonl` | 24 passages from published essays, blog posts, and finished shorts. Each one is tagged with genre, traits, and an editorial note |
| `editorial-rubric.json` | Six dimensions (voice fidelity, rhetorical naturalness, rhythm, specificity, authorial personality, meaning preservation), severities, verdicts, genre notes |
| `protected-choices.json` | Choices that are never problems on their own: em-dashes, fragments, one-line paragraphs, repetition, profanity, political directness… |
| `feedback.jsonl` | Your accept/reject/modify rulings. They feed back into every later prompt |
| `evals/cases.jsonl` | Labeled regression cases |
| `evals/results/` | Eval runs, one JSON per run |
| `reports/` | Per-run editorial reports (gitignored) |

Code: `tools/unslop.py` (deterministic, free) and `tools/voice_guardian.py` (model-assisted). Tests: `python3 tools/test_voice_guardian.py`.

---

## Workflow

```
agent edits prose → Stop hook → changed prose? → unslop (cheap)
    → findings? → agent shows them to you (advisory)
    → for substantial revisions you run:  voice_guardian.py diff
    → report with evidence from published work
    → you rule: accept / reject / modify  → feedback.jsonl → next run
```

The `unslop.py` Stop hook is wired for Claude Code (`.claude/settings.json`). Codex runs its own advisory Stop hook, `.codex/hooks/editorial.py` (see `.codex/hooks.json`). The Claude hook only looks at prose you changed since the last turn, so your existing local edits don't re-trigger it. The first run takes a silent baseline. Turn it off with `VOICE_GUARDIAN_HOOK=off`.

Model review is opt-in. Run it on purpose:

```bash
python3 tools/voice_guardian.py diff                       # HEAD vs working tree
python3 tools/voice_guardian.py diff HEAD~1 HEAD           # a commit
python3 tools/voice_guardian.py diff main -- essays/       # branch vs working tree, scoped
python3 tools/voice_guardian.py compare old.md new.md      # any two files (or REV:PATH)
python3 tools/voice_guardian.py review essays/my-essay.md  # does a whole doc sound like you?
python3 tools/voice_guardian.py drift novels/x/ms/ --narrate
```

Or `/voice-guardian` in Claude Code.

### Rulings

```bash
python3 tools/voice_guardian.py feedback latest F2 reject --reason "deliberate rhythm"
python3 tools/voice_guardian.py feedback latest F3 modify --note "right problem; restore the aside instead of cutting"
python3 tools/voice_guardian.py feedback latest F1 reject --reason "deliberate" --protect "Second-person asides to the reader in blog posts"
python3 tools/voice_guardian.py stats     # precision and false-positive rate, by dimension/genre/model
```

`--protect` promotes a rejection into `protected-choices.json` so it holds everywhere.

### Evals

```bash
python3 tools/voice_guardian.py fixtures --n 10            # 3 synthetic variants per reference passage
python3 tools/voice_guardian.py eval                       # run the suite
python3 tools/voice_guardian.py eval --model sonnet        # compare models
python3 tools/voice_guardian.py label old.md new.md --verdict acceptable   # add a real, author-labeled case
```

Each reference passage gets three variants:

- **tighten**: a modest edit you'd sign off on. Expected: *acceptable*.
- **generic**: a fluent "polish this" AI rewrite. Expected: *original-better*.
- **sanded**: a copyeditor's style-manual "corrections". Fragments joined, em-dashes swapped out, asides cut. Expected: *original-better*.

The metric that matters most is the **false alarm rate**: how often Voice Guardian complains about a revision that was fine. Synthetic labels are a starting point. Replace them with real ones via `label` as you approve and reject actual revisions. Re-run `eval` whenever you change the profile, rubric, prompts, or model.

### Drift

`drift` computes per-chapter voice stats: sentence length and spread, em-dash, italic, fragment, and one-line-paragraph rates, first person, questions, asides, and dialogue share. It flags chapters that move well away from the manuscript's own mean. `--narrate` asks the model to describe the shift with quoted evidence and a question for you. A shift is a question, not a verdict.

---

## Settings

| Env var | Default | |
|---|---|---|
| `VOICE_GUARDIAN_MODEL` | `opus` | Model for review/diff/eval |
| `VOICE_GUARDIAN_FIXTURE_MODEL` | `sonnet` | Model that generates synthetic fixtures |
| `VOICE_GUARDIAN_BACKEND` | `claude` | `claude` (headless `claude -p`) or `codex` (`codex exec`) |
| `VOICE_GUARDIAN_HOOK` | on | `off` disables the Stop hook |

## Curating the corpus

The 24 reference passages are a first pass picked by Claude (`"author_reviewed": false`). Swap in the passages you'd defend as your strongest *intentional* choices, especially the ones a conventional editor would "fix." Keep it near 20. More passages isn't better. Sharper ones are.
