"""DB-backed ChatDeps — production implementation for the Chat Agent.

Wraps the same DB query logic used by ``routers/chat.py`` so the
Chat Agent can resolve media IDs, BV IDs, and video context
without depending on the router layer.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Collection, FavoriteFolder
from app.services.rag import get_rag_service

logger = logging.getLogger(__name__)


class DBChatDeps:
    """Production ``ChatDeps`` backed by SQLAlchemy + RAGService.

    Each method creates its own DB session via the ``session_factory``
    so the agent does not hold a long-lived session across the ReAct loop.
    """

    def __init__(self, session_factory: Any) -> None:
        self._session_factory = session_factory

    async def _get_session(self) -> AsyncSession:
        return self._session_factory()

    # ── ChatDeps protocol ─────────────────────────────────────────────

    async def get_media_ids(self, uid: int | None, folder_ids: list[int]) -> list[int]:
        if not uid:
            return []
        async with await self._get_session() as db:
            stmt = (
                select(FavoriteFolder.media_id)
                .where(FavoriteFolder.uid == uid, FavoriteFolder.deleted_at.is_(None))
                .order_by(FavoriteFolder.updated_at.desc())
            )
            if folder_ids:
                stmt = stmt.where(FavoriteFolder.media_id.in_(folder_ids))
            rows = await db.execute(stmt)
            seen: set[int] = set()
            result: list[int] = []
            for (mid,) in rows.fetchall():
                if mid and mid not in seen:
                    seen.add(mid)
                    result.append(mid)
            return result

    async def get_bvids(self, media_ids: list[int]) -> list[str]:
        if not media_ids:
            return []
        async with await self._get_session() as db:
            rows = await db.execute(
                select(Collection.bvid).where(Collection.media_id.in_(media_ids))
            )
            seen: set[str] = set()
            result: list[str] = []
            for (bvid,) in rows.fetchall():
                if bvid and bvid not in seen:
                    seen.add(bvid)
                    result.append(bvid)
            return result

    def has_cloud_backend(self) -> bool:
        rag = get_rag_service()
        return rag.cloud_backend is not None

    async def get_conversation_context(self, session_id: str) -> str:
        # Short-term context injection — the detailed retrieval is handled
        # by context tools (search_chat_history, get_recent_context, etc.)
        return ""

    async def get_video_context(
        self,
        media_ids: list[int],
        *,
        include_content: bool = False,
        limit: int | None = 50,
    ) -> tuple[str, list[dict]]:
        if not media_ids:
            return "", []
        async with await self._get_session() as db:
            query = (
                select(
                    FavoriteFolder.title.label("folder_title"),
                    Collection.bvid,
                    Collection.title,
                    Collection.description,
                )
                .join(Collection, Collection.media_id == FavoriteFolder.media_id)
                .where(FavoriteFolder.media_id.in_(media_ids))
            )
            if limit is not None:
                query = query.limit(limit)
            result = await db.execute(query)
            records = result.fetchall()
            if not records:
                return "", []

            grouped: dict[str, list[str]] = {}
            sources: list[dict] = []
            seen_bvids: set[str] = set()
            for folder_title, bvid, title, desc in records:
                if not bvid or not title:
                    continue
                if bvid in seen_bvids:
                    continue
                folder_name = folder_title or "默认收藏夹"
                grouped.setdefault(folder_name, [])
                video_info = f"- 《{title}》"
                if include_content and desc:
                    video_info += f"\n  摘要: {desc}"
                elif desc:
                    short_desc = desc[:100] + "..." if len(desc) > 100 else desc
                    video_info += f" ({short_desc})"
                grouped[folder_name].append(video_info)
                seen_bvids.add(bvid)
                sources.append({"bvid": bvid, "title": title})

            parts = [
                f"【{name}】\n" + "\n".join(vids) for name, vids in grouped.items()
            ]
            return "\n\n".join(parts), sources

    async def get_video_titles_context(self, media_ids: list[int]) -> str:
        if not media_ids:
            return ""
        async with await self._get_session() as db:
            query = (
                select(
                    FavoriteFolder.title.label("folder_title"),
                    Collection.bvid,
                    Collection.title,
                )
                .join(Collection, Collection.media_id == FavoriteFolder.media_id)
                .where(FavoriteFolder.media_id.in_(media_ids))
                .limit(50)
            )
            result = await db.execute(query)
            records = result.fetchall()
            if not records:
                return ""

            grouped: dict[str, list[str]] = {}
            seen_bvids: set[str] = set()
            for folder_title, bvid, title in records:
                if not title or not bvid:
                    continue
                if bvid in seen_bvids:
                    continue
                seen_bvids.add(bvid)
                folder_name = folder_title or "默认收藏夹"
                grouped.setdefault(folder_name, []).append(f"- 《{title}》")

            parts = [
                f"【{name}】\n" + "\n".join(vids) for name, vids in grouped.items()
            ]
            return "\n\n".join(parts)

    async def is_related_to_collection(
        self, media_ids: list[int], question: str
    ) -> bool:
        # Heuristic: if we have media_ids, the question is likely related
        return bool(media_ids)
