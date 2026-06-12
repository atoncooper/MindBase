"""DelegateToAgentTool — lets an agent call another agent mid-conversation.

Implements the Agent-as-Tool pattern: a Chat Agent can delegate a
sub-query to the Memory Agent (or any other registered agent) and
receive the result as a tool response.

The tool holds a reference to ``AgentLifecycleManager`` and calls
``invoke()`` directly — bypassing the orchestrator to avoid infinite
routing loops.
"""

from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from app.agent.lifecycle import AgentLifecycleManager

logger = logging.getLogger(__name__)


class DelegateToAgentTool:
    """Call another registered agent and return its result.

    This tool enables inter-agent delegation within the ReAct loop.
    For example, the Chat Agent can delegate a history-retrieval
    sub-query to the Memory Agent instead of using the context tools
    directly.
    """

    def __init__(
        self,
        lifecycle: AgentLifecycleManager,
        *,
        timeout: float = 30.0,
    ) -> None:
        self._lifecycle = lifecycle
        self._timeout = timeout

    @property
    def name(self) -> str:
        return "delegate_to_agent"

    @property
    def description(self) -> str:
        return (
            "委托子任务给专业 Agent 处理。可用 Agent:\n"
            "- memory: 记忆检索助手，搜索对话历史、提供上下文摘要。"
            "当需要回溯用户之前聊过的内容、查找历史对话时使用。\n"
            "仅在需要委托给专业 Agent 时使用，普通问答不需要调用此工具。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "agent_name": {
                    "type": "string",
                    "description": "要委托的 Agent 名称（目前仅支持 'memory'）",
                },
                "query": {
                    "type": "string",
                    "description": "委托给目标 Agent 的查询文本",
                },
            },
            "required": ["agent_name", "query"],
        }

    async def run(
        self,
        agent_name: str,
        query: str,
        **kwargs: Any,
    ) -> str:
        """Delegate to the target agent and return its result."""
        # Pass through implicit kwargs from the calling agent's state
        session_id = kwargs.get("chat_session_id", "")
        if not session_id:
            return "无法委托：缺少 chat_session_id"

        logger.info(
            "[DELEGATE] agent='%s' query='%s' session=%s",
            agent_name,
            query[:60],
            session_id,
        )

        try:
            result = await self._lifecycle.invoke(
                agent_name,
                session_id,
                timeout=self._timeout,
                query=query,
                target_agent="chat",
            )

            if isinstance(result, dict):
                if "error" in result and result["error"]:
                    return f"委托失败: {result['error']}"
                # Extract the answer from the agent result
                answer = result.get("result", "")
                if not answer:
                    messages = result.get("messages", [])
                    if messages:
                        last_msg = messages[-1]
                        answer = getattr(last_msg, "content", str(last_msg))
                return answer or "目标 Agent 未返回结果"

            return str(result)

        except Exception as exc:
            logger.warning("[DELEGATE] failed: %s", exc)
            return f"委托失败: {exc}"
