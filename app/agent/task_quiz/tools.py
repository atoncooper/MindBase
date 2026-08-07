"""Tools for the task-quiz agent.

random_time_generator - generate a future random time (Beijing), avoiding sleep/nap
submit_task           - register a task on app-task (via APISIX)
query_task            - query a task's status (via APISIX)

app-task base URL + APISIX consumer key come from env (set in docker-compose).
"""

import os
import random
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
from langchain_core.tools import tool
from loguru import logger

_APPTASK_BASE = os.environ.get("APPTASK_BASE_URL", "http://apisix:9080").rstrip("/")
_APPTASK_KEY = os.environ.get("APISIX_CONSUMER_KEY", "")
_BEIJING = ZoneInfo("Asia/Shanghai")


def _in_sleep(dt: datetime) -> bool:
    """Sleep window 23:00-07:00 (Beijing)."""
    return dt.hour >= 23 or dt.hour < 7


def _in_nap(dt: datetime) -> bool:
    """Nap window 12:00-13:30 (Beijing)."""
    if dt.hour == 12:
        return True
    if dt.hour == 13 and dt.minute <= 30:
        return True
    return False


@tool
def random_time_generator(window_days: int = 7) -> str:
    """生成一个未来的随机触发时间（北京时间），自动避开睡觉(23:00-07:00)和午休(12:00-13:30)。
    返回北京时间展示串 + UTC ISO8601（供 submit_task 使用）。"""
    now = datetime.now(_BEIJING)
    for _ in range(80):
        offset_hours = random.uniform(1, max(1, window_days) * 24)
        candidate = now + timedelta(hours=offset_hours)
        if _in_sleep(candidate) or _in_nap(candidate):
            continue
        utc = candidate.astimezone(timezone.utc)
        return (
            f"北京时间 {candidate.strftime('%Y-%m-%d %H:%M')}（周{['一','二','三','四','五','六','日'][candidate.weekday()]}）"
            f" | UTC={utc.isoformat()}"
        )
    return "未找到合适时间，请缩小窗口或重试。"


@tool
async def submit_task(
    trigger_time_utc: str,
    prompt: str,
    cc_emails: list[str],
    incomplete_message: str,
    uid: int,
    user_email: str,
) -> str:
    """提交定时出题任务到 app-task。trigger_time_utc 为 ISO8601 UTC（来自 random_time_generator）。
    prompt 为出题方向；incomplete_message 留空字符串则用默认模板。"""
    payload = {
        "uid": uid,
        "user_email": user_email,
        "cc_emails": cc_emails or [],
        "prompt": prompt,
        "trigger_time": trigger_time_utc,
        "incomplete_message": incomplete_message or None,
    }
    headers = {"apikey": _APPTASK_KEY, "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{_APPTASK_BASE}/tasks/register", json=payload, headers=headers
            )
    except Exception as e:
        return f"提交失败（网络）: {e}"
    if resp.status_code != 200:
        return f"提交失败: status={resp.status_code} body={resp.text[:200]}"
    data = resp.json()
    logger.info("[TASK_QUIZ_AGENT] submitted task_id={}", data.get("task_id"))
    return f"提交成功！task_id={data['task_id']}，状态=pending。到时间后会自动出题并发邮件。"


@tool
async def query_task(task_id: str, uid: int) -> str:
    """查询指定任务的状态（需 task_id 与当前用户 uid）。"""
    headers = {"apikey": _APPTASK_KEY}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_APPTASK_BASE}/tasks/{task_id}",
                params={"uid": uid},
                headers=headers,
            )
    except Exception as e:
        return f"查询失败（网络）: {e}"
    if resp.status_code != 200:
        return f"查询失败: status={resp.status_code}"
    return f"任务详情: {resp.text[:500]}"
