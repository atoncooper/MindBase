"""定时出题 - 答题提交 + 判题（业务逻辑归主 app）。

架构定位（CLAUDE.md §2.7）：app-task 是调度执行器，负责到点触发生成、
轮询状态、发通知、超时检测；答题判题属于业务逻辑，在本模块。

存储解耦（独立 MySQL）：app-task 拥有自己的数据库，主 app 不再直写
共享的 task_quiz_task / task_quiz_answer。本模块判题后，把结果经 APISIX
POST 到 app-task 的 /internal/answer（key-auth），由 app-task 落库并流转
sent -> completed（归属校验与幂等也在 app-task 侧）。

判题规则：
- choice（选择题）：兼容 LLM 两种存法——answer 为完整选项文本（"B. 收敛"）
  或仅字母（"B"），而前端提交的是用户所点选项的完整文本。统一把正确答案
  和用户答案解析为选项字母后比较，避免"答对却被判错"。
- fill_blank（填空）：去除首尾空白后精确比较。
- short_answer（简答）：不区分大小写，包含匹配。
"""

from __future__ import annotations

import os

from app.infra.mongo import coll
from app.services.quiz_task_service import (
    get_quiz_task_by_uid,
    save_answers,
)

TASK_QUIZ_QUESTIONS = "task_quiz_questions"

_APPTASK_BASE = os.environ.get("APPTASK_BASE_URL", "http://apisix:9080").rstrip("/")
_APPTASK_KEY = os.environ.get("APISIX_CONSUMER_KEY", "")


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
    """用户答题：判题（主 app）-> 结果经 APISIX 提交 app-task 落库 + 状态流转。

    存储解耦：app-task 拥有独立 MySQL，本模块不再直写共享的 task_quiz_task /
    task_quiz_answer。归属校验与幂等由 app-task 的 /internal/answer 处理
    （主 app 重复提交时返回既有结果）。

    answers: [{"question_index": 0, "answer": "..."}, ...]
    返回 {"status": ..., "results": [{"question_index", "answer", "is_correct"}],
          "is_correct": 全部正确}，与前端 task-quiz-api 契约一致。
    """
    # 1. 取题目（主 app 自己的 Mongo 权威数据）并逐题判题
    quiz_doc = await coll(TASK_QUIZ_QUESTIONS).find_one({"task_id": task_id})
    questions = _quiz_questions(quiz_doc)

    results: list[dict] = []
    for item in answers:
        idx = int(item.get("question_index", 0))
        ans = (item.get("answer") or "").strip()
        q = questions[idx] if 0 <= idx < len(questions) else None
        is_correct = judge_task_quiz_answer(q, ans)
        results.append(
            {"question_index": idx, "answer": ans, "is_correct": is_correct}
        )

    # 2. 归属校验（业务行）
    task = await get_quiz_task_by_uid(task_id, uid)
    if task is None:
        raise TaskQuizNotFound()

    # 3. 判题结果存业务库（主 app executor 侧）
    await save_answers(task_id, uid, results)
    return {
        "status": "completed",
        "is_correct": all(r["is_correct"] for r in results),
        "results": results,
    }
