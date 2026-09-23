"""BoardNavigateTool — tree navigation / recursive search over one board.

Structured perception for the agent without pulling the full document into
context: children / siblings / parent / subtree views around a target node,
plus a recursive keyword search that returns node paths. Views are computed
server-side from the full document (fetched via MCP get_board); raw document
JSON never reaches the LLM.
"""

from __future__ import annotations

import json
from typing import Any

from app.tools import register_tool
from app.tools.board._base import (
    BoardToolBase,
    _node_flags,
    _outline_lines,
    _parse_board_doc,
    _plain_text,
)

_VIEWS = ("children", "siblings", "parent", "subtree", "search")
_DEFAULT_LIMIT = 20
_MAX_LIMIT = 50
_SUBTREE_CHAR_LIMIT = 3000


def _norm(text: Any) -> str:
    return _plain_text(text)


def _item(node: dict[str, Any]) -> dict[str, Any]:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    children = node.get("children") or []
    item: dict[str, Any] = {"text": _norm(data.get("text"))[:120]}
    flags = _node_flags(data)
    if flags:
        item["flags"] = flags
    if isinstance(children, list) and children:
        item["child_count"] = len(children)
    return item


def _path_text(path: list[dict[str, Any]]) -> str:
    return " > ".join(_norm((n.get("data") or {}).get("text"))[:60] for n in path)


def _walk_find(
    node: dict[str, Any],
    path: list[dict[str, Any]],
    wanted: str,
    prefix_base: str,
    exact: list,
    prefix: list,
) -> None:
    text = _norm((node.get("data") or {}).get("text"))
    here = path + [node]
    if text != "":
        if text == wanted:
            exact.append((node, here))
        elif prefix_base and wanted.endswith("…") and text.startswith(prefix_base):
            prefix.append((node, here))
    for child in node.get("children") or []:
        if isinstance(child, dict):
            _walk_find(child, here, wanted, prefix_base, exact, prefix)


def _search_tree(root: dict[str, Any], keyword: str, limit: int) -> dict[str, Any]:
    kw = _norm(keyword).lower()
    if kw == "":
        return {"error": "search 视图需要 keyword 参数"}
    matches: list[dict[str, Any]] = []
    stack: list[tuple[dict[str, Any], list[dict[str, Any]]]] = [(root, [root])]
    while stack and len(matches) < limit:
        node, path = stack.pop()
        text = _norm((node.get("data") or {}).get("text"))
        if kw in text.lower() and not (len(path) == 1):
            entry = {"path": _path_text(path)}
            flags = _node_flags(node.get("data") or {})
            if flags:
                entry["flags"] = flags
            matches.append(entry)
        for child in reversed(node.get("children") or []):
            if isinstance(child, dict):
                stack.append((child, path + [child]))
    return {"keyword": keyword, "matches": matches, "total_shown": len(matches)}


