"""BoardUpdateTool — update a board via app-board-mcp (optimistic lock)."""

from __future__ import annotations

from typing import Any

from app.tools import register_tool
from app.tools.board._base import DOC_SHAPE, BoardToolBase


@register_tool
class BoardUpdateTool(BoardToolBase):
    """Update a board's title/content/pin state with optimistic locking."""

    @property
    def name(self) -> str:
        return "board_update"

    @property
    def description(self) -> str:
        return (
            "更新思维导图/白板（title/content/is_pinned 至少一项；content 整体替换，"
            "mindmap 形状：" + DOC_SHAPE + " ）。"
            "乐观锁：expected_version 传 board_get 返回的 version；省略则自动锁定当前最新版本"
            "（并发编辑场景请先 board_get 再带版本提交）。冲突时会返回最新版本号。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "board_uuid": {"type": "string", "description": "板子 UUID"},
                "expected_version": {"type": "integer", "description": "期望版本号（乐观锁）；省略=自动取最新"},
                "title": {"type": "string", "description": "新标题"},
                "content": {"type": "object", "description": "新文档 JSON（整体替换）"},
                "is_pinned": {"type": "boolean", "description": "置顶状态"},
            },
            "required": ["board_uuid"],
        }

    async def run(self, *, board_uuid: str, **kwargs: Any) -> dict[str, Any]:
        arguments: dict[str, Any] = {"board_uuid": board_uuid}
        for key in ("expected_version", "title", "content", "is_pinned"):
            if kwargs.get(key) is not None:
                arguments[key] = kwargs[key]
        return await self._call(kwargs, "update_board", arguments)
