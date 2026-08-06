"""Import finite Twine 1 stories as accessible linked gamebooks."""
from __future__ import annotations

import html
import re
from collections import deque
from dataclasses import dataclass
from pathlib import Path


_TIDDLER_RE = re.compile(r'<div\s+tiddler="([^"]+)"[^>]*>([\s\S]*?)</div>')
_LINK_RE = re.compile(r"\[\[([^\]|]*?)(?:\|([^\]]+))?\]\]")
_MACRO_RE = re.compile(r"<<[^>]+>>")
_DEFAULT_EXCLUDED = frozenset({"StoryTitle", "StoryAuthor"})


@dataclass(frozen=True)
class Passage:
    """One authored Twine passage."""

    title: str
    text: str


def _decode(value: str) -> str:
    return (
        html.unescape(value)
        .replace("\\n", "\n")
        .replace("\\s", " ")
        .replace("â€™", "’")
        .strip()
    )


def _anchor(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return f"twine-{slug or 'passage'}"


def _links(text: str) -> list[tuple[str, str]]:
    return [
        (match.group(1).strip(), (match.group(2) or match.group(1)).strip())
        for match in _LINK_RE.finditer(text)
    ]


def load_twine1(
    path: Path,
    *,
    start: str = "Start",
    exclude: tuple[str, ...] = (),
    restart_label: str = "Start over",
    back_label: str = "Back",
) -> tuple[dict[str, str], str]:
    """Return publication metadata and gamebook Markdown from compiled Twine 1.

    A gamebook is safe only when every included passage is reachable and every
    choice points to a reader passage. State-dependent macros cannot be
    represented honestly in static PDF/EPUB, so they are rejected.
    """
    raw = path.read_text(encoding="utf-8")
    passages: list[Passage] = []
    titles: set[str] = set()
    for match in _TIDDLER_RE.finditer(raw):
        title = html.unescape(match.group(1)).strip()
        if title in titles:
            raise ValueError(f"Duplicate Twine passage title: {title}")
        titles.add(title)
        passages.append(Passage(title=title, text=_decode(match.group(2))))

    by_title = {passage.title: passage for passage in passages}
    title = by_title.get("StoryTitle")
    if title is None or not title.text:
        raise ValueError("Twine 1 source is missing StoryTitle.")
    if start not in by_title:
        raise ValueError(f"Twine 1 source is missing start passage: {start}")

    excluded = _DEFAULT_EXCLUDED | set(exclude)
    reader = {key: value for key, value in by_title.items() if key not in excluded}
    if start not in reader:
        raise ValueError("The configured start passage cannot be excluded.")

    for passage in reader.values():
        if _MACRO_RE.search(passage.text):
            raise ValueError(
                f"Unsupported stateful Twine macro in passage {passage.title!r}."
            )
        for _label, target in _links(passage.text):
            if target not in reader:
                raise ValueError(
                    f"Twine choice {passage.title!r} -> {target!r} does not target a reader passage."
                )

    ordered: list[Passage] = []
    seen: set[str] = set()
    # Every reader passage but Start can have many parents (branches converge),
    # so a static "Back" link can't replay the reader's actual path. Instead we
    # record the *first* passage that ever links to a given target — the
    # canonical route by which the branch tree first reaches it — and use that
    # as a reasonable, deterministic "one step back" for a print/EPUB reader
    # who took a wrong turn and doesn't want to lose their place entirely.
    parent: dict[str, str] = {}
    queue = deque([start])
    while queue:
        passage_id = queue.popleft()
        if passage_id in seen:
            continue
        seen.add(passage_id)
        passage = reader[passage_id]
        ordered.append(passage)
        for _label, target in _links(passage.text):
            if target != passage_id and target != start and target not in parent:
                parent[target] = passage_id
            queue.append(target)

    unreachable = sorted(set(reader) - seen)
    if unreachable:
        raise ValueError(
            "Twine reader passages are unreachable from the configured start: "
            + ", ".join(unreachable)
        )

    def visible_text(source: str) -> str:
        return _LINK_RE.sub(lambda match: match.group(1).strip(), source).strip()

    blocks: list[str] = []
    for passage in ordered:
        choices = _links(passage.text)
        block = [f"## Passage {{#{_anchor(passage.title)} .twine-passage}}", visible_text(passage.text)]
        choice_lines = [
            f"[{label}](#{_anchor(target)}){{.twine-choice}}"
            for label, target in choices
        ]
        back_target = parent.get(passage.title)
        if back_target is not None:
            choice_lines.append(f"[{back_label}](#{_anchor(back_target)}){{.twine-back}}")
        choice_lines.append(f"[{restart_label}](#{_anchor(start)}){{.twine-restart}}")
        block.append("::: {.twine-choices}\n" + "\n\n".join(choice_lines) + "\n:::")
        blocks.append("\n\n".join(block))

    author = by_title.get("StoryAuthor")
    front = {"title": title.text, "author": author.text if author else ""}
    return front, "\n\n".join(blocks)
