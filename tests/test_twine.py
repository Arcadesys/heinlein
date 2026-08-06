from pathlib import Path

import pytest

from heinlein import twine
from heinlein import config as cfg_mod


def _story(*passages: tuple[str, str]) -> str:
    body = "".join(
        f'<div tiddler="{title}" tags="">{text}</div>'
        for title, text in passages
    )
    return f"<html><div id=\"storeArea\">{body}</div></html>"


def test_twine_builds_linked_gamebook_and_restores_legacy_escapes(tmp_path: Path) -> None:
    source = tmp_path / "story.html"
    source.write_text(
        _story(
            ("StoryTitle", "Test.exe"),
            ("StoryAuthor", "Original Name"),
            ("OUTLINE", "do not ship"),
            ("Start", "Tom &amp; Jerry\\n\\sindented\\n\\n[[Go|End]]"),
            ("End", "done"),
        ),
        encoding="utf-8",
    )

    front, body = twine.load_twine1(source, exclude=("OUTLINE",))

    assert front == {"title": "Test.exe", "author": "Original Name"}
    assert "Tom & Jerry" in body
    assert "\n indented" in body
    assert "[Go](#twine-end){.twine-choice}" in body
    assert "[Start over](#twine-start){.twine-restart}" in body
    assert "OUTLINE" not in body


@pytest.mark.parametrize(
    ("passages", "message"),
    [
        (
            (("StoryTitle", "Test"), ("Start", "[[Broken|Missing]]")),
            "does not target a reader passage",
        ),
        (
            (("StoryTitle", "Test"), ("Start", "done"), ("Unused", "nope")),
            "unreachable",
        ),
        (
            (("StoryTitle", "Test"), ("Start", "<<set $x = 1>>")),
            "Unsupported stateful Twine macro",
        ),
    ],
)
def test_twine_rejects_unsafe_static_exports(
    tmp_path: Path,
    passages: tuple[tuple[str, str], ...],
    message: str,
) -> None:
    source = tmp_path / "story.html"
    source.write_text(_story(*passages), encoding="utf-8")

    with pytest.raises(ValueError, match=message):
        twine.load_twine1(source)


def test_twine_config_and_author_override(tmp_path: Path) -> None:
    source = tmp_path / "story.html"
    source.write_text(
        _story(("StoryTitle", "Test"), ("StoryAuthor", "Old Name"), ("Start", "done")),
        encoding="utf-8",
    )
    project = tmp_path / "heinlein.yaml"
    project.write_text(
        """manuscript: story.html
source_format: twine1
twine:
  exclude: [OUTLINE]
metadata:
  author: Austen Tucker
formats: [epub]
""",
        encoding="utf-8",
    )

    cfg = cfg_mod.load(project_yaml=project)

    assert cfg.source_format == "twine1"
    assert cfg.twine_exclude == ("OUTLINE",)
    assert cfg.metadata["author"] == "Austen Tucker"


def test_twine_back_link_targets_first_parent(tmp_path: Path) -> None:
    """Every reader passage but Start gets a Back link to whichever passage
    first reaches it in traversal order — a static stand-in for 'go back one
    choice' since a print/EPUB reader has no session history to replay."""
    source = tmp_path / "story.html"
    source.write_text(
        _story(
            ("StoryTitle", "Test.exe"),
            ("Start", "[[Go|Middle]]"),
            ("Middle", "[[Left|End]] [[Right|End]]"),
            ("End", "done"),
        ),
        encoding="utf-8",
    )

    _front, body = twine.load_twine1(source)

    assert "[Back](#twine-start){.twine-back}" in body
    # End is reachable from Middle via two links; the first one wins.
    assert "[Back](#twine-middle){.twine-back}" in body
    # Start itself never gets a Back link — there is nowhere before it.
    start_block = body.split("{#twine-start")[1].split("{#twine-")[0]
    assert ".twine-back" not in start_block


def test_twine_back_label_override(tmp_path: Path) -> None:
    source = tmp_path / "story.html"
    source.write_text(
        _story(("StoryTitle", "Test"), ("Start", "[[Go|End]]"), ("End", "done")),
        encoding="utf-8",
    )

    _front, body = twine.load_twine1(source, back_label="Previous")

    assert "[Previous](#twine-start){.twine-back}" in body


def test_butterfly_ending_set_is_preserved(tmp_path: Path) -> None:
    """A finite Butterfly-shaped branch keeps exactly its three terminal passages."""
    source = tmp_path / "butterfly.html"
    source.write_text(
        _story(
            ("StoryTitle", "Butterfly.exe"),
            ("StoryAuthor", "Austen Crowder"),
            ("OUTLINE", "production note"),
            ("Start", "[[Good|Good Night]] [[Port|Port In]] [[Angry|Angry Port In]]"),
            ("Good Night", "The end."),
            ("Port In", "The end."),
            ("Angry Port In", "The end."),
        ),
        encoding="utf-8",
    )

    _front, body = twine.load_twine1(source, exclude=("OUTLINE",))

    ending_ids = {"twine-good-night", "twine-port-in", "twine-angry-port-in"}
    rendered_ids = set(__import__("re").findall(r"\{#(twine-[^ ]+) ", body))
    assert rendered_ids == {"twine-start", *ending_ids}
    assert all(ending in body for ending in ending_ids)
