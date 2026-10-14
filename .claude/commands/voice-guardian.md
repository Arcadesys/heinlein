---
description: Voice Guardian. Check whether a revision damaged the author's voice, or whether a document sounds like her. Advisory, evidence-backed.
argument-hint: diff [REV_A [REV_B]] | review <file> | compare <orig> <rev> | drift <dir> | stats
---

Run `python3 tools/voice_guardian.py $ARGUMENTS` from the repo root. If `$ARGUMENTS` is empty, run `diff`, which compares HEAD to the working tree.

The run makes model calls through the `claude` CLI and can take a minute or two per file. Run it in the background if it's a whole manuscript.

When it finishes:

1. Show the report as it printed. Don't summarize away the findings table, and don't add findings it didn't make.
2. Ask the author to rule on each finding: **accept** (real problem), **reject** (deliberate choice), or **modify** (right problem, wrong fix). Record each ruling:
   `python3 tools/voice_guardian.py feedback latest F<n> accept|reject|modify --reason "..."`
   If a rejection should hold everywhere, add `--protect "<the choice, in one sentence>"`.
3. Don't rewrite anything. Voice Guardian is advisory. The author decides what to fix.

`python3 tools/voice_guardian.py stats` shows how often the author agrees with Voice Guardian. False positives matter more than misses.
