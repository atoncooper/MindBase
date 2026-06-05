"""Markdown document parser using markdown-it-py."""

from __future__ import annotations

from markdown_it import MarkdownIt
from markdown_it.token import Token

from app.services.doc_parser.base import BaseDocParser, ParsedDocument


class MarkdownParser(BaseDocParser):
    name = "markdown"

    def can_parse(self, mime_type: str, filename: str) -> bool:
        return mime_type in ("text/markdown", "text/x-markdown") or filename.endswith(
            (".md", ".markdown")
        )

    def _parse_sync(self, content: bytes, filename: str) -> ParsedDocument:
        text = content.decode("utf-8")
        md = MarkdownIt("commonmark", {"html": False})
        tokens = md.parse(text)
        result = self._walk_tokens(tokens, text)
        result.metadata["title"] = filename
        return result

    def _walk_tokens(self, tokens: list[Token], source_text: str) -> ParsedDocument:
        headings: list[dict] = []
        code_blocks: list[dict] = []
        images: list[dict] = []
        tables: list[dict] = []
        text_parts: list[str] = []
        pos = 0

        i = 0
        while i < len(tokens):
            t = tokens[i]
            if t.type == "heading_open":
                level = int(t.tag[1]) if t.tag.startswith("h") else 1
                i += 1
                heading_text = ""
                while i < len(tokens) and tokens[i].type != "heading_close":
                    if tokens[i].content:
                        heading_text += tokens[i].content
                    i += 1
                headings.append({"level": level, "text": heading_text, "position": pos})
                text_parts.append(heading_text)
                pos += len(heading_text) + 1
            elif t.type == "fence":
                lang = t.info.strip() if t.info else ""
                code = t.content
                code_blocks.append({"language": lang, "code": code, "position": pos})
                text_parts.append(f"[{lang}] {code}" if lang else code)
                pos += len(code) + 1
            elif t.type == "image":
                src = t.attrGet("src") or ""
                alt = t.content or ""
                images.append({"src": src, "alt": alt, "position": pos})
                if alt:
                    text_parts.append(alt)
                    pos += len(alt) + 1
            elif t.type == "table_open":
                table_rows: list[list[str]] = []
                i += 1
                while i < len(tokens) and tokens[i].type != "table_close":
                    if tokens[i].type == "tr_open":
                        row: list[str] = []
                        i += 1
                        while i < len(tokens) and tokens[i].type != "tr_close":
                            if tokens[i].type in ("th_open", "td_open"):
                                cell_text = ""
                                i += 1
                                while i < len(tokens) and tokens[i].type not in (
                                    "th_close",
                                    "td_close",
                                ):
                                    if tokens[i].content:
                                        cell_text += tokens[i].content
                                    i += 1
                                row.append(cell_text)
                            i += 1
                        table_rows.append(row)
                    i += 1
                if table_rows:
                    headers = table_rows[0] if table_rows else []
                    rows = table_rows[1:] if len(table_rows) > 1 else []
                    tables.append({"headers": headers, "rows": rows, "position": pos})
            elif t.type == "inline" and t.content:
                text_parts.append(t.content)
                pos += len(t.content) + 1
            elif t.type in ("paragraph_open", "bullet_list_open", "ordered_list_open"):
                para_text: list[str] = []
                i += 1
                while i < len(tokens) and tokens[i].type not in (
                    "paragraph_close",
                    "bullet_list_close",
                    "ordered_list_close",
                ):
                    if tokens[i].content:
                        para_text.append(tokens[i].content)
                    i += 1
                combined = " ".join(para_text).strip()
                if combined:
                    text_parts.append(combined)
                    pos += len(combined) + 1
            i += 1

        return ParsedDocument(
            text="\n".join(text_parts),
            headings=headings,
            code_blocks=code_blocks,
            images=images,
            tables=tables,
        )
