"""
Quiz 题目生成服务 — 批量生成练习题。

从 Milvus 检索知识片段，通过 LLM 批量生成题目，复用现有凭证管理体系。
"""

import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from loguru import logger
from sqlalchemy import select
from langchain_openai import ChatOpenAI

from app.agent.quiz import (
    QuizBatchOutput as QuizBatchOutput,
    generate_batch,
    generate_questions,
    validate_question,
)
from app.config import settings
from app.database import get_db_context
from app.models import QuizSet, Collection, Video
from app.repository import mongo_quiz_repository as mongo_quiz
from app.services.chat.llm import build_llm
from app.services.rag import RAGService


_SENSITIVE_PATTERNS = (
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "token",
    "secret",
    "password",
    "sk-",
)


def _sanitize_error_message(msg: str) -> str:
    """Redact secrets and collapse file paths before persisting errors.

    Returns a short generic message when ``msg`` appears to leak sensitive
    content; otherwise returns the original string truncated to 500 chars.
    """
    if not msg:
        return "internal error"
    lower = msg.lower()
    if any(p in lower for p in _SENSITIVE_PATTERNS):
        return "internal error (sensitive detail redacted)"
    # Collapse Windows / Unix file paths to a placeholder
    sanitized = re.sub(
        r"([A-Za-z]:[\\/][^\s:]+|/[^\s:]+\.py)", "<path>", msg
    )
    return sanitized[:500]


