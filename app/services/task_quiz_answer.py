"""定时出题 - 答题提交 + 判题（业务逻辑归主 app）。

架构定位（CLAUDE.md §2.7）：app-task 是纯调度执行器，负责到点触发生成、
轮询状态、发通知、超时检测；答题判题/入库/状态流转属于业务逻辑，必须在
主 app。本模块被 app/routers/task_answer.py 调用。

判题规则：
- choice（选择题）：兼容 LLM 两种存法——answer 为完整选项文本（"B. 收敛"）
  或仅字母（"B"），而前端提交的是用户所点选项的完整文本。统一把正确答案
  和用户答案解析为选项字母后比较，避免"答对却被判错"。
- fill_blank（填空）：去除首尾空白后精确比较。
- short_answer（简答）：不区分大小写，包含匹配。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import text

from app.database import get_db_context
from app.infra.mongo import coll

TASK_QUIZ_QUESTIONS = "task_quiz_questions"


class TaskQuizNotFound(Exception):
    """任务不存在。"""


class TaskQuizForbidden(Exception):
    """不是任务所有者。"""


def judge_task_quiz_answer(quiz: dict | None, user_answer: str) -> bool:
    """判定单题答案是否正确。quiz 是 questions 数组中的某一题。"""
    if not quiz:
        return False
    correct = (quiz.get("answer") or "").strip()
    given = (user_answer or "").strip()
    if not correct:
        return False
    if quiz.get("question_type") == "short_answer":
        return correct.lower() in given.lower()
    options = quiz.get("options") or []
    if options:
        c_letter = _choice_letter(options, correct)
        g_letter = _choice_letter(options, given)
        if c_letter and g_letter:
            return c_letter == g_letter
    # 无 options（填空等）或解析失败：回退精确比较
    return correct == given


def _choice_letter(options: list, answer: str) -> str:
    """把答案解析成选项字母 A/B/C/...；解析不了返回空串。

    兼容三种形态：裸字母（"B"）、完整选项文本（"B. 收敛"）、去掉字母前缀的
    文本（"收敛"）。裸字母比较区分大小写（与历史精确比较语义一致）。
    """
    a = answer.strip()
    if not a:
        return ""
    if len(a) == 1 and "A" <= a <= "Z":
        return a
    for i, opt in enumerate(options):
        t = (opt or "").strip()
        if t == a:
            return chr(ord("A") + i)
        if _strip_option_label(t) == a:
            return chr(ord("A") + i)
    return ""


def _strip_option_label(s: str) -> str:
    """去掉选项开头的字母标签（"A. "、"B、"、"C) "、"D "），无标签则原样返回。"""
    t = s.strip()
    if not t:
        return s
    first = t[0]
    is_letter = ("A" <= first <= "Z") or ("a" <= first <= "z")
    if not is_letter:
        return s
    for sep in (".", "、", ")", "）", ":", "：", " ", "\t"):
        if t[1:].startswith(sep):
            return t[1 + len(sep):].strip()
    return s


def _quiz_questions(quiz_doc: dict | None) -> list:
    """把题库文档归一化为题目列表（新文档 questions 数组；兼容旧单题平铺）。"""
    if not quiz_doc:
        return []
    qs = quiz_doc.get("questions")
    if isinstance(qs, list) and qs:
        return qs
    single = {
        "question": quiz_doc.get("question"),
        "question_type": quiz_doc.get("question_type"),
        "options": quiz_doc.get("options"),
        "answer": quiz_doc.get("answer"),
        "difficulty": quiz_doc.get("difficulty"),
        "answer_time_limit_seconds": quiz_doc.get("answer_time_limit_seconds"),
    }
    return [single] if single.get("question") else []


async def submit_task_quiz_answer(
    task_id: str, uid: int, answers: list[dict]
) -> dict:
    """用户答题：归属校验 -> 幂等 -> 逐题判题 -> 入库 -> 状态流转。

    answers: [{"question_index": 0, "answer": "..."}, ...]
    返回 {"status": ..., "results": [{"question_index", "answer", "is_correct"}],
          "is_correct": 全部正确}，与前端 task-quiz-api 契约一致。
    """
    async with get_db_context() as db:
        # 1. 任务存在性 + 归属（X-Uid 由 APISIX forward-auth 注入）
        row = (
            await db.execute(
                text(
                    "SELECT task_id, uid, status FROM task_quiz_task "
                    "WHERE task_id = :tid"
                ),
                {"tid": task_id},
            )
        ).mappings().first()
        if row is None:
            raise TaskQuizNotFound()
        if int(row["uid"]) != uid:
            raise TaskQuizForbidden()

        # 2. 幂等：已答过直接返回既有结果（按题号）
        existing = (
            await db.execute(
                text(
                    "SELECT question_index, answer, is_correct "
                    "FROM task_quiz_answer WHERE task_id = :tid "
                    "ORDER BY question_index"
                ),
                {"tid": task_id},
            )
        ).mappings().all()
        if existing:
            return {
                "status": row["status"],
                "is_correct": all(bool(e["is_correct"]) for e in existing),
                "results": [
                    {
                        "question_index": int(e["question_index"]),
                        "answer": e["answer"],
                        "is_correct": bool(e["is_correct"]),
                    }
                    for e in existing
                ],
            }

        # 3. 取题目（主 app 的 Mongo 权威数据）并逐题判题
        quiz_doc = await coll(TASK_QUIZ_QUESTIONS).find_one({"task_id": task_id})
        questions = _quiz_questions(quiz_doc)
        now = datetime.now(timezone.utc)

        results: list[dict] = []
        for item in answers:
            idx = int(item.get("question_index", 0))
            ans = (item.get("answer") or "").strip()
            q = questions[idx] if 0 <= idx < len(questions) else None
            is_correct = judge_task_quiz_answer(q, ans)
            results.append(
                {"question_index": idx, "answer": ans, "is_correct": is_correct}
            )

        # 4. 写答案记录（每题一行）
        for r in results:
            await db.execute(
                text(
                    "INSERT INTO task_quiz_answer "
                    "(task_id, uid, question_index, answer, is_correct, submitted_at) "
                    "VALUES (:tid, :uid, :qidx, :ans, :correct, :ts)"
                ),
                {
                    "tid": task_id,
                    "uid": uid,
                    "qidx": r["question_index"],
                    "ans": r["answer"],
                    "correct": r["is_correct"],
                    "ts": now,
                },
            )

        # 5. 状态流转 sent -> completed（条件更新防与超时检测竞态）
        updated = (
            await db.execute(
                text(
                    "UPDATE task_quiz_task SET status = 'completed', updated_at = :ts "
                    "WHERE task_id = :tid AND status = 'sent'"
                ),
                {"tid": task_id, "ts": now},
            )
        ).rowcount

        await db.commit()

        status = "completed" if updated else row["status"]
        return {
            "status": status,
            "is_correct": all(r["is_correct"] for r in results),
            "results": results,
        }
