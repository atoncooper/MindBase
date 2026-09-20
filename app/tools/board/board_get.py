"""BoardGetTool — read one board document via app-board-mcp."""

from __future__ import annotations

from typing import Any

from app.tools import register_tool
from app.tools.board._base import BoardToolBase


@register_tool
class BoardGetTool(BoardToolBase):
    """Read one board (metadata + full document JSON)."""

    @property
    def name(self) -> str:
        return "board_get"

    @property
    def description(self) -> str:
        return (
            "读取一块思维导图/白板的完整文档 JSON（含 title/kind/version 与 content）。"
            "返回的 version 是乐观锁版本号：之后用 board_update 修改时作为 expected_version 传回。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "board_uuid": {"type": "string", "description": "板子 UUID（来自 board_list）"},
            },
            "required": ["board_uuid"],
        }

    async def run(self, *, board_uuid: str, **kwargs: Any) -> dict[str, Any]:
        return await self._call(kwargs, "get_board", {"board_uuid": board_uuid})
