#!/usr/bin/env python3
"""Advisory project-local editorial hooks. Never writes manuscript files."""
import json
import re
import subprocess
import sys
from pathlib import Path

IGNORED = ("AGENTS.md", "README.md", "SCHEMA.md", "ARCHIVE-CATALOG.md")
SKIP_PARTS = {".git", ".codex", "node_modules", "dist", "build", "exports", "output"}
PROSE_EXTENSIONS = {".md", ".txt", ".markdown"}

PATTERNS = (
    ("cliche", re.compile(r"\b(?:but here's the thing|here's what nobody tells you|let that sink in|that changes everything|the future isn't coming)\b", re.I), "Stock rhetorical flourish"),
    ("contrast", re.compile(r"\b(?:it's|it is) not\b.{3,150}?(?:[,;:]\s*|[.!?]\s+)(?:it's|it is)\b", re.I), "Formulaic 'it's not X, it's Y' contrast"),
    ("dramatic-question", re.compile(r"\b(?:the truth|the reality)\?\s+\S+", re.I), "Manufactured dramatic reveal"),
)

def run_git(root, *args):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=8)
    return result.stdout if result.returncode == 0 else ""

def root_path():
    p = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=5)
    if p.returncode:
        return None
    root = Path(p.stdout.strip()).resolve()
    return root if root.name == "heinlein" and (root / "AGENTS.md").is_file() else None

def prose(path):
    p = Path(path)
    return bool(p.parts) and not (set(p.parts) & SKIP_PARTS) and p.name not in IGNORED and p.suffix.lower() in PROSE_EXTENSIONS

def changed_lines(root):
    """Review added/modified lines, not untouched historical manuscript prose."""
    diff = run_git(root, "diff", "--no-ext-diff", "--unified=0", "HEAD", "--", ".")
    files = {}
    current = None
    line = 0
    for raw in diff.splitlines():
        if raw.startswith("+++ b/"):
            current = raw[6:]
            if prose(current):
                files.setdefault(current, [])
            else:
                current = None
        elif raw.startswith("@@ "):
            m = re.search(r"\+(\d+)", raw)
            if m:
                line = int(m.group(1))
        elif current is not None and raw.startswith("+") and not raw.startswith("+++"):
            files[current].append((line, raw[1:]))
            line += 1
        elif current is not None and raw.startswith(" "):
            line += 1
    # Untracked drafts have no Git diff yet.
    untracked = run_git(root, "ls-files", "--others", "--exclude-standard", "-z")
    for name in filter(None, untracked.split("\0")):
        if prose(name):
            p = (root / name).resolve()
            if p.is_file() and p.is_relative_to(root) and p.stat().st_size < 200000:
                files[name] = list(enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1))
    return files

def lint(lines):
    findings = []
    for i, (lineno, text) in enumerate(lines):
        if not text.strip() or text.lstrip().startswith(("#", ">", "`", "|")):
            continue
        for code, pattern, explanation in PATTERNS:
            if pattern.search(text):
                findings.append((lineno, code, explanation))
        # Multiple tiny full sentences in one line is often synthetic emphasis.
        # Inspect the prior delimiter without consuming the next sentence's anchor.
        fragments = re.findall(r"(?:^|(?<=[.!?])\s+)([A-Z][^.!?]{1,26}[.!?])", text)
        if len(fragments) >= 3:
            findings.append((lineno, "fragment-stack", "Three or more very short sentences in succession"))
    return findings

def stop(root):
    results = []
    for path, lines in changed_lines(root).items():
        for lineno, code, explanation in lint(lines):
            results.append(f"{path}:{lineno}: {code}: {explanation}")
    if results:
        return {"systemMessage": "Unslop advisory (no files changed):\n" + "\n".join(results[:20]) +
                ("\nMore findings omitted." if len(results) > 20 else "") +
                "\nReview context before editing. Preserve deliberate rhythm and ALL em dashes. Never auto-rewrite."}
    return {}

def session(root):
    return {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext":
            "Heinlein editorial rules: Read root AGENTS.md and applicable nested AGENTS.md before edits. "
            "Preserve the author's voice and deliberate short punches. Em dashes are protected: never flag or replace. "
            "Watch for templated 'it's not X, it's Y' and fragment stacks. "
            "Consult established canon before changing character facts. "
            "Report editorial suggestions; never rewrite, publish, or change canon without authorization."}}

def main():
    try:
        json.load(sys.stdin)  # Codex hook event envelope (not a stable transcript).
    except (ValueError, EOFError):
        pass
    root = root_path()
    if root is None:
        print("{}")
        return
    action = sys.argv[1] if len(sys.argv) > 1 else "stop"
    print(json.dumps(session(root) if action == "session" else stop(root)))

if __name__ == "__main__":
    main()
