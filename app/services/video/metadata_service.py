"""
Metadata extraction service — AI-powered structured insights from ASR content.

Reads full ASR text from MongoDB (asr_documents), extracts structured metadata
via LLM, and stores in arc_meta table (MySQL).
"""

from datetime import datetime, timezone
from typing import Optional

from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Video, VideoMetadata
from app.repository.video_metadata_repository import (
    get_video_metadata_repository,
    VideoMetadataRepository,
)

_EXTRACT_PROMPT = """Analyze the following video transcript and return a JSON object with these fields:
- summary: a 2-3 sentence summary of the content (in the transcript's language)
- keywords: array of 5-10 key terms
- topics: array of {{"name": "topic", "confidence": 0.0-1.0}} objects (2-5 topics)
- difficulty: "beginner", "intermediate", or "advanced"
- language: "zh", "en", or "mix"
- has_code: true if the content contains code snippets or programming instruction
- has_math: true if contains mathematical formulas or proofs
- is_tutorial: true if structured as a tutorial/lesson

Return ONLY valid JSON, no other text.

Transcript:
{content}"""


class MetadataService:

    def __init__(self, repo: Optional[VideoMetadataRepository] = None):
        self._repo = repo or get_video_metadata_repository()

    async def get_metadata(
        self, video_id: int, db: AsyncSession
    ) -> Optional[VideoMetadata]:
        return await self._repo.get_by_video_id(video_id, db)

    async def extract_metadata(
        self,
        video_id: int,
        db: AsyncSession,
    ) -> VideoMetadata:
        """Extract structured metadata from ASR content using LLM."""
        # Load video page
        page = await db.get(Video, video_id)
        if not page:
            raise ValueError(f"Video not found: id={video_id}")

        if not page.is_processed:
            raise ValueError("ASR not completed yet, cannot extract metadata")

        # Get ASR content from MongoDB (or MySQL fallback)
        content = None
        from app.infra.mongo import is_enabled as mongo_enabled
        if mongo_enabled():
            try:
                from app.repository.mongo_asr_repository import get_latest
                doc = await get_latest(page.bvid, page.cid)
                if doc:
                    content = doc.get("content")
            except Exception as e:
                logger.warning(f"[MetadataService] MongoDB read failed: {e}")

        if not content:
            from app.repository.mongo_asr_repository import get_latest
            doc = await get_latest(page.bvid, page.cid)
            if doc:
                content = doc.get("content")

        if not content or len(content.strip()) < 100:
            raise ValueError("ASR content too short for metadata extraction")

        # Truncate for LLM
        max_chars = 8000
        if len(content) > max_chars:
            content = content[:max_chars]

        # LLM extraction
        from langchain_openai import ChatOpenAI
        from langchain_core.messages import HumanMessage
        from app.config import settings
        import json

        llm = ChatOpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
            model=settings.llm_model,
            temperature=0.3,
        )

        prompt = _EXTRACT_PROMPT.format(content=content)
        response = await llm.ainvoke([HumanMessage(content=prompt)])
        text = str(response.content or "").strip()

        # Parse JSON response
        if text.startswith("```json"):
            text = text[7:]
        if text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]

        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            logger.warning(f"[MetadataService] LLM returned invalid JSON, raw: {text[:200]}")
            # Try to extract JSON from the text
            import re
            match = re.search(r"\{.+\}", text, re.DOTALL)
            if match:
                data = json.loads(match.group())
            else:
                raise ValueError("Failed to parse LLM response as JSON")

        # Compute stats
        word_count = len(content)
        reading_time = max(1, word_count // 200)  # ~200 chars/min

        # Upsert
        meta = await self._repo.upsert(
            video_id=video_id,
            summary=data.get("summary"),
            keywords=data.get("keywords"),
            topics=data.get("topics"),
            difficulty=data.get("difficulty"),
            word_count=word_count,
            reading_time=reading_time,
            language=data.get("language"),
            has_code=data.get("has_code", False),
            has_math=data.get("has_math", False),
            is_tutorial=data.get("is_tutorial", False),
            db=db,
        )

        # Mark extraction time
        meta.extracted_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(meta)

        logger.info(
            f"[MetadataService] extracted metadata for video_id={video_id} "
            f"difficulty={meta.difficulty} topics={len(meta.topics or [])}"
        )
        return meta

    async def update_user_tags(
        self,
        video_id: int,
        user_tags: Optional[list] = None,
        notes: Optional[str] = None,
        db: AsyncSession = None,
    ) -> Optional[VideoMetadata]:
        return await self._repo.update_user_fields(video_id, user_tags, notes, db)
