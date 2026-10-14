#!/usr/bin/env python3
"""Voice Guardian — advisory, model-assisted voice review. See editorial/voice-guardian/.

    review FILE                 does this document sound like the author?
    diff [REV_A [REV_B]] [-- PATH...]
                                did a revision damage what was already working?
                                (default: HEAD vs working tree)
    compare ORIGINAL REVISION   same, for two files or REV:PATH specs
    feedback REPORT FINDING accept|reject|modify [--reason ...]
                                record the author's ruling on a finding
    stats                       precision / false-positive rate from feedback
    label ORIGINAL REVISION --verdict acceptable|original-better
                                add an author-labeled eval case
    fixtures                    generate synthetic eval cases from references
    eval                        run the labeled eval suite (regression test)
    drift PATH...               voice drift across chapters of a manuscript

Never rewrites prose. Reports land in editorial/voice-guardian/reports/.
Model calls go through the `claude` CLI by default (VOICE_GUARDIAN_BACKEND=codex
to use `codex exec`). VOICE_GUARDIAN_MODEL picks the model (default: opus).
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from unslop import (  # noqa: E402
    ROOT, diff as unslop_diff, features, git, is_prose, read_spec, scan,
    strip_frontmatter, word_count,
)

VG = ROOT / "editorial" / "voice-guardian"
REPORTS = VG / "reports"
EVALS = VG / "evals"
FEEDBACK = VG / "feedback.jsonl"

MODEL = os.environ.get("VOICE_GUARDIAN_MODEL", "opus")
BACKEND = os.environ.get("VOICE_GUARDIAN_BACKEND", "claude")
CHUNK_WORDS = 2500

# ---------------------------------------------------------------- knowledge

def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def append_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("a") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


REFS = load_jsonl(VG / "reference-passages.jsonl")
RUBRIC = json.loads((VG / "editorial-rubric.json").read_text())
PROTECTED = json.loads((VG / "protected-choices.json").read_text())["choices"]
PROFILE = (VG / "voice-profile.md").read_text()
DIM_IDS = [d["id"] for d in RUBRIC["dimensions"]]
FAMILY = {g: fam for fam, gs in RUBRIC["genre_families"].items() for g in gs}
GENRES = list(FAMILY)

# unslop feature key -> reference traits that demonstrate it
FEATURE_TRAITS = {
    "em_dash_rate": {"em-dash-interruption"},
    "italic_rate": {"italic-emphasis"},
    "fragment_rate": {"fragment-cadence"},
    "one_line_para_rate": {"kicker", "punch-then-earn"},
    "profanity_rate": {"profanity"},
    "first_person_rate": {"confessional"},
    "paren_rate": {"parenthetical-aside"},
    "sentence_len_stdev": {"punch-then-earn", "fragment-cadence"},
}


def infer_genre(path: str, text: str) -> str:
    p = path.lower()
    if "blog" in p:
        return "blog"
    if "memoir" in p or "spco" in p:
        return "memoir-essay"
    if "singularity-log" in p:
        return "polemic-essay"
    if p.startswith("essays") or "/essays/" in p:
        return "personal-essay"
    # Fiction: guess person from narration outside dialogue.
    narration = re.sub(r"[\"“][^\"”]*[\"”]", " ", strip_frontmatter(text))
    count = lambda rx: len(re.findall(rx, narration))
    first, second = count(r"\bI\b|\bmy\b"), count(r"\byou\b|\byour\b")
    third = count(r"\b(he|she|they|his|her|their)\b")
    best = max((first, "fiction-first-person"), (second * 1.5, "fiction-second-person"), (third * 0.5, "fiction-third-person"))
    return best[1]


def retrieve_refs(genre: str, hint_traits: set[str] = frozenset(), k: int = 6) -> list[dict]:
    fam = FAMILY.get(genre)

    def score(r):
        s = 3 if r["genre"] == genre else 2 if FAMILY.get(r["genre"]) == fam else 0
        return s + len(hint_traits & set(r["traits"]))
    ranked = sorted(enumerate(REFS), key=lambda ir: (-score(ir[1]), ir[0]))
    picked = [r for _, r in ranked[:k]]
    # One out-of-family anchor keeps the model from over-fitting to one register.
    other = next((r for _, r in ranked[k:] if FAMILY.get(r["genre"]) != fam), None)
    return picked + ([other] if other else [])


def rulings(genre: str, limit: int = 25) -> list[dict]:
    rows = load_jsonl(FEEDBACK)
    fam = FAMILY.get(genre)
    same = [r for r in rows if FAMILY.get(r.get("genre")) == fam]
    other = [r for r in rows if FAMILY.get(r.get("genre")) != fam]
    return (same + other)[-limit:]


# ------------------------------------------------------------------ prompts

SYSTEM = """You are Voice Guardian, an advisory editorial evaluator for one specific writer.

You don't decide whether prose is "good." You decide whether it keeps the things that make this writer sound like herself, and, for revisions, whether the revision damaged anything that was already working.

