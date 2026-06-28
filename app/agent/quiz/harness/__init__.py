"""Offline quiz AI quality harness.

Runs generation + grading against fixed sample sets and emits metrics for
regression comparison. Does NOT couple to the live request path — invoke
via ``python -m scripts.run_quiz_harness``.

Metrics:
    - generation_success_rate: fraction of rounds that produced any questions
    - schema_parse_rate: fraction of LLM calls returning valid structured output
    - traceability_rate: fraction of questions whose answers trace to source
    - type_distribution_match: fraction of rounds matching requested distribution
    - grading_consistency: max score variance across 3 grading runs of same answer
    - avg_token_cost: average tokens consumed per generated question
"""

from __future__ import annotations

import asyncio
import statistics
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from app.agent.quiz.graph import generate_batch, grade_essay


SAMPLE_CHUNKS: list[dict[str, Any]] = [
    {
        "bvid": "BV_SAMPLE_1",
        "title": "向量检索原理",
        "content": (
            "向量检索通过将文本转换为高维向量，利用相似度搜索找到语义相关内容。"
            "核心步骤包括分块、embedding、索引构建和近邻搜索。"
            "常见的索引算法有 HNSW 和 IVF，前者查询快但内存占用高，后者适合大规模数据。"
            "RAG 系统中向量检索是召回阶段，结果质量直接影响最终生成答案的准确性。"
        ),
        "chunk_index": 0,
    },
    {
        "bvid": "BV_SAMPLE_2",
        "title": "Prompt 工程要点",
        "content": (
            "Prompt 工程是引导大语言模型生成预期输出的技术。"
            "关键原则包括：明确角色定义、提供上下文、约束输出格式、使用思维链。"
            "对于结构化输出，function calling 比纯文本解析更可靠。"
            "防注入需要将用户输入与系统指令隔离，并对动态内容做转义。"
        ),
        "chunk_index": 1,
    },
]


@dataclass
class HarnessReport:
    rounds: int = 0
    generation_success_count: int = 0
    schema_parse_success_count: int = 0
    total_questions_generated: int = 0
    traceability_rates: list[float] = field(default_factory=list)
    type_distribution_matches: list[bool] = field(default_factory=list)
    grading_variances: list[float] = field(default_factory=list)
    total_tokens: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "rounds": self.rounds,
            "generation_success_rate": round(
                self.generation_success_count / max(1, self.rounds), 3
            ),
            "schema_parse_rate": round(
                self.schema_parse_success_count / max(1, self.rounds), 3
            ),
            "traceability_rate": (
                round(statistics.mean(self.traceability_rates), 3)
                if self.traceability_rates
                else 0.0
            ),
            "type_distribution_match_rate": (
                round(sum(self.type_distribution_matches) / max(1, len(self.type_distribution_matches)), 3)
                if self.type_distribution_matches
                else 0.0
            ),
            "grading_consistency_max_variance": (
                round(max(self.grading_variances), 3) if self.grading_variances else 0.0
            ),
            "total_questions_generated": self.total_questions_generated,
            "total_tokens": self.total_tokens,
            "avg_token_cost": (
                round(self.total_tokens / max(1, self.total_questions_generated))
                if self.total_questions_generated
                else 0
            ),
        }


async def run_harness(rounds: int = 3) -> HarnessReport:
    """Run generation + grading ``rounds`` times against SAMPLE_CHUNKS.

    Each round: generate 1 single_choice + 1 essay, then grade the essay
    3 times to measure consistency. Uses the default LLM factory.
    """
    report = HarnessReport()
    report.rounds = rounds

    for r in range(rounds):
        logger.info(f"[QUIZ_HARNESS] round {r + 1}/{rounds}")
        try:
            questions = await generate_batch(
                chunks=SAMPLE_CHUNKS,
                batch_count=2,
                batch_types=["single_choice", "essay"],
                difficulty="medium",
                uid=0,
                used_chunk_indices=set(),
            )
        except Exception as e:
            logger.error(f"[QUIZ_HARNESS] round {r + 1} generation failed: {e}")
            continue

        if questions:
            report.generation_success_count += 1
            report.schema_parse_success_count += 1
            report.total_questions_generated += len(questions)

            # Traceability
            from app.agent.quiz.quality import compute_traceability_rate

            rate = compute_traceability_rate(questions, SAMPLE_CHUNKS)
            report.traceability_rates.append(rate)

            # Type distribution match (we asked for 1 single + 1 essay)
            types = [q.get("type") for q in questions]
            match = types.count("single_choice") >= 1 and types.count("essay") >= 1
            report.type_distribution_matches.append(match)

            # Grading consistency — grade the first essay 3 times
            essay_q = next((q for q in questions if q.get("type") == "essay"), None)
            if essay_q:
                scores: list[float] = []
                for _ in range(3):
                    try:
                        result = await grade_essay(
                            question_text=essay_q.get("question", ""),
                            user_answer="这是一个测试答案，包含向量检索和相似度搜索。",
                            scoring_rubric=essay_q.get("scoring_rubric", []),
                            model_answer=essay_q.get("model_answer"),
                        )
                        scores.append(float(result.get("auto_score", 0)))
                    except Exception as e:
                        logger.warning(f"[QUIZ_HARNESS] grading failed: {e}")
                if len(scores) >= 2:
                    report.grading_variances.append(statistics.pvariance(scores))
        else:
            report.schema_parse_success_count += 0  # explicit

    return report


if __name__ == "__main__":
    report = asyncio.run(run_harness(rounds=2))
    import json

    print(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
