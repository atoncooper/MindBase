"""BoardDeleteTool — soft-delete a board via app-board-mcp."""

from __future__ import annotations

from typing import Any

from app.tools import register_tool
from app.tools.board._base import BoardToolBase


@register_tool
class BoardDeleteTool(BoardToolBase):
    """Soft-delete one board (recoverable server-side)."""

    @property
    def name(self) -> str:
        return "board_delete"

    @property
    def description(self) -> str:
        return (
            "删除一块思维导图/白板（软删除：立即不可见，服务端保留正文备人工恢复）。"
            "删除前务必与用户确认。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "board_uuid": {"type": "string", "description": "板子 UUID"},
            },
            "required": ["board_uuid"],
        }

    async def run(self, *, board_uuid: str, **kwargs: Any) -> dict[str, Any]:
        return await self._call(kwargs, "delete_board", {"board_uuid": board_uuid})
