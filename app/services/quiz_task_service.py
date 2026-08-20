"""定时出题业务（主 app 作为 executor 的业务侧）。

app-task 负责调度(到点触发出题 task);主 app 管理业务生命周期:生成题目 →
发题目邮件 → 等用户答题 → 判题 → 完成;超时发未完成语录。
邮件经 app-task 的投递服务发送(/internal/email/send 回调)。
"""

from __future__ import annotations

import html
import json
import os
from datetime import datetime

import httpx
from loguru import logger

from app.repository import quiz_task_repository

_APPTASK_BASE = os.environ.get("APPTASK_BASE_URL", "http://apisix:9080").rstrip("/")
_APPTASK_KEY = os.environ.get("APISIX_CONSUMER_KEY", "")

_EMAIL_SEND_PATH = "/internal/email/send"

DEFAULT_INCOMPLETE = "您有一项定时出题任务未在规定时间内完成，请再接再厉。"


# ── 邮件模板（从 app-task 迁移；业务内容由主 app 渲染） ─────────────

def render_quiz_email(prompt: str, questions: list, deadline_str: str) -> tuple[str, str]:
    """返回 (subject, html_body)。≤2 题内联展示题目;>2 题只提示数量。"""
    subject = "【MindBase】您的定时出题任务"
    qs = questions or []
    show_detail = len(qs) <= 2
    rows = []
    for i, q in enumerate(qs, 1):
        qtext = html.escape(str(q.get("question", "")))
        opts = q.get("options") or []
        opts_html = "".join(
            f"<li style='margin:2px 0;'>{html.escape(str(o))}</li>" for o in opts
        )
        # 选项列表整段先拼好再插值（f-string 表达式内不能有反斜杠转义，3.10 兼容）
        list_html = (
            f"<ul style='margin:0 0 6px 0;padding-left:20px;'>{opts_html}</ul>"
            if opts_html
            else ""
        )
        rows.append(
            f"""<div style='margin:0 0 16px 0;'>"
            f"<p style='margin:0 0 6px 0;'><b>第 {i} 题</b>：{qtext}</p>"
            f"{list_html}"
            f"</div>""",
        )
    body_detail = "".join(rows) if show_detail else ""
    body = f"""
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#202124;">
  <h2 style="margin:0 0 16px 0;">定时出题任务</h2>
  <p style="margin:0 0 12px 0;color:#5f6368;">出题方向：{html.escape(prompt)}</p>
  {body_detail if show_detail else f'<p>本次共 <b>{len(qs)}</b> 道题，请登录系统查看并作答。</p>'}
  <p style="margin:0 0 8px 0;color:#d93025;"><b>答题截止：{deadline_str}</b></p>
  <p style="margin:0;color:#5f6368;font-size:13px;">请登录 MindBase 在「任务列表」中作答。</p>
</div>"""
    return subject, body


def render_overdue_email(incomplete: str | None, prompt: str) -> tuple[str, str]:
    """返回 (subject, html_body) 未完成语录。"""
    subject = "【MindBase】出题任务未完成提醒"
    msg = (incomplete or "").strip() or DEFAULT_INCOMPLETE
    body = f"""
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#202124;">
  <h2 style="margin:0 0 16px 0;">出题任务未完成</h2>
  <p style="margin:0 0 12px 0;">{html.escape(msg)}</p>
  <p style="margin:0;color:#5f6368;font-size:13px;">出题方向：{html.escape(prompt)}</p>
</div>"""
    return subject, body


# ── app-task 回调（邮件投递 + task 完成报告） ────────────────────────

async def _apptask_post(path: str, payload: dict) -> None:
    """POST 到 app-task 内部端点（key-auth）。失败只记日志（调度器重试兜底）。"""
    headers = {"apikey": _APPTASK_KEY, "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(f"{_APPTASK_BASE}{path}", json=payload, headers=headers)
        if resp.status_code >= 400:
            logger.error("[QUIZ_TASK] app-task %s failed status=%s body=%s", path, resp.status_code, resp.text[:200])
    except Exception as e:
        logger.error("[QUIZ_TASK] app-task %s transport error: %s", path, e)


async def deliver_email(to: list[str], cc: list[str], subject: str, html_body: str, reference_id: str) -> None:
    """回调 app-task 投递邮件（规范格式）。"""
    await _apptask_post(
        _EMAIL_SEND_PATH,
        {"to": to, "cc": cc or [], "subject": subject, "html": html_body, "reference_id": reference_id},
    )


async def report_task_complete(task_id: str, status: str, result: str = "", error: str = "") -> None:
    """回调 app-task 报告异步 task 完成（running → completed/failed）。"""
    await _apptask_post(
        f"/internal/task/{task_id}/complete",
        {"status": status, "result": result, "error": error},
    )


# ── 业务状态（quiz_task / quiz_task_answer 表） ─────────────────────

async def create_quiz_task(
    task_id: str, uid: int, prompt: str, difficulty: str, question_count: int,
    user_email: str, cc_emails: list, incomplete_message: str | None,
) -> None:
    """注册出题业务行（生成中）。业务归一化后交由仓储持久化。"""
    await quiz_task_repository.create_quiz_task(
        task_id=task_id,
        uid=uid,
        prompt=prompt,
        difficulty=difficulty or "medium",
        question_count=max(1, min(question_count, 5)),
        user_email=user_email,
        cc_emails=cc_emails or [],
        incomplete_message=incomplete_message,
    )


async def get_quiz_task(task_id: str) -> dict | None:
    return await quiz_task_repository.get_quiz_task(task_id)


async def mark_generated(task_id: str, deadline: datetime, question_count: int) -> None:
    """出题完成 → awaiting_answer + 设定 deadline。"""
    await quiz_task_repository.mark_generated(task_id, deadline, question_count)


async def get_quiz_task_by_uid(task_ref: str, uid: int) -> dict | None:
    return await quiz_task_repository.get_quiz_task_by_uid(task_ref, uid)


async def get_answers(task_id: str) -> list[dict]:
    """按题号返回答题记录。"""
    return await quiz_task_repository.get_answers(task_id)


async def save_answers(task_id: str, uid: int, results: list[dict]) -> None:
    """判题结果入库 + 业务状态 → completed。"""
    await quiz_task_repository.save_answers(task_id, uid, results)


async def scan_overdue() -> int:
    """扫描 deadline 到期未答的任务：发未完成语录（幂等 overdue_emailed）并转 overdue。

    返回本次发送的语录数量。由后台定时任务调用。
    """
    rows = await quiz_task_repository.list_overdue_tasks()
    sent = 0
    for row in rows:
        task_id = row["task_id"]
        subject, body = render_overdue_email(row["incomplete_message"], row["prompt"])
        await deliver_email(
            [row["user_email"]], json.loads(row["cc_emails"] or "[]"), subject, body, f"overdue:{task_id}"
        )
        await quiz_task_repository.mark_overdue_emailed(task_id)
        sent += 1
        logger.info("[QUIZ_TASK] overdue emailed task_id={}", task_id)
    return sent

