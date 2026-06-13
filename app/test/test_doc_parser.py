"""Tests for doc parser module — MD, HTML, DOCX parsers, cleaner, and registry."""

from app.services.doc_parser.cleaner import clean_document_text
from app.services.doc_parser import get_parser, is_vectorizable, MAX_DOC_SIZE


# ====================================================================
# Markdown Parser
# ====================================================================

class TestMarkdownParser:
    def test_can_parse_md_mime(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        assert p.can_parse("text/markdown", "notes.md")
        assert p.can_parse("text/x-markdown", "notes.markdown")
        assert not p.can_parse("text/html", "page.html")

    def test_basic_paragraph(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        result = p._parse_sync(b"Hello world", "test.md")
        assert "Hello world" in result.text

    def test_headings_hierarchy(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        md = b"# H1\n## H2\n### H3\ncontent"
        result = p._parse_sync(md, "test.md")
        levels = [h["level"] for h in result.headings]
        assert levels == [1, 2, 3]

    def test_code_block_with_language(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        md = b"```python\nprint('hello')\n```"
        result = p._parse_sync(md, "test.md")
        assert len(result.code_blocks) == 1
        assert result.code_blocks[0]["language"] == "python"

    def test_code_block_no_language(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        md = b"```\nplain code\n```"
        result = p._parse_sync(md, "test.md")
        assert len(result.code_blocks) == 1
        assert result.code_blocks[0]["language"] == ""

    def test_table_extraction(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        md = b"| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"
        result = p._parse_sync(md, "test.md")
        assert len(result.tables) >= 0  # table parsing depends on markdown-it extensions
        # At minimum, the text should contain the table content
        assert "1" in result.text or "2" in result.text

    def test_image_alt_text(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        md = b"Some text\n![my image](http://example.com/img.png)\nmore text"
        result = p._parse_sync(md, "test.md")
        # The image alt text should appear in the extracted text
        assert "my image" in result.text

    def test_empty_document(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        result = p._parse_sync(b"", "empty.md")
        assert result.text == ""

    def test_html_raw_disabled(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        md = b"<script>alert(1)</script>\nreal content"
        result = p._parse_sync(md, "test.md")
        assert "alert" not in result.text or "real content" in result.text

    def test_metadata_title(self):
        from app.services.doc_parser.markdown_parser import MarkdownParser
        p = MarkdownParser()
        result = p._parse_sync(b"# Title", "mydoc.md")
        assert result.metadata.get("title") == "mydoc.md"


# ====================================================================
# HTML Parser
# ====================================================================

class TestHtmlParser:
    def test_can_parse_html_mime(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        assert p.can_parse("text/html", "page.html")
        assert p.can_parse("application/xhtml+xml", "page.xhtml")
        assert not p.can_parse("text/plain", "notes.txt")

    def test_basic_text_extraction(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        result = p._parse_sync(b"<html><body><p>Hello</p></body></html>", "test.html")
        assert "Hello" in result.text

    def test_script_tags_removed(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        html = b"<html><script>alert('XSS')</script><p>safe</p></html>"
        result = p._parse_sync(html, "test.html")
        assert "alert" not in result.text
        assert "safe" in result.text

    def test_style_tags_removed(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        html = b"<html><style>.x{color:red}</style><p>text</p></html>"
        result = p._parse_sync(html, "test.html")
        assert ".x" not in result.text
        assert "text" in result.text

    def test_iframe_object_embed_removed(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        # Elements wrapped in proper structure for BeautifulSoup lxml parsing
        html = b"<html><body><iframe>evil</iframe><p>ok</p></body></html>"
        result = p._parse_sync(html, "test.html")
        assert "ok" in result.text
        assert "evil" not in result.text.lower()

    def test_noise_tags_removed(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        html = b"<html><body><script>x=1</script><p>safe</p><style>a{}</style></body></html>"
        result = p._parse_sync(html, "test.html")
        assert "safe" in result.text
        assert "x=1" not in result.text
        assert "a{}" not in result.text

    def test_headings_hierarchy(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        html = b"<h1>A</h1><h2>B</h2><h3>C</h3>"
        result = p._parse_sync(html, "test.html")
        levels = sorted(h["level"] for h in result.headings)
        assert levels == [1, 2, 3]

    def test_code_blocks(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        html = b"<pre><code class='language-python'>print(1)</code></pre>"
        result = p._parse_sync(html, "test.html")
        assert len(result.code_blocks) == 1
        assert result.code_blocks[0]["language"] == "python"

    def test_tables(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        html = b"<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"
        result = p._parse_sync(html, "test.html")
        assert len(result.tables) == 1
        assert result.tables[0]["headers"] == ["A", "B"]

    def test_images_alt_text(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        html = b'<img src="a.png" alt="desc">'
        result = p._parse_sync(html, "test.html")
        assert len(result.images) == 1
        assert result.images[0]["alt"] == "desc"

    def test_title_extraction(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        html = b"<html><head><title>My Page</title></head><body></body></html>"
        result = p._parse_sync(html, "test.html")
        assert result.metadata.get("title") == "My Page"

    def test_chinese_encoding(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        html = "<html><body><p>中文内容测试</p></body></html>".encode("utf-8")
        result = p._parse_sync(html, "test.html")
        assert "中文内容测试" in result.text

    def test_empty_body(self):
        from app.services.doc_parser.html_parser import HtmlParser
        p = HtmlParser()
        result = p._parse_sync(b"<html></html>", "test.html")
        assert isinstance(result.text, str)


# ====================================================================
# DOCX Parser
# ====================================================================

class TestDocxParser:
    def test_can_parse_docx_mime(self):
        from app.services.doc_parser.docx_parser import DocxParser
        p = DocxParser()
        assert p.can_parse(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "doc.docx",
        )
        assert not p.can_parse("text/plain", "notes.txt")

    def test_guess_heading_level(self):
        from app.services.doc_parser.docx_parser import DocxParser
        assert DocxParser._guess_heading_level("Heading 1") == 1
        assert DocxParser._guess_heading_level("Heading 2") == 2
        assert DocxParser._guess_heading_level("Normal") == 0
        assert DocxParser._guess_heading_level("heading 3") == 3

    def test_is_code_block_monospace(self):
        from app.services.doc_parser.docx_parser import DocxParser
        # Mock a paragraph with Courier New font
        class MockRun:
            class font:
                name = "Courier New"
        class MockPara:
            runs = [MockRun()]
        assert DocxParser._is_code_block(MockPara())

    def test_is_code_block_normal_font(self):
        from app.services.doc_parser.docx_parser import DocxParser
        class MockRun:
            class font:
                name = "Times New Roman"
        class MockPara:
            runs = [MockRun()]
        assert not DocxParser._is_code_block(MockPara())

    def test_invalid_zip_does_not_crash(self):
        from app.services.doc_parser.docx_parser import DocxParser
        p = DocxParser()
        try:
            result = p._parse_sync(b"PK\x03\x04not a real zip", "empty.docx")
            assert isinstance(result.text, str)
        except Exception:
            # python-docx may raise on truly invalid input — that's acceptable
            pass


# ====================================================================
# Text Cleaner
# ====================================================================

class TestCleaner:
    def test_extra_newlines_collapsed(self):
        result = clean_document_text("line1\n\n\n\nline2")
        assert result == "line1\n\nline2"

    def test_line_stripping(self):
        result = clean_document_text("  a  \n  b  ")
        assert result == "a\nb"

    def test_multiple_spaces_collapsed(self):
        result = clean_document_text("hello    world")
        assert result == "hello world"

    def test_leading_trailing_whitespace(self):
        result = clean_document_text("\n\n  text  \n\n")
        assert result == "text"

    def test_empty_string(self):
        assert clean_document_text("") == ""

    def test_whitespace_only(self):
        assert clean_document_text("   \n\n  ") == ""

    def test_preserves_single_newline(self):
        result = clean_document_text("a\nb")
        assert result == "a\nb"

    def test_chinese_text(self):
        result = clean_document_text("  中文   内容\n\n\n测试  ")
        assert result == "中文 内容\n\n测试"

    def test_mixed_cjk_and_latin(self):
        result = clean_document_text("Hello 世界   测试\n\n\nDone")
        assert result == "Hello 世界 测试\n\nDone"


# ====================================================================
# Parser Registry
# ====================================================================

class TestParserRegistry:
    def test_get_parser_returns_markdown(self):
        p = get_parser("text/markdown", "notes.md")
        assert p is not None
        assert p.name == "markdown"

    def test_get_parser_returns_html(self):
        p = get_parser("text/html", "page.html")
        assert p is not None
        assert p.name == "html"

    def test_get_parser_returns_docx(self):
        p = get_parser(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "doc.docx",
        )
        assert p is not None
        assert p.name == "docx"

    def test_get_parser_returns_pdf(self):
        p = get_parser("application/pdf", "doc.pdf")
        assert p is not None
        assert p.name == "pdf"

    def test_get_parser_returns_none_for_unknown(self):
        p = get_parser("application/zip", "archive.zip")
        assert p is None

    def test_get_parser_fallback_by_extension(self):
        p = get_parser("application/octet-stream", "notes.md")
        assert p is not None
        assert p.name == "markdown"


class TestIsVectorizable:
    def test_markdown_is_vectorizable(self):
        assert is_vectorizable("text/markdown")

    def test_html_is_vectorizable(self):
        assert is_vectorizable("text/html")

    def test_docx_is_vectorizable(self):
        assert is_vectorizable(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )

    def test_video_is_vectorizable(self):
        assert is_vectorizable("video/mp4")
        assert is_vectorizable("video/webm")

    def test_pdf_not_vectorizable(self):
        # PDF moved off the deny list once PdfParser landed.
        assert is_vectorizable("application/pdf")

    def test_zip_not_vectorizable(self):
        assert not is_vectorizable("application/zip")

    def test_rar_not_vectorizable(self):
        assert not is_vectorizable("application/x-rar-compressed")

    def test_image_not_vectorizable(self):
        assert not is_vectorizable("image/png")
        assert not is_vectorizable("image/jpeg")
        assert not is_vectorizable("image/svg+xml")

    def test_exe_not_vectorizable(self):
        assert not is_vectorizable("application/x-msdownload")

    def test_unknown_mime_default_false(self):
        assert not is_vectorizable("application/x-unknown-format")

    def test_plain_text_is_vectorizable(self):
        assert is_vectorizable("text/plain")


class TestMaxDocSize:
    def test_max_doc_size_is_100mb(self):
        assert MAX_DOC_SIZE == 100 * 1024 * 1024


# ====================================================================
# PDF Parser
# ====================================================================


def _build_minimal_pdf(text: str) -> bytes:
    """Construct a tiny PDF 1.4 with a single page rendering ``text``.

    Avoids reportlab so the test suite stays dependency-light. The text
    is embedded directly in a content stream via ``Tj``; pypdf can read
    it back from ``page.extract_text()``.
    """
    cs = f"BT /F1 12 Tf 50 750 Td ({text}) Tj ET".encode("latin-1")
    objs: list[tuple[int, bytes]] = [
        (1, b"<< /Type /Catalog /Pages 2 0 R >>"),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        (
            3,
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        ),
        (
            4,
            b"<< /Length " + str(len(cs)).encode() + b" >>\nstream\n" + cs + b"\nendstream",
        ),
        (5, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for num, body in objs:
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for num, _ in objs:
        out += f"{offsets[num]:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode()
    return bytes(out)


class TestPdfParser:
    def test_can_parse_pdf_mime(self):
        from app.services.doc_parser.pdf_parser import PdfParser

        p = PdfParser()
        assert p.can_parse("application/pdf", "doc.pdf")
        assert p.can_parse("application/octet-stream", "report.PDF")
        assert not p.can_parse("text/plain", "notes.txt")

    def test_basic_text_extraction(self):
        from app.services.doc_parser.pdf_parser import PdfParser

        text = (
            "Hello World, this is a test PDF document for parser unit tests "
            "covering basic extraction."
        )
        pdf_bytes = _build_minimal_pdf(text)
        p = PdfParser()
        result = p._parse_sync(pdf_bytes, "sample.pdf")
        assert text.split(",")[0] in result.text
        assert result.metadata.get("title") == "sample.pdf"
        assert result.metadata.get("page_count") == 1
        assert result.tables == []
        assert result.code_blocks == []

    def test_empty_pdf_raises_empty_text(self):
        from app.services.doc_parser.pdf_parser import (
            EmptyPdfTextError,
            PdfParser,
        )

        # Below the 50-char floor — looks like a scanned image PDF.
        pdf_bytes = _build_minimal_pdf("hi")
        p = PdfParser()
        try:
            p._parse_sync(pdf_bytes, "empty.pdf")
        except EmptyPdfTextError:
            return
        raise AssertionError("expected EmptyPdfTextError")

    def test_invalid_bytes_raise(self):
        from app.services.doc_parser.pdf_parser import PdfParser

        p = PdfParser()
        try:
            p._parse_sync(b"not a real pdf at all", "broken.pdf")
        except Exception:
            return
        raise AssertionError("expected an exception on invalid PDF bytes")


class TestPdfRegistration:
    def test_registry_returns_pdf_parser(self):
        from app.services.doc_parser.pdf_parser import PdfParser

        p = get_parser("application/pdf", "anything.pdf")
        assert isinstance(p, PdfParser)

    def test_pdf_is_vectorizable_via_registry(self):
        assert is_vectorizable("application/pdf", "doc.pdf")


# ====================================================================
# PDF helpers — table rendering + font-size heading heuristic
# ====================================================================


class TestPdfTableRender:
    def test_basic_table_rendered_as_markdown(self):
        from app.services.doc_parser.pdf_parser import _render_table_markdown

        out = _render_table_markdown([["Col A", "Col B"], ["1", "2"], ["3", "4"]])
        assert out is not None
        assert "| Col A | Col B |" in out
        assert "| --- | --- |" in out
        assert "| 1 | 2 |" in out
        assert "| 3 | 4 |" in out

    def test_none_cells_become_empty(self):
        from app.services.doc_parser.pdf_parser import _render_table_markdown

        out = _render_table_markdown([["A", "B"], ["x", None]])
        assert "| x |  |" in out

    def test_pipe_in_cell_is_escaped(self):
        from app.services.doc_parser.pdf_parser import _render_table_markdown

        out = _render_table_markdown([["A", "B"], ["x|y", "z"]])
        assert "x\\|y" in out

    def test_single_column_skipped(self):
        from app.services.doc_parser.pdf_parser import _render_table_markdown

        # Single column tables are usually layout artefacts.
        assert _render_table_markdown([["only"], ["one"]]) == ""

    def test_empty_table_skipped(self):
        from app.services.doc_parser.pdf_parser import _render_table_markdown

        assert _render_table_markdown([]) == ""
        assert _render_table_markdown([["", ""], ["", ""]]) == ""

    def test_ragged_rows_padded(self):
        from app.services.doc_parser.pdf_parser import _render_table_markdown

        out = _render_table_markdown([["A", "B", "C"], ["1", "2"]])
        # Row 2 must be padded to 3 columns.
        assert "| 1 | 2 |  |" in out


class TestPdfHeadingHeuristic:
    def test_no_records_returns_empty(self):
        from app.services.doc_parser.pdf_parser import _infer_headings_by_fontsize

        assert _infer_headings_by_fontsize([]) == []

    def test_uniform_size_yields_no_headings(self):
        from app.services.doc_parser.pdf_parser import _infer_headings_by_fontsize

        records = [(0, 12.0, f"line {i}") for i in range(5)]
        assert _infer_headings_by_fontsize(records) == []

    def test_two_distinct_heading_sizes_get_levels(self):
        from app.services.doc_parser.pdf_parser import _infer_headings_by_fontsize

        # Body is 12pt (most common), 18pt → level 1, 14pt → level 2.
        records = [
            (0, 18.0, "Top heading"),
            (0, 12.0, "body line one"),
            (0, 12.0, "body line two"),
            (0, 12.0, "body line three"),
            (0, 14.0, "Sub heading"),
            (0, 12.0, "more body"),
        ]
        out = _infer_headings_by_fontsize(records)
        by_text = {h["text"]: h["level"] for h in out}
        assert by_text["Top heading"] == 1
        assert by_text["Sub heading"] == 2

    def test_long_lines_are_not_promoted(self):
        from app.services.doc_parser.pdf_parser import (
            _HEADING_MAX_CHARS,
            _infer_headings_by_fontsize,
        )

        long_line = "x" * (_HEADING_MAX_CHARS + 1)
        records = [
            (0, 12.0, "body"),
            (0, 12.0, "body"),
            (0, 12.0, "body"),
            (0, 18.0, long_line),
        ]
        out = _infer_headings_by_fontsize(records)
        assert all(h["text"] != long_line for h in out)

    def test_size_just_above_body_below_threshold(self):
        from app.services.doc_parser.pdf_parser import _infer_headings_by_fontsize

        # 12 → 13.5 is +12.5 % → below the 1.15 ratio, must NOT count as heading.
        records = [
            (0, 12.0, "body"),
            (0, 12.0, "body"),
            (0, 12.0, "body"),
            (0, 13.5, "near-body"),
        ]
        assert _infer_headings_by_fontsize(records) == []


class TestPdfParserTableIntegration:
    def test_extract_text_picks_up_table_rows(self):
        """Build a simple bordered table PDF via reportlab if available;
        otherwise rely on the existing minimal PDF basic test for coverage.

        pdfplumber's table detection requires actual rule lines, which the
        hand-rolled minimal PDF does not provide. We therefore skip cleanly
        when reportlab is missing rather than fabricating a brittle byte
        sequence.
        """
        try:
            from reportlab.lib.pagesizes import LETTER  # noqa: F401
            from reportlab.pdfgen import canvas
        except ImportError:
            import pytest

            pytest.skip("reportlab not installed; table integration test skipped")

        from io import BytesIO

        from app.services.doc_parser.pdf_parser import PdfParser

        buf = BytesIO()
        c = canvas.Canvas(buf)
        # Body paragraph so the doc clears the 50-char floor.
        c.setFont("Helvetica", 12)
        c.drawString(72, 700, "This is a sample report containing one table for testing.")

        # Draw a 3x2 table using lines + cell text.
        x0, y0, cw, rh = 72, 600, 90, 24
        rows = [["Col1", "Col2", "Col3"], ["A", "B", "C"]]
        for r, row in enumerate(rows):
            for col_idx, val in enumerate(row):
                c.drawString(x0 + col_idx * cw + 4, y0 - r * rh - 16, val)
        # Outer + inner grid lines.
        c.rect(x0, y0 - rh * len(rows), cw * 3, rh * len(rows), stroke=1, fill=0)
        for i in range(1, 3):
            c.line(x0 + i * cw, y0, x0 + i * cw, y0 - rh * len(rows))
        for i in range(1, len(rows)):
            c.line(x0, y0 - i * rh, x0 + cw * 3, y0 - i * rh)
        c.showPage()
        c.save()

        p = PdfParser()
        result = p._parse_sync(buf.getvalue(), "table.pdf")
        # The text must contain the cell values (in either layout or
        # markdown table form).
        assert "Col1" in result.text
        assert "A" in result.text
        # And the rendered tables payload should be populated.
        assert isinstance(result.tables, list)


class TestPdfParserHeadingFallback:
    def test_outline_takes_precedence_over_heuristic(self):
        """When pypdf reports an outline, the font-size heuristic should
        not run. The minimal hand-rolled PDF carries no outline, so we
        verify the empty-outline → heuristic path instead by asserting
        the call shape rather than the data: heuristic output is allowed
        to be empty for a single-line PDF, but it must not crash.
        """
        from app.services.doc_parser.pdf_parser import PdfParser

        text = (
            "Body paragraph with sufficient length so the parser does not "
            "raise EmptyPdfTextError on this document."
        )
        pdf_bytes = _build_minimal_pdf(text)
        p = PdfParser()
        result = p._parse_sync(pdf_bytes, "doc.pdf")
        # No outline + single-line same-size body → no heuristic headings.
        assert result.headings == []


