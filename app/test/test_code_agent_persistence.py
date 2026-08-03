"""Tests for code agent runtime_dispatch persistence.

Verifies each run_code tool call is persisted to code_executions with the
correct association keys (uid / chat_session_id / assistant_msg_id) and that
persistence failures don't break the agent flow (best-effort contract).
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from app.agent.code.graph import runtime_dispatch
from app.agent.code.state import CodeAgentState

pytestmark = pytest.mark.asyncio


def _state(**overrides) -> CodeAgentState:
    defaults = dict(
        query="画爱心",
        uid=1,
        chat_session_id="sess-1",
        assistant_msg_id="msg-1",
        messages=[],
    )
    defaults.update(overrides)
    return CodeAgentState(**defaults)


class TestRuntimeDispatchPersistence:
    async def test_run_code_call_persisted_with_association_keys(self):
        ai_msg = AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "tc1",
                    "name": "run_code",
                    "args": {"code": "print(1)", "language": "python"},
                }
            ],
        )
        tool_msg = ToolMessage(
            content="exitCode=0\n1",
            tool_call_id="tc1",
            name="run_code",
            additional_kwargs={
                "exit_code": 0,
                "artifacts": [{"name": "heart.png", "url": "u"}],
            },
        )
        state = _state(messages=[ai_msg])
        runtime = MagicMock()
        runtime.execute = AsyncMock(return_value=[tool_msg])

        with patch(
            "app.repository.code_execution_repository.insert",
            new_callable=AsyncMock,
            return_value="exec-1",
        ) as mock_insert:
            result = await runtime_dispatch(state, runtime)

        mock_insert.assert_awaited_once()
        kwargs = mock_insert.call_args.kwargs
        assert kwargs["uid"] == 1
        assert kwargs["chat_session_id"] == "sess-1"
        assert kwargs["assistant_msg_id"] == "msg-1"
        assert kwargs["delegate_query"] == "画爱心"
        assert kwargs["code"] == "print(1)"
        assert kwargs["exit_code"] == 0
        assert kwargs["artifacts"] == [{"name": "heart.png", "url": "u"}]
        # exec_id + artifacts surfaced in sub_steps for SSE.
        sub_step = result["sub_steps"][0]
        assert sub_step["exec_id"] == "exec-1"
        assert sub_step["artifacts"] == [{"name": "heart.png", "url": "u"}]

    async def test_persistence_failure_does_not_break_flow(self):
        ai_msg = AIMessage(
            content="",
            tool_calls=[
                {"id": "tc1", "name": "run_code", "args": {"code": "print(1)"}}
            ],
        )
        tool_msg = ToolMessage(
            content="exitCode=0\n1",
            tool_call_id="tc1",
            name="run_code",
            additional_kwargs={"exit_code": 0},
        )
        state = _state(messages=[ai_msg])
        runtime = MagicMock()
        runtime.execute = AsyncMock(return_value=[tool_msg])

        with patch(
            "app.repository.code_execution_repository.insert",
            new_callable=AsyncMock,
            side_effect=Exception("mongo down"),
        ):
            result = await runtime_dispatch(state, runtime)  # must not raise

        # ToolMessage still returned to the graph; sub_step has no exec_id.
        assert len(result["messages"]) == 1
        assert "exec_id" not in result["sub_steps"][0]

    async def test_non_run_code_tool_not_persisted(self):
        ai_msg = AIMessage(
            content="",
            tool_calls=[
                {"id": "tc1", "name": "vector_search", "args": {"query": "q"}}
            ],
        )
        tool_msg = ToolMessage(
            content="results...",
            tool_call_id="tc1",
            name="vector_search",
        )
        state = _state(messages=[ai_msg])
        runtime = MagicMock()
        runtime.execute = AsyncMock(return_value=[tool_msg])

        with patch(
            "app.repository.code_execution_repository.insert",
            new_callable=AsyncMock,
        ) as mock_insert:
            await runtime_dispatch(state, runtime)

        mock_insert.assert_not_awaited()
