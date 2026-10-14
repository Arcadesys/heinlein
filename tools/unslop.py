#!/usr/bin/env python3
"""Deterministic slop check. Cheap, stdlib only, no model calls.

    check FILE...           flag slop patterns in a file
    diff OLD NEW            flag what a revision INTRODUCED and which voice
                            features it LOST (OLD may be REV:PATH for git)
    hook                    Stop-hook entry point for Claude Code / Codex

This is the first stage of Voice Guardian (see editorial/voice-guardian/). It
does not judge prose. It counts things: patterns a generic AI revision tends to
add, and voice features (em-dashes, fragments, one-line paragraphs, italics,
profanity) a generic revision tends to remove. The author's own work uses some
of these patterns on purpose, so `diff` only reports what changed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import statistics
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ------------------------------------------------------------------- patterns

# (id, category, severity, regex, note)
RULES: list[tuple[str, str, str, str, str]] = [
    ("suddenly", "banned", "low", r"\bsuddenly\b", "CLAUDE.md: avoid 'suddenly'"),
    ("very", "banned", "low", r"\bvery\b", "CLAUDE.md: avoid 'very'"),
    ("hedge", "hedge", "medium",
     r"\b(perhaps|arguably|it could be argued|you might (want to )?consider|it(?:'s| is) (?:important|worth) (?:to note|noting)|to some extent|in many ways|somewhat|one could say)\b",
     "Hedging. Not this voice."),
    ("ai-lexicon", "ai-lexicon", "high",
     r"\b(delve[sd]?|tapestry|testament to|unlock(?:s|ing|ed)?|transformative|leverag(?:e|es|ing|ed)|seamless(?:ly)?|robust|ever-evolving|game[- ]changer|harness(?:ing)? the power|navigat(?:e|ing) the (?:complexit\w+|landscape)|in today's (?:fast-paced|digital|modern) world|multifaceted|pivotal|underscor(?:e|es|ed|ing)|showcas(?:e|es|ed|ing)|embark(?:s|ed|ing)? on|elevat(?:e|es|ed|ing) (?:the|your|our)|speaks volumes|a reminder that|rich tapestry|realm of|foster(?:s|ing|ed)?|empower(?:s|ing|ed|ment)?|resonat(?:e|es|ed|ing) (?:with|deeply)|intricate|vibrant)\b",
     "Generic AI lexicon."),
    ("canned-contrast", "contrast", "low",
     r"\b(?:is ?n[o']t (?:just |simply |merely )?about\b[^.!?\n]{0,80}[.!?;,—-]\s*(?:it'?s|it is|but) about|not (?:just|only|simply|merely) [^.!?\n]{1,60},? but (?:also )?)",
     "Formulaic contrast. The author uses her own; judge whether this one is earned."),
    ("connective-filler", "filler", "low",
     r"(?:^|(?<=[.!?]\s))(?:Moreover|Furthermore|Additionally|In conclusion|Ultimately|Notably|Importantly),",
     "Essay-machine transition."),
    ("abstract-stakes", "ai-lexicon", "medium",
     r"\b(the future of \w+|at its core|in an era of|the power of|a new paradigm|unprecedented|profound(?:ly)?)\b",
     "Inflated abstraction where a specific would land harder."),
]
_COMPILED = [(i, c, s, re.compile(rx, re.I | re.M), n) for i, c, s, rx, n in RULES]

PROFANITY = re.compile(r"\b(fuck\w*|shit\w*|bitch\w*|damn\w*|hell|ass(?:hole)?s?|goddam\w*|crap)\b", re.I)
FIRST_PERSON = re.compile(r"\b(I|I'm|I've|I'd|I'll|me|my|mine|myself)\b")
ITALIC = re.compile(r"(?<![*\w])[*_](?![*_\s])[^*_\n]{1,60}?(?<![\s*_])[*_](?![*\w])")
EM_DASH = re.compile(r"—|(?<=\w) -- (?=\w)|(?<=\w) – (?=\w)")
PAREN = re.compile(r"\([^)]{3,}\)")

PROSE_EXCLUDE_NAMES = {"CLAUDE.md", "AGENTS.md", "README.md", "SCHEMA.md", "ARCHIVE-CATALOG.md",
                       "BRIEF.md", "SPINE.md", "BUILDING.md", "MEMORY.md"}
PROSE_EXCLUDE_DIRS = {"tools", "editorial", ".claude", ".codex", ".git", "node_modules", "_dist",
                      "dist", "build", "output", "exports", "templates", "scripts", "reports", "_plans"}


# --------------------------------------------------------------------- text

def strip_frontmatter(text: str) -> str:
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            return text[end + 4:].lstrip("\n")
    return text


def prose_paragraphs(text: str) -> list[str]:
    """Paragraphs of prose: drops headers, rules, images, html, code fences."""
    out, in_code = [], False
    for block in re.split(r"\n\s*\n", strip_frontmatter(text)):
        b = block.strip()
        if b.startswith("```"):
            in_code = not in_code if b.count("```") % 2 else in_code
            continue
        if in_code or not b or re.fullmatch(r"[-*_]{3,}", b) or b.startswith(("#", "![", "<")):
            continue
        out.append(b)
    return out


def sentences(para: str) -> list[str]:
    para = re.sub(r"\s+", " ", para.strip("> "))
    return [s for s in re.split(r"(?<=[.!?…])[\"”’)*_]*\s+(?=[\"“*_(]?[A-Z0-9])", para) if s.strip()]


def word_count(s: str) -> int:
    return len(re.findall(r"[A-Za-z0-9'’]+", s))


def line_of(text: str, idx: int) -> int:
    return text.count("\n", 0, idx) + 1


def sentence_at(text: str, start: int, end: int) -> str:
    a = max(text.rfind(c, 0, start) for c in ".!?\n") + 1
    bs = [i for i in (text.find(c, end) for c in ".!?\n") if i != -1]
    b = min(bs) + 1 if bs else len(text)
    return re.sub(r"\s+", " ", text[a:b]).strip()


# ---------------------------------------------------------------- features

def features(text: str) -> dict:
    """Voice features per document. Rates are per 1000 words."""
    paras = prose_paragraphs(text)
    body = "\n\n".join(paras)
    words = max(word_count(body), 1)
    sents = [s for p in paras for s in sentences(p)]
    lens = [word_count(s) for s in sents] or [0]
    k = 1000 / words
    one_line = sum(1 for p in paras if len(sentences(p)) == 1 and word_count(p) <= 14)
    return {
        "words": words,
        "sentences": len(sents),
        "paragraphs": len(paras),
        "avg_sentence_len": round(statistics.mean(lens), 1),
        "sentence_len_stdev": round(statistics.pstdev(lens), 1),
        "avg_paragraph_words": round(words / max(len(paras), 1), 1),
        "em_dash_rate": round(len(EM_DASH.findall(body)) * k, 2),
        "italic_rate": round(len(ITALIC.findall(body)) * k, 2),
        "fragment_rate": round(sum(1 for n in lens if 0 < n <= 4) * k, 2),
        "one_line_para_rate": round(one_line * k, 2),
        "profanity_rate": round(len(PROFANITY.findall(body)) * k, 2),
        "first_person_rate": round(len(FIRST_PERSON.findall(body)) * k, 2),
        "question_rate": round(body.count("?") * k, 2),
        "paren_rate": round(len(PAREN.findall(body)) * k, 2),
        "dialogue_share": round(sum(word_count(m) for m in re.findall(r"[\"“]([^\"”]+)[\"”]", body)) / words, 3),
    }


# Features a generic revision tends to strip. Reported when the rate drops.
PROTECTED_FEATURES = {
    "em_dash_rate": "em-dashes",
    "italic_rate": "italic emphasis",
    "fragment_rate": "fragments",
    "one_line_para_rate": "one-line paragraphs",
    "profanity_rate": "profanity",
    "first_person_rate": "first-person narrator",
    "paren_rate": "parenthetical asides",
    "sentence_len_stdev": "rhythm variation (sentence-length spread)",
}


# ------------------------------------------------------------------- checks

@dataclass
class Hit:
    rule: str
    category: str
    severity: str
    line: int
    match: str
    sentence: str
    note: str


def scan(text: str) -> list[Hit]:
    body = strip_frontmatter(text)
    offset = text.count("\n", 0, len(text) - len(body))
    hits = []
    for rid, cat, sev, rx, note in _COMPILED:
        for m in rx.finditer(body):
            hits.append(Hit(rid, cat, sev, line_of(body, m.start()) + offset, m.group(0),
                            sentence_at(body, m.start(), m.end())[:240], note))
    return sorted(hits, key=lambda h: h.line)


def diff(old: str, new: str) -> dict:
    """What the revision introduced and which protected features it lost."""
    old_norm = re.sub(r"\s+", " ", old)
    introduced = [h for h in scan(new) if h.sentence not in old_norm]
    fo, fn = features(old), features(new)
    lost = []
    for key, label in PROTECTED_FEATURES.items():
        a, b = fo[key], fn[key]
        # Ignore noise on tiny counts: need a real baseline and a real drop.
        if a >= 2 and b < a * 0.6:
            lost.append({"feature": label, "key": key, "before": a, "after": b,
                         "severity": "medium" if key != "first_person_rate" else "high"})
    return {"introduced": [asdict(h) for h in introduced], "lost": lost,
            "features": {"before": fo, "after": fn}}


# -------------------------------------------------------------------- git

def git(*args: str, check: bool = True) -> str:
    r = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(r.stderr.strip())
    return r.stdout


def read_spec(spec: str) -> str:
    """A path, or REV:PATH for a git blob. Missing blob reads as empty."""
    p = Path(spec)
    if p.exists():
        return p.read_text(errors="replace")
    if ":" in spec:
        try:
            return git("show", spec)
        except RuntimeError:
            return ""
    raise FileNotFoundError(spec)


def is_prose(path: str) -> bool:
    p = Path(path)
    return (p.suffix.lower() == ".md" and p.name not in PROSE_EXCLUDE_NAMES
            and not any(part in PROSE_EXCLUDE_DIRS for part in p.parts))


# ------------------------------------------------------------------- render

def render_check(path: str, hits: list[Hit]) -> str:
    if not hits:
        return f"{path}: clean"
    out = [f"{path}: {len(hits)} flag(s)"]
    for h in hits:
        out.append(f"  {path}:{h.line}  [{h.severity}] {h.rule}: “{h.match}” — {h.sentence}")
    return "\n".join(out)


def render_diff(label: str, d: dict) -> str:
    if not d["introduced"] and not d["lost"]:
        return f"{label}: no slop introduced, no voice features lost"
    out = [f"{label}:"]
    for h in d["introduced"]:
        out.append(f"  + line {h['line']} [{h['severity']}] {h['rule']}: “{h['match']}” — {h['sentence']}")
    for l in d["lost"]:
        unit = " per 1000 words" if l["key"].endswith("_rate") else ""
        out.append(f"  - lost {l['feature']}: {l['before']} → {l['after']}{unit} [{l['severity']}]")
    return "\n".join(out)


# --------------------------------------------------------------------- hook

STATE_DIR = Path(git("rev-parse", "--git-common-dir", check=False).strip() or ".git")
if not STATE_DIR.is_absolute():
    STATE_DIR = ROOT / STATE_DIR
STATE_DIR = STATE_DIR / "voice-guardian"


def _changed_prose() -> list[str]:
    out = git("status", "--porcelain", "-z", "--untracked-files=all", check=False)
    paths = []
    entries = out.split("\0")
    i = 0
    while i < len(entries):
        e = entries[i]
        i += 1
        if len(e) < 4:
            continue
        status, path = e[:2], e[3:]
        if status[0] in "RC":
            i += 1  # skip the rename source
        if "D" in status:
            continue
        if is_prose(path):
            paths.append(path)
    return paths


def cmd_hook(args) -> int:
    """Stop hook. Compares each changed prose file against its snapshot from the
    previous Stop (or HEAD the first time it's seen), so pre-existing local
    edits don't re-trigger every turn. Advisory: never rewrites anything."""
    if os.environ.get("VOICE_GUARDIAN_ACTIVE") or os.environ.get("VOICE_GUARDIAN_HOOK") == "off":
        return 0
    try:
        payload = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    except json.JSONDecodeError:
        payload = {}
    snaps = STATE_DIR / "snapshots"
    snaps.mkdir(parents=True, exist_ok=True)
    first_run = not (STATE_DIR / "initialized").exists()

    reports = []
    for path in _changed_prose():
        full = ROOT / path
        try:
            new = full.read_text(errors="replace")
        except OSError:
            continue
        snap = snaps / hashlib.sha1(path.encode()).hexdigest()
        if snap.exists():
            old = snap.read_text(errors="replace")
        elif first_run:
            old = new  # baseline silently on first run; don't flag old local edits
        else:
            old = read_spec(f"HEAD:{path}")
        snap.write_text(new)
        if old == new:
            continue
        d = diff(old, new)
        if d["introduced"] or d["lost"]:
            reports.append(render_diff(path, d))
    (STATE_DIR / "initialized").touch()

    if not reports or payload.get("stop_hook_active"):
        return 0
    msg = ("Voice Guardian (unslop, advisory) found patterns in prose you just edited:\n\n"
           + "\n\n".join(reports)
           + "\n\nShow these to the author as advisory findings. Don't rewrite anything unless asked. "
             "For a model-assisted review of the revision run: python3 tools/voice_guardian.py diff")
    print(json.dumps({"decision": "block", "reason": msg}))
    return 0


# ---------------------------------------------------------------------- cli

def cmd_check(args) -> int:
    results = {}
    for path in args.files:
        hits = scan(Path(path).read_text(errors="replace"))
        results[path] = [asdict(h) for h in hits]
        if not args.json:
            print(render_check(path, hits))
    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    return 1 if args.strict and any(results.values()) else 0


def cmd_diff(args) -> int:
    d = diff(read_spec(args.old), read_spec(args.new))
    print(json.dumps(d, indent=2, ensure_ascii=False) if args.json else render_diff(f"{args.old} → {args.new}", d))
    return 1 if args.strict and (d["introduced"] or d["lost"]) else 0


def cmd_features(args) -> int:
    for path in args.files:
        print(path, json.dumps(features(Path(path).read_text(errors="replace"))))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("files", nargs="+")
    c.add_argument("--json", action="store_true")
    c.add_argument("--strict", action="store_true", help="exit 1 on any flag")
    c.set_defaults(fn=cmd_check)
    d = sub.add_parser("diff")
    d.add_argument("old")
    d.add_argument("new")
    d.add_argument("--json", action="store_true")
    d.add_argument("--strict", action="store_true")
    d.set_defaults(fn=cmd_diff)
    f = sub.add_parser("features")
    f.add_argument("files", nargs="+")
    f.set_defaults(fn=cmd_features)
    h = sub.add_parser("hook")
    h.set_defaults(fn=cmd_hook)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
