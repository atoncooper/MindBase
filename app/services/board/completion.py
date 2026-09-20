"""Board completion — suggest related nodes for an anchor (AI 补全).

Single structured LLM call per request (latency-sensitive, no agent loop):
read the board via MCP (service mode), locate the anchor node, ask the model
for child / sibling node suggestions, return them for the editor's ghost
chips. The user confirms with Tab/click; the editor applies them through the
normal optimistic-lock save path.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict, deque
from typing import Any

from pydantic import BaseModel, Field

from app.config import settings
from app.response.board import BoardCompleteRequest, BoardCompleteResponse, NodeSuggestion
from app.services.board.mcp import BoardMCPError, get_board_mcp_client
from app.services.llm.factory import build_platform_llm

logger = logging.getLogger(__name__)


class CompletionRateLimited(BoardMCPError):
    """Too many completion requests from this uid."""


class AnchorNotFound(BoardMCPError):
    """The anchor node could not be located in the board document."""


# Per-uid sliding-window rate limit (in-memory: the backend runs a single
# uvicorn worker; move to Redis counters when workers scale out).
_RATE_LIMIT = 20
_RATE_WINDOW = 60.0
_rate_buckets: dict[int, deque[float]] = defaultdict(deque)

# Bound the prompt: only the anchor neighbourhood goes to the model.
_MAX_SIBLING_NAMES = 12
_MAX_TEXT_CHARS = 60
_MAX_DOC_CHARS = 3000
_SUGGESTION_LIMIT = 8


def _rate_limited(uid: int) -> bool:
    now = time.monotonic()
    bucket = _rate_buckets[uid]
    while bucket and now - bucket[0] > _RATE_WINDOW:
        bucket.popleft()
    if len(bucket) >= _RATE_LIMIT:
        return True
    bucket.append(now)
    return False


def _parse_doc(content: Any) -> dict[str, Any]:
    """Board content arrives as a JSON string (app-board stores it verbatim)."""
    if isinstance(content, str):
        try:
            doc = json.loads(content)
            return doc if isinstance(doc, dict) else {}
        except json.JSONDecodeError:
            return {}
    return content if isinstance(content, dict) else {}


def _find_anchor(node: dict[str, Any], uid: str, text: str) -> dict[str, Any] | None:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    if uid and data.get("uid") == uid:
        return node
    if not uid and text and data.get("text") == text:
        return node
    for child in node.get("children", []) or []:
        if isinstance(child, dict):
            found = _find_anchor(child, uid, text)
            if found is not None:
                return found
    return None


def _find_parent(root: dict[str, Any], target: dict[str, Any]) -> dict[str, Any] | None:
    """Walk the tree to find the parent dict of target (identity match)."""
    stack = [root]
    while stack:
        node = stack.pop()
        for child in node.get("children", []) or []:
            if not isinstance(child, dict):
                continue
            if child is target:
                return node
            stack.append(child)
    return None


def _short(text: Any) -> str:
    s = str(text or "").strip()
    return s[:_MAX_TEXT_CHARS]


def _build_prompt(board_title: str, doc_json: str, anchor_text: str, sibling_names: list[str], direction: str) -> str:
    siblings = "、".join(sibling_names) if sibling_names else "（无）"
    direction_line = {
        "children": "只给出 children 建议，siblings 留空数组。",
        "siblings": "只给出 siblings 建议，children 留空数组。",
    }.get(direction, "children 与 siblings 都要给出。")
    return (
        "你在为一张思维导图做节点补全。下面是导图的文档 JSON 与锚点节点信息。\n"
        "请推荐与锚点语义相关的新节点：children 是挂在锚点下的子节点；"
        "siblings 是与锚点同级的节点（挂在同一个父节点下）。\n"
        "要求：不要重复已有节点；每个建议是一句简洁的节点文本（不超过 30 字）；"
        "只依据导图主题与锚点语义，不要编造导图中不存在的上下文。\n"
        "节点类型（kind）：\n"
        '- 默认 kind="text"，只填 text（简洁标题）。\n"'
        '- 当内容确实是一段完整代码（函数/算法/命令）时用 kind="code"，填 code（完整代码）与 language（语言标识如 python/js），text 填一句话标题；仅当代码是节点核心内容（算法实现/命令示例）才用，普通概念节点不用。\n"'
        '- 当内容是成段的 Markdown 文本（笔记/引用/表格/列表）时用 kind="md"，填 markdown（Markdown 源码），text 填一句话标题。\n"'
        f"{direction_line}\n\n"
        f"导图标题：{board_title}\n"
        f"锚点节点文本：{anchor_text}\n"
        f"锚点的同级节点（已存在，禁止重复）：{siblings}\n"
        f"导图文档 JSON（可能被截断）：\n{doc_json}\n"
    )


class _NodeIdea(BaseModel):
    text: str
    reason: str = ""
    kind: str = "text"          # text | code | md
    code: str = ""
    language: str = ""
    markdown: str = ""


class _SuggestionSchema(BaseModel):
    """Structured output schema for the completion LLM call."""

    children: list[_NodeIdea] = Field(default_factory=list)
    siblings: list[_NodeIdea] = Field(default_factory=list)


def _suggestions(items: list[_NodeIdea] | None) -> list[NodeSuggestion]:
    """Normalize model output: validate kind, downgrade malformed code/md to text."""
    out: list[NodeSuggestion] = []
    for item in items or []:
        text = _short(item.text)
        if not text:
            continue
        kind = item.kind if item.kind in ("text", "code", "md") else "text"
        if kind == "code" and item.code.strip():
            out.append(NodeSuggestion(text=text, reason=_short(item.reason), kind="code",
                                      code=item.code.strip(), language=_short(item.language) or "text"))
        elif kind == "md" and item.markdown.strip():
            out.append(NodeSuggestion(text=text, reason=_short(item.reason), kind="md",
                                      markdown=item.markdown.strip()))
        else:
            out.append(NodeSuggestion(text=text, reason=_short(item.reason)))
    return out


async def complete_board(uid: int, req: BoardCompleteRequest) -> BoardCompleteResponse:
    """Generate child/sibling suggestions for the anchor node."""
    if _rate_limited(uid):
        raise CompletionRateLimited("补全请求过于频繁，请稍后再试")

    client = get_board_mcp_client()
    board = await client.call(uid, "get_board", {"board_uuid": req.board_uuid})
    doc = _parse_doc(board.get("content"))
    root = doc.get("root")
    if not isinstance(root, dict):
        return BoardCompleteResponse()  # empty board: nothing to anchor on

    anchor = _find_anchor(root, req.anchor_uid, req.anchor_text)
    if anchor is None:
        raise AnchorNotFound("未找到锚点节点：请刷新板子后重试")
    anchor_data = anchor.get("data") if isinstance(anchor.get("data"), dict) else {}
    anchor_text = _short(anchor_data.get("text"))

    parent = _find_parent(root, anchor)
    sibling_names = [
        _short((c.get("data") or {}).get("text"))
        for c in ((parent or {}).get("children") or [])
        if isinstance(c, dict) and c is not anchor
    ]
    sibling_names = [s for s in sibling_names if s][:_MAX_SIBLING_NAMES]

    doc_json = json.dumps(doc, ensure_ascii=False)[:_MAX_DOC_CHARS]
    prompt = _build_prompt(_short(board.get("title")), doc_json, anchor_text, sibling_names, req.direction)

    llm = build_platform_llm(
        purpose="board_complete",
        uid=uid,
        temperature=0.7,
        model=settings.board_mcp_completion_model or None,
    )
    # method=function_calling：经 OpenRouter 的模型普遍不支持 strict json_schema
    # response_format（会被忽略并返回散文），tool-calls 是最可移植的结构化路径。
    schema = await llm.with_structured_output(_SuggestionSchema, method="function_calling").ainvoke(prompt)

    response = BoardCompleteResponse(
        anchor_text=anchor_text,
        children=_suggestions(schema.children if req.direction != "siblings" else []),
        siblings=_suggestions(schema.siblings if req.direction != "children" else []),
    )
    logger.info(
        "[BOARD_AI] complete uid=%s board=%s children=%d siblings=%d",
        uid, req.board_uuid, len(response.children), len(response.siblings),
    )
    return response
