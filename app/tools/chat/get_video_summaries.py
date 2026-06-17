"""GetVideoSummariesTool — get detailed summaries of videos in the collection."""

from __future__ import annotations

import logging
from typing import Any

from app.tools import ToolDeps, register_tool

logger = logging.getLogger(__name__)


@register_tool
class GetVideoSummariesTool:
    """Get video titles + full descriptions from the user's collection.

    Use when the user wants a summary or overview of their collection,
    e.g. 「总结收藏夹」「概述一下我的视频」.
    """

    def __init__(self, deps: Any) -> None:
        self._deps = deps

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "GetVideoSummariesTool | None":
        if deps.db_deps is None:
            return None
        return cls(deps.db_deps)

    @property
    def name(self) -> str:
        return "get_video_summaries"

    @property
    def description(self) -> str:
        return (
            "获取用户收藏夹中视频的标题和详细描述。"
            "适用于总结/概览类问题，例如「总结我的收藏夹」「概述一下视频内容」。"
            "返回按收藏夹分组的视频标题与完整描述。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "folder_ids": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "要查询的收藏夹ID列表，为空则查询全部",
                },
            },
            "required": [],
        }

    async def run(self, *, folder_ids: list[int] | None = None, **kwargs: Any) -> str:
        """Query DB for video titles + descriptions grouped by folder."""
        media_ids = kwargs.get("_media_ids", [])
        if not media_ids:
            return "用户暂无已同步的收藏夹。"

        context, sources = await self._deps.get_video_context(
            media_ids,
            include_content=True,
            limit=None,
        )
        if not context:
            return "收藏夹中暂无视频信息，可能需要先入库。"
        return context
