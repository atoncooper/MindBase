"""docx_preview.py — render one .docx to safe HTML for the research file previewer.

Protocol: argv[1] = docx path; exactly one JSON line on stdout:
    {"ok": true, "html": "...", "size": 12345}
    {"ok": false, "error": "..."}

Only escaped text and a fixed tag set (p / h1-h4 / strong / em / u / code /
ul / ol / li / table / tr / td / br) is emitted — never raw document markup or
scripts. Inline/display OMML formulas become <code class="docx-math">$...$</code>
so equations do not disappear from the preview.
"""
import html
import json
import os
import sys


def heading_level(style_name):
    name = (style_name or "").strip().lower()
    if name == "title":
        return 1
    if name == "subtitle":
        return 2
    if name.startswith("heading"):
        digits = "".join(character for character in name if character.isdigit())
        if digits:
            return max(1, min(4, int(digits)))
    return 0


def is_bullet(style_name):
    name = (style_name or "").strip().lower()
    return "bullet" in name


def is_numbered(style_name):
    name = (style_name or "").strip().lower()
    return "number" in name


def run_html(run):
    text = (run.text or "").replace("\r\n", "\n").replace("\r", "\n")
    chunks = []
    for index, line in enumerate(text.split("\n")):
        if index:
            chunks.append("<br>")
        if not line:
            continue
        escaped = html.escape(line, quote=False)
        if run.bold:
            escaped = "<strong>" + escaped + "</strong>"
        if run.italic:
            escaped = "<em>" + escaped + "</em>"
        if run.underline:
            escaped = "<u>" + escaped + "</u>"
        chunks.append(escaped)
    return "".join(chunks)


def _math_html(element, display):
    from docx_math import omml_to_latex

    latex = omml_to_latex(element, display=display)
    if not latex:
        return ""
    return '<code class="docx-math">' + html.escape(latex, quote=False) + "</code>"


def paragraph_inline(paragraph):
    """Run text + OMML formulas in document order (formulas never dropped)."""
    from docx.text.run import Run
    from docx_math import local_name

    parts = []
    for child in paragraph._p.iterchildren():
        name = local_name(child)
        if name == "r":
            try:
                parts.append(run_html(Run(child, paragraph)))
            except Exception:  # noqa: BLE001 — malformed run: skip formatting
                pass
        elif name == "hyperlink":
            for sub in child.iterchildren():
                if local_name(sub) == "r":
                    try:
                        parts.append(run_html(Run(sub, paragraph)))
                    except Exception:  # noqa: BLE001
                        pass
        elif name == "oMath":
            parts.append(_math_html(child, display=False))
        elif name == "oMathPara":
            parts.append(_math_html(child, display=True))
    return "".join(parts)


def cell_html(cell):
    parts = []
    for paragraph in cell.paragraphs:
        inline = paragraph_inline(paragraph).strip()
        if inline:
            parts.append(inline)
    return "<td>" + "<br>".join(parts) + "</td>"


def table_html(table):
    rows = []
    for row in table.rows:
        rows.append("<tr>" + "".join(cell_html(cell) for cell in row.cells) + "</tr>")
    return "<table>" + "".join(rows) + "</table>"


def iter_blocks(document):
    try:
        iterator = document.iter_inner_content()
    except AttributeError:
        for paragraph in document.paragraphs:
            yield paragraph
        for table in document.tables:
            yield table
        return
    for block in iterator:
        yield block


def render(document):
    out = []
    list_tag = None
    for block in iter_blocks(document):
        if block.__class__.__name__ == "Table":
            if list_tag:
                out.append("</" + list_tag + ">")
                list_tag = None
            out.append(table_html(block))
            continue
        paragraph = block
        style = paragraph.style.name if paragraph.style is not None else ""
        inline = paragraph_inline(paragraph)
        level = heading_level(style)
        if level:
            if list_tag:
                out.append("</" + list_tag + ">")
                list_tag = None
            out.append("<h{0}>{1}</h{0}>".format(level, inline))
            continue
        if is_bullet(style):
            if list_tag != "ul":
                if list_tag:
                    out.append("</" + list_tag + ">")
                out.append("<ul>")
                list_tag = "ul"
            out.append("<li>" + inline + "</li>")
            continue
        if is_numbered(style):
            if list_tag != "ol":
                if list_tag:
                    out.append("</" + list_tag + ">")
                out.append("<ol>")
                list_tag = "ol"
            out.append("<li>" + inline + "</li>")
            continue
        if list_tag:
            out.append("</" + list_tag + ">")
            list_tag = None
        if inline.strip():
            out.append("<p>" + inline + "</p>")
    if list_tag:
        out.append("</" + list_tag + ">")
    return "".join(out)


def main():
    if len(sys.argv) < 2:
        raise ValueError("缺少 DOCX 文件路径")
    path = sys.argv[1]
    from docx import Document

    document = Document(path)
    return {"ok": True, "html": render(document), "size": os.path.getsize(path)}


if __name__ == "__main__":
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        exit_payload = main()
    except Exception as error:  # noqa: BLE001 — the protocol reports errors as JSON
        exit_payload = {"ok": False, "error": str(error)}
    print(json.dumps(exit_payload, ensure_ascii=False))
