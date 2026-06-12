"""
Quiz 题目生成服务 — 批量生成练习题。

从 Milvus 检索知识片段，通过 LLM 批量生成题目，复用现有凭证管理体系。
"""

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
from app.models import QuizSet, Collection
from app.services.llm.buffered_usage_writer import get_buffered_usage_writer
from app.services.llm.usage_tracker import UsageTrackingCallback
from app.services.rag import RAGService


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
            min_chunks = (
                max(1, question_count // 5)
                if is_pages_mode
                else max(1, question_count // 3)
            )
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
            if len(valid_questions) < question_count:
                raise RuntimeError(
                    f"有效题目数量不足: {len(valid_questions)} < {question_count}"
                )

            # 4. Save to MongoDB
            from app.repository import mongo_quiz_repository as mongo_quiz

            saved = await mongo_quiz.insert_questions(quiz_uuid, uid, valid_questions)
            if saved == 0 and valid_questions:
                raise RuntimeError("MongoDB unavailable — 0 questions saved")

            # 5. Update status → done
            async with get_db_context() as db:
                result = await db.execute(
                    select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid)
                )
                qs = result.scalar_one_or_none()
                if qs:
                    qs.status = "done"
                    qs.bvid_count = len(set(q.get("bvid", "") for q in valid_questions))
                    qs.completed_at = datetime.now(timezone.utc)
                    await db.commit()

            est_tokens = sum(len(c["content"]) for c in chunks) // 3
            logger.info(
                f"[QUIZ] generated quiz_uuid={quiz_uuid} questions={len(valid_questions)} tokens~{est_tokens}"
            )

        except Exception as e:
            logger.error(f"[QUIZ] generation failed quiz_uuid={quiz_uuid}: {e}")
            async with get_db_context() as db:
                result = await db.execute(
                    select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid)
                )
                qs = result.scalar_one_or_none()
                if qs:
                    qs.status = "failed"
                    qs.error_message = str(e)
                    await db.commit()

    async def _get_bvids_by_folder_ids(self, media_ids: list[int]) -> list[str]:
        """获取指定收藏夹的 BV 列表 (media_id → collection)"""
        async with get_db_context() as db:
            rows = await db.execute(
                select(Collection.bvid).where(Collection.media_id.in_(media_ids))
            )
            bvids = []
            seen = set()
            for (bvid,) in rows.fetchall():
                if bvid not in seen:
                    seen.add(bvid)
                    bvids.append(bvid)
        return bvids

    async def _retrieve_chunks(
        self,
        bvids: list[str],
        question_count: int,
    ) -> list[dict]:
        """
        检索出题用的知识片段，多轮多样化查询确保覆盖面。
        """
        queries = [
            "概念 定义 原理 什么是",
            "方法 步骤 流程 怎么做",
            "原因 为什么 机制 背景",
            "特点 优势 区别 对比",
            "应用 场景 案例 实例",
        ]

        seen_bvids: set[str] = set()
        chunks: list[dict] = []
        target = int(question_count * 1.5)

        for query in queries:
            try:
                results = self.rag.search(query, k=5, bvids=bvids)
            except Exception as e:
                logger.warning(f"[QUIZ] search failed query={query}: {e}")
                continue

            for doc in results:
                doc_bvid = doc.metadata.get("bvid", "")
                if doc_bvid not in seen_bvids and len(doc.page_content) >= 200:
                    seen_bvids.add(doc_bvid)
                    chunks.append(
                        {
                            "bvid": doc_bvid,
                            "title": doc.metadata.get("title", ""),
                            "content": doc.page_content[:3000],
                            "chunk_index": doc.metadata.get("chunk_index"),
                        }
                    )
                    if len(chunks) >= target:
                        return chunks

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
        target = int(question_count * 1.5)

        workspace_pages = [
            {"bvid": p["bvid"], "page_index": p["page_index"]} for p in pages
        ]

        for query in queries:
            try:
                results = self.rag.search(query, k=5, workspace_pages=workspace_pages)
            except Exception as e:
                logger.warning(f"[QUIZ] pages search failed query={query}: {e}")
                continue

            for doc in results:
                chunk_id = doc.metadata.get("chunk_id", "")
                if not chunk_id:
                    # Fallback: construct unique key from metadata
                    bvid_fb = doc.metadata.get("bvid", "")
                    pi_fb = doc.metadata.get("page_index", 0)
                    ci_fb = doc.metadata.get("chunk_index", 0)
                    chunk_id = f"{bvid_fb}:{pi_fb}:{ci_fb}"
                if chunk_id in seen_chunk_ids or len(doc.page_content) < 100:
                    continue
                seen_chunk_ids.add(chunk_id)
                bvid = doc.metadata.get("bvid", "")
                page_idx = doc.metadata.get("page_index", 0)
                # Match back to the page title
                page_title = ""
                for p in pages:
                    if p["bvid"] == bvid and p["page_index"] == page_idx:
                        page_title = p.get("page_title", "")
                        break
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
        llm = self._get_llm(temperature=temperature)
        provider = "openai"
        base_url = settings.openai_base_url or ""
        if "deepseek" in base_url:
            provider = "deepseek"
        elif "anthropic" in base_url:
            provider = "anthropic"
        writer = get_buffered_usage_writer()
        tracker = UsageTrackingCallback(
            uid=uid,
            provider=provider,
            model=settings.llm_model,
            writer=writer,
        )
        llm.callbacks = [tracker]
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
    from app.repository import mongo_quiz_repository as mongo_quiz

    return await mongo_quiz.get_questions(quiz_uuid)


async def get_quiz_questions_full(quiz_uuid: str) -> list[dict]:
    """Get questions with answers from MongoDB (for grading / review)."""
    from app.repository import mongo_quiz_repository as mongo_quiz

    return await mongo_quiz.get_questions_full(quiz_uuid)
