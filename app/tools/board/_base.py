"""Shared plumbing for the board MCP proxy tools."""

from __future__ import annotations

import html
import json
import logging
import re
from typing import Any

from app.services.board import BoardMCPClient, BoardMCPError, BoardMCPUnavailableError, get_board_mcp_client
from app.tools import ToolDeps

logger = logging.getLogger(__name__)

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _plain_text(text: Any) -> str:
    """Node text → plain text for the LLM outline.

    Order mirrors the frontend matcher (overlays.stripHtmlTags + collapse):
    strip tags FIRST, then decode entities, then collapse whitespace. The
    agent copies outline texts verbatim as anchor/remove targets, so the
    outline must not contain raw rich-text HTML or entity noise.
    """
    stripped = _WS_RE.sub(" ", html.unescape(_TAG_RE.sub(" ", str(text or ""))))
    return stripped.strip()

# Canonical board document shape, kept in sync with the app-board-mcp tool
# descriptions and the frontend editors (simple-mind-map tree).
DOC_SHAPE = (
    'MindMapDoc JSON：{"root":{"data":{"text":"节点文本"},'
    '"children":[{"data":{"text":"子节点"},"children":[]}]},'
    '"layout":"logicalStructure","theme":{"template":"default"}}。'
    "每个节点必须包含 data.text 与 children 数组（叶子可为空数组）。"
)

# ── LLM-facing payload budget ────────────────────────────────────────
# get/create/update echo the full document JSON back to the model, and the
# tool result is embedded verbatim into the next LLM request. A large board
# overflows the gateway request-size limit (HTTP 413 "Payload Too Large")
# and the whole turn dies with no answer. Above the limit the LLM gets a
# structural outline instead; the raw doc stays reachable in
# additional_kwargs for programmatic consumers but is never serialized
# into the LLM request.
_FULL_DOC_CHAR_LIMIT = 8000
_OUTLINE_CHAR_LIMIT = 6000
_NODE_TEXT_LIMIT = 80
_EXCERPT_CHAR_LIMIT = 2000


def _parse_board_doc(content: Any) -> dict[str, Any]:
    """Board content arrives as a JSON string (app-board stores it verbatim)."""
    if isinstance(content, str):
        try:
            doc = json.loads(content)
            return doc if isinstance(doc, dict) else {}
        except (TypeError, ValueError):
            return {}
    return content if isinstance(content, dict) else {}


def _node_flags(data: dict[str, Any]) -> list[str]:
    """Compact markers for enhanced node fields (contents are NOT inlined)."""
    flags: list[str] = []
    if data.get("note"):
        flags.append("备注")
    rich = data.get("richNodeType")
    if rich:
        flags.append(f"{rich}卡片")
    if data.get("generalizationList"):
        flags.append("概要")
    if data.get("hyperlink"):
        flags.append("外链")
    return flags


def _outline_lines(node: dict[str, Any], depth: int, lines: list[str]) -> None:
    """Flatten the mind-map tree into an indented text outline."""
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    text = _plain_text(data.get("text"))
    if text:
        line = "  " * depth + "- " + text[:_NODE_TEXT_LIMIT]
        if len(text) > _NODE_TEXT_LIMIT:
            line += "…"
        flags = _node_flags(data)
        if flags:
            line += f"（{'/'.join(flags)}）"
        lines.append(line)
    for child in node.get("children", []) or []:
        if isinstance(child, dict):
            _outline_lines(child, depth + 1, lines)


def _llm_view(data: dict[str, Any]) -> dict[str, Any]:
    """Project a board payload into the shape the LLM should see.

    Payloads without ``content`` (list/delete results, metadata) pass through
    unchanged. Boards within ``_FULL_DOC_CHAR_LIMIT`` keep the full document
    JSON so the agent can still do full-replacement board_update rewrites.
    Larger boards get a structural outline plus an explicit guard: the agent
    cannot see what it would overwrite, so full-document updates are off the
    table and small additions go through the board-nodes suggestion channel.
    """
    content = data.get("content")
    if content is None:
        return data
    raw = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    if len(raw) <= _FULL_DOC_CHAR_LIMIT:
        return data

    out = dict(data)
    out.pop("content", None)
    doc = _parse_board_doc(content)
    root = doc.get("root") if isinstance(doc, dict) else None
    if isinstance(root, dict):
        lines: list[str] = []
        _outline_lines(root, 0, lines)
        outline = "\n".join(lines)
        if len(outline) > _OUTLINE_CHAR_LIMIT:
            outline = outline[:_OUTLINE_CHAR_LIMIT] + "\n…（更多节点省略）"
        out["content_outline"] = outline
    else:
        # Whiteboard (Excalidraw scene JSON) has no tree to outline; a capped
        # excerpt is still enough for content interpretation.
        out["content_excerpt"] = raw[:_EXCERPT_CHAR_LIMIT] + (
            "…" if len(raw) > _EXCERPT_CHAR_LIMIT else ""
        )
    out["content_full"] = False
    out["content_chars"] = len(raw)
    out["hint"] = (
        "文档过大，未返回完整 content。禁止基于大纲调用 board_update 全量重写"
        "（会覆盖看不到的节点字段，造成数据丢失）；少量新增节点走 board-nodes 建议。"
    )
    return out


class BoardToolBase:
    """Common: registry constructor hook, uid extraction, error envelope."""

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> Any:
        # The MCP client is a module-level singleton configured from settings;
        # no ToolDeps state is needed.
        return cls()

    @staticmethod
    def _uid(kwargs: dict[str, Any]) -> int | None:
        uid = kwargs.get("_uid")
        try:
            return int(uid) if uid is not None else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _client() -> BoardMCPClient:
        return get_board_mcp_client()

    async def _call(self, kwargs: dict[str, Any], tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Run one MCP tool call, mapping failures into LLM-readable text."""
        uid = self._uid(kwargs)
        if uid is None:
            return {"content": "无法识别用户身份，请重新登录后再试"}
        try:
            data = await self._client().call(uid, tool, arguments)
        except BoardMCPUnavailableError as exc:
            return {"content": f"板子服务暂不可用：{exc}"}
        except BoardMCPError as exc:
            return {"content": f"板子操作失败：{exc}"}
        except Exception as exc:  # unexpected — keep the agent loop alive
            logger.exception("[BOARD_TOOL] unexpected failure tool=%s", tool)
            return {"content": f"板子操作出现意外错误：{exc}"}
        # The LLM sees the compact view; the raw payload rides in extras
        # (ToolMessage.additional_kwargs) for programmatic consumers and is
        # never serialized into the LLM request.
        return {
            "content": json.dumps(_llm_view(data), ensure_ascii=False),
            "data": data,
        }
