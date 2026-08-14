"""Plain text (.txt) document parser — UTF-8 with GBK/GB18030 fallback.

Fixes the gap where ``is_vectorizable("text/plain")`` returned True but no
registered parser could actually parse ``text/plain`` files, so .txt uploads
always failed at vectorization time with ``ValueError: No parser for ...``.
"""

from __future__ import annotations

from app.services.doc_parser.base import BaseDocParser, ParsedDocument


class PlainTextParser(BaseDocParser):
    name = "plain_text"

    def can_parse(self, mime_type: str, filename: str) -> bool:
        return mime_type == "text/plain" or filename.lower().endswith(
            (".txt", ".text")
        )

    def _parse_sync(self, content: bytes, filename: str) -> ParsedDocument:
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            # 中文 .txt 常为 GBK / GB18030 编码；GB18030 是 GBK 的超集，
            # 无法 UTF-8 解码时回退，乱码字节用替换符兜底。
            text = content.decode("gb18030", errors="replace")
        return ParsedDocument(text=text, metadata={"title": filename})
