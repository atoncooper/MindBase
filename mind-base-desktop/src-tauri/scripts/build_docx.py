"""build_docx.py — render a journal manuscript to .docx via python-docx.

Protocol: JSON on stdin, output path as the only argument.
    {"title": "...", "paperKind": "...", "venue": "...",
     "sections": [{"heading": "...", "body": "..."}],
     "references": [{"title": "...", "authors": "[...]", "year": 2024, ...}]}

Section bodies are Markdown + LaTeX math:
- #/##/### headings -> bold heading paragraphs
- "- item" / "* item" -> List Bullet; "1. item" -> List Number
- **bold** inline -> bold runs
- fenced code blocks -> monospace paragraphs
- $...$ math and inline code stay verbatim as text

Prints one JSON line {"ok": true, "path": "..."} on success.
"""
import json
import re
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt

BOLD_RE = re.compile(r"(\*\*[^*]+\*\*)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
BULLET_RE = re.compile(r"^[-*]\s+(.*)$")
ORDERED_RE = re.compile(r"^\d+\.\s+(.*)$")

MONO_FONT = "Consolas"


def set_cjk_font(run, name="宋体", size=None):
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)


def set_mono_font(run, size=None):
    run.font.name = MONO_FONT
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), MONO_FONT)
    rfonts.set(qn("w:ascii"), MONO_FONT)
    rfonts.set(qn("w:hAnsi"), MONO_FONT)
    if size is not None:
        run.font.size = Pt(size)


def add_runs(paragraph, text, size=10.5):
    """Append inline text, honoring **bold**; math stays verbatim."""
    for part in BOLD_RE.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            run = paragraph.add_run(part[2:-2])
            run.bold = True
        else:
            run = paragraph.add_run(part)
        set_cjk_font(run, size=size)


def add_body_paragraph(doc, text, size=10.5):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.line_spacing = 1.5
    paragraph.paragraph_format.first_line_indent = Pt(21)
    add_runs(paragraph, text, size=size)


def add_heading_paragraph(doc, text, level):
    paragraph = doc.add_paragraph()
    size = {1: 13.5, 2: 12.5, 3: 11.5}.get(level, 11)
    run = paragraph.add_run(text)
    run.bold = True
    set_cjk_font(run, size=size)


def add_list_item(doc, style, text):
    paragraph = doc.add_paragraph(style=style)
    add_runs(paragraph, text)


def add_code_block(doc, lines):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.line_spacing = 1.0
    for index, line in enumerate(lines):
        run = paragraph.add_run(line)
        set_mono_font(run, size=9)
        if index < len(lines) - 1:
            run.add_break()


def is_cjk(ch):
    return (
        "\u4e00" <= ch <= "\u9fff"
        or "\u3000" <= ch <= "\u303f"
        or "\uff00" <= ch <= "\uffef"
    )


def join_paragraph_lines(lines):
    joined = ""
    for line in lines:
        if not joined:
            joined = line
        elif is_cjk(joined[-1]) or is_cjk(line[0]):
            joined += line
        else:
            joined += " " + line
    return joined


def render_section_body(doc, body):
    """Render a Markdown body block into the Word document."""
    lines = body.splitlines()
    index = 0
    in_code = False
    code_lines = []
    paragraph_lines = []

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if in_code:
            if stripped.startswith("```"):
                add_code_block(doc, code_lines)
                code_lines = []
                in_code = False
            else:
                code_lines.append(line)
            index += 1
            continue
        if stripped.startswith("```"):
            if paragraph_lines:
                add_body_paragraph(doc, join_paragraph_lines(paragraph_lines))
                paragraph_lines = []
            in_code = True
            index += 1
            continue

        heading = HEADING_RE.match(stripped)
        bullet = BULLET_RE.match(stripped)
        ordered = ORDERED_RE.match(stripped)
        if not stripped or heading or bullet or ordered:
            if paragraph_lines:
                add_body_paragraph(doc, join_paragraph_lines(paragraph_lines))
                paragraph_lines = []
        if not stripped:
            index += 1
            continue
        if heading:
            add_heading_paragraph(doc, heading.group(2).strip(), min(len(heading.group(1)), 3))
            index += 1
            continue
        if bullet:
            add_list_item(doc, "List Bullet", bullet.group(1).strip())
            index += 1
            continue
        if ordered:
            add_list_item(doc, "List Number", ordered.group(1).strip())
            index += 1
            continue
        paragraph_lines.append(stripped)
        index += 1

    if in_code and code_lines:
        add_code_block(doc, code_lines)
    if paragraph_lines:
        add_body_paragraph(doc, join_paragraph_lines(paragraph_lines))


def main():
    out_path = sys.argv[1]
    # Always decode as UTF-8: the Rust caller writes UTF-8 bytes, and Windows
    # consoles default stdin to GBK, which would corrupt CJK into control
    # characters that lxml rejects.
    raw = sys.stdin.buffer.read().decode("utf-8")
    payload = json.loads(raw)
    doc = Document()

    title = str(payload.get("title") or "未命名论文")
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run(title)
    run.bold = True
    set_cjk_font(run, size=18)

    meta = " · ".join(
        str(item) for item in (payload.get("paperKind"), payload.get("venue")) if item
    )
    if meta:
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = paragraph.add_run(meta)
        set_cjk_font(run, size=10.5)

    sections = payload.get("sections") or []
    for section in sections:
        heading = str(section.get("heading") or "").strip()
        body = str(section.get("body") or "").strip()
        if not heading and not body:
            continue
        if heading:
            paragraph = doc.add_paragraph()
            run = paragraph.add_run(heading)
            run.bold = True
            set_cjk_font(run, size=14)
        if body:
            render_section_body(doc, body)

    references = payload.get("references") or []
    if references:
        paragraph = doc.add_paragraph()
        run = paragraph.add_run("参考文献")
        run.bold = True
        set_cjk_font(run, size=14)
        for index, ref in enumerate(references, start=1):
            authors = ref.get("authors") or "[]"
            try:
                author_list = json.loads(authors) if isinstance(authors, str) else authors
                author_text = ", ".join(str(name) for name in author_list)
            except Exception:
                author_text = str(authors)
            year = ref.get("year")
            venue = ref.get("venue") or ""
            title_text = ref.get("title") or ""
            doi = ref.get("doi") or ""
            line = f"[{index}] {author_text}. {title_text}[J]. {venue}"
            if year:
                line += f", {year}"
            if doi:
                line += f". DOI: {doi}"
            line += "."
            paragraph = doc.add_paragraph()
            run = paragraph.add_run(line)
            set_cjk_font(run, size=9)

    doc.save(out_path)
    print(json.dumps({"ok": True, "path": out_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
