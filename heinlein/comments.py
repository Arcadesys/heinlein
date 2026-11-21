"""Private author comments (CriticMarkup ``{>>note<<}``) never reach a published book.

A text pre-pass run before any writer: each complete comment is removed together
with one space directly before it, so ``new {>>x<<}.`` becomes ``new.``. A comment
never crosses a blank line; an unclosed ``{>>`` is a structural error that stops
the build rather than leaking the note into the output.
"""
from __future__ import annotations

import re

_OPEN = "{>>"
_COMMENT = re.compile(r"\{>>(?:(?!<<\}|\r?\n[ \t]*\r?\n|\r[ \t]*\r)[\s\S])*?<<\}")
UNFINISHED = "A scene has an unfinished comment. Close or remove it before exporting."


def strip_comments(text: str) -> str:
    """Return ``text`` without author comments; raise ``ValueError`` on an unclosed one."""
    out: list[str] = []
    cursor = 0
    start = text.find(_OPEN)
    while start != -1:
        match = _COMMENT.match(text, start)
        if match is None:
            raise ValueError(UNFINISHED)
        keep_to = start - 1 if start > cursor and text[start - 1] == " " else start
        out.append(text[cursor:keep_to])
        cursor = match.end()
        start = text.find(_OPEN, cursor)
    out.append(text[cursor:])
    return "".join(out)
