#!/usr/bin/env python3
"""Inspect synthetic artifacts from document_export::tests::bundled_documents.

The app does not use Python. This developer-only acceptance check uses stdlib.
"""
import argparse
import posixpath
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile, ZIP_STORED


def verify(directory: Path, css: Path) -> None:
    with ZipFile(directory / "synthetic-export.docx") as archive:
        assert archive.testzip() is None
        document = ET.fromstring(archive.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = ["".join(p.itertext()) for p in document.findall(".//w:p", ns)]
        prose = "\n".join(paragraphs)
        assert prose.index("First chapter") < prose.index("ALPHA-BEGIN") < prose.index("Last chapter") < prose.index("OMEGA-END")
        assert "Exact prose — with italic words, bold words, and a link." in prose
        assert "Synthetic Author" in prose and "Quoted words." in prose
        assert "First list item" in prose and "Second list item" in prose
        runs = document.findall(".//w:r", ns)
        assert any("italic words" in "".join(r.itertext()) and r.find("w:rPr/w:i", ns) is not None for r in runs)
        assert any("bold words" in "".join(r.itertext()) and r.find("w:rPr/w:b", ns) is not None for r in runs)
        assert document.find(".//w:hyperlink", ns) is not None
    with ZipFile(directory / "synthetic-export.epub") as archive:
        assert archive.testzip() is None
        first = archive.infolist()[0]
        assert first.filename == "mimetype" and first.compress_type == ZIP_STORED
        assert archive.read("mimetype") == b"application/epub+zip"
        container = ET.fromstring(archive.read("META-INF/container.xml"))
        opf_path = next(e.attrib["full-path"] for e in container.iter() if e.tag.endswith("rootfile"))
        opf = ET.fromstring(archive.read(opf_path))
        ns = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
        assert opf.find(".//dc:title", ns).text == "Synthetic Export"
        assert opf.find(".//dc:creator", ns).text == "Synthetic Author"
        assert opf.find(".//dc:publisher", ns) is None
        assert opf.find(".//dc:rights", ns) is None
        assert all((element.text or "").strip() for element in opf.findall("opf:metadata/*", ns)
                   if element.tag.startswith("{http://purl.org/dc/elements/1.1/}"))
        manifest = {e.attrib["id"]: e.attrib for e in opf.findall("opf:manifest/opf:item", ns)}
        members = [manifest[e.attrib["idref"]]["href"] for e in opf.findall("opf:spine/opf:itemref", ns)]
        roots = [ET.fromstring(archive.read(posixpath.join(posixpath.dirname(opf_path), member))) for member in members]
        prose = "\n".join("".join(root.itertext()) for root in roots)
        assert prose.index("First chapter") < prose.index("ALPHA-BEGIN") < prose.index("Last chapter") < prose.index("OMEGA-END")
        assert "Exact prose — with italic words, bold words, and a link." in prose
        assert any(e.tag.endswith("}em") and e.text == "italic words" for root in roots for e in root.iter())
        assert any(e.tag.endswith("}strong") and e.text == "bold words" for root in roots for e in root.iter())
        assert any(e.tag.endswith("}a") and e.attrib.get("href") == "https://example.org" for root in roots for e in root.iter())
        styles = [e["href"] for e in manifest.values() if e.get("media-type") == "text/css"]
        assert len(styles) == 1
        assert archive.read(posixpath.join(posixpath.dirname(opf_path), styles[0])) == css.read_bytes()
    assert "ALPHA-BEGIN" in (directory / "original.md").read_text()
    print("DOCX and EPUB: valid containers, reading order, exact prose/em dash, emphasis, link, metadata and manuscript stylesheet verified.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--css", required=True, type=Path)
    args = parser.parse_args()
    verify(args.directory, args.css)
