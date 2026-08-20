"""quiz_task / quiz_task_answer 持久化（定时出题业务行）。

数据访问层：本模块拥有对 quiz_task / quiz_task_answer 两表的全部 SQL。
业务编排（邮件模板/投递、回调 app-task、超时扫描）在
app/services/quiz_task_service.py，routers 不直接触达本模块。
"""

import json
from datetime import datetime, timezone

from sqlalchemy import text

from app.database import get_db_context


async def create_quiz_task(
    task_id: str,
    uid: int,
    prompt: str,
    difficulty: str,
    question_count: int,
    user_email: str,
    cc_emails: list,
    incomplete_message: str | None,
) -> None:
    """插入出题业务行（status=generating）。入参已由 service 归一化。"""
    async with get_db_context() as db:
        await db.execute(
            text(
                "INSERT INTO quiz_task (task_id, uid, prompt, difficulty, question_count, user_email, cc_emails, incomplete_message, status, overdue_emailed, created_at, updated_at) "
                "VALUES (:task_id, :uid, :prompt, :difficulty, :qcount, :email, :cc, :incomplete, 'generating', 0, :now, :now)"
            ),
            {
                "task_id": task_id,
                "uid": uid,
                "prompt": prompt,
                "difficulty": difficulty or "medium",
                "qcount": max(1, min(question_count, 5)),
                "email": user_email,
                # cc_emails 是 JSON 列：绑定参数必须是 json.dumps 后的字符串。
                # 直接传 Python list 会被 aiomysql 当参数序列展开，SQL 语法错误 1064。
                "cc": json.dumps(cc_emails or []),
                "incomplete": incomplete_message or None,
                "now": datetime.now(timezone.utc),
            },
        )
        await db.commit()


async def get_quiz_task(task_id: str) -> dict | None:
    async with get_db_context() as db:
        row = (
            await db.execute(
                text("SELECT * FROM quiz_task WHERE task_id = :task_id"),
                {"task_id": task_id},
            )
        ).mappings().first()
        return dict(row) if row else None


async def get_quiz_task_by_uid(task_ref: str, uid: int) -> dict | None:
    async with get_db_context() as db:
        row = (
            await db.execute(
                text("SELECT * FROM quiz_task WHERE task_id = :t AND uid = :uid"),
                {"t": task_ref, "uid": uid},
            )
        ).mappings().first()
        return dict(row) if row else None


async def mark_generated(task_id: str, deadline: datetime, question_count: int) -> None:
    """出题完成 → awaiting_answer + 设定 deadline（幂等：仅 generating 生效）。"""
    async with get_db_context() as db:
        await db.execute(
            text(
                "UPDATE quiz_task SET status = 'awaiting_answer', deadline = :dl, question_count = :qc, updated_at = :now "
                "WHERE task_id = :task_id AND status = 'generating'"
            ),
            {
                "task_id": task_id,
                "dl": deadline,
                "qc": question_count,
                "now": datetime.now(timezone.utc),
            },
        )
        await db.commit()


async def get_answers(task_id: str) -> list[dict]:
    """按题号返回答题记录。"""
    async with get_db_context() as db:
        rows = (
            await db.execute(
                text(
                    "SELECT question_index, answer, is_correct, submitted_at "
                    "FROM quiz_task_answer WHERE task_id = :task_id ORDER BY question_index"
                ),
                {"task_id": task_id},
            )
        ).mappings().all()
        return [dict(r) for r in rows]


async def save_answers(task_id: str, uid: int, results: list[dict]) -> None:
    """判题结果入库 + 业务状态 → completed（幂等：仅 awaiting_answer/generating）。"""
    now = datetime.now(timezone.utc)
    async with get_db_context() as db:
        for r in results:
            await db.execute(
                text(
                    "INSERT INTO quiz_task_answer (task_id, uid, question_index, answer, is_correct, submitted_at) "
                    "VALUES (:task_id, :uid, :qidx, :ans, :correct, :ts)"
                ),
                {
                    "task_id": task_id,
                    "uid": uid,
                    "qidx": r["question_index"],
                    "ans": r["answer"],
                    "correct": r["is_correct"],
                    "ts": now,
                },
            )
        await db.execute(
            text(
                "UPDATE quiz_task SET status = 'completed', updated_at = :ts "
                "WHERE task_id = :task_id AND status IN ('awaiting_answer','generating')"
            ),
            {"task_id": task_id, "ts": now},
        )
        await db.commit()


async def list_overdue_tasks(limit: int = 50) -> list:
    """扫描 deadline 到期未答且未发语录的任务（overdue_emailed=0）。"""
    now = datetime.now(timezone.utc)
    async with get_db_context() as db:
        rows = (
            await db.execute(
                text(
                    "SELECT * FROM quiz_task "
                    "WHERE status = 'awaiting_answer' AND deadline IS NOT NULL "
                    "AND deadline <= :now AND overdue_emailed = 0 LIMIT :limit"
                ),
                {"now": now, "limit": limit},
            )
        ).mappings().all()
        return list(rows)


async def mark_overdue_emailed(task_id: str) -> None:
    """转 overdue 并标记语录已发（幂等：仅 overdue_emailed=0 生效）。"""
    async with get_db_context() as db:
        await db.execute(
            text(
                "UPDATE quiz_task SET status = 'overdue', overdue_emailed = 1, updated_at = :now "
                "WHERE task_id = :task_id AND overdue_emailed = 0"
            ),
            {"task_id": task_id, "now": datetime.now(timezone.utc)},
        )
        await db.commit()
