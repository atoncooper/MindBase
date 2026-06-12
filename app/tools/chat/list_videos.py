"""ListVideosTool — list videos from the user's favorite folders."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class ListVideosTool:
    """List videos in the user's favorite folders (DB query, no vector search).

    Use when the user asks for a catalog / inventory of their collection,
    e.g. 「有哪些视频」「列出收藏夹」.
    """

    def __init__(self, deps: Any) -> None:
        self._deps = deps

    @property
    def name(self) -> str:
        return "list_videos"

    @property
    def description(self) -> str:
        return (
            "列出用户收藏夹中的视频标题和简介。"
            "适用于列表/清单类问题，例如「有哪些视频」「收藏夹里有什么」。"
            "返回按收藏夹分组的视频列表。"
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
        """Query DB for video titles grouped by folder."""
        media_ids = kwargs.get("_media_ids", [])
        if not media_ids:
            return "用户暂无已同步的收藏夹。"

        context, sources = await self._deps.get_video_context(
            media_ids, include_content=False, limit=50,
        )
        if not context:
            return "收藏夹中暂无视频信息，可能需要先入库。"
        return context
