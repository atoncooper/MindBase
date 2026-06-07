"""
Quiz 题目生成服务 — 批量生成练习题。

从 ChromaDB 检索知识片段，通过 LLM 批量生成题目，复用现有凭证管理体系。
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from loguru import logger
from sqlalchemy import select
from langchain_openai import ChatOpenAI

from app.config import settings
from app.database import get_db_context
from app.models import QuizSet, Collection
from app.services.rag import RAGService
from app.services.llm.buffered_usage_writer import get_buffered_usage_writer
from app.services.llm.usage_tracker import UsageTrackingCallback


QUIZ_BATCH_SYSTEM_PROMPT = """你是一个专业的习题出题专家。你的任务是基于给定的知识库片段，一次生成全部题目。

重要约束：
1. 所有答案必须能从原文找到依据，绝不编造
2. 同一知识点的内容不重复出题
3. 题干要转述，避免直接照抄原文
4. 选择题选项要有区分度，干扰项需看似合理但明显错误

题型规范：
- single_choice: 4个选项，1个正确
- multi_choice: 4~6个选项，2~4个正确（题干中需注明"多选"）
- short_answer: 答案30-100字，附3-5个关键词，允许多种表述
- essay: 综合性问题，附分步骤评分标准"""

QUIZ_BATCH_USER_PROMPT = """基于以下 {chunk_count} 个知识片段，生成 {total_count} 道题。

知识片段：
---
{context}
---

题型分布：{type_distribution}
难度：{difficulty}

请严格按JSON格式输出（不要包含markdown代码块之外的内容）：
```json
{{
  "questions": [
    {{
      "type": "single_choice",
      "difficulty": "medium",
      "source_chunk_index": 0,
      "question": "题目文本",
      "options": ["A. 选项1", "B. 选项2", "C. 选项3", "D. 选项4"],
      "correct_answer": "A",
      "explanation": "解析文本"
    }},
    {{
      "type": "short_answer",
      "difficulty": "medium",
      "source_chunk_index": 0,
      "question": "题目文本",
      "keywords": ["关键词1", "关键词2", "关键词3"],
      "answer_template": "标准答案",
      "explanation": "解析文本"
    }}
  ]
}}
```

