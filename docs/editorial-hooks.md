# Editorial tooling migrated from writing-archive

This is the first, deliberately conservative migration. The source archive remains unchanged. The tools run **on explicit invocation**; optional project-local Claude/Codex Stop hooks offer non-mutating diff advisories. They are not yet wired into `heinlein build` or the preview UI.

## Commands

```sh
python3 tools/unslop.py check path/to/manuscript.md
python3 tools/unslop.py diff older.md newer.md
python3 tools/voice_guardian.py review path/to/manuscript.md
python3 tools/voice_guardian.py compare original.md revised.md
python3 -m unittest discover -s .codex/hooks/tests -v
uv run pytest tests/test_editorial_tools.py
```

Voice Guardian requires a local `claude` CLI by default, or `VOICE_GUARDIAN_BACKEND=codex` to run using Codex. No automatic model calls occur during `heinlein build` or project hooks. Models may incur usage costs when manually invoked.

The copied reference passages and protected choices reflect **Austen's author-specific profile**. Do not apply that profile to other authors without opting in. Writing-archive keeps its own copy and remains the source history; reconcile later changes intentionally.

## Invariants

- Findings are advisory; original manuscripts are never rewritten by these tools.
- Authorial em dashes are protected, not lint targets.
- Edits require author approval, with a reviewable diff.
- Publishing and content-integrity gates are separate from prose-style advisories.
- `Stop` hooks are project-scoped and require local tooling/trust; a GitHub PR alone does not enable hooks on your computer.

## Next integration

Define a versioned finding format, attach findings to manuscript revisions, expose accept/reject/modify in the Heinlein UI, and add deterministic text-integrity validation before release. Those are follow-up product changes, not implied by this tooling port.
