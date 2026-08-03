"""Error classification, retry, fallback for the Code Agent.

Agent-agnostic pieces (classify_error, ErrorCategory) reused from
``app.agent.errors``; only the fallback string is code-specific.
"""

from __future__ import annotations

import asyncio
import logging

from app.agent.errors import ErrorCategory, classify_error  # noqa: F401 (re-exported)

from app.agent.code.state import CodeAgentState

logger = logging.getLogger(__name__)

FALLBACK_RESULT = "代码服务暂时不可用，请稍后再试。"

# Returned when run_code is not registered (daytona-sdk missing/misconfigured).
# More specific than FALLBACK_RESULT so the user knows code execution is
# unavailable. Set WITHOUT calling the LLM (build_code_agent short-circuits
# _inject) so the LLM cannot fabricate an "executed successfully" reply.
UNAVAILABLE_RESULT = "代码执行服务暂时不可用：run_code 工具未注册（daytona-sdk 未安装或 Daytona 配置错误），无法执行代码。请稍后再试或联系管理员检查 Daytona 配置。"


def build_fallback(state: CodeAgentState) -> dict:
    return {"result": FALLBACK_RESULT, "error": state.error or "unknown error"}


async def backoff_delay(attempt: int, base_seconds: float = 1.0) -> None:
    delay = min(base_seconds * (2**attempt), 10.0)
    logger.debug("[BACKOFF] sleeping %.2fs (attempt %s)", delay, attempt)
    await asyncio.sleep(delay)


def as_error_node(node_name: str):
    """Wrap a LangGraph node with error handling (sets state.error/failed_node)."""

    def _report_error(state: CodeAgentState, error_msg: str) -> dict:
        return {"error": error_msg, "failed_node": node_name}

    def decorator(func):
        async def wrapper(state: CodeAgentState, **kwargs) -> dict:
            try:
                result = await func(state, **kwargs)
                if isinstance(result, dict):
                    result.setdefault("error", "")
                    result.setdefault("retry_count", state.retry_count)
                return result
            except Exception as exc:
                logger.warning(
                    "[CODE_AGENT] %s failed: %s (retry %s/%s)",
                    node_name,
                    exc,
                    state.retry_count,
                    state.max_retries,
                )
                return _report_error(state, str(exc))

        return wrapper

    return decorator
