"""BoardCreateTool — create a board via app-board-mcp."""

from __future__ import annotations

from typing import Any

from app.tools import register_tool
from app.tools.board._base import DOC_SHAPE, BoardToolBase


@register_tool
class BoardCreateTool(BoardToolBase):
    """Create a new mind-map / whiteboard board."""

    @property
    def name(self) -> str:
        return "board_create"

    @property
    def description(self) -> str:
        return (
            "创建一块新的思维导图（kind=mindmap，content 为 " + DOC_SHAPE + " ）"
            "或白板（kind=whiteboard，content 为 Excalidraw scene JSON）。"
            "创建成功即持久化，返回新板子的 uuid 与 version。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "标题（最长 255 字符）"},
                "kind": {
                    "type": "string",
                    "enum": ["mindmap", "whiteboard"],
                    "description": "类型，默认 mindmap",
                },
                "content": {
                    "type": "object",
                    "description": "文档 JSON（对象，形状见工具描述）；可省略创建空板",
                },
            },
            "required": ["title"],
        }

    async def run(
        self,
        *,
        title: str,
        kind: str = "mindmap",
        content: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        arguments: dict[str, Any] = {"title": title, "kind": kind}
        if content is not None:
            arguments["content"] = content
        return await self._call(kwargs, "create_board", arguments)
