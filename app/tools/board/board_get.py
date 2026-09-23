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
            "读取板子：元数据（title/kind/version/is_pinned）+ 文档 JSON。"
            "返回的 version 是乐观锁版本号：之后用 board_update 修改时作为 expected_version 传回。"
            "小板子返回完整 content；大板子只返回 content_outline 结构大纲（content_full=false），"
            "此时禁止 board_update 全量重写。"
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
