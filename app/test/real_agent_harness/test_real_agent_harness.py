"""Real integration tests for uncommitted Agent/Harness engineering changes.

These tests intentionally do not use mock/patch. They require real local
configuration, a real database, a real LLM key, and for retrieval tests, real
vector data in the configured vector store.
"""

from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

from app.context import init_context_manager, reset_context_manager
from app.database import async_session_factory
from app.harness import AgentHarness
from app.main import _get_harness_llm
from app.services.rag import get_rag_service


REQUIRED_CHAT_TOOLS = {
    "vector_search",
    "list_videos",
    "get_video_summaries",
}
REQUIRED_CONTEXT_TOOLS = {
    "search_chat_history",
    "get_recent_context",
    "get_full_history",
    "get_compressed_summary",
}


def _require_real_env() -> None:
    if os.getenv("BILIRAG_REAL_AGENT_HARNESS_TESTS") != "1":
        pytest.skip("Set BILIRAG_REAL_AGENT_HARNESS_TESTS=1 to run real tests")


@pytest_asyncio.fixture
async def real_harness():
    _require_real_env()
    reset_context_manager()
    ctx_mgr = init_context_manager()
    llm = _get_harness_llm()
    if llm is None:
        pytest.fail("真实 LLM 未配置：请设置 LLM__API_KEY 或兼容配置")

    harness = AgentHarness(
        context_manager=ctx_mgr,
        llm=llm,
        session_factory=async_session_factory,
        cleanup_interval=3600,
        session_ttl=3600,
    )
    await harness.start()
    try:
        yield harness
    finally:
        await harness.shutdown()
        reset_context_manager()


@pytest.mark.asyncio
async def test_real_harness_startup_discovers_tools_and_agents(real_harness):
    health = await real_harness.health()
    tool_names = set(real_harness.tool_names)

    assert real_harness.started is True
    assert real_harness.runtime.started is True
    assert "chat" in real_harness.lifecycle.registered_agents
    assert "memory" in real_harness.lifecycle.registered_agents
    assert "quiz" in real_harness.lifecycle.registered_agents
    assert REQUIRED_CHAT_TOOLS <= tool_names
    assert REQUIRED_CONTEXT_TOOLS <= tool_names
    assert health["tools"]["failed"] == 0
    assert health["runtime"]["running"] is True


@pytest.mark.asyncio
async def test_real_runtime_executes_registered_context_tool(real_harness):
    session_id = f"real-harness-{uuid.uuid4()}"

    messages = await real_harness.runtime.execute(
        [
            {
                "id": "real-context-call-1",
                "name": "get_recent_context",
                "args": {"chat_session_id": session_id},
            }
        ]
    )
    metrics = real_harness.runtime.monitor()

    assert len(messages) == 1
    assert messages[0].tool_call_id == "real-context-call-1"
    assert messages[0].name == "get_recent_context"
    assert isinstance(messages[0].content, str)
    assert metrics["tools"]["get_recent_context"]["call_count"] >= 1
    assert metrics["totals"]["error_count"] == 0


@pytest.mark.asyncio
async def test_real_vector_search_tool_uses_configured_vector_store(real_harness):
    rag = get_rag_service()
    docs = rag.search("AI", k=1)
    if not docs:
        pytest.skip("配置的向量库没有可检索数据；请先构建知识库后再运行该测试")

    messages = await real_harness.runtime.execute(
        [
            {
                "id": "real-vector-call-1",
                "name": "vector_search",
                "args": {"query": "AI", "k": 1},
            }
        ]
    )

    assert len(messages) == 1
    assert messages[0].tool_call_id == "real-vector-call-1"
    assert messages[0].name == "vector_search"
    assert isinstance(messages[0].content, str)
    assert messages[0].content.strip()
    assert isinstance(messages[0].additional_kwargs.get("sources", []), list)


@pytest.mark.asyncio
async def test_real_chat_agent_invokes_llm_and_returns_answer(real_harness):
    session_id = f"real-chat-{uuid.uuid4()}"

    result = await real_harness.invoke(
        "chat",
        session_id=session_id,
        uid=1,
        query="请用一句中文回答：你现在是否通过真实 AgentHarness 运行？",
        folder_ids=[],
        timeout=90,
    )

    assert isinstance(result, dict)
    assert isinstance(result.get("result"), str)
    assert result["result"].strip()
    assert "error" not in result or not result["error"]
