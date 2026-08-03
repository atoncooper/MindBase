"""DelegateToAgentTool — lets an agent call another agent mid-conversation.

Implements the Agent-as-Tool pattern: a Chat Agent can delegate a
sub-query to the Memory Agent (or any other registered agent) and
receive the result as a tool response.

The tool holds a reference to ``AgentLifecycleManager`` and calls
``invoke()`` directly — bypassing the orchestrator to avoid infinite
routing loops.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, TYPE_CHECKING

from loguru import logger as loguru_logger

from app.tools import ToolDeps, register_tool

if TYPE_CHECKING:
    from app.agent.lifecycle import AgentLifecycleManager

logger = logging.getLogger(__name__)

# Maximum delegation nesting depth. Prevents loops like chat -> memory -> chat.
# chat(0) -> memory(1) -> X(2): X cannot delegate further.
MAX_DELEGATE_DEPTH = 2

# Delegation timeout for the code agent. The default self._timeout (30s) is
# too short: Daytona sandbox creation alone can take 10-40s on the cloud, and
# run_code adds up to 20s execution + artifact harvest on top of the code
# agent's own ReAct LLM calls. 30s kills run_code mid-flight (no artifact
# uploaded), and the parent chat LLM then fabricates a success description.
CODE_AGENT_DELEGATE_TIMEOUT = 120.0


@register_tool
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

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "DelegateToAgentTool | None":
        if deps.lifecycle is None:
            return None
        return cls(deps.lifecycle)

    @property
    def name(self) -> str:
        return "delegate_to_agent"

    @property
    def description(self) -> str:
        return (
            "委托子任务给专业 Agent 处理。可用 Agent:\n"
            "- memory: 记忆检索助手，搜索对话历史、提供上下文摘要。"
            "当需要回溯用户之前聊过的内容、查找历史对话时使用。\n"
            "- note: 笔记助手，把对话内容或视频要点整理成 Markdown 笔记并保存。"
            "当用户要求\"建笔记/记笔记/把这个记下来\"时使用。\n"
            "- code: 代码助手，编写代码并在沙箱中运行。"
            "当用户要求\"写代码/运行脚本/执行代码\"时使用。\n"
            "- search: 联网搜索助手，通过 Context7 + 爬虫联网搜索技术文档和最新信息。"
            "当用户要求\"联网搜索/查文档/搜一下/找最新信息\"时使用。\n"
            "仅在需要委托给专业 Agent 时使用，普通问答不需要调用此工具。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "agent_name": {
                    "type": "string",
                    "description": "要委托的 Agent 名称（支持 'memory'、'note'、'code' 和 'search'）",
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
    ) -> dict[str, Any]:
        """Delegate to the target agent and return its result.

        Returns a dict ``{"content": str, "sub_steps": list[dict]}`` so the
        parent agent's SSE stream can surface what the sub-agent did internally.
        """
        # Prevent delegation back to the top-level chat agent (would loop).
        if agent_name == "chat":
            return {"content": "不能委托给 chat agent(它是顶层路由目标)", "failed": True}

        # Cap delegation nesting to prevent chat -> memory -> chat -> ... loops.
        depth = kwargs.get("delegate_depth", 0)
        if depth >= MAX_DELEGATE_DEPTH:
            return {
                "content": f"委托深度超限(>{MAX_DELEGATE_DEPTH}),已阻止以防止循环委托",
                "failed": True,
            }

        # Pass through implicit kwargs from the calling agent's state
        session_id = kwargs.get("chat_session_id", "")
        if not session_id:
            return "无法委托：缺少 chat_session_id"

        assistant_msg_id = kwargs.get("assistant_msg_id", "")

        uid = kwargs.get("_uid")
        callbacks = self._make_usage_callbacks(uid)

        logger.info(
            "[DELEGATE] agent='%s' query='%s' session=%s uid=%s",
            agent_name,
            query[:60],
            session_id,
            uid,
        )
        # loguru mirror so delegation is visible in logs/app.log (standard
        # logging is not bridged to loguru - see docs/code-execution.md).
        loguru_logger.info(
            "[DELEGATE] agent='{}' query='{}' session={} uid={}",
            agent_name, query[:60], session_id, uid,
        )

        # Code execution needs a much longer window than the default 30s
        # (sandbox creation + code run + harvest + ReAct LLM calls). See
        # CODE_AGENT_DELEGATE_TIMEOUT rationale above.
        timeout = (
            CODE_AGENT_DELEGATE_TIMEOUT if agent_name == "code" else self._timeout
        )

        try:
            # Reentrant entry: the chat agent already holds the session lock,
            # and asyncio.Lock is non-reentrant. Using plain invoke() would
            # deadlock against the outer acquire.
            result = await self._lifecycle.invoke_reentrant(
                agent_name,
                session_id,
                timeout=timeout,
                callbacks=callbacks,
                query=query,
                target_agent="chat",
                uid=uid,
                caller_session_id=session_id,
                delegate_depth=depth + 1,
                chat_session_id=session_id,
                assistant_msg_id=assistant_msg_id,
            )

            if isinstance(result, dict):
                sub_steps = result.get("sub_steps", [])
                if "error" in result and result["error"]:
                    return {"content": f"委托失败: {result['error']}", "sub_steps": sub_steps, "failed": True}
                # Extract the answer from the agent result
                answer = result.get("result", "")
                if not answer:
                    messages = result.get("messages", [])
                    if messages:
                        last_msg = messages[-1]
                        answer = getattr(last_msg, "content", str(last_msg))
                return {"content": answer or "目标 Agent 未返回结果", "sub_steps": sub_steps}

            return {"content": str(result), "sub_steps": []}

        except asyncio.TimeoutError:
            # str(TimeoutError()) is "" -> an empty "委托失败: " message
            # leaves the parent LLM guessing and it fabricates a success.
            # Spell out the timeout + forbid fabrication explicitly.
            logger.warning(
                "[DELEGATE] agent='%s' timed out after %ss", agent_name, timeout
            )
            return {
                "content": (
                    f"委托 {agent_name} agent 超时（{int(timeout)}s），代码可能未执行完成、"
                    f"没有生成任何产物。请如实告知用户执行超时，不要编造执行结果或描述不存在的产物。"
                ),
                "failed": True,
                "timeout": True,
            }
        except Exception as exc:
            logger.warning("[DELEGATE] failed: %s", exc)
            # str(exc) may be "" (e.g. bare Exception()) -> surface a placeholder
            # so the parent LLM isn't fed an empty "委托失败: " it can't interpret.
            return {"content": f"委托失败: {str(exc) or '未知错误'}", "failed": True}

    def _make_usage_callbacks(self, uid: Any) -> list[Any]:
        """Build usage-tracking callbacks for sub-agent invocation.

        Sub-agents (e.g. memory) run outside the parent agent's token handler,
        so we attach a dedicated callback here.
        """
        if uid is None:
            return []
        try:
            from app.services.chat.llm import build_llm
            from app.services.llm.buffered_usage_writer import get_buffered_usage_writer
            from app.services.llm.usage_tracker import UsageTrackingCallback

            llm = build_llm(uid=uid)
            return [
                UsageTrackingCallback(
                    uid=uid,
                    credential_id=getattr(llm, "_credential_id", None),
                    provider=getattr(llm, "_provider", "openai"),
                    model=getattr(llm, "_model", None),
                    writer=get_buffered_usage_writer(),
                )
            ]
        except Exception:
            logger.exception("[DELEGATE] failed to create usage callback")
            return []
