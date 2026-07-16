"""Markdown sanitisation tests — defence-in-depth against XSS in shared notes.

The frontend BlockNote editor already strips raw HTML, but a hand-crafted
direct API call could otherwise inject ``<script>`` or ``javascript:``
URLs into a public shared note. The backend ``sanitize_markdown``
function is the last line of defence.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services.notes.markdown import sanitize_markdown  # noqa: E402


class TestSanitizeMarkdown:
    def test_plain_markdown_preserved(self) -> None:
        text = "# Heading\n\nSome **bold** and *italic* text."
        assert sanitize_markdown(text) == text

    def test_code_fence_preserved(self) -> None:
        text = "```python\nprint('hi')\n```"
        assert sanitize_markdown(text) == text

    def test_link_preserved(self) -> None:
        text = "[example](https://example.com)"
        assert sanitize_markdown(text) == text

    def test_script_tag_stripped(self) -> None:
        text = "hello <script>alert('xss')</script> world"
        out = sanitize_markdown(text)
        assert "<script>" not in out
        assert "alert" not in out
        assert "hello" in out
        assert "world" in out

    def test_iframe_stripped(self) -> None:
        text = '<iframe src="evil"></iframe>clean'
        out = sanitize_markdown(text)
        assert "<iframe" not in out
        assert "clean" in out

    def test_javascript_url_replaced(self) -> None:
        text = "[click](javascript:alert(1))"
        out = sanitize_markdown(text)
        assert "javascript:" not in out
        assert "#" in out

    def test_vbscript_url_replaced(self) -> None:
        text = "[x](vbscript:msgbox(1))"
        out = sanitize_markdown(text)
        assert "vbscript:" not in out

    def test_file_url_replaced(self) -> None:
        text = "[x](file:///etc/passwd)"
        out = sanitize_markdown(text)
        assert "file:" not in out

    def test_raw_html_tag_stripped(self) -> None:
        text = "hi <b onclick='evil()'>bold</b> there"
        out = sanitize_markdown(text)
        assert "<b" not in out
        assert "onclick" not in out
        # Inner text is preserved (raw tag stripped, not the content).
        assert "bold" in out

    def test_empty_input(self) -> None:
        assert sanitize_markdown("") == ""

    def test_none_like_input(self) -> None:
        # Function is typed for str — but should not crash on falsy.
        assert sanitize_markdown("") == ""

    def test_multiple_script_blocks(self) -> None:
        text = (
            "<script>a=1</script>"
            "middle"
            "<script>b=2</script>"
            "end"
        )
        out = sanitize_markdown(text)
        assert out == "middleend"

    def test_style_block_stripped(self) -> None:
        text = "<style>body{color:red}</style>visible"
        out = sanitize_markdown(text)
        assert "<style" not in out
        assert "visible" in out

    def test_markdown_image_with_safe_url_preserved(self) -> None:
        text = "![alt](https://example.com/img.png)"
        assert sanitize_markdown(text) == text

    def test_markdown_image_with_data_url_preserved(self) -> None:
        # data:image/... is allowed by the safe-url scheme regex (legacy);
        # here we only forbid javascript:/vbscript:/file:. data: is left
        # alone but it's only rendered as image in react-markdown.
        text = "![alt](data:image/png;base64,abc)"
        assert sanitize_markdown(text) == text