source_chunk_index 表示题目来源于第几个知识片段。
请确保所有题目的答案都能在对应片段中找到依据。"""


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
                title=title or f"练习 {datetime.now(timezone.utc).strftime('%m-%d %H:%M')}",
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
                chunks = await self._retrieve_chunks_by_pages(pages, question_count)
            else:
                bvids = await self._get_bvids_by_folder_ids(folder_ids)
                chunks = await self._retrieve_chunks(bvids, question_count)
            min_chunks = max(1, question_count // 5) if is_pages_mode else max(1, question_count // 3)
            if len(chunks) < min_chunks:
                raise ValueError(f"可用知识片段不足: {len(chunks)} < {min_chunks}")

            # 2. Batch generate via LLM
            questions = await self._batch_generate(chunks, question_count, type_distribution, difficulty, uid)

            # 3. Quality validation
            valid_questions = [q for q in questions if self._validate_question(q, chunks)]

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
            logger.info(f"[QUIZ] generated quiz_uuid={quiz_uuid} questions={len(valid_questions)} tokens~{est_tokens}")

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
                    chunks.append({
                        "bvid": doc_bvid,
                        "title": doc.metadata.get("title", ""),
                        "content": doc.page_content[:3000],
                        "chunk_index": doc.metadata.get("chunk_index"),
                    })
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
            {"bvid": p["bvid"], "page_index": p["page_index"]}
            for p in pages
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
                chunks.append({
                    "bvid": bvid,
                    "title": doc.metadata.get("title", ""),
                    "page_index": page_idx,
                    "page_title": page_title or doc.metadata.get("page_title", ""),
                    "content": doc.page_content[:3000],
                    "chunk_index": doc.metadata.get("chunk_index"),
                })
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
        """Generate a single batch of questions with JSON mode enforcement.

        Returns exactly batch_count questions (or fewer if LLM fails to comply).
        """
        # Pick unused chunks for diversity
        available = [i for i in range(len(chunks)) if i not in used_chunk_indices]
        if not available:
            available = list(range(len(chunks)))  # fallback: reuse all
        selected = available[:max(3, batch_count)]

        context_parts = []
        for i in selected:
            c = chunks[i]
            context_parts.append(f"【片段{i}】来源: {c['title']}\n{c['content']}")
            used_chunk_indices.add(i)
        context = "\n\n---\n\n".join(context_parts)

        type_desc = "、".join(
            f"{batch_types.count(t)}道{t}" for t in set(batch_types)
        )

        prompt = QUIZ_BATCH_USER_PROMPT.format(
            chunk_count=len(selected),
            total_count=batch_count,
            context=context,
            type_distribution=type_desc,
            difficulty=difficulty,
        )

        llm = self._get_llm(temperature=0.7)
        # JSON mode: enforce structured output
        llm.model_kwargs = {"response_format": {"type": "json_object"}}

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

        try:
            response = await llm.ainvoke([
                {"role": "system", "content": QUIZ_BATCH_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ])
        except Exception as e:
            logger.error(f"[QUIZ] LLM call failed: {e}")
            return []

        text = response.content.strip()
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0]
        elif "```" in text:
            text = text.split("```")[1].split("```")[0]

        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            logger.error(f"[QUIZ] failed to parse JSON: {text[:200]}")
            return []

        questions = data.get("questions", [])
        for q in questions:
            chunk_idx = q.get("source_chunk_index", 0)
            if chunk_idx < len(chunks):
                q["bvid"] = chunks[chunk_idx].get("bvid", "")
                q["source_segment"] = chunks[chunk_idx].get("content", "")[:500]
            q["question_uuid"] = str(uuid.uuid4())

        logger.info(f"[QUIZ] batch generated {len(questions)}/{batch_count} questions")
        return questions

    async def _batch_generate(
        self,
        chunks: list[dict],
        total_count: int,
        type_distribution: dict,
        difficulty: str,
        uid: int,
    ) -> list[dict]:
        """Generate questions in batches until target count is reached.

        Uses JSON mode + iterative generation to enforce exact question count.
        """
        # Build ordered type list for round-robin distribution
        type_list = []
        for qtype, count in type_distribution.items():
            type_list.extend([qtype] * count)

        all_questions: list[dict] = []
        used_chunk_indices: set[int] = set()
        max_rounds = (total_count // self.BATCH_SIZE) + 3
        seen_questions: set[str] = set()  # dedup by question text

        for round_idx in range(max_rounds):
            remaining = total_count - len(all_questions)
            if remaining <= 0:
                break

            batch_count = min(self.BATCH_SIZE, remaining)
            batch_types = type_list[len(all_questions):len(all_questions) + batch_count]

            batch = await self._generate_batch(
                chunks, batch_count, batch_types, difficulty, uid, used_chunk_indices
            )

            for q in batch:
                # Dedup by question text
                q_text = q.get("question", "").strip()
                if q_text in seen_questions:
                    continue
                # Validate
                if not self._validate_question(q, chunks):
                    continue
                seen_questions.add(q_text)
                all_questions.append(q)
                if len(all_questions) >= total_count:
                    break

            logger.info(
                f"[QUIZ] round {round_idx + 1}: {len(all_questions)}/{total_count} "
                f"valid questions so far"
            )

        # Trim to exact count
        result = all_questions[:total_count]
        logger.info(f"[QUIZ] final: {len(result)} questions (requested {total_count})")
        return result

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

    def _validate_question(self, q: dict, chunks: list[dict]) -> bool:
        """校验单道题目的质量"""
        # 1. 基本字段检查
        if not q.get("question") or not q.get("correct_answer"):
            return False

        # 2. 答案溯源
        chunk_idx = q.get("source_chunk_index", 0)
        if chunk_idx < len(chunks):
            source = chunks[chunk_idx]["content"].lower()
            answer = q.get("correct_answer", "")
            if isinstance(answer, list):
                answer_text = " ".join(str(a) for a in answer)
            else:
                answer_text = str(answer)

            if len(answer_text) > 2 and answer_text.lower() not in source:
                core_words = [w for w in answer_text.lower().split() if len(w) > 1]
                if core_words and not any(w in source for w in core_words):
                    logger.warning(f"[QUIZ] answer not traced to source: {answer_text[:50]}")
                    return False

        # 3. 选择题选项检查
        qtype = q.get("type", "")
        if qtype in ("single_choice", "multi_choice"):
            options = q.get("options", [])
            if len(options) < 4:
                return False
        if qtype == "multi_choice":
            correct = q.get("correct_answer", [])
            if isinstance(correct, list) and len(correct) < 2:
                return False

        # 4. 简答题关键词检查
        if qtype == "short_answer":
            keywords = q.get("keywords", [])
            if not keywords:
                return False

        return True

    # _save_questions removed — questions stored in MongoDB via mongo_quiz_repository


async def get_quiz_set(quiz_uuid: str) -> Optional[QuizSet]:
    """Get quiz set metadata from MySQL."""
    async with get_db_context() as db:
        result = await db.execute(
            select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid)
        )
        return result.scalar_one_or_none()


async def get_quiz_questions(quiz_uuid: str) -> list[dict]:
    """Get questions without answers from MongoDB (for quiz display)."""
    from app.repository import mongo_quiz_repository as mongo_quiz
    return await mongo_quiz.get_questions(quiz_uuid)


async def get_quiz_questions_full(quiz_uuid: str) -> list[dict]:
    """Get questions with answers from MongoDB (for grading / review)."""
    from app.repository import mongo_quiz_repository as mongo_quiz
    return await mongo_quiz.get_questions_full(quiz_uuid)
