"""Loop-guard regression tests for the board agent's deterministic gates.

The gates live in ``runtime_dispatch`` (externalized judgment, never model
decision):

* duplicate rejection — a tool+args pair executed ``DUPLICATE_LIMIT`` times
  gets a synthesized refusal on the next identical request;
* tool budget — at most ``MAX_TOOL_CALLS`` executions per turn;
* forced finalize — when every pending call is refused, the turn routes to
  the ``finalize`` node for a forced no-tools answer instead of looping.

Uses the REAL compiled graph with scripted LLM/runtime fakes.
"""

from __future__ import annotations

from typing import Any

import pytest

from langchain_core.messages import AIMessage, ToolMessage

from app.agent.board.graph import (
    DUPLICATE_LIMIT,
    MAX_TOOL_CALLS,
    build_board_agent,
)


class ScriptedLLM:
    """Returns canned responses in order for every ainvoke (agent + finalize)."""

    def __init__(self, responses: list[AIMessage]) -> None:
        self.responses = list(responses)
        self.prompts: list[list] = []

    def bind_tools(self, tools: Any) -> "ScriptedLLM":
        return self  # bind_tools is a no-op; tool_calls are scripted anyway

    async def ainvoke(self, messages: Any, config: Any = None) -> AIMessage:
        self.prompts.append(messages)
        if not self.responses:
            raise AssertionError("ScriptedLLM exhausted")
        return self.responses.pop(0)


class FakeRuntime:
    """Executes every call: canned ok payload."""

    def list_tool_defs(self, names: Any = None) -> list:
        return []

    async def execute(self, tool_calls: list[dict], config: Any = None) -> list[ToolMessage]:
        return [
            ToolMessage(
                content='{"uuid": "u1", "version": 1}',
                tool_call_id=tc["id"],
                name=tc["name"],
            )
            for tc in tool_calls
        ]


def _tool_call(i: int, *, uuid: str = "u1") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"id": f"c{i}", "name": "board_get", "args": {"board_uuid": uuid}}],
    )


def _plain(text: str) -> AIMessage:
    return AIMessage(content=text)


INPUT_STATE: dict[str, Any] = {
    "query": "完善定义",
    "session_id": "",
    "uid": 1,
    "board_uuid": "u1",
    "board_anchor_text": "",
}


@pytest.mark.asyncio
async def test_duplicate_calls_refused_then_forced_finalize() -> None:
    # Same tool+args executed twice (allowed), the third request is refused —
    # and since every pending call is refused, the turn force-finalizes.
    llm = ScriptedLLM(
        [
            _tool_call(1),
            _tool_call(2),
            _tool_call(3),          # 3rd identical → refused → force finalize
            _plain("最终答案"),       # finalize (no-tools) call
        ]
    )
    graph = build_board_agent(FakeRuntime(), llm, deps=None)
    final = await graph.ainvoke(INPUT_STATE, config={"recursion_limit": 30})

    assert final["result"] == "最终答案"
    assert final["tool_call_count"] == DUPLICATE_LIMIT
    assert final["force_finalize"] is True

    # Ledger: two executions + one system refusal, in order.
    oks = [s for s in final["steps"] if s["ok"]]
    refusals = [s for s in final["steps"] if not s["ok"]]
    assert len(oks) == 2 and len(refusals) == 1
    assert "系统拒绝" in refusals[0]["brief"]

    # The 3rd agent run must have seen the ledger naming the two executions,
    # and the finalize prompt carries the refusal ToolMessage.
    third_prompt = llm.prompts[2]
    ledger_text = third_prompt[0].content
    assert "已执行操作台账" in ledger_text and "剩余工具预算" in ledger_text
    finalize_prompt = llm.prompts[3]
    assert any("[系统拒绝]" in str(getattr(m, "content", "")) for m in finalize_prompt)
    assert "立即基于已有信息" in finalize_prompt[-1].content


@pytest.mark.asyncio
async def test_tool_budget_exhaustion_forces_finalize() -> None:
    # Every call uses fresh args (never a duplicate), so the budget gate is
    # what stops the loop. MAX_TOOL_CALLS execute; the (MAX+1)-th agent turn's
    # call is refused (consumes the next scripted response) and the turn
    # force-finalizes on the following plain response.
    responses = [_tool_call(i, uuid=f"u{i}") for i in range(MAX_TOOL_CALLS + 1)]
    responses.append(_plain("预算耗尽后的答案"))
    llm = ScriptedLLM(responses)
    graph = build_board_agent(FakeRuntime(), llm, deps=None)
    final = await graph.ainvoke(INPUT_STATE, config={"recursion_limit": 60})

    assert final["tool_call_count"] == MAX_TOOL_CALLS
    assert final["force_finalize"] is True
    assert final["result"] == "预算耗尽后的答案"
    executed = [s for s in final["steps"] if s["ok"]]
    refused = [s for s in final["steps"] if not s["ok"]]
    assert len(executed) == MAX_TOOL_CALLS
    assert len(refused) == 1
    assert "预算" in refused[0]["brief"]


@pytest.mark.asyncio
async def test_mixed_batch_executes_fresh_and_refuses_duplicates() -> None:
    # One batch: two identical calls (2nd is the first duplicate → allowed at
    # DUPLICATE_LIMIT=2), then a batch where the 3rd identical is refused but
    # a fresh distinct call in the same batch still executes.
    llm = ScriptedLLM(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {"id": "c1", "name": "board_get", "args": {"board_uuid": "u1"}},
                    {"id": "c2", "name": "board_get", "args": {"board_uuid": "u1"}},
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    {"id": "c3", "name": "board_get", "args": {"board_uuid": "u1"}},
                    {"id": "c4", "name": "board_get", "args": {"board_uuid": "u2"}},
                ],
            ),
            _plain("混合批次后的答案"),
        ]
    )
    graph = build_board_agent(FakeRuntime(), llm, deps=None)
    final = await graph.ainvoke(INPUT_STATE, config={"recursion_limit": 30})

    assert final["result"] == "混合批次后的答案"
    # force_finalize stays unset (LangGraph omits never-written channels).
    assert final.get("force_finalize", False) is False
    # u1 executed twice, refused once; u2 executed once.
    oks = [s for s in final["steps"] if s["ok"]]
    refusals = [s for s in final["steps"] if not s["ok"]]
    assert len([s for s in oks if s["args"].startswith('{"board_uuid": "u1"')]) == 2
    assert len([s for s in oks if s["args"].startswith('{"board_uuid": "u2"')]) == 1
    assert len(refusals) == 1
    assert final["tool_call_count"] == 3
