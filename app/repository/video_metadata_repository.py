"""
VideoMetadata (arc_meta) CRUD repository.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models import VideoMetadata


class VideoMetadataRepository:

    async def get_by_video_id(self, video_id: int, db: AsyncSession) -> Optional[VideoMetadata]:
        result = await db.execute(
            select(VideoMetadata).where(VideoMetadata.video_id == video_id)
        )
        return result.scalar_one_or_none()

    async def upsert(
        self,
        video_id: int,
        *,
        summary: Optional[str] = None,
        keywords: Optional[list] = None,
        topics: Optional[list] = None,
        difficulty: Optional[str] = None,
        word_count: int = 0,
        reading_time: int = 0,
        language: Optional[str] = None,
        has_code: bool = False,
        has_math: bool = False,
        is_tutorial: bool = False,
        db: AsyncSession,
    ) -> VideoMetadata:
        existing = await self.get_by_video_id(video_id, db)
        now = datetime.utcnow()

        if existing:
            if summary is not None:
                existing.summary = summary
            if keywords is not None:
                existing.keywords = keywords
            if topics is not None:
                existing.topics = topics
            if difficulty is not None:
                existing.difficulty = difficulty
            existing.word_count = word_count
            existing.reading_time = reading_time
            if language is not None:
                existing.language = language
            existing.has_code = has_code
            existing.has_math = has_math
            existing.is_tutorial = is_tutorial
            existing.updated_at = now
            await db.commit()
            await db.refresh(existing)
            return existing

        meta = VideoMetadata(
            video_id=video_id,
            summary=summary,
            keywords=keywords,
            topics=topics,
            difficulty=difficulty,
            word_count=word_count,
            reading_time=reading_time,
            language=language,
            has_code=has_code,
            has_math=has_math,
            is_tutorial=is_tutorial,
        )
        db.add(meta)
        await db.commit()
        await db.refresh(meta)
        return meta

    async def update_user_fields(
        self,
        video_id: int,
        user_tags: Optional[list] = None,
        notes: Optional[str] = None,
        db: AsyncSession = None,
    ) -> Optional[VideoMetadata]:
        meta = await self.get_by_video_id(video_id, db)
        if not meta:
            return None
        if user_tags is not None:
            meta.user_tags = user_tags
        if notes is not None:
            meta.notes = notes
        meta.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(meta)
        return meta

    async def delete(self, video_id: int, db: AsyncSession) -> bool:
        meta = await self.get_by_video_id(video_id, db)
        if not meta:
            return False
        await db.delete(meta)
        await db.commit()
        return True


_repo: Optional[VideoMetadataRepository] = None


def get_video_metadata_repository() -> VideoMetadataRepository:
    global _repo
    if _repo is None:
        _repo = VideoMetadataRepository()
    return _repo
