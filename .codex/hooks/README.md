# Writing archive editorial hooks

These are **project-local Codex hooks**, loaded only when this repository's project config is trusted. They never mutate manuscripts, block completion, launch models, or publish work.

- `SessionStart`: reminds the agent to consult root/nested `AGENTS.md`, protect em dashes, and check canon.
- `Stop`: `unslop` scans **added lines of tracked prose** and untracked prose drafts. It emits an advisory for high-confidence formulas such as "it's not X, it's Y", "let that sink in", and stacked short sentences. Clean prose results in no notification.
- Existing prose outside the diff is intentionally ignored. The report is capped at 20 findings.
- Em dashes are **never a lint target**. Punchy short sentences are allowed; only repeated stacks merit review.
- Writing style and continuity are interpretive tasks: see `AGENTS.md`, not a brittle regular-expression rewrite rule.
- No automatic revision ledger: Git captures changes, while author-approved rationale can be recorded in commit messages. Never fabricate motivations.

## Enable
From the repository, start Codex and use `/hooks` to review/trust these project hooks. Their definitions are skipped until trusted. Global hooks, if configured, remain independent.

## Test locally
```sh
python3 -m unittest discover -s .codex/hooks/tests -v
printf '{}' | python3 .codex/hooks/editorial.py stop
```
Run from within the repository; the stop hook checks your current Git diff, so it may emit editorial advisories.

The hooks use Python 3.9+ and Git; no external packages required.
