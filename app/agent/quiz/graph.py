from __future__ import annotations

import hashlib
import html
import re
import uuid
from typing import Any, Callable

from loguru import logger
from langchain_openai import ChatOpenAI

from app.agent.quiz.prompts import (
    ESSAY_GRADING_PROMPT,
    ESSAY_GRADING_SYSTEM,
    QUIZ_BATCH_SYSTEM_PROMPT,
    QUIZ_BATCH_USER_PROMPT,
)
from app.agent.quiz.schemas import EssayGradingOutput, QuizBatchOutput
from app.config import settings


MAX_BATCH_COUNT = 20
MAX_BATCH_SIZE = 20
MAX_CHUNK_CHARS = 4000
MAX_CONTEXT_CHARS = 16000
MAX_GRADING_QUESTION_CHARS = 1000
MAX_GRADING_RUBRIC_CHARS = 4000
MAX_GRADING_MODEL_ANSWER_CHARS = 4000
MAX_GRADING_USER_ANSWER_CHARS = 8000
ALLOWED_QUESTION_TYPES = {"single_choice", "multi_choice", "short_answer", "essay"}
ALLOWED_DIFFICULTIES = {"easy", "medium", "hard"}
_DOWNGRADE_MAP = {"essay": "short_answer", "short_answer": "single_choice"}


def get_default_llm(temperature: float = 0.7) -> ChatOpenAI:
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


def _option_label(value: str) -> str:
    match = re.match(r"^\s*([A-Za-z])(?:[.．、\s]+|$)", value)
    return match.group(1).upper() if match else ""


def _strip_option_label(value: str) -> str:
    return re.sub(r"^\s*[A-Za-z](?:[.．、\s]+|$)", "", value).strip()


def _option_maps(options: list[Any]) -> tuple[dict[str, str], set[str]]:
    label_map = {}
    text_set = set()
    for index, option in enumerate(options):
        raw = str(option).strip()
        text = _strip_option_label(raw)
        if not text:
            continue
        text_set.add(text)
        label = _option_label(raw) or chr(ord("A") + index)
        label_map[label] = text
    return label_map, text_set


def _answer_texts(q: dict[str, Any]) -> list[str]:
    option_map, option_texts = _option_maps(q.get("options", []))
    correct = q.get("correct_answer")
    answers = correct if isinstance(correct, list) else [correct]
    texts = []
    seen = set()
    for answer in answers:
        raw = str(answer).strip()
        label = _option_label(raw)
        if label:
            text = option_map.get(label)
            if text is None:
                return []
            stripped = _strip_option_label(raw)
            if raw.upper() != label and stripped != text:
                return []
        else:
            text = _strip_option_label(raw)
            if text not in option_texts:
                return []
        if text in seen:
            return []
        seen.add(text)
        texts.append(text)
    return [text for text in texts if len(text) > 1]


def _trace_tokens(text: str) -> set[str]:
    normalized = text.lower()
    tokens = {token for token in re.findall(r"[a-z0-9_\-]{2,}", normalized)}
    for seq in re.findall(r"[一-鿿]{2,}", normalized):
        tokens.update(seq[i : i + 2] for i in range(len(seq) - 1))
    return tokens


def _is_traced_to_source(terms: list[str], source: str) -> bool:
    """Check whether each answer term has an anchor in the source chunk.

    Each term must independently trace back to source via one of:
      1. Substring containment (≥3 chars, case-insensitive) — tolerates
         rephrased answers that still embed an original phrase.
      2. 2-gram / alphanumeric token overlap — handles short or
         English/numeric terms where substring matching is too coarse.

    Pure-fabricated answers with zero anchor fail. This replaces the old
    "merged token set overlap ≥ 1" rule, which let one term's hit cover
    for unrelated others and still rejected legitimate rephrased answers
    from generation models like qwen3-max.
    """
    if not terms:
        return False
    source_lower = source.lower()
    source_tokens = _trace_tokens(source)
    validated = 0
    for term in terms:
        if len(term) < 2:
            continue
        term_lower = term.lower()
        if len(term_lower) >= 3 and term_lower in source_lower:
            validated += 1
            continue
        if _trace_tokens(term) & source_tokens:
            validated += 1
            continue
        return False
    return validated > 0


def _invalid_question(reason: str, q: dict[str, Any], **extra: Any) -> bool:
    question = str(q.get("question", ""))
    question_hash = hashlib.sha256(question.encode("utf-8")).hexdigest()[:12]
    logger.warning(
        "[QUIZ] invalid question reason={} type={} chunk={} question_len={} question_hash={} extra={}",
        reason,
        q.get("type"),
        q.get("source_chunk_index"),
        len(question),
        question_hash,
        extra,
    )
    return False


