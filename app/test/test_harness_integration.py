"""Tests for AgentHarness agent registration and invocation."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from app.agent.chat import build_chat_agent, ChatAgentState
from app.agent.lifecycle.circuit import CircuitBreaker
from app.agent.memory import build_memory_agent
from app.agent.quiz import build_quiz_agent
from app.harness.app import AgentHarness
from app.harness.runtime import AgentRuntime
from app.tools.chat import VectorSearchTool, ListVideosTool, GetVideoSummariesTool
from app.tools.context import SearchChatHistoryTool, GetRecentContextTool
from app.tools.registry import ToolRegistry


# ---------------------------------------------------------------------------
# Mock dependencies
# ---------------------------------------------------------------------------


class MockDeps:
    """ChatDeps mock — satisfies the ChatDeps protocol."""

    def __init__(self, *, bvids=None, cloud=False):
        self._bvids = bvids or ["BV1xx"]
        self._cloud = cloud

    async def get_media_ids(self, uid, folder_ids):
        return [123]

    async def get_bvids(self, media_ids):
        return self._bvids

    def has_cloud_backend(self):
        return self._cloud

    async def get_conversation_context(self, session_id):
        return ""

    async def get_video_context(self, media_ids, *, include_content=False, limit=None):
        return "【哲学】\n- 《中国哲学》", [{"bvid": "BV1xx", "title": "中国哲学"}]

    async def get_video_titles_context(self, media_ids):
        return "【哲学】\n- 《中国哲学》"

    async def is_related_to_collection(self, media_ids, question):
        return True


class MockContextManager:
    """Minimal ContextManager mock for context tools."""

    async def get_context_raw(self, session_id):
        return []


class FakeStructuredQuizLlm:
    def __init__(self, parent):
        self.parent = parent

    async def ainvoke(self, _messages, **_kwargs):
        return self.parent.schema(
            questions=[
                {
                    "type": "single_choice",
                    "difficulty": "medium",
                    "source_chunk_index": 0,
                    "question": "向量数据库主要通过什么方式召回相关内容？",
                    "options": [
                        "A. 相似度搜索",
                        "B. 随机抽样",
                        "C. 手工排序",
                        "D. 固定模板",
                    ],
                    "correct_answer": "A",
                    "explanation": "原文提到通过相似度搜索找到语义相关内容。",
                }
            ]
        )


class FakeQuizLlm:
    def __init__(self):
        self.schema = None
        self.method = None

    def with_structured_output(self, schema, method):
        self.schema = schema
        self.method = method
        return FakeStructuredQuizLlm(self)


class MockContextTool:
    """Mock context tool for testing registration."""

    def __init__(self, name="search_chat_history"):
        self._name = name
        self.last_chat_session_id = ""

    @property
    def name(self):
        return self._name

    @property
    def description(self):
        return f"Mock {self._name}"

    def parameters(self):
        return {
            "type": "object",
            "properties": {"chat_session_id": {"type": "string"}},
            "required": ["chat_session_id"],
        }

    async def run(self, chat_session_id="", **kwargs):
        self.last_chat_session_id = chat_session_id
        return "mock result"


def _make_harness(deps=None, llm=None):
    """Create a harness with both agents registered (using mock deps)."""
    from app.harness.runtime import ToolMetrics

    ctx_mgr = MockContextManager()
    llm = llm or AsyncMock()
    llm.bind_tools = MagicMock(return_value=llm)

    harness = AgentHarness(context_manager=ctx_mgr, llm=llm)

    # Manually register tools (skip get_rag_service which needs infra)
    rag_mock = MagicMock()
    rag_mock.search = MagicMock(return_value=[])
    harness._registry.register(VectorSearchTool(rag_mock))

    _deps = deps or MockDeps()
    harness._registry.register(ListVideosTool(_deps))
    harness._registry.register(GetVideoSummariesTool(_deps))

    # Context tools
    harness._registry.register(MockContextTool("search_chat_history"))
    harness._registry.register(MockContextTool("get_recent_context"))

    # Start runtime manually
    tool_names = harness._registry.list()
    harness._runtime._metrics = {name: ToolMetrics() for name in tool_names}
    harness._runtime._started = True

    # Register agents
    harness._lifecycle.register(
        "memory",
        build_memory_agent,
        runtime=harness._runtime,
        llm=llm,
        circuit_breaker=harness._lifecycle.circuit,
    )
    harness._lifecycle.register(
        "chat",
        build_chat_agent,
        runtime=harness._runtime,
        llm=llm,
        deps=_deps,
        circuit_breaker=harness._lifecycle.circuit,
    )
    harness._lifecycle.register(
        "quiz",
        build_quiz_agent,
        llm=llm,
        circuit_breaker=harness._lifecycle.circuit,
    )

    harness._started = True
    return harness


# ---------------------------------------------------------------------------
# Registration tests
# ---------------------------------------------------------------------------


class TestHarnessRegistration:
    def test_core_agents_registered(self):
        harness = _make_harness()
        assert "chat" in harness._lifecycle.registered_agents
        assert "memory" in harness._lifecycle.registered_agents
        assert "quiz" in harness._lifecycle.registered_agents

    def test_chat_tools_registered(self):
        harness = _make_harness()
        names = harness.tool_names
        assert "vector_search" in names
        assert "list_videos" in names
        assert "get_video_summaries" in names

    def test_context_tools_registered(self):
        harness = _make_harness()
        names = harness.tool_names
        assert "search_chat_history" in names
        assert "get_recent_context" in names

    def test_runtime_started(self):
        harness = _make_harness()
        assert harness.runtime.started


# ---------------------------------------------------------------------------
# Invoke tests
# ---------------------------------------------------------------------------


class TestHarnessInvokeChat:
    @pytest.mark.asyncio
    async def test_invoke_chat_agent(self):
        harness = _make_harness()

        # Mock LLM: answer directly
        harness._llm.ainvoke = AsyncMock(
            return_value=AIMessage(content="你好！我是知识库助手。")
        )

        result = await harness.invoke(
            "chat",
            session_id="test-session",
            query="你好",
            uid=1,
        )

        assert "result" in result
        assert result["result"] == "你好！我是知识库助手。"

    @pytest.mark.asyncio
    async def test_invoke_chat_agent_with_tool_call(self):
        harness = _make_harness(deps=MockDeps(bvids=["BV1xx"]))

        call_count = 0

        async def mock_invoke(messages, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "tc1",
                            "name": "vector_search",
                            "args": {"query": "中国哲学"},
                        }
                    ],
                )
            return AIMessage(content="根据检索结果，中国哲学的核心观点包括...")

        harness._llm.ainvoke = mock_invoke

        result = await harness.invoke(
            "chat",
            session_id="test-session",
            query="中国哲学的核心观点",
            uid=1,
        )

        assert call_count == 2
        assert "中国哲学" in result["result"]

    @pytest.mark.asyncio
    async def test_invoke_chat_agent_direct_answer(self):
        """Chat agent can answer directly without tools."""
        harness = _make_harness()

        harness._llm.ainvoke = AsyncMock(
            return_value=AIMessage(content="你好！我是知识库助手。")
        )

        result = await harness.invoke(
            "chat",
            session_id="sess-direct",
            query="你好",
            uid=1,
        )

        assert result["result"] == "你好！我是知识库助手。"


class TestHarnessInvokeMemory:
    @pytest.mark.asyncio
    async def test_invoke_memory_agent(self):
        harness = _make_harness()

        harness._llm.ainvoke = AsyncMock(
            return_value=AIMessage(content="已找到相关历史记录。")
        )

        result = await harness.invoke(
            "memory",
            session_id="test-session",
            query="之前讨论的哲学",
        )

        assert "result" in result


class TestHarnessInvokeQuiz:
    @pytest.mark.asyncio
    async def test_invoke_quiz_agent_generate_batch(self):
        llm = FakeQuizLlm()
        harness = _make_harness(llm=llm)

        result = await harness.invoke(
            "quiz",
            session_id="quiz-session",
            operation="generate_batch",
            chunks=[
                {
                    "bvid": "BV1",
                    "title": "向量检索",
                    "content": "向量数据库通过相似度搜索找到语义相关内容。" * 20,
                    "chunk_index": 0,
                }
            ],
            batch_count=1,
            batch_types=["single_choice"],
            difficulty="medium",
            uid=1,
            used_chunk_indices=[],
        )

        assert llm.method == "function_calling"
        assert result["questions"][0]["bvid"] == "BV1"


# ---------------------------------------------------------------------------
# Error handling tests
# ---------------------------------------------------------------------------


class TestHarnessErrorHandling:
    @pytest.mark.asyncio
    async def test_unknown_agent_returns_error(self):
        harness = _make_harness()

        result = await harness.invoke("nonexistent", session_id="x", query="test")
        # Lifecycle manager catches ValueError and returns error dict
        assert "error" in result
        assert "unknown agent" in result["error"]

    @pytest.mark.asyncio
    async def test_circuit_breaker_blocks_invocation(self):
        harness = _make_harness()
        cb = harness._lifecycle.circuit
        # Trip the circuit breaker
        for _ in range(cb._failure_threshold):
            cb.record_failure()

        result = await harness.invoke("chat", session_id="x", query="test")
        assert "error" in result
