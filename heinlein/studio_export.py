"""Bounded Studio adapter for the existing publishing pipeline; no source discovery."""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from importlib.resources import files
from jinja2 import Environment, FileSystemLoader, select_autoescape
from heinlein import comments, frontmatter, pandoc
from heinlein.outputs import docx, epub, pdf


def export(*, manuscript:Path, output_dir:Path, format:str, title:str, author:str) -> Path:
    """A plain review manuscript, without the publisher's edition/colophon pages."""
    output_dir.mkdir(parents=True, exist_ok=True)
    body=comments.strip_comments(frontmatter.strip_title_block(manuscript.read_text(encoding="utf-8")))
    heading="# "+title.replace("\n", " ")+"\n\n"
    byline=("*by "+author.replace("*", "\\*")+"*\n\n") if author else ""
    source=heading+byline+body
    output=output_dir/f"manuscript.{format}"
    templates=Path(str(files("heinlein").joinpath("templates")))
    if format=="docx":
        return docx.build(body_md=source,output=output)
    image_filter=Path(__file__).with_name("studio_images.lua")
    if format=="epub":
        return epub.build(body_md=source,front={"title":title,"author":author},cfg_meta={"rights":" ","language":"en-US"},cover=None,css=templates/"manuscript.css",output=output,lua_filter=image_filter,reader="markdown-raw_html-raw_attribute-raw_tex-implicit_figures")
    env=Environment(loader=FileSystemLoader(str(templates)),autoescape=select_autoescape(("html","xml"),default_for_string=True,default=True))
    if format=="pdf":
        body_html=subprocess.run([pandoc.pandoc_path(), "-f","markdown-raw_html-raw_attribute-raw_tex-implicit_figures","-t","html5","--lua-filter",str(image_filter),"--no-highlight"],input=source,capture_output=True,text=True,check=True).stdout
        # Chrome prints from a separate temporary directory. Inline only the
        # generated, validated resources so the PDF remains independent of cwd.
        import base64
        import re
        def inline(match):
            path=Path(match[1])
            mime="image/png" if path.suffix==".png" else "image/jpeg"
            return 'src="data:'+mime+';base64,'+base64.b64encode(path.read_bytes()).decode("ascii")+'"'
        body_html=re.sub(r'src="(illustrations/[0-9]+\.(?:png|jpg))"',inline,body_html)
    else:
        body_html=pandoc.md_to_html(source)
    rendered=env.get_template("manuscript.html").render(title=title,body=body_html,stylesheet=(templates/"manuscript.css").read_text())
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
