from heinlein import frontmatter


def test_parse_basic():
    text = """---
title: Hello
author: Austen
---

# Hello

*by Austen*

Body paragraph.
"""
    front, body = frontmatter.parse(text)
    assert front == {"title": "Hello", "author": "Austen"}
    assert body.startswith("\n# Hello")


def test_parse_no_frontmatter():
    text = "no frontmatter here"
    front, body = frontmatter.parse(text)
    assert front == {}
    assert body == text


def test_strip_title_block():
    body = "\n# Hello\n\n*by Austen*\n\nFirst paragraph.\n"
    out = frontmatter.strip_title_block(body)
    assert "# Hello" not in out
    assert "*by Austen*" not in out
    assert "First paragraph." in out


def test_strip_title_block_preserves_later_h1_sections():
    body = "\n# Hello\n\n*by Austen*\n\nStory.\n\n# Afterword\n\nAfterword.\n"

    out = frontmatter.strip_title_block(body)

    assert "# Hello" not in out
    assert "*by Austen*" not in out
    assert "# Afterword" in out