def validate_question(q: dict[str, Any], chunks: list[dict[str, Any]]) -> bool:
    if not q.get("question"):
        return _invalid_question("missing_question", q)

    chunk_idx = q.get("source_chunk_index", 0)
    if not isinstance(chunk_idx, int) or not 0 <= chunk_idx < len(chunks):
        return _invalid_question("source_chunk_out_of_range", q)

    qtype = q.get("type", "")
    trace_terms: list[str] = []
    if qtype in ("single_choice", "multi_choice"):
        options = q.get("options", [])
        correct = q.get("correct_answer")
        if len(options) < 4 or not correct:
            return _invalid_question("choice_missing_options_or_answer", q)
        trace_terms = _answer_texts(q)
        if not trace_terms:
            return _invalid_question("choice_answer_not_in_options", q)
        if qtype == "multi_choice":
            correct = q.get("correct_answer", [])
            if not isinstance(correct, list) or not 2 <= len(correct) <= 4:
                return _invalid_question("multi_choice_answer_count_invalid", q)
            if len(trace_terms) != len(correct):
                return _invalid_question(
                    "multi_choice_answer_count_mismatch",
                    q,
                    expected=len(correct),
                    actual=len(trace_terms),
                )
    elif qtype == "short_answer":
        keywords = q.get("keywords", [])
        answer_text = q.get("answer_template", "")
        if len(keywords) < 3 or not answer_text:
            return _invalid_question("short_answer_missing_keywords_or_template", q)
        trace_terms = [str(keyword) for keyword in keywords]
    elif qtype == "essay":
        rubric = q.get("scoring_rubric") or []
        model_answer = q.get("model_answer")
        if not model_answer or not rubric:
            return _invalid_question("essay_missing_model_answer_or_rubric", q)
        trace_terms = [
            str(keyword)
            for item in rubric
            for keyword in (
                item.get("keywords", [])
                if isinstance(item, dict)
                else getattr(item, "keywords", [])
            )
        ]
        # Include the model answer itself so we verify it is grounded in source
        trace_terms.append(str(model_answer))
    else:
        return _invalid_question("unsupported_question_type", q)

    source = chunks[chunk_idx]["content"]
    trace_terms = [term for term in trace_terms if len(term) > 1]
    if qtype == "multi_choice":
        traced = all(_is_traced_to_source([term], source) for term in trace_terms)
    else:
        traced = not trace_terms or _is_traced_to_source(trace_terms, source)
    if not traced:
        # Downgrade: trace failure is no longer a hard reject. Good quiz
        # answers are often conceptual summaries that share no 3-char
        # substring with the source; a lexical check cannot distinguish
        # legitimate rephrasing from fabrication. Mark low_confidence so
        # harness evaluation can flag/filter, and keep the question.
        q["_low_confidence"] = True
        question_str = str(q.get("question", ""))
        question_hash = hashlib.sha256(
            question_str.encode("utf-8")
        ).hexdigest()[:12]
        logger.warning(
            "[QUIZ] low_confidence reason=answer_not_traced_to_source "
            "type={} chunk={} question_len={} question_hash={} "
            "trace_term_count={}",
            qtype,
            q.get("source_chunk_index"),
            len(question_str),
            question_hash,
            len(trace_terms),
        )

    return True


def normalize_question(
    q: dict[str, Any], chunks: list[dict[str, Any]]
) -> dict[str, Any]:
    if q["type"] == "short_answer":
        q = {**q, "correct_answer": q["answer_template"]}
    elif q["type"] == "essay":
        q = {**q, "correct_answer": q["model_answer"]}
    chunk_idx = q["source_chunk_index"]
    return {
        **q,
        "bvid": chunks[chunk_idx].get("bvid", ""),
        "source_segment": chunks[chunk_idx].get("content", "")[:500],
        "question_uuid": str(uuid.uuid4()),
    }


def _format_chunk_context(index: int, chunk: dict[str, Any]) -> str:
    title = html.escape(str(chunk.get("title", "")), quote=False)[:200]
    content = html.escape(str(chunk.get("content", "")), quote=False)[:MAX_CHUNK_CHARS]
    return (
        f'<knowledge_chunk index="{index}">\n'
        f"<title>{title}</title>\n"
        f"<content>{content}</content>\n"
        "</knowledge_chunk>"
    )