Rules:
- Ground judgments in the reference passages. Cite them by id in reference_ids when they support a finding.
- Choices listed under PROTECTED CHOICES are never problems in themselves. A revision that removes one is a finding.
- AUTHOR RULINGS are the author's past decisions on your findings. A 'reject' means that kind of flag was wrong in that context. Don't repeat it.
- False positives cost more than misses. An editor that argues with the author's style gets fired. Report only findings you would defend to the author. Zero findings is a fine answer.
- "original-better" is a legitimate verdict. Grammatically cleaner can still be worse.
- Quote excerpts exactly as they appear in the text you were given (short, under 30 words).
- suggested_action is advice ("restore the aside", "keep the fragment"). Never rewrite whole passages.
- Change in voice isn't automatically bad. If a shift might be intentional, say so.
- Don't soften or 'balance' political, queer, trans, kink, or furry content, and don't flag it. It's the point of the work.
- Write explanations plainly and briefly. No hedging."""


def knowledge_block(genre: str, refs: list[dict], include_meaning: bool) -> str:
    dims = [d for d in RUBRIC["dimensions"] if include_meaning or not d.get("revision_only")]
    fam = FAMILY.get(genre, "essay")
    prot = [c for c in PROTECTED if c["genres"] in ("all", fam)]
    parts = [
        "# VOICE PROFILE\n\n" + PROFILE,
        "# RUBRIC\n\n" + "\n".join(
            f"- {d['id']} ({d['name']}): {d['question']} Damage looks like: {'; '.join(d['damage_signals'])}. "
            f"Not damage: {'; '.join(d['not_damage'])}." for d in dims),
        f"Genre: {genre}. {RUBRIC['genre_notes'].get(genre, '')}",
        "Severity: " + " | ".join(f"{k}: {v}" for k, v in RUBRIC["severity"].items()),
        "# PROTECTED CHOICES\n\n" + "\n".join(f"- [{c['id']}] {c['choice']}" for c in prot),
    ]
    rl = rulings(genre)
    if rl:
        parts.append("# AUTHOR RULINGS (most recent last)\n\n" + "\n".join(
            f"- {r['author_decision'].upper()}: \"{r.get('finding', '')}\" on “{r.get('excerpt', '')}” "
            f"({r.get('dimension')}, {r.get('genre')}). Reason: {r.get('reason') or 'none given'}"
            + (f" Note: {r['note']}" if r.get("note") else "") for r in rl))
    parts.append("# REFERENCE PASSAGES (published work)\n\n" + "\n\n".join(
        f"[{r['id']}] ({r['genre']}; traits: {', '.join(r['traits'])})\n{r['passage']}\nEditorial note: {r['editorial_note']}"
        for r in refs))
    return "\n\n---\n\n".join(parts)


def _finding_schema(revision: bool) -> dict:
    props = {
        "location": {"type": "string", "description": "Hunk id (H1...) or paragraph number"},
        "dimension": {"type": "string", "enum": DIM_IDS},
        "severity": {"type": "string", "enum": ["high", "medium", "low"]},
        "excerpt": {"type": "string", "description": "Exact quote from the document/revision"},
        "explanation": {"type": "string"},
        "suggested_action": {"type": "string"},
        "reference_ids": {"type": "array", "items": {"type": "string"}},
    }
    if revision:
        props["original_excerpt"] = {"type": "string", "description": "Exact quote from the original, or empty"}
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


def _dims_schema(ratings: list[str], ids: list[str]) -> dict:
    return {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["dimension", "rating", "note"],
        "properties": {"dimension": {"type": "string", "enum": ids},
                       "rating": {"type": "string", "enum": ratings},
                       "note": {"type": "string"}}}}


COMPARE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["verdict", "assessment", "dimensions", "findings", "protected_preserved", "protected_lost"],
    "properties": {
        "verdict": {"type": "string", "enum": list(RUBRIC["verdicts"])},
        "assessment": {"type": "string"},
        "dimensions": _dims_schema(RUBRIC["ratings"]["comparison"], DIM_IDS),
        "findings": {"type": "array", "items": _finding_schema(True)},
        "protected_preserved": {"type": "array", "items": {"type": "string"}},
        "protected_lost": {"type": "array", "items": {"type": "string"}},
    },
}

REVIEW_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["assessment", "dimensions", "findings", "strengths"],
    "properties": {
        "assessment": {"type": "string"},
        "dimensions": _dims_schema(RUBRIC["ratings"]["single"], [d for d in DIM_IDS if d != "meaning_preservation"]),
        "findings": {"type": "array", "items": _finding_schema(False)},
        "strengths": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["excerpt", "why", "reference_ids"],
            "properties": {"excerpt": {"type": "string"}, "why": {"type": "string"},
                           "reference_ids": {"type": "array", "items": {"type": "string"}}}}},
    },
}

DRIFT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["summary", "observations"],
    "properties": {
        "summary": {"type": "string"},
        "observations": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["span", "observation", "evidence", "possible_intent", "question_for_author"],
            "properties": {"span": {"type": "string"}, "observation": {"type": "string"},
                           "evidence": {"type": "array", "items": {"type": "string"}},
                           "possible_intent": {"type": "string"},
                           "question_for_author": {"type": "string"}}}},
    },
}

FIXTURE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["tighten", "generic", "sanded"],
    "properties": {k: {"type": "string"} for k in ("tighten", "generic", "sanded")},
}


# ------------------------------------------------------------------ backend

def call_model(system: str, prompt: str, schema: dict, model: str | None = None, backend: str | None = None) -> tuple[dict, float]:
    model, backend = model or MODEL, backend or BACKEND
    env = {**os.environ, "VOICE_GUARDIAN_ACTIVE": "1"}  # keeps the Stop hook from recursing
    if backend == "claude":
        cmd = ["claude", "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config",
               "--setting-sources", "", "--no-session-persistence", "--model", model,
               "--json-schema", json.dumps(schema), "--system-prompt", system]
        r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, env=env, timeout=900)
        if r.returncode:
            raise RuntimeError(f"claude exited {r.returncode}: {r.stderr.strip() or r.stdout[:500]}")
        out = json.loads(r.stdout)
        if out.get("is_error"):
            raise RuntimeError(f"claude error: {out.get('result')}")
        data = out.get("structured_output") or _parse_json(out.get("result", ""))
        return data, float(out.get("total_cost_usd") or 0)
    if backend == "codex":
        with tempfile.TemporaryDirectory() as td:
            sp, op = Path(td, "schema.json"), Path(td, "out.json")
            sp.write_text(json.dumps(schema))
            cmd = ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
                   "--output-schema", str(sp), "-o", str(op), "-C", td]
            if model and model not in ("opus", "sonnet", "haiku"):
                cmd += ["-m", model]
            r = subprocess.run(cmd + ["-"], input=system + "\n\n" + prompt, capture_output=True,
                               text=True, env=env, timeout=900)
            if r.returncode or not op.exists():
                raise RuntimeError(f"codex exited {r.returncode}: {r.stderr.strip()[-800:]}")
            return _parse_json(op.read_text()), 0.0
    raise ValueError(f"unknown backend {backend!r}")


def _parse_json(s: str) -> dict:
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        raise RuntimeError(f"no JSON in model output: {s[:300]}")
    return json.loads(m.group(0))


# ------------------------------------------------------------------- hunks

def raw_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", strip_frontmatter(text)) if p.strip()]


def hunks(old: str, new: str, context: int = 1, merge_gap: int = 2) -> list[dict]:
    """Changed paragraph spans with a little revised-side context."""
    a, b = raw_paragraphs(old), raw_paragraphs(new)
    ops = [op for op in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if op[0] != "equal"]
    spans: list[list[int]] = []
    for _, i1, i2, j1, j2 in ops:
        if spans and j1 - spans[-1][3] <= merge_gap and i1 - spans[-1][1] <= merge_gap:
            spans[-1][1], spans[-1][3] = i2, j2
        else:
            spans.append([i1, i2, j1, j2])
    out = []
    for n, (i1, i2, j1, j2) in enumerate(spans, 1):
        c1, c2 = max(0, j1 - context), min(len(b), j2 + context)
        out.append({"id": f"H{n}", "original": "\n\n".join(a[max(0, i1 - context):min(len(a), i2 + context)]),
                    "revised": "\n\n".join(b[c1:c2]),
                    "para_range": f"{j1 + 1}-{j2}" if j2 > j1 else f"deleted before {j1 + 1}"})
    return out


def batch_by_words(items: list, size, limit: int = CHUNK_WORDS) -> list[list]:
    batches, cur, n = [], [], 0
    for it in items:
        w = size(it)
        if cur and n + w > limit:
            batches.append(cur)
            cur, n = [], 0
        cur.append(it)
        n += w
    return batches + ([cur] if cur else [])


# --------------------------------------------------------------- evaluation

def evaluate_revision(label: str, old: str, new: str, genre: str, model: str = MODEL) -> dict:
    hs = hunks(old, new)
    if not hs:
        return {"file": label, "genre": genre, "kind": "compare", "verdict": "equivalent",
                "assessment": "No prose changes.", "dimensions": [], "findings": [], "unslop": {},
                "protected_preserved": [], "protected_lost": [], "cost_usd": 0}
    us = unslop_diff(old, new)
    hint = set().union(*(FEATURE_TRAITS.get(l["key"], set()) for l in us["lost"])) if us["lost"] else set()
    refs = retrieve_refs(genre, hint)
    kb = knowledge_block(genre, refs, include_meaning=True)
    flags = "\n".join([f"- introduced {h['rule']}: “{h['match']}” in: {h['sentence']}" for h in us["introduced"]]
                      + [f"- lost {l['feature']}: {l['before']} → {l['after']}" for l in us["lost"]]) or "- none"
    results, cost = [], 0.0
    batches = batch_by_words(hs, lambda h: word_count(h["original"]) + word_count(h["revised"]))
    for batch in batches:
        body = "\n\n".join(f"## {h['id']} (revised paragraphs {h['para_range']})\n\n### ORIGINAL\n\n"
                           f"{h['original'] or '(nothing — added text)'}\n\n### REVISED\n\n{h['revised'] or '(deleted)'}"
                           for h in batch)
        prompt = (f"{kb}\n\n---\n\n# DETERMINISTIC FLAGS (unslop, whole file)\n\n{flags}\n\n"
                  "These are counts, not verdicts. Confirm or dismiss them on the evidence.\n\n---\n\n"
                  f"# TASK\n\nFile: {label}\n\nCompare each ORIGINAL/REVISED hunk. Did the revision preserve the "
                  "author's voice and meaning, improve it, or damage it? Rate every dimension across all hunks. "
                  "Set each finding's location to its hunk id.\n\n" + body)
        data, c = call_model(SYSTEM, prompt, COMPARE_SCHEMA, model)
        results.append(data)
        cost += c
    return {"file": label, "genre": genre, "kind": "compare", "unslop": us, "reference_ids": [r["id"] for r in refs],
            "hunks": hs, "cost_usd": round(cost, 4), **merge_results(results, compare=True)}


def evaluate_document(label: str, text: str, genre: str, model: str = MODEL) -> dict:
    paras = raw_paragraphs(text)
    hits = scan(text)
    refs = retrieve_refs(genre)
    kb = knowledge_block(genre, refs, include_meaning=False)
    flags = "\n".join(f"- line {h.line} {h.rule}: “{h.match}” in: {h.sentence}" for h in hits) or "- none"
    numbered = [(i + 1, p) for i, p in enumerate(paras)]
    results, cost = [], 0.0
    for batch in batch_by_words(numbered, lambda np: word_count(np[1])):
        body = "\n\n".join(f"[¶{n}] {p}" for n, p in batch)
        prompt = (f"{kb}\n\n---\n\n# DETERMINISTIC FLAGS (unslop)\n\n{flags}\n\n"
                  "These are counts, not verdicts. The author uses some of these patterns on purpose.\n\n---\n\n"
                  f"# TASK\n\nFile: {label} (paragraphs {batch[0][0]}–{batch[-1][0]} of {len(paras)})\n\n"
                  "Does this sound like the author? Rate each dimension, list what's working (strengths) and what "
                  "isn't (findings). Set each finding's location to its ¶ number.\n\n" + body)
        data, c = call_model(SYSTEM, prompt, REVIEW_SCHEMA, model)
        results.append(data)
        cost += c
    return {"file": label, "genre": genre, "kind": "review", "unslop": {"hits": [h.__dict__ for h in hits]},
            "reference_ids": [r["id"] for r in refs], "cost_usd": round(cost, 4),
            **merge_results(results, compare=False)}


RATING_ORDER = {"damaged": 0, "weak": 0, "adequate": 1, "preserved": 1, "strong": 2, "improved": 2, "not-applicable": 3}


def merge_results(results: list[dict], compare: bool) -> dict:
    if len(results) == 1:
        merged = dict(results[0])
    else:
        dims: dict[str, dict] = {}
        for r in results:
            for d in r["dimensions"]:
                cur = dims.get(d["dimension"])
                if cur is None or RATING_ORDER[d["rating"]] < RATING_ORDER[cur["rating"]]:
                    dims[d["dimension"]] = d  # worst rating wins
        merged = {"assessment": " ".join(r["assessment"] for r in results),
                  "dimensions": list(dims.values()),
                  "findings": [f for r in results for f in r["findings"]]}
        if compare:
            vs = {r["verdict"] for r in results}
            merged["verdict"] = vs.pop() if len(vs) == 1 else "mixed"
            merged["protected_preserved"] = sorted({p for r in results for p in r["protected_preserved"]})
            merged["protected_lost"] = sorted({p for r in results for p in r["protected_lost"]})
        else:
            merged["strengths"] = [s for r in results for s in r["strengths"]]
    sev = {"high": 0, "medium": 1, "low": 2}
    merged["findings"].sort(key=lambda f: sev[f["severity"]])
    return merged


# ------------------------------------------------------------------ reports

def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:50] or "report"


def write_report(cmd: str, title: str, docs: list[dict], meta: dict) -> Path:
    REPORTS.mkdir(parents=True, exist_ok=True)
    rid = f"{datetime.now():%Y%m%d-%H%M%S}-{cmd}-{slug(title)}"
    n = 0
    for d in docs:
        for f in d["findings"]:
            n += 1
            f["id"] = f"F{n}"
    report = {"id": rid, "command": cmd, "title": title, "created": datetime.now().isoformat(timespec="seconds"),
              "model": MODEL, "backend": BACKEND, **meta, "documents": docs}
    (REPORTS / f"{rid}.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    md = render_report(report)
    (REPORTS / f"{rid}.md").write_text(md)
    print(md)
    print(f"\nReport: {(REPORTS / rid).relative_to(ROOT)}.md (.json)")
    if n:
        print(f"Rule on findings: python3 tools/voice_guardian.py feedback {rid} F1 accept|reject|modify --reason \"...\"")
    return REPORTS / f"{rid}.json"


def render_report(rep: dict) -> str:
    out = ["## Voice Guardian: Editorial Review", ""]
    out.append(f"**Report:** `{rep['id']}`  ")
    out.append(f"**Model:** {rep['backend']}/{rep['model']}  ")
    cost = sum(d.get("cost_usd", 0) for d in rep["documents"])
    if cost:
        out.append(f"**Cost:** ${cost:.2f}  ")
    for d in rep["documents"]:
        out += ["", f"### {d['file']}", "", f"**Genre:** {d['genre']}  "]
        if d["kind"] == "compare":
            out.append(f"**Verdict:** {d['verdict']} — {RUBRIC['verdicts'][d['verdict']]}  ")
        out += ["", d["assessment"], ""]
        if d["dimensions"]:
            out += ["| Dimension | Rating | Note |", "|---|---|---|"]
            out += [f"| {x['dimension']} | {x['rating']} | {x['note']} |" for x in d["dimensions"]]
            out.append("")
        if d["findings"]:
            out += ["| ID | Where | Severity | Dimension | Finding | Suggested action |", "|---|---|---|---|---|---|"]
            for f in d["findings"]:
                was = f" (was: “{f['original_excerpt']}”)" if f.get("original_excerpt") else ""
                refs = f" Refs: {', '.join(f['reference_ids'])}." if f["reference_ids"] else ""
                out.append(f"| {f['id']} | {f['location']} | {f['severity']} | {f['dimension']} | "
                           f"“{f['excerpt']}”{was} — {f['explanation']}{refs} | {f['suggested_action']} |")
            out.append("")
        else:
            out += ["No findings.", ""]
        if d.get("protected_preserved") or d.get("protected_lost"):
            out.append(f"**Protected choices preserved:** {', '.join(d.get('protected_preserved') or ['—'])}  ")
            out.append(f"**Protected choices lost:** {', '.join(d.get('protected_lost') or ['—'])}")
            out.append("")
        if d.get("strengths"):
            out.append("**What's working:**")
            out += [f"- “{s['excerpt']}” — {s['why']}" for s in d["strengths"]]
            out.append("")
    return "\n".join(out).replace("\n\n\n", "\n\n")


def find_report(rid: str) -> Path:
    if rid == "latest":
        files = sorted(REPORTS.glob("*.json"))
        if not files:
            sys.exit("no reports yet")
        return files[-1]
    p = REPORTS / (rid if rid.endswith(".json") else rid + ".json")
    if not p.exists():
        sys.exit(f"no report {rid}")
    return p


# ---------------------------------------------------------------- commands

def cmd_review(args) -> int:
    docs = []
    for path in args.files:
        text = Path(path).read_text(errors="replace")
        genre = args.genre or infer_genre(path, text)
        docs.append(evaluate_document(path, text, genre, args.model))
    write_report("review", Path(args.files[0]).stem, docs, {})
    return 0


def _is_rev(s: str) -> bool:
    return not Path(s).exists() and subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "--verify", "--quiet", f"{s}^{{commit}}"],
        capture_output=True).returncode == 0


def cmd_diff(args) -> int:
    revs = []
    rest = list(args.args)
    while rest and len(revs) < 2 and _is_rev(rest[0]):
        revs.append(rest.pop(0))
    paths = rest
    a = revs[0] if revs else "HEAD"
    b = revs[1] if len(revs) > 1 else None
    names = git("diff", "--name-only", "--diff-filter=M", a, *([b] if b else []), "--", *paths).split("\n")
    files = [n for n in names if n and is_prose(n)]
    if not files:
        print("No changed prose files.")
        return 0
    print(f"Reviewing {len(files)} file(s): {a} → {b or 'working tree'}", file=sys.stderr)
    docs = []
    for f in files:
        old = read_spec(f"{a}:{f}")
        new = read_spec(f"{b}:{f}") if b else (ROOT / f).read_text(errors="replace")
        genre = args.genre or infer_genre(f, new)
        docs.append(evaluate_revision(f, old, new, genre, args.model))
    write_report("diff", f"{a}..{b or 'wt'}", docs, {"rev_a": a, "rev_b": b or "working-tree"})
    return 0


def cmd_compare(args) -> int:
    old, new = read_spec(args.original), read_spec(args.revision)
    genre = args.genre or infer_genre(args.revision.split(":")[-1], new)
    doc = evaluate_revision(f"{args.original} → {args.revision}", old, new, genre, args.model)
    write_report("compare", Path(args.revision.split(":")[-1]).stem, [doc], {})
    return 0


def cmd_feedback(args) -> int:
    rep = json.loads(find_report(args.report).read_text())
    for d in rep["documents"]:
        f = next((x for x in d["findings"] if x["id"] == args.finding), None)
        if f:
            break
    else:
        sys.exit(f"{args.finding} not in {rep['id']}")
    row = {"date": datetime.now().isoformat(timespec="seconds"), "report": rep["id"], "finding_id": f["id"],
           "file": d["file"], "genre": d["genre"], "dimension": f["dimension"], "severity": f["severity"],
           "finding": f["explanation"], "excerpt": f["excerpt"], "original_excerpt": f.get("original_excerpt", ""),
           "guardian_recommendation": f["suggested_action"], "author_decision": args.decision,
           "reason": args.reason or "", "note": args.note or "", "model": rep["model"]}
    append_jsonl(FEEDBACK, [row])
    print(f"Recorded {args.decision} on {f['id']} ({f['dimension']}, {f['severity']}).")
    if args.protect:
        path = VG / "protected-choices.json"
        data = json.loads(path.read_text())
        pid = slug(args.protect)[:40]
        data["choices"].append({"id": pid, "choice": args.protect, "genres": FAMILY.get(d["genre"], "all")})
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        print(f"Added protected choice [{pid}].")
    return 0


def cmd_stats(args) -> int:
    rows = load_jsonl(FEEDBACK)
    if not rows:
        print("No feedback yet. Rule on findings with: voice_guardian.py feedback latest F1 accept|reject|modify")
        return 0

    def line(label, rs):
        n = len(rs)
        acc = sum(r["author_decision"] == "accept" for r in rs)
        mod = sum(r["author_decision"] == "modify" for r in rs)
        rej = sum(r["author_decision"] == "reject" for r in rs)
        return (f"{label:26} n={n:3}  precision={(acc + mod) / n:5.0%}  false-positive={rej / n:5.0%}  "
                f"(accept {acc}, modify {mod}, reject {rej})")
    print(line("all", rows))
    for key in ("dimension", "severity", "genre", "model"):
        print(f"\nby {key}:")
        for v in sorted({r.get(key) or "?" for r in rows}):
            print("  " + line(str(v), [r for r in rows if (r.get(key) or "?") == v]))
    return 0


def cmd_label(args) -> int:
    old, new = read_spec(args.original), read_spec(args.revision)
    cases = EVALS / "cases.jsonl"
    cid = args.id or f"author-{datetime.now():%Y%m%d-%H%M%S}"
    append_jsonl(cases, [{"id": cid, "kind": "author-approved" if args.verdict == "acceptable" else "author-rejected",
                          "genre": args.genre or infer_genre(args.revision.split(":")[-1], new),
                          "original": strip_frontmatter(old).strip(), "revision": strip_frontmatter(new).strip(),
                          "expected": args.verdict, "label_source": "author", "notes": args.note or ""}])
    print(f"Added eval case {cid} ({args.verdict}).")
    return 0


FIXTURE_PROMPT = """Make three altered versions of the passage below for an evaluation suite that tests whether a voice evaluator can tell good revisions from damaging ones. Keep each version about the same length as the original and keep its markdown (italics, paragraph breaks).

