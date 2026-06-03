"""Document parser registry and scheduling."""

import logging

from app.services.doc_parser.base import DocParser
from app.services.doc_parser.markdown_parser import MarkdownParser
from app.services.doc_parser.html_parser import HtmlParser
from app.services.doc_parser.docx_parser import DocxParser

logger = logging.getLogger(__name__)

_PARSERS: list[DocParser] = [
    MarkdownParser(),
    HtmlParser(),
    DocxParser(),
]

MAX_DOC_SIZE = 100 * 1024 * 1024  # 100 MB

VECTORIZABLE_MIME_PREFIXES: list[str] = [
    "text/markdown",
    "text/x-markdown",
    "text/html",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.wordprocessingml",
    "video/",
]

NOT_VECTORIZABLE_MIME_PREFIXES: list[str] = [
    "application/pdf",
    "application/zip",
    "application/x-rar-compressed",
    "application/x-7z-compressed",
    "image/",                  # includes image/svg+xml (potentially unsafe)
    "application/x-msdownload",
]
# All image types are intentionally NOT vectorizable (no OCR support yet).
# image/svg+xml is additionally dangerous — SVG can contain embedded JavaScript
# and must not be served with inline Content-Type.


def get_parser(mime_type: str, filename: str) -> DocParser | None:
    for parser in _PARSERS:
        if parser.can_parse(mime_type, filename):
            return parser
    return None


def is_vectorizable(mime_type: str, filename: str = "") -> bool:
    for prefix in NOT_VECTORIZABLE_MIME_PREFIXES:
        if mime_type.startswith(prefix):
            return False
    for prefix in VECTORIZABLE_MIME_PREFIXES:
        if mime_type.startswith(prefix):
            return True
    if get_parser(mime_type, filename) is not None:
        return True
    return False