async def generate_batch(
    *,
    chunks: list[dict[str, Any]],
    batch_count: int,
    batch_types: list[str],
    difficulty: str,
    uid: int,
    used_chunk_indices: set[int],
    llm: Any | None = None,
    llm_factory: Callable[[float], Any] | None = None,
) -> list[dict[str, Any]]:
    if batch_count <= 0 or batch_count > MAX_BATCH_COUNT:
        logger.warning("[QUIZ] invalid batch_count={}", batch_count)
        return []
    if len(batch_types) > MAX_BATCH_SIZE:
        logger.warning("[QUIZ] invalid batch_types_count={}", len(batch_types))
        return []
    if difficulty not in ALLOWED_DIFFICULTIES:
        logger.warning("[QUIZ] invalid difficulty={}", difficulty)
        return []
    if any(qtype not in ALLOWED_QUESTION_TYPES for qtype in batch_types):
        logger.warning("[QUIZ] invalid batch_types_count={}", len(batch_types))
        return []

    available = [i for i in range(len(chunks)) if i not in used_chunk_indices]
    if not available:
        available = list(range(len(chunks)))
    selected = available[: max(3, batch_count)]

    context_parts = []
    context_chars = 0
    for i in selected:
        chunk_context = _format_chunk_context(i, chunks[i])
        if context_parts and context_chars + len(chunk_context) > MAX_CONTEXT_CHARS:
            break
        context_parts.append(chunk_context)
        context_chars += len(chunk_context)
        used_chunk_indices.add(i)
    context = "\n\n".join(context_parts)

    type_desc = "、".join(f"{batch_types.count(t)}道{t}" for t in set(batch_types))
    prompt = QUIZ_BATCH_USER_PROMPT.format(
        chunk_count=len(selected),
        total_count=batch_count,
        context=context,
        type_distribution=type_desc,
        difficulty=difficulty,
    )

    active_llm = llm or (llm_factory(0.7) if llm_factory else get_default_llm(0.7))

    # Retry once on structured-output / parse failures (transient schema mismatches).
    # Rate-limit and other errors are not retried here — the outer round loop in
    # generate_questions handles broader retry by generating a fresh batch.
    response = None
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            response = await active_llm.with_structured_output(
                QuizBatchOutput,
                method="function_calling",
            ).ainvoke(
                [
                    {"role": "system", "content": QUIZ_BATCH_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ]
            )
            break
        except Exception as e:
            last_exc = e
            err_msg = str(e).lower()
            is_parse_error = any(
                sig in err_msg
                for sig in ("structured_output", "function_call", "parse", "schema", "validation")
            )
            if not is_parse_error or attempt == 1:
                logger.error(f"[QUIZ] LLM structured output failed: {e}")
                return []
            logger.warning(f"[QUIZ] structured output retry attempt=1 err={e}")
            # retry with slightly higher temperature via a fresh LLM if factory provided
            if llm_factory is not None and llm is None:
                try:
                    active_llm = llm_factory(0.8)
                except Exception as factory_err:
                    logger.debug(f"[QUIZ] llm_factory retry temp=0.8 failed: {factory_err}")

    if response is None:
        if last_exc:
            logger.error(f"[QUIZ] structured output gave up: {last_exc}")
        return []

    questions = []
    failed_types: list[str] = []
    for item in response.questions:
        q = item.model_dump()
        if validate_question(q, chunks):
            questions.append(normalize_question(q, chunks))
        else:
            if q.get("type") in _DOWNGRADE_MAP:
                failed_types.append(_DOWNGRADE_MAP[q["type"]])

    # Bounded downgrade: for each failed essay/short_answer, retry once as a
    # lower-rigor type. Caps at 2 extra LLM calls per batch to bound cost.
    for target_type in failed_types[:2]:
        if len(questions) >= batch_count:
            break
        downgrade = await generate_batch(
            chunks=chunks,
            batch_count=1,
            batch_types=[target_type],
            difficulty=difficulty,
            uid=uid,
            used_chunk_indices=set(),
            llm_factory=llm_factory,
        )
        if downgrade:
            questions.append(downgrade[0])
            logger.info(
                f"[QUIZ] downgrade retry succeeded type={target_type}"
            )

    logger.info(f"[QUIZ] batch generated {len(questions)}/{batch_count} questions")
    return questions


async def generate_questions(
    *,
    chunks: list[dict[str, Any]],
    total_count: int,
    type_distribution: dict[str, int],
    difficulty: str,
    uid: int,
    batch_size: int = 5,
    llm_factory: Callable[[float], Any] | None = None,
) -> list[dict[str, Any]]:
    type_list = []
    for qtype, count in type_distribution.items():
        type_list.extend([qtype] * count)

    all_questions: list[dict[str, Any]] = []
    used_chunk_indices: set[int] = set()
    max_rounds = (total_count // batch_size) + 3
    seen_questions: set[str] = set()

    for round_idx in range(max_rounds):
        remaining = total_count - len(all_questions)
        if remaining <= 0:
            break

        batch_count = min(batch_size, remaining)
        batch_types = type_list[len(all_questions) : len(all_questions) + batch_count]
        batch = await generate_batch(
            chunks=chunks,
            batch_count=batch_count,
            batch_types=batch_types,
            difficulty=difficulty,
            uid=uid,
            used_chunk_indices=used_chunk_indices,
            llm_factory=llm_factory,
        )

        for q in batch:
            q_text = q.get("question", "").strip()
            if q_text in seen_questions:
                continue
            if not validate_question(q, chunks):
                continue
            seen_questions.add(q_text)
            all_questions.append(q)
            if len(all_questions) >= total_count:
                break

        logger.info(
            f"[QUIZ] round {round_idx + 1}: {len(all_questions)}/{total_count} "
            f"valid questions so far"
        )

    result = all_questions[:total_count]
    logger.info(f"[QUIZ] final: {len(result)} questions (requested {total_count})")
    return result


async def grade_essay(
    *,
    question_text: str,
    user_answer: str,
    scoring_rubric: list[dict[str, Any]],
    model_answer: str | None,
    uid: int | None = None,
    llm: Any | None = None,
    llm_factory: Callable[[float], Any] | None = None,
) -> dict[str, Any]:
    total_max = sum(r.get("points", 0) for r in scoring_rubric)
    rubric_text = "\n".join(
        f"- {r.get('step', '步骤')}（{r.get('points', 0)}分）：关键词 {', '.join(r.get('keywords', []))}"
        for r in scoring_rubric
    )

    prompt = ESSAY_GRADING_PROMPT.format(
        question_text=html.escape(
            question_text[:MAX_GRADING_QUESTION_CHARS], quote=False
        ),
        scoring_rubric=html.escape(rubric_text[:MAX_GRADING_RUBRIC_CHARS], quote=False),
        model_answer=html.escape(
            (model_answer or "暂无参考答案")[:MAX_GRADING_MODEL_ANSWER_CHARS],
            quote=False,
        ),
        user_answer=html.escape(
            user_answer[:MAX_GRADING_USER_ANSWER_CHARS], quote=False
        ),
    )

    # llm_factory may accept uid to wire up usage tracking; fall back to plain call
    if llm is None and llm_factory is not None:
        try:
            active_llm = llm_factory(0.1, uid=uid) if uid is not None else llm_factory(0.1)
        except TypeError:
            active_llm = llm_factory(0.1)
    else:
        active_llm = llm or get_default_llm(0.1)
    data = await active_llm.with_structured_output(
        EssayGradingOutput,
        method="function_calling",
    ).ainvoke(
        [
            {"role": "system", "content": ESSAY_GRADING_SYSTEM},
            {"role": "user", "content": prompt},
        ]
    )

    auto_score = max(0, min(data.total_score, total_max))
    return {
        "auto_score": auto_score,
        "max_score": total_max,
        "grading_detail": {
            "type": "llm_essay_grading",
            "step_scores": [s.model_dump() for s in data.step_scores],
            "feedback": data.overall_feedback,
            "strengths": data.strengths,
            "weaknesses": data.weaknesses,
        },
        "grading_note": "AI辅助评分，可人工修改",
    }


class QuizAgent:
    def __init__(
        self,
        *,
        llm: Any | None = None,
        llm_factory: Callable[[float], Any] | None = None,
    ) -> None:
        self.llm = llm
        self.llm_factory = llm_factory

    async def ainvoke(
        self,
        input: dict[str, Any],
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        operation = input.get("operation")
        if operation == "generate_batch":
            questions = await generate_batch(
                chunks=input["chunks"],
                batch_count=input["batch_count"],
                batch_types=input["batch_types"],
                difficulty=input["difficulty"],
                uid=input["uid"],
                used_chunk_indices=set(input.get("used_chunk_indices", [])),
                llm=self.llm,
                llm_factory=self.llm_factory,
            )
            return {"questions": questions}
        if operation == "grade_essay":
            result = await grade_essay(
                question_text=input["question_text"],
                user_answer=input["user_answer"],
                scoring_rubric=input["scoring_rubric"],
                model_answer=input.get("model_answer"),
                uid=input.get("uid"),
                llm=self.llm,
                llm_factory=self.llm_factory,
            )
            return {"result": result}
        return {"error": f"unknown quiz operation: {operation}"}


def build_quiz_agent(
    *,
    llm: Any | None = None,
    llm_factory: Callable[[float], Any] | None = None,
    circuit_breaker: Any | None = None,
) -> QuizAgent:
    return QuizAgent(llm=llm, llm_factory=llm_factory)


def create_quiz_agent(**kwargs: Any) -> QuizAgent:
    return build_quiz_agent(**kwargs)