1. tighten — a modest line edit a careful editor who knows this author would make. Trim a few slack words, maybe sharpen one verb. Keep every em-dash, fragment, one-line paragraph, italic, profanity, joke, aside, and the exact meaning. The author would sign off on it.

2. generic — what a capable general-purpose AI produces when asked to "polish this and make it more engaging." Fluent and plausible, NOT a parody. It drifts toward generic phrasing, loses some concrete specifics, and smooths the narrator's edges.

3. sanded — a conventional copyeditor's "corrections." Mostly the same words, but fragments joined into full sentences, em-dashes turned into commas or semicolons, one-line paragraphs merged, profanity softened, a hedge or transition added, and an aside or self-correction cut. Each change is defensible by a style manual.

Return only the three passages.

Genre: {genre}

PASSAGE:

{passage}"""


def cmd_fixtures(args) -> int:
    cases_path = EVALS / "cases.jsonl"
    existing = load_jsonl(cases_path)
    have = {c["id"] for c in existing}
    refs = [r for r in REFS if not args.ids or r["id"] in args.ids]
    if not args.ids:  # spread across genres
        refs = sorted(refs, key=lambda r: (REFS.index(r) % 3, REFS.index(r)))[:args.n]
    todo = [r for r in refs if f"{r['id']}--tighten" not in have or args.force]
    print(f"Generating fixtures for {len(todo)} reference passage(s) with {args.model}…", file=sys.stderr)

    def gen(r):
        data, _ = call_model("You produce evaluation fixtures for an editorial tool. Follow instructions exactly.",
                             FIXTURE_PROMPT.format(genre=r["genre"], passage=r["passage"]), FIXTURE_SCHEMA, args.model)
        expected = {"tighten": "acceptable", "generic": "original-better", "sanded": "original-better"}
        return [{"id": f"{r['id']}--{k}", "ref_id": r["id"], "kind": k, "genre": r["genre"], "original": r["passage"],
                 "revision": data[k], "expected": expected[k], "label_source": "synthetic",
                 "notes": "Generated by voice_guardian.py fixtures. Review and relabel if wrong."} for k in expected]
    with ThreadPoolExecutor(args.jobs) as ex:
        new_rows = [row for rows in ex.map(gen, todo) for row in rows]
    ids = {r["id"] for r in new_rows}
    kept = [c for c in existing if c["id"] not in ids]
    cases_path.write_text("".join(json.dumps(c, ensure_ascii=False) + "\n" for c in kept + new_rows))
    print(f"{len(new_rows)} case(s) written to {cases_path.relative_to(ROOT)}")
    return 0


def cmd_eval(args) -> int:
    cases = load_jsonl(Path(args.cases))
    if args.kind:
        cases = [c for c in cases if c["kind"] in args.kind]
    if args.limit:
        cases = cases[:args.limit]
    if not cases:
        sys.exit("no eval cases (run: voice_guardian.py fixtures)")
    print(f"Evaluating {len(cases)} case(s) with {BACKEND}/{args.model}…", file=sys.stderr)

    def run(c):
        t = time.time()
        try:
            d = evaluate_revision(c["id"], c["original"], c["revision"], c["genre"], args.model)
        except Exception as e:  # keep the suite running; record the failure
            return {"id": c["id"], "kind": c["kind"], "expected": c["expected"], "error": str(e)}
        predicted = "acceptable" if d["verdict"] in ("revision-better", "equivalent") else "original-better"
        serious = [f for f in d["findings"] if f["severity"] in ("high", "medium")]
        return {"id": c["id"], "kind": c["kind"], "label_source": c.get("label_source"), "expected": c["expected"],
                "verdict": d["verdict"], "predicted": predicted, "correct": predicted == c["expected"],
                "findings": len(d["findings"]), "serious_findings": len(serious), "cost_usd": d["cost_usd"],
                "seconds": round(time.time() - t, 1), "assessment": d["assessment"],
                "finding_summaries": [f"[{f['severity']}/{f['dimension']}] {f['explanation']}" for f in d["findings"]]}
    with ThreadPoolExecutor(args.jobs) as ex:
        results = list(ex.map(run, cases))

    ok = [r for r in results if "error" not in r]
    summary = {"model": args.model, "backend": BACKEND, "cases": len(cases), "errors": len(results) - len(ok)}
    if ok:
        acc_exp = [r for r in ok if r["expected"] == "acceptable"]
        dmg_exp = [r for r in ok if r["expected"] == "original-better"]
        summary.update({
            "accuracy": round(sum(r["correct"] for r in ok) / len(ok), 3),
            # Of revisions that were fine, how often did Guardian cry wolf?
            "false_alarm_rate": round(sum(not r["correct"] for r in acc_exp) / len(acc_exp), 3) if acc_exp else None,
            "serious_findings_on_good_revisions": round(statistics.mean(r["serious_findings"] for r in acc_exp), 2) if acc_exp else None,
            # Of revisions that damaged the voice, how often did Guardian catch it?
            "damage_recall": round(sum(r["correct"] for r in dmg_exp) / len(dmg_exp), 3) if dmg_exp else None,
            "by_kind": {k: f"{sum(r['correct'] for r in ok if r['kind'] == k)}/{sum(r['kind'] == k for r in ok)}"
                        for k in sorted({r['kind'] for r in ok})},
            "cost_usd": round(sum(r["cost_usd"] for r in ok), 2),
        })
    out = EVALS / "results" / f"{datetime.now():%Y%m%d-%H%M%S}-{slug(args.model)}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "results": results}, indent=2, ensure_ascii=False))

    print(f"\n{'case':44} {'expected':16} {'verdict':16} ok  serious")
    for r in results:
        if "error" in r:
            print(f"{r['id']:44} ERROR {r['error'][:80]}")
        else:
            print(f"{r['id']:44} {r['expected']:16} {r['verdict']:16} {'✓' if r['correct'] else '✗'}   {r['serious_findings']}")
    print("\n" + json.dumps(summary, indent=2))
    print(f"\nSaved {out.relative_to(ROOT)}")
    return 0


DRIFT_KEYS = ["avg_sentence_len", "sentence_len_stdev", "em_dash_rate", "italic_rate", "fragment_rate",
              "one_line_para_rate", "first_person_rate", "question_rate", "paren_rate", "dialogue_share"]


def cmd_drift(args) -> int:
    files: list[Path] = []
    for p in map(Path, args.paths):
        files += sorted(x for x in p.rglob("*.md") if is_prose(str(x))) if p.is_dir() else [p]
    files = [f for f in files if word_count(strip_frontmatter(f.read_text(errors="replace"))) >= 300]
    if len(files) < 3:
        sys.exit("drift needs at least 3 chapters of 300+ words")
    feats = [features(f.read_text(errors="replace")) for f in files]
    stats = {k: (statistics.mean(x[k] for x in feats), statistics.pstdev(x[k] for x in feats) or 1e-9) for k in DRIFT_KEYS}
    rows = []
    print(f"{'chapter':44} " + " ".join(f"{k[:10]:>10}" for k in DRIFT_KEYS))
    for f, x in zip(files, feats):
        z = {k: (x[k] - stats[k][0]) / stats[k][1] for k in DRIFT_KEYS}
        # Small manuscripts put everything near 1.5σ, so a flag also needs a real
        # relative shift and, for per-1000-word rates, a non-trivial absolute one.
        def real(k):
            delta, mean = abs(x[k] - stats[k][0]), stats[k][0]
            return (abs(z[k]) >= args.threshold and delta >= 0.35 * max(mean, 1e-9)
                    and (not k.endswith("_rate") or delta >= 1.0))
        flags = [f"{k} {'↑' if z[k] > 0 else '↓'}" for k in DRIFT_KEYS if real(k)]
        rows.append({"file": str(f), "features": x, "z": {k: round(v, 2) for k, v in z.items()}, "flags": flags})
        print(f"{f.stem[:44]:44} " + " ".join(f"{x[k]:>10}" for k in DRIFT_KEYS) + ("  ← " + ", ".join(flags) if flags else ""))
    print(f"\nmean: " + ", ".join(f"{k}={stats[k][0]:.2f}" for k in DRIFT_KEYS))
    print(f"Flags mark chapters ≥{args.threshold}σ from the manuscript mean. A shift isn't a verdict; it's a question.")
    if not args.narrate:
        return 0

    def sample(f: Path) -> str:
        paras = [p for p in raw_paragraphs(f.read_text(errors="replace")) if word_count(p) >= 40 and not p.startswith("#")]
        picks = [paras[i] for i in sorted({0, len(paras) // 2, len(paras) - 1})] if paras else []
        return "\n\n".join(picks)[:2500]
    table = "\n".join(f"{i + 1}. {Path(r['file']).stem}: " + ", ".join(f"{k}={r['features'][k]}" for k in DRIFT_KEYS)
                      + (f"  FLAGS: {', '.join(r['flags'])}" if r["flags"] else "") for i, r in enumerate(rows))
    samples = "\n\n".join(f"## {i + 1}. {Path(r['file']).stem}\n\n{sample(Path(r['file']))}" for i, r in enumerate(rows))
    genre = args.genre or infer_genre(rows[0]["file"], Path(rows[0]["file"]).read_text(errors="replace"))
    kb = knowledge_block(genre, retrieve_refs(genre, k=4), include_meaning=False)
    prompt = (f"{kb}\n\n---\n\n# TASK: VOICE DRIFT\n\nBelow are per-chapter voice statistics (rates per 1000 words) "
              f"and sample paragraphs (opening, middle, closing) for a manuscript, in reading order. Describe how "
              f"the voice shifts across the manuscript, with evidence quoted from the samples. Don't assume a shift "
              f"is bad; it may track the narrator's emotional state or POV. Each observation should end with a question "
              f"for the author. Skip noise.\n\n# STATISTICS\n\n{table}\n\n# SAMPLES\n\n{samples}")
    data, cost = call_model(SYSTEM, prompt, DRIFT_SCHEMA, args.model)
    REPORTS.mkdir(parents=True, exist_ok=True)
    rid = f"{datetime.now():%Y%m%d-%H%M%S}-drift-{slug(Path(args.paths[0]).name)}"
    md = [f"## Voice Guardian: Voice Drift", "", f"**Report:** `{rid}`  ", f"**Chapters:** {len(rows)}  ", "",
          data["summary"], ""]
    for o in data["observations"]:
        md += [f"### {o['span']}", "", o["observation"], ""] + [f"> {e}" for e in o["evidence"]] + \
              ["", f"*Possible intent:* {o['possible_intent']}", "", f"**Question:** {o['question_for_author']}", ""]
    (REPORTS / f"{rid}.json").write_text(json.dumps({"id": rid, "rows": rows, **data, "cost_usd": cost}, indent=2, ensure_ascii=False))
    (REPORTS / f"{rid}.md").write_text("\n".join(md))
    print("\n" + "\n".join(md))
    print(f"Report: {(REPORTS / rid).relative_to(ROOT)}.md")
    return 0


# --------------------------------------------------------------------- main

def main(argv=None) -> int:
    global MODEL, BACKEND
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", choices=["claude", "codex"], default=BACKEND)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, **kw):
        p = sub.add_parser(name, **kw)
        p.set_defaults(fn=fn)
        p.add_argument("--model", default=MODEL)
        p.add_argument("--genre", choices=GENRES)
        return p

    p = add("review", cmd_review)
    p.add_argument("files", nargs="+")
    p = add("diff", cmd_diff)
    p.add_argument("args", nargs="*", metavar="REV_OR_PATH")
    p = add("compare", cmd_compare)
    p.add_argument("original")
    p.add_argument("revision")
    p = add("feedback", cmd_feedback)
    p.add_argument("report", help="report id or 'latest'")
    p.add_argument("finding", help="finding id, e.g. F2")
    p.add_argument("decision", choices=["accept", "reject", "modify"])
    p.add_argument("--reason")
    p.add_argument("--note", help="for modify: what the right fix is")
    p.add_argument("--protect", metavar="DESCRIPTION", help="also add a protected choice")
    add("stats", cmd_stats)
    p = add("label", cmd_label)
    p.add_argument("original")
    p.add_argument("revision")
    p.add_argument("--verdict", required=True, choices=["acceptable", "original-better"])
    p.add_argument("--id")
    p.add_argument("--note")
    p = add("fixtures", cmd_fixtures)
    p.add_argument("--n", type=int, default=10, help="number of reference passages")
    p.add_argument("--ids", nargs="*")
    p.add_argument("--force", action="store_true")
    p.add_argument("--jobs", type=int, default=4)
    p.set_defaults(model=os.environ.get("VOICE_GUARDIAN_FIXTURE_MODEL", "sonnet"))
    p = add("eval", cmd_eval)
    p.add_argument("--cases", default=str(EVALS / "cases.jsonl"))
    p.add_argument("--kind", nargs="*")
    p.add_argument("--limit", type=int)
    p.add_argument("--jobs", type=int, default=4)
    p = add("drift", cmd_drift)
    p.add_argument("paths", nargs="+")
    p.add_argument("--threshold", type=float, default=1.5)
    p.add_argument("--narrate", action="store_true", help="ask the model for evidence-backed observations")

    args = ap.parse_args(argv)
    BACKEND = args.backend
    MODEL = args.model
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
