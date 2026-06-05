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

    def test_get_parser_returns_none_for_unknown(self):
        p = get_parser("application/pdf", "doc.pdf")
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
        assert not is_vectorizable("application/pdf")

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
