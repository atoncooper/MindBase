"""BoardListTool — list the user's boards via app-board-mcp."""

from __future__ import annotations

from typing import Any

from app.tools import register_tool
from app.tools.board._base import BoardToolBase


@register_tool
class BoardListTool(BoardToolBase):
    """List the current user's mind-map / whiteboard boards."""

    @property
    def name(self) -> str:
        return "board_list"

    @property
    def description(self) -> str:
        return (
            "列出当前用户的思维导图/白板（元数据：uuid、标题、类型、版本、更新时间）。"
            "page_size 上限 100。先用它发现板子，再用 board_get 读取内容。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["mindmap", "whiteboard"],
                    "description": "按类型过滤；省略返回全部",
                },
                "page": {"type": "integer", "description": "页码，默认 1"},
                "page_size": {"type": "integer", "description": "每页数量，默认 20，上限 100"},
            },
            "required": [],
        }

    async def run(self, **kwargs: Any) -> dict[str, Any]:
        arguments: dict[str, Any] = {}
        for key in ("kind", "page", "page_size"):
            if kwargs.get(key) is not None:
                arguments[key] = kwargs[key]
        return await self._call(kwargs, "list_boards", arguments)
