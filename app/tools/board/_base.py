"""Shared plumbing for the board MCP proxy tools."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.services.board import BoardMCPClient, BoardMCPError, BoardMCPUnavailableError, get_board_mcp_client
from app.tools import ToolDeps

logger = logging.getLogger(__name__)

# Canonical board document shape, kept in sync with the app-board-mcp tool
# descriptions and the frontend editors (simple-mind-map tree).
DOC_SHAPE = (
    'MindMapDoc JSON：{"root":{"data":{"text":"节点文本"},'
    '"children":[{"data":{"text":"子节点"},"children":[]}]},'
    '"layout":"logicalStructure","theme":{"template":"default"}}。'
    "每个节点必须包含 data.text 与 children 数组（叶子可为空数组）。"
)


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
        return {"content": json.dumps(data, ensure_ascii=False), "data": data}
