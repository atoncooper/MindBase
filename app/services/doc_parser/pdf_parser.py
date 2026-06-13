"""PDF document parser using pdfplumber (primary) + pypdf (encryption / outline).

Scope:
  - Plain text extraction via ``pdfplumber.Page.extract_text``.
  - Table extraction via ``pdfplumber.Page.extract_tables``; each table is
    rendered as a Markdown table and appended to the page text so the
    RAG chunker keeps tabular structure rather than seeing reordered
    cell soup.
  - Headings from PDF outline / bookmarks (pypdf — pdfplumber does not
    expose outlines).  When no outline exists we fall back to a font-size
    heuristic: lines with size noticeably larger than the body median are
    promoted to headings, and distinct sizes map to descending levels.

Behaviour on edge inputs:
  - Encrypted PDF without an empty-string password → ``PdfEncryptedError``.
  - Extracted text shorter than ``_MIN_TEXT_CHARS`` (likely scanned image
    PDF) → ``EmptyPdfTextError``. The pipeline maps this to
    ``vector_status='not_supported'``.
  - Any other backend error bubbles up as a generic ``Exception`` and the
    pipeline marks the file ``vector_status='failed'``.
"""

from __future__ import annotations

import logging
from collections import Counter
from io import BytesIO
from typing import Any

import pdfplumber
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.services.doc_parser.base import BaseDocParser, ParsedDocument

logger = logging.getLogger(__name__)


_MIN_TEXT_CHARS = 50

# Promote a line to a heading when its average font size exceeds the
# document's body size by this factor. 1.15 catches typical 14pt headings
# in 12pt body without flagging bold-but-same-size emphasis.
_HEADING_SIZE_RATIO = 1.15

# A heuristic heading line should not be longer than this — paragraphs
# accidentally sized larger should not be sucked in.
_HEADING_MAX_CHARS = 120


class PdfEncryptedError(Exception):
    """Raised when the PDF is encrypted and cannot be opened with an empty password."""


class EmptyPdfTextError(Exception):
    """Raised when the PDF parses but yields no usable text (likely scanned)."""


class PdfParser(BaseDocParser):
    name = "pdf"

    def can_parse(self, mime_type: str, filename: str) -> bool:
        return mime_type == "application/pdf" or filename.lower().endswith(".pdf")

    def _parse_sync(self, content: bytes, filename: str) -> ParsedDocument:
        # Encryption pre-check via pypdf — keeps existing error semantics
        # and short-circuits before pdfplumber/pdfminer raises a less
        # specific exception.
        try:
            reader = PdfReader(BytesIO(content), strict=False)
        except PdfReadError as exc:
            raise PdfReadError(f"PDF parse failed for {filename}: {exc}") from exc

        if reader.is_encrypted:
            try:
                if reader.decrypt("") == 0:
                    raise PdfEncryptedError(
                        f"PDF {filename} is encrypted; password required"
                    )
            except PdfReadError as exc:
                raise PdfEncryptedError(
                    f"PDF {filename} encryption could not be parsed: {exc}"
                ) from exc

        page_text_blocks: list[str] = []
        page_tables: list[list[list[str]]] = []
        # Per-line records `(page_index, avg_size, text)` for the heading
        # heuristic.  Only collected when the document has no outline so
        # the cost is paid lazily.
        line_records: list[tuple[int, float, str]] = []

        try:
            with pdfplumber.open(BytesIO(content)) as pdf:
                for page_idx, page in enumerate(pdf.pages):
                    block_parts: list[str] = []

                    page_text = ""
                    try:
                        page_text = page.extract_text() or ""
                    except Exception:
                        logger.debug(
                            "[PDF] extract_text failed on page %s of %s",
                            page_idx,
                            filename,
                            exc_info=True,
                        )
                    page_text = page_text.strip()
                    if page_text:
                        block_parts.append(page_text)

                    try:
                        tables = page.extract_tables() or []
                    except Exception:
                        tables = []
                    for table in tables:
                        rendered = _render_table_markdown(table)
                        if rendered:
                            block_parts.append(rendered)
                            page_tables.append(table)

                    if block_parts:
                        page_text_blocks.append("\n\n".join(block_parts))

                    # Collect line records for heading inference only if we
                    # might need them (cheap to skip when an outline exists).
                    try:
                        line_records.extend(_collect_line_records(page, page_idx))
                    except Exception:
                        logger.debug(
                            "[PDF] line scan failed on page %s of %s",
                            page_idx,
                            filename,
                            exc_info=True,
                        )
        except PdfEncryptedError:
            raise
        except Exception as exc:
            # pdfplumber wraps pdfminer; map any opaque failure to a
            # PdfReadError for callers (and the pipeline) to treat as
            # 'failed' rather than 'not_supported'.
            raise PdfReadError(f"PDF parse failed for {filename}: {exc}") from exc

        full_text = "\n\n".join(page_text_blocks)

        if len(full_text) < _MIN_TEXT_CHARS:
            raise EmptyPdfTextError(
                f"PDF {filename} produced {len(full_text)} chars of text "
                f"(min={_MIN_TEXT_CHARS}); likely a scanned image PDF"
            )

        headings = self._extract_outline_headings(reader)
        if not headings and line_records:
            headings = _infer_headings_by_fontsize(line_records)

        author = ""
        try:
            if reader.metadata is not None and hasattr(reader.metadata, "author"):
                author = reader.metadata.author or ""
        except Exception:
            author = ""

        tables_payload = [
            {"rows": [[("" if cell is None else str(cell)) for cell in row] for row in t]}
            for t in page_tables
        ]

        return ParsedDocument(
            text=full_text,
            headings=headings,
            code_blocks=[],
            tables=tables_payload,
            images=[],
            metadata={
                "title": filename,
                "author": author,
                "page_count": len(reader.pages),
            },
        )

    @staticmethod
    def _extract_outline_headings(reader: PdfReader) -> list[dict]:
        """Flatten the PDF outline into ``[{level, text, position}]`` items.

        Position is left at 0 because pypdf does not give a reliable text
        offset for outline items. Downstream chunking only uses the
        heading text + level; position is informational.
        """
        headings: list[dict] = []

        def _walk(items, level: int) -> None:
            # Cap recursion depth: a crafted PDF with deeply nested
            # outlines could otherwise blow the Python stack.
            if level > 10:
                return
            for item in items:
                if isinstance(item, list):
                    _walk(item, level + 1)
                    continue
                title = getattr(item, "title", None)
                if not title:
                    continue
                headings.append(
                    {"level": max(1, level), "text": str(title).strip(), "position": 0}
                )

        try:
            outline = reader.outline
        except Exception:
            return headings

        if outline:
            _walk(outline, 1)
        return headings


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _render_table_markdown(table: list[list[Any]]) -> str:
    """Render a pdfplumber table (list of rows of cells) as a markdown table.

    Empty / 1×1 / fully-empty tables are skipped — they're either layout
    artefacts or noise from the table detector.
    """
    cleaned_rows: list[list[str]] = []
    for row in table or []:
        if not row:
            continue
        cells = [
            ("" if cell is None else str(cell).strip().replace("\n", " "))
            for cell in row
        ]
        cleaned_rows.append(cells)
    if not cleaned_rows:
        return ""
    width = max(len(r) for r in cleaned_rows)
    if width < 2:
        return ""
    if all(all(cell == "" for cell in row) for row in cleaned_rows):
        return ""

    padded = [row + [""] * (width - len(row)) for row in cleaned_rows]
    header = padded[0]
    body = padded[1:] if len(padded) > 1 else []

    def _fmt(row: list[str]) -> str:
        return "| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |"

    parts = [_fmt(header), "| " + " | ".join("---" for _ in range(width)) + " |"]
    for row in body:
        parts.append(_fmt(row))
    return "\n".join(parts)