@register_tool
class BoardNavigateTool(BoardToolBase):
    """Tree navigation and recursive search for one board (compact output)."""

    @property
    def name(self) -> str:
        return "board_navigate"

    @property
    def description(self) -> str:
        return (
            "查看板子树结构与递归定位节点（紧凑结果，不返回整份文档）："
            "view=children|siblings|parent|subtree 时需 target（节点文本，逐字）；"
            "view=search 用 keyword 递归搜索全树并返回节点路径。"
            "对锚点没有把握时先 search 定位，再出 board-nodes 建议。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "board_uuid": {"type": "string", "description": "板子 UUID"},
                "view": {
                    "type": "string",
                    "enum": list(_VIEWS),
                    "description": "children=子节点 / siblings=兄弟节点 / parent=父节点 / subtree=以该节点为根的子树大纲 / search=递归搜索",
                },
                "target": {"type": "string", "description": "目标节点文本（逐字；非 search 视图必填）"},
                "keyword": {"type": "string", "description": "搜索关键词（search 必填）"},
                "limit": {"type": "integer", "description": "返回条数上限，默认 20，上限 50"},
            },
            "required": ["board_uuid", "view"],
        }

    async def run(
        self,
        *,
        board_uuid: str,
        view: str = "children",
        target: str = "",
        keyword: str = "",
        limit: int = _DEFAULT_LIMIT,
        **kwargs: Any,
    ) -> dict[str, Any]:
        # Fetch the full doc server-side; the mapped error text passes through
        # on MCP failure (get_result has no "data" then).
        get_result = await self._call(kwargs, "get_board", {"board_uuid": board_uuid})
        raw = get_result.get("data")
        if not isinstance(raw, dict):
            return get_result
        doc = _parse_board_doc(raw.get("content"))
        root = doc.get("root") if isinstance(doc, dict) else None
        if not isinstance(root, dict):
            return {"content": json.dumps({"error": "板子为空或不是思维导图"}, ensure_ascii=False)}

        view = view if view in _VIEWS else "children"
        try:
            capped = max(1, min(int(limit), _MAX_LIMIT))
        except (TypeError, ValueError):
            capped = _DEFAULT_LIMIT

        if view == "search":
            payload = _search_tree(root, keyword, capped)
        else:
            wanted = _norm(target)
            if wanted == "":
                payload = {"error": f"view={view} 需要 target（节点文本，逐字）"}
            else:
                exact: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
                prefix: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
                _walk_find(root, [], wanted, wanted[:-1] if wanted.endswith("…") else "", exact, prefix)
                if len(exact) == 1:
                    node, path = exact[0]
                elif len(exact) > 1:
                    payload = {
                        "error": f"匹配到 {len(exact)} 个同名节点「{wanted[:40]}」；用 view=search 查看各路径后重试",
                    }
                    node, path = None, []
                elif len(prefix) == 1:
                    node, path = prefix[0]
                elif len(prefix) > 1:
                    payload = {"error": f"截断前缀匹配到 {len(prefix)} 个节点「{wanted[:40]}」；用 view=search 消歧"}
                    node, path = None, []
                else:
                    payload = {"error": f"未找到节点「{wanted[:40]}」；用 view=search 递归定位"}
                    node, path = None, []

                if node is not None:
                    if view == "children":
                        kids = [c for c in node.get("children") or [] if isinstance(c, dict)]
                        payload = {
                            "target": wanted[:120],
                            "child_count": len(kids),
                            "items": [_item(c) for c in kids[:capped]],
                        }
                    elif view == "siblings":
                        parent = path[-2] if len(path) >= 2 else None
                        sibs = [c for c in (parent.get("children") or []) if isinstance(c, dict)] if parent else []
                        me = wanted[:120]
                        payload = {
                            "target": me,
                            "parent": _norm((parent.get("data") or {}).get("text"))[:120] if parent else "",
                            "sibling_count": len(sibs),
                            "items": [
                                {**_item(c), "is_target": _norm((c.get("data") or {}).get("text")) == wanted}
                                for c in sibs[:capped]
                            ],
                        }
                    elif view == "parent":
                        parent = path[-2] if len(path) >= 2 else None
                        payload = {
                            "target": wanted[:120],
                            "parent": _norm((parent.get("data") or {}).get("text"))[:120] if parent else "（目标就是中心主题，无父节点）",
                            "parent_path": _path_text(path[:-1]) if len(path) >= 2 else "",
                        }
                    else:  # subtree
                        lines: list[str] = []
                        _outline_lines(node, 0, lines)
                        outline = "\n".join(lines)
                        if len(outline) > _SUBTREE_CHAR_LIMIT:
                            outline = outline[:_SUBTREE_CHAR_LIMIT] + "\n…（子树过大已截断）"
                        payload = {"target": wanted[:120], "subtree_outline": outline}

        return {"content": json.dumps(payload, ensure_ascii=False), "data": payload}
