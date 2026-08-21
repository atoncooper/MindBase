"""Tests for delegate failure short-circuit in chat agent runtime_dispatch.

Verifies that repeated delegate failures to the same agent_name are counted
and short-circuited after DELEGATE_FAILURE_THRESHOLD, so the LLM cannot burn
the whole ReAct budget retrying one failing sub-agent.
"""

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from app.agent.chat.graph import DELEGATE_FAILURE_THRESHOLD, runtime_dispatch
from app.agent.chat.state import ChatAgentState

pytestmark = pytest.mark.asyncio


class _MockRuntime:
    """Stand-in for AgentRuntime that returns preset ToolMessages."""

    def __init__(self) -> None:
        self.executed: list[dict] = []
        self._responses: dict[str, ToolMessage] = {}

    def set_response(self, tool_call_id: str, message: ToolMessage) -> None:
        self._responses[tool_call_id] = message

    async def execute(self, tool_calls: list[dict], config: dict | None = None) -> list[ToolMessage]:
        self.executed.extend(tool_calls)
        return [self._responses[tc["id"]] for tc in tool_calls]


def _delegate_tc(tc_id: str, agent_name: str, query: str = "x") -> dict:
    return {
        "id": tc_id,
        "name": "delegate_to_agent",
        "args": {"agent_name": agent_name, "query": query},
    }


def _state_with_calls(*tool_calls: dict, delegate_failures: dict | None = None) -> ChatAgentState:
    return ChatAgentState(
        query="q",
        session_id="s1",
        uid=1,
        messages=[AIMessage(content="", tool_calls=list(tool_calls))],
        delegate_failures=delegate_failures or {},
    )


class TestFailureCounting:
    async def test_failure_increments_counter(self):
        runtime = _MockRuntime()
        runtime.set_response(
            "tc1",
            ToolMessage(
                content="委托失败: timeout",
                tool_call_id="tc1",
                additional_kwargs={"failed": True},
            ),
        )
        state = _state_with_calls(_delegate_tc("tc1", "code"))

        out = await runtime_dispatch(state, runtime=runtime)

        assert out["delegate_failures"] == {"code": 1}

    async def test_success_does_not_increment(self):
        runtime = _MockRuntime()
        runtime.set_response("tc1", ToolMessage(content="ok result", tool_call_id="tc1"))
        state = _state_with_calls(_delegate_tc("tc1", "memory"))

        out = await runtime_dispatch(state, runtime=runtime)

        # No failure -> delegate_failures unchanged -> not included in update.
        assert "delegate_failures" not in out

    async def test_two_failures_accumulate(self):
        """Two delegate calls to code both fail -> counter reaches 2."""
        runtime = _MockRuntime()
        runtime.set_response(
            "tc1",
            ToolMessage(content="委托失败: err", tool_call_id="tc1", additional_kwargs={"failed": True}),
        )
        runtime.set_response(
            "tc2",
            ToolMessage(content="委托失败: err", tool_call_id="tc2", additional_kwargs={"failed": True}),
        )
        state = _state_with_calls(_delegate_tc("tc1", "code"), _delegate_tc("tc2", "code"))

        out = await runtime_dispatch(state, runtime=runtime)

        assert out["delegate_failures"] == {"code": 2}


class TestShortCircuit:
    async def test_short_circuits_at_threshold(self):
        """code already failed THRESHOLD times -> next delegate is short-circuited."""
        runtime = _MockRuntime()
        state = _state_with_calls(
            _delegate_tc("tc1", "code"),
            delegate_failures={"code": DELEGATE_FAILURE_THRESHOLD},
        )

        out = await runtime_dispatch(state, runtime=runtime)

        # runtime.execute was NOT called for the short-circuited delegate.
        assert runtime.executed == []
        # A short-circuit message was returned.
        assert len(out["messages"]) == 1
        msg = out["messages"][0]
        assert "委托已短路" in msg.content
        assert "code" in msg.content
        assert msg.tool_call_id == "tc1"

    async def test_short_circuit_still_counts_step(self):
        runtime = _MockRuntime()
        state = _state_with_calls(
            _delegate_tc("tc1", "code"),
            delegate_failures={"code": DELEGATE_FAILURE_THRESHOLD},
        )
        state.step_count = 3

        out = await runtime_dispatch(state, runtime=runtime)

        assert out["step_count"] == 4

    async def test_different_agents_independent(self):
        """code at threshold short-circuits; memory delegate still runs."""
        runtime = _MockRuntime()
        runtime.set_response(
            "tc2",
            ToolMessage(content="mem ok", tool_call_id="tc2"),
        )
        state = _state_with_calls(
            _delegate_tc("tc1", "code"),
            _delegate_tc("tc2", "memory"),
            delegate_failures={"code": DELEGATE_FAILURE_THRESHOLD},
        )

        out = await runtime_dispatch(state, runtime=runtime)

        executed_agents = [tc["args"]["agent_name"] for tc in runtime.executed]
        assert "memory" in executed_agents
        assert "code" not in executed_agents
        # Two messages: one ToolMessage (memory result) + one short-circuit (code).
        assert len(out["messages"]) == 2

    async def test_non_delegate_tool_not_affected(self):
        """Non-delegate tools always run, even with delegate_failures set."""
        runtime = _MockRuntime()
        runtime.set_response(
            "tc1",
            ToolMessage(content="search results", tool_call_id="tc1", additional_kwargs={"sources": []}),
        )
        vector_tc = {"id": "tc1", "name": "vector_search", "args": {"query": "q"}}
        state = _state_with_calls(
            vector_tc,
            delegate_failures={"code": DELEGATE_FAILURE_THRESHOLD},
        )

        await runtime_dispatch(state, runtime=runtime)

        assert len(runtime.executed) == 1
        assert runtime.executed[0]["name"] == "vector_search"
