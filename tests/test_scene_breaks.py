from pathlib import Path

from heinlein import pandoc


def test_spaced_dash_scene_break_is_semantic_hr() -> None:
    assert pandoc.md_to_html("before\n\n- - -\n\nafter\n") == "<p>before</p>\n<hr />\n<p>after</p>\n"


def test_scene_breaks_are_ink_rules_in_every_screen_and_print_template() -> None:
    templates = Path(__file__).resolve().parents[1] / "heinlein" / "templates"
    for name in ("epub.css", "html-preview.html.j2", "print.html.j2"):
        stylesheet = (templates / name).read_text(encoding="utf-8")
        assert "hr::after" in stylesheet
        assert 'content: ""' in stylesheet
        assert "linear-gradient" in stylesheet
        assert "·  ·  ·" not in stylesheet
