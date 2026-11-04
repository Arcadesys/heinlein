"""Bounded Studio adapter for the existing publishing pipeline; no source discovery."""
from __future__ import annotations

import argparse
from pathlib import Path

from importlib.resources import files
from jinja2 import Environment, FileSystemLoader, select_autoescape
from heinlein import frontmatter, pandoc
from heinlein.outputs import docx, epub, pdf


def export(*, manuscript:Path, output_dir:Path, format:str, title:str, author:str) -> Path:
    """A plain review manuscript, without the publisher's edition/colophon pages."""
    output_dir.mkdir(parents=True, exist_ok=True)
    body=frontmatter.strip_title_block(manuscript.read_text(encoding="utf-8"))
    heading="# "+title.replace("\n", " ")+"\n\n"
    byline=("*by "+author.replace("*", "\\*")+"*\n\n") if author else ""
    source=heading+byline+body
    output=output_dir/f"manuscript.{format}"
    templates=Path(str(files("heinlein").joinpath("templates")))
    if format=="docx":
        return docx.build(body_md=source,output=output)
    if format=="epub":
        return epub.build(body_md=source,front={"title":title,"author":author},cfg_meta={"rights":" ","language":"en-US"},cover=None,css=templates/"manuscript.css",output=output)
    env=Environment(loader=FileSystemLoader(str(templates)),autoescape=select_autoescape(("html","xml"),default_for_string=True,default=True))
    rendered=env.get_template("manuscript.html").render(title=title,body=pandoc.md_to_html(source),stylesheet=(templates/"manuscript.css").read_text())
    if format=="html":
        output.write_text(rendered,encoding="utf-8")
    elif format=="pdf":
        pdf._print_to_pdf(rendered,output)
    else:
        raise ValueError("Unsupported manuscript export format")
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--format", required=True, choices=("pdf", "epub", "html", "docx"))
    parser.add_argument("--title", required=True)
    parser.add_argument("--author", default="")
    args = parser.parse_args()
    export(
        manuscript=args.input,
        output_dir=args.output_dir,
        format=args.format,
        title=args.title,
        author=args.author,
    )


if __name__ == "__main__":
    main()