class QuizGeneratorService:
    """题目生成服务"""

    def __init__(self):
        self.rag = RAGService()

    async def create_quiz_set(
        self,
        uid: int,
        folder_ids: Optional[list[int]] = None,
        pages: Optional[list[dict]] = None,
        question_count: int = 10,
        difficulty: str = "medium",
        title: Optional[str] = None,
    ) -> str:
        """Create QuizSet row with status='generating', return quiz_uuid immediately."""
        is_pages_mode = bool(pages)

        type_distribution = {
            "single_choice": max(2, question_count // 3),
            "multi_choice": max(1, question_count // 4),
            "short_answer": max(1, question_count // 4),
            "essay": max(1, question_count // 5),
        }
        total = sum(type_distribution.values())
        if total != question_count:
            type_distribution["single_choice"] += question_count - total

        quiz_uuid = str(uuid.uuid4())

        async with get_db_context() as db:
            quiz_set = QuizSet(
                quiz_uuid=quiz_uuid,
                uid=uid,
                title=title
                or f"练习 {datetime.now(timezone.utc).strftime('%m-%d %H:%M')}",
                question_count=question_count,
                type_distribution=type_distribution,
                difficulty=difficulty,
                folder_ids=folder_ids or [],
                source_type="pages" if is_pages_mode else "folder",
                source_pages=pages if is_pages_mode else None,
                status="generating",
            )
            db.add(quiz_set)
            await db.commit()

        return quiz_uuid

    async def count_retrievable_chunks(
        self,
        *,
        folder_ids: Optional[list[int]] = None,
        pages: Optional[list[dict]] = None,
        question_count: int = 10,
    ) -> tuple[int, str]:
        """Public preflight API: retrieve chunks (no LLM) and return count.

        Returns ``(count, empty_reason)``. ``empty_reason`` is a user-readable
        Chinese message when ``count == 0``, otherwise empty string.
        """
        is_pages_mode = bool(pages)
        try:
            if is_pages_mode:
                chunks = await self._retrieve_chunks_by_pages(pages or [], question_count)
            else:
                bvids = await self._get_bvids_by_folder_ids(folder_ids or [])
                if not bvids:
                    return 0, "收藏夹内没有已向量化的视频，请先同步并构建知识库"
                chunks = await self._retrieve_chunks(bvids, question_count)
        except Exception as e:
            logger.warning(f"[QUIZ] preflight retrieval failed: {e}")
            return 0, "知识库检索失败，请稍后重试"
        if not chunks:
            return 0, "未检索到可用知识片段，请先向量化更多视频"
        return len(chunks), ""

    async def run_generation(
        self,
        quiz_uuid: str,
        uid: int,
        folder_ids: Optional[list[int]] = None,
        pages: Optional[list[dict]] = None,
        question_count: int = 10,
        difficulty: str = "medium",
        title: Optional[str] = None,
    ) -> None:
        """Background: retrieve chunks → LLM generate → save MongoDB → update MySQL status."""
        is_pages_mode = bool(pages)

        type_distribution = {
            "single_choice": max(2, question_count // 3),
            "multi_choice": max(1, question_count // 4),
            "short_answer": max(1, question_count // 4),
            "essay": max(1, question_count // 5),
        }
        total = sum(type_distribution.values())
        if total != question_count:
            type_distribution["single_choice"] += question_count - total

        try:
            # 1. Retrieve knowledge chunks from vector store
            if is_pages_mode:
                chunks = await self._retrieve_chunks_by_pages(
                    pages or [], question_count
                )
            else:
                bvids = await self._get_bvids_by_folder_ids(folder_ids or [])
                chunks = await self._retrieve_chunks(bvids, question_count)
            min_chunks = max(1, question_count // 5)
            if len(chunks) < min_chunks:
                raise ValueError(f"可用知识片段不足: {len(chunks)} < {min_chunks}")

            # 2. Batch generate via LLM
            questions = await self._batch_generate(
                chunks, question_count, type_distribution, difficulty, uid
            )

            # 3. Quality validation
            valid_questions = [
                q for q in questions if self._validate_question(q, chunks)
            ]

            # Partial degradation: if we have >= 60% of requested, accept as partial.
            # Only fail outright when fewer than 60% could be generated.
            partial_threshold = max(1, int(question_count * 0.6))
            if len(valid_questions) < partial_threshold:
                raise RuntimeError(
                    f"有效题目数量不足: {len(valid_questions)} < {partial_threshold} (60% threshold)"
                )

            final_status = "done" if len(valid_questions) >= question_count else "partial"
            final_count = len(valid_questions)

            # 4. Save to MongoDB — clear any stale docs from a prior failed run first,
            # then upsert (idempotent by question_uuid).
            await mongo_quiz.delete_by_quiz(quiz_uuid, uid=uid)
            saved = await mongo_quiz.insert_questions(quiz_uuid, uid, valid_questions)
            if saved == 0 and valid_questions:
                raise RuntimeError("MongoDB unavailable — 0 questions saved")

            # 5. Update status → done or partial
            from app.agent.quiz.quality import compute_quiz_quality

            quality_metrics = compute_quiz_quality(
                valid_questions, chunks, type_distribution
            )

            async with get_db_context() as db:
                result = await db.execute(
                    select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid)
                )
                qs = result.scalar_one_or_none()
                if qs:
                    qs.status = final_status
                    qs.question_count = final_count
                    qs.bvid_count = len(set(q.get("bvid", "") for q in valid_questions))
                    qs.completed_at = datetime.now(timezone.utc)
                    qs.quality_metrics = quality_metrics
                    await db.commit()

            est_tokens = sum(len(c["content"]) for c in chunks) // 3
            logger.info(
                f"[QUIZ] generated quiz_uuid={quiz_uuid} questions={len(valid_questions)} tokens~{est_tokens}"
            )

        except Exception as e:
            logger.error(f"[QUIZ] generation failed quiz_uuid={quiz_uuid}: {e}")
            # Purge any partial MongoDB writes from this attempt so failed
            # quizzes leave no orphan questions behind. Best-effort: a Mongo
            # failure here must not mask the original error.
            try:
                await mongo_quiz.delete_by_quiz(quiz_uuid, uid=uid)
            except Exception as purge_err:
                logger.warning(
                    f"[QUIZ] mongo purge failed quiz_uuid={quiz_uuid}: {purge_err}"
                )
            async with get_db_context() as db:
                result = await db.execute(
                    select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid)
                )
                qs = result.scalar_one_or_none()
                if qs:
                    qs.status = "failed"
                    qs.error_message = _sanitize_error_message(str(e))
                    await db.commit()

    async def _get_bvids_by_folder_ids(self, media_ids: list[int]) -> list[str]:
        """获取指定收藏夹中已向量化的 BV 列表。

        Join Video table on is_vectorized='done' so we only pass bvids that
        actually have chunks in Milvus. Without this filter, a folder with
        many synced-but-unvectorized bvids would query Milvus with bvids that
        have no chunks, and the in-filter would mask the vectorized subset
        when Milvus stores nothing for the rest.
        """
        async with get_db_context() as db:
            rows = await db.execute(
                select(Collection.bvid)
                .join(Video, Video.bvid == Collection.bvid, isouter=False)
                .where(
                    Collection.media_id.in_(media_ids),
                    Video.is_vectorized == "done",
                )
                .distinct()
            )
            bvids = [row[0] for row in rows.fetchall() if row[0]]
        logger.info(
            f"[QUIZ] _get_bvids_by_folder_ids folders={media_ids} "
            f"vectorized_bvids={len(bvids)}"
        )
        return bvids

    async def _retrieve_chunks(
        self,
        bvids: list[str],
        question_count: int,
    ) -> list[dict]:
        """
        检索出题用的知识片段，多轮多样化查询确保覆盖面。
        Dedup by chunk_id (not bvid) so a single video can contribute multiple
        chunks — needed for small folders where bvid-level dedup starves the
        generator below the min_chunks threshold.

        Calls the Milvus bilibili backend directly (bypasses legacy.search's
        dual-backend merge + partition filter) — the quiz only wants bilibili
        chunks, and the 365-day partition window in legacy.search can exclude
        older chunks that are still valid quiz material.
        """
        queries = [
            "概念 定义 原理 什么是",
            "方法 步骤 流程 怎么做",
            "原因 为什么 机制 背景",
            "特点 优势 区别 对比",
            "应用 场景 案例 实例",
        ]

        seen_chunk_ids: set[str] = set()
        chunks: list[dict] = []
        target = int(question_count * 2)

        total_raw = 0
        for query in queries:
            try:
                # Direct Milvus call: no partition filter, no cloud merge.
                # bvids param builds `bvid in [...]` expr in MilvusVectorStore.
                results = self.rag.vectorstore.search(query, k=5, bvids=bvids)
            except Exception as e:
                logger.warning(f"[QUIZ] search failed query={query}: {e}")
                continue

            total_raw += len(results)
            for doc in results:
                doc_bvid = doc.metadata.get("bvid", "")
                chunk_index = doc.metadata.get("chunk_index")
                chunk_id = f"{doc_bvid}:{chunk_index}" if chunk_index is not None else doc_bvid
                if chunk_id in seen_chunk_ids or len(doc.page_content) < 100:
                    continue
                seen_chunk_ids.add(chunk_id)
                chunks.append(
                    {
                        "bvid": doc_bvid,
                        "title": doc.metadata.get("title", ""),
                        "content": doc.page_content[:3000],
                        "chunk_index": chunk_index,
                    }
                )
                if len(chunks) >= target:
                    return chunks

        # Diagnostic: if bvid-filtered search returned nothing, probe Milvus
        # without filter to distinguish "Milvus empty" from "bvid mismatch".
        if not chunks:
            try:
                probe = self.rag.vectorstore.search("知识 概念 内容", k=3, bvids=None)
                logger.warning(
                    f"[QUIZ] 0 chunks after {len(queries)} queries "
                    f"bvids={bvids} raw_hits={total_raw} "
                    f"unfiltered_probe={len(probe)}"
                )
                if probe:
                    sample_bvids = list({d.metadata.get("bvid", "?") for d in probe[:3]})
                    logger.warning(
                        f"[QUIZ] Milvus has chunks but not for requested bvids. "
                        f"Sample bvids in Milvus: {sample_bvids}"
                    )
            except Exception as pe:
                logger.warning(f"[QUIZ] unfiltered probe failed: {pe}")

        return chunks

    async def _retrieve_chunks_by_pages(
        self,
        pages: list[dict],
        question_count: int,
    ) -> list[dict]:
        """
        按指定分P检索出题用的知识片段。
        pages: [{"bvid": "BVxxx", "cid": 123, "page_index": 0, "page_title": "P1"}, ...]
        """
        queries = [
            "概念 定义 原理 什么是",
            "方法 步骤 流程 怎么做",
            "原因 为什么 机制 背景",
            "特点 优势 区别 对比",
            "应用 场景 案例 实例",
        ]

        seen_chunk_ids: set[str] = set()
        chunks: list[dict] = []
        target = int(question_count * 2)

        # Build (bvid, page_index) lookup for post-filtering. Milvus filter
        # is bvid-only; page_index is filtered here after retrieval.
        page_lookup = {
            (p["bvid"], p.get("page_index", 0)): p.get("page_title", "")
            for p in pages
        }
        wp_bvids = list({p["bvid"] for p in pages})

        total_raw = 0
        for query in queries:
            try:
                # Direct Milvus call: bypass legacy.search's partition filter
                # (365-day window can exclude older chunks) and cloud merge.
                results = self.rag.vectorstore.search(query, k=5, bvids=wp_bvids)
            except Exception as e:
                logger.warning(f"[QUIZ] pages search failed query={query}: {e}")
                continue

            total_raw += len(results)
            for doc in results:
                chunk_id = doc.metadata.get("chunk_id", "")
                if not chunk_id:
                    bvid_fb = doc.metadata.get("bvid", "")
                    pi_fb = doc.metadata.get("page_index", 0)
                    ci_fb = doc.metadata.get("chunk_index", 0)
                    chunk_id = f"{bvid_fb}:{pi_fb}:{ci_fb}"
                if chunk_id in seen_chunk_ids or len(doc.page_content) < 100:
                    continue
                bvid = doc.metadata.get("bvid", "")
                page_idx = doc.metadata.get("page_index", 0)
                # Post-filter: only keep chunks from requested pages
                if (bvid, page_idx) not in page_lookup:
                    continue
                seen_chunk_ids.add(chunk_id)
                page_title = page_lookup.get((bvid, page_idx), "")
                chunks.append(
                    {
                        "bvid": bvid,
                        "title": doc.metadata.get("title", ""),
                        "page_index": page_idx,
                        "page_title": page_title or doc.metadata.get("page_title", ""),
                        "content": doc.page_content[:3000],
                        "chunk_index": doc.metadata.get("chunk_index"),
                    }
                )
                if len(chunks) >= target:
                    return chunks

        # Diagnostic: if page-filtered search returned nothing, probe Milvus
        # without filter to distinguish "Milvus empty" from "bvid mismatch".
        if not chunks:
            try:
                probe = self.rag.vectorstore.search("知识 概念 内容", k=3, bvids=None)
                logger.warning(
                    f"[QUIZ] pages 0 chunks after {len(queries)} queries "
                    f"wp_bvids={wp_bvids} raw_hits={total_raw} "
                    f"unfiltered_probe={len(probe)}"
                )
                if probe:
                    sample = list({
                        f"{d.metadata.get('bvid', '?')}:P{d.metadata.get('page_index', '?')}"
                        for d in probe[:3]
                    })
                    logger.warning(
                        f"[QUIZ] Milvus has chunks but not for requested pages. "
                        f"Sample bvid:page in Milvus: {sample}"
                    )
            except Exception as pe:
                logger.warning(f"[QUIZ] pages unfiltered probe failed: {pe}")

        return chunks

    BATCH_SIZE = 5  # generate 5 questions per LLM call for quality

    async def _generate_batch(
        self,
        chunks: list[dict],
        batch_count: int,
        batch_types: list[str],
        difficulty: str,
        uid: int,
        used_chunk_indices: set[int],
    ) -> list[dict]:
        return await generate_batch(
            chunks=chunks,
            batch_count=batch_count,
            batch_types=batch_types,
            difficulty=difficulty,
            uid=uid,
            used_chunk_indices=used_chunk_indices,
            llm_factory=lambda temperature: self._get_tracking_llm(
                uid=uid,
                temperature=temperature,
            ),
        )

    async def _batch_generate(
        self,
        chunks: list[dict],
        total_count: int,
        type_distribution: dict,
        difficulty: str,
        uid: int,
    ) -> list[dict]:
        return await generate_questions(
            chunks=chunks,
            total_count=total_count,
            type_distribution=type_distribution,
            difficulty=difficulty,
            uid=uid,
            batch_size=self.BATCH_SIZE,
            llm_factory=lambda temperature: self._get_tracking_llm(
                uid=uid,
                temperature=temperature,
            ),
        )

    @staticmethod
    def _get_llm(temperature: float = 0.7) -> ChatOpenAI:
        """获取 LLM 实例（使用系统默认 Key）"""
        api_key = settings.openai_api_key
        base_url = settings.openai_base_url
        model = settings.llm_model

        if not api_key:
            raise RuntimeError("未配置 LLM API Key")

        return ChatOpenAI(
            api_key=api_key,
            base_url=base_url,
            model=model,
            temperature=temperature,
        )

    def _get_tracking_llm(self, *, uid: int, temperature: float) -> ChatOpenAI:
        """Build a per-user LLM with usage tracking for quiz generation.

        ``build_llm`` already attaches a UsageTrackingCallback, so we only
        need to set the desired temperature and return it.
        """
        llm = build_llm(uid=uid)
        llm.temperature = temperature
        return llm

    def _validate_question(self, q: dict, chunks: list[dict]) -> bool:
        return validate_question(q, chunks)

    # _save_questions removed — questions stored in MongoDB via mongo_quiz_repository


async def get_quiz_set(quiz_uuid: str) -> Optional[QuizSet]:
    """Get quiz set metadata from MySQL."""
    async with get_db_context() as db:
        result = await db.execute(select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid))
        return result.scalar_one_or_none()


async def get_quiz_questions(quiz_uuid: str) -> list[dict]:
    """Get questions without answers from MongoDB (for quiz display)."""
    return await mongo_quiz.get_questions(quiz_uuid)


async def get_quiz_questions_full(quiz_uuid: str) -> list[dict]:
    """Get questions with answers from MongoDB (for grading / review)."""
    return await mongo_quiz.get_questions_full(quiz_uuid)