def _collect_line_records(
    page: pdfplumber.page.Page, page_idx: int
) -> list[tuple[int, float, str]]:
    """Group a page's chars into visual lines and record (page, size, text).

    Lines are inferred by ``top`` (y-coordinate from the page top, after
    pdfplumber's internal flip).  Two chars are on the same line when
    their ``top`` values differ by less than 2 pt — coarse but robust to
    minor baseline jitter.
    """
    chars = getattr(page, "chars", None) or []
    if not chars:
        return []

    by_line: dict[int, list[dict[str, Any]]] = {}
    for ch in chars:
        top = ch.get("top")
        if top is None:
            continue
        bucket = int(round(float(top) / 2.0))
        by_line.setdefault(bucket, []).append(ch)

    records: list[tuple[int, float, str]] = []
    for _, line_chars in sorted(by_line.items()):
        line_chars.sort(key=lambda c: c.get("x0", 0))
        text = "".join(str(c.get("text", "")) for c in line_chars).strip()
        if not text:
            continue
        sizes = [float(c.get("size", 0) or 0) for c in line_chars]
        sizes = [s for s in sizes if s > 0]
        if not sizes:
            continue
        avg_size = sum(sizes) / len(sizes)
        records.append((page_idx, avg_size, text))
    return records


def _infer_headings_by_fontsize(
    records: list[tuple[int, float, str]],
) -> list[dict]:
    """Promote outsized lines to headings.

    Workflow:
      1. Round each line's average size to the nearest 0.5 pt and pick the
         most common bucket as the body size.
      2. Any line whose size > body_size * _HEADING_SIZE_RATIO is a
         heading candidate (subject to a length cap).
      3. Distinct heading sizes, sorted descending, map to levels 1..N.
    """
    if not records:
        return []

    rounded = [round(size * 2) / 2 for _, size, _ in records]
    body_size = Counter(rounded).most_common(1)[0][0]
    if body_size <= 0:
        return []

    threshold = body_size * _HEADING_SIZE_RATIO
    candidates: list[tuple[int, float, str]] = []
    for page_idx, size, text in records:
        if size < threshold:
            continue
        if len(text) > _HEADING_MAX_CHARS:
            continue
        candidates.append((page_idx, size, text))

    if not candidates:
        return []

    distinct_sizes = sorted({round(size * 2) / 2 for _, size, _ in candidates}, reverse=True)
    size_to_level = {size: idx + 1 for idx, size in enumerate(distinct_sizes)}

    headings: list[dict] = []
    for page_idx, size, text in candidates:
        level = size_to_level.get(round(size * 2) / 2, len(distinct_sizes))
        headings.append(
            {"level": max(1, level), "text": text, "position": page_idx}
        )
    return headings
