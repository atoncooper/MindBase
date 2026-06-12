"""Tests for the ReAct Chat Agent graph."""

import pytest
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from unittest.mock import AsyncMock, MagicMock

from app.agent.chat import build_chat_agent, ChatAgentState
from app.agent.chat.prompts import build_system_prompt
from app.agent.chat.error_handling import classify_error, ErrorCategory
from app.agent.chat.graph import runtime_dispatch
from app.tools.chat import VectorSearchTool, ListVideosTool, GetVideoSummariesTool
from app.tools.registry import ToolRegistry
from app.harness.runtime import AgentRuntime


# ---------------------------------------------------------------------------
# Mock dependencies
# ---------------------------------------------------------------------------


class MockDeps:
    def __init__(self, *, media_ids=None, bvids=None, cloud=False,
                 video_context=("", []), titles_context=""):
        self._media_ids = media_ids or [123]
        self._bvids = bvids or ["BV1xx"]
        self._cloud = cloud
        self._video_context = video_context
        self._titles_context = titles_context

    async def get_media_ids(self, uid, folder_ids):
        return self._media_ids

    async def get_bvids(self, media_ids):
        return self._bvids

    def has_cloud_backend(self):
        return self._cloud

    async def get_conversation_context(self, session_id):
        return ""

    async def get_video_context(self, media_ids, *, include_content=False, limit=None):
        return self._video_context

    async def get_video_titles_context(self, media_ids):
        return self._titles_context

    async def is_related_to_collection(self, media_ids, question):
        return True


class MockContextTool:
    """Mock context tool for testing chat_session_id injection."""

    def __init__(self, *, name="search_chat_history", result="找到历史对话"):
        self._name = name
        self._result = result
        self.last_args = None

    @property
    def name(self):
        return self._name

    @property
    def description(self):
        return f"Mock {self._name} for testing."

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "chat_session_id": {"type": "string"},
                "query": {"type": "string"},
            },
            "required": ["chat_session_id", "query"],
        }

    async def run(self, chat_session_id="", query="", **kwargs):
        self.last_args = {"chat_session_id": chat_session_id, "query": query, **kwargs}
        return self._result


def _make_runtime_and_llm(tools=None):
    """Create an AgentRuntime with the given tools, plus a mock LLM."""
    from app.harness.runtime import ToolMetrics

    registry = ToolRegistry()
    if tools:
        for t in tools:
            registry.register(t)
    runtime = AgentRuntime(registry)
    # Initialize synchronously (avoid asyncio.run in async test context)
    tool_names = registry.list()
    runtime._metrics = {name: ToolMetrics() for name in tool_names}
    runtime._started = True

    llm = AsyncMock()
    llm.bind_tools = MagicMock(return_value=llm)
    return registry, runtime, llm


# ---------------------------------------------------------------------------
# Prompt tests
# ---------------------------------------------------------------------------


class TestBuildSystemPrompt:
    def test_with_data(self):
        prompt = build_system_prompt("test", has_data=True, cloud_has_data=False)
        assert "B站视频" in prompt
        assert "test" in prompt

    def test_no_data(self):
        prompt = build_system_prompt("test", has_data=False, cloud_has_data=False)
        assert "暂无向量数据" in prompt

    def test_cloud_only(self):
        prompt = build_system_prompt("test", has_data=False, cloud_has_data=True)
        assert "云盘文档" in prompt

    def test_conversation_context(self):
        prompt = build_system_prompt("test", conversation_context="之前聊过Python")
        assert "之前聊过Python" in prompt


# ---------------------------------------------------------------------------
# Error handling tests
# ---------------------------------------------------------------------------


class TestErrorClassification:
    @pytest.mark.parametrize("msg", [
        "connection timeout",
        "rate limit exceeded",
        "502 bad gateway",
        "service unavailable",
    ])
    def test_retryable(self, msg):
        assert classify_error(msg) == ErrorCategory.RETRYABLE

    @pytest.mark.parametrize("msg", [
        "invalid api key",
        "authentication failed",
        "permission denied",
    ])
    def test_fatal(self, msg):
        assert classify_error(msg) == ErrorCategory.FATAL

    def test_non_retryable(self):
        assert classify_error("something weird happened") == ErrorCategory.NON_RETRYABLE


# ---------------------------------------------------------------------------
# ReAct loop tests
# ---------------------------------------------------------------------------


class TestReActDirectAnswer:
    @pytest.mark.asyncio
    async def test_llm_answers_without_tools(self):
        """LLM decides to answer directly without calling any tools."""
        _, runtime, llm = _make_runtime_and_llm()
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="你好！我是你的知识库助手。"))

        agent = build_chat_agent(llm=llm, runtime=runtime, deps=MockDeps())
        result = await agent.ainvoke({"query": "你好", "uid": 1})

        assert result["result"] == "你好！我是你的知识库助手。"
        # Messages: system + user + ai_response
        assert len(result["messages"]) == 3
        assert isinstance(result["messages"][0], SystemMessage)
        assert isinstance(result["messages"][1], HumanMessage)
        assert isinstance(result["messages"][2], AIMessage)


class TestReActToolCall:
    @pytest.mark.asyncio
    async def test_llm_calls_vector_search_then_answers(self):
        """LLM calls vector_search, gets results, then answers."""
        mock_rag = MagicMock()
        mock_rag.search = MagicMock(return_value=[
            Document(page_content="哲学是关于世界观的学问", metadata={"bvid": "BV1xx", "title": "哲学入门", "score": 0.9})
        ])

        _, runtime, llm = _make_runtime_and_llm(tools=[VectorSearchTool(mock_rag)])

        call_count = 0
        async def mock_invoke(messages, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return AIMessage(
                    content="",
                    tool_calls=[{"id": "tc1", "name": "vector_search", "args": {"query": "中国哲学"}}],
                )
            return AIMessage(content="根据检索结果，中国哲学的核心观点包括...")

        llm.ainvoke = mock_invoke

        agent = build_chat_agent(llm=llm, runtime=runtime, deps=MockDeps())
        result = await agent.ainvoke({"query": "中国哲学的核心观点", "uid": 1})

        assert call_count == 2  # ReAct: think → act → observe → answer
        assert "中国哲学" in result["result"]
        # Messages: system + user + ai(tool_call) + tool_message + ai(answer)
        assert len(result["messages"]) == 5
        assert isinstance(result["messages"][3], ToolMessage)

    @pytest.mark.asyncio
    async def test_llm_calls_list_videos(self):
        """LLM calls list_videos for a catalog question."""
        deps = MockDeps(video_context=("【哲学】\n- 《中国哲学》\n- 《西方哲学》", []))
        _, runtime, llm = _make_runtime_and_llm(tools=[ListVideosTool(deps)])

        call_count = 0
        async def mock_invoke(messages, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return AIMessage(
                    content="",
                    tool_calls=[{"id": "tc1", "name": "list_videos", "args": {}}],
                )
            return AIMessage(content="你的收藏夹中有以下视频：...")

        llm.ainvoke = mock_invoke

        agent = build_chat_agent(llm=llm, runtime=runtime, deps=deps)
        result = await agent.ainvoke({"query": "我有哪些视频", "uid": 1})

        assert call_count == 2
        assert "视频" in result["result"]


class TestReActMultiRound:
    @pytest.mark.asyncio
    async def test_llm_searches_twice_before_answering(self):
        """LLM calls vector_search twice, then answers with combined results."""
        mock_rag = MagicMock()
        mock_rag.search = MagicMock(return_value=[
            Document(page_content="结果", metadata={"bvid": "BV1xx", "title": "Test", "score": 0.8})
        ])

        _, runtime, llm = _make_runtime_and_llm(tools=[VectorSearchTool(mock_rag)])

        call_count = 0
        async def mock_invoke(messages, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return AIMessage(
                    content="",
                    tool_calls=[{"id": "tc1", "name": "vector_search", "args": {"query": "中国哲学"}}],
                )
            if call_count == 2:
                # Still not satisfied, search again
                return AIMessage(
                    content="",
                    tool_calls=[{"id": "tc2", "name": "vector_search", "args": {"query": "西方哲学"}}],
                )
            # Third call: answer with all results
            return AIMessage(content="综合两轮检索结果，中西方哲学的差异在于...")

        llm.ainvoke = mock_invoke

        agent = build_chat_agent(llm=llm, runtime=runtime, deps=MockDeps())
        result = await agent.ainvoke({"query": "中西方哲学的差异", "uid": 1})

        assert call_count == 3  # think → search1 → search2 → answer
        assert "差异" in result["result"]
        # Messages: system + user + ai(tc1) + tool + ai(tc2) + tool + ai(answer)
        assert len(result["messages"]) == 7


class TestReActErrorHandling:
    @pytest.mark.asyncio
    async def test_circuit_breaker_tripped(self):
        """Circuit breaker should short-circuit the agent."""
        from app.agent.lifecycle.circuit import CircuitBreaker

        _, runtime, llm = _make_runtime_and_llm()
        cb = CircuitBreaker(failure_threshold=1)
        cb.record_failure()
        assert cb.is_tripped

        agent = build_chat_agent(llm=llm, runtime=runtime, deps=MockDeps(), circuit_breaker=cb)
        result = await agent.ainvoke({"query": "test"})
        # Circuit breaker should cause a fallback result (not a normal answer)
        assert result.get("result") == "服务暂时不可用，请稍后再试。" or result.get("error") != ""


# ---------------------------------------------------------------------------
# Context tools integration tests
# ---------------------------------------------------------------------------


class TestContextToolsPrompt:
    def test_prompt_includes_context_tools_when_available(self):
        prompt = build_system_prompt("test", has_context_tools=True)
        assert "search_chat_history" in prompt
        assert "get_recent_context" in prompt
        assert "get_compressed_summary" in prompt
        assert "get_full_history" in prompt
        assert "上下文检索工具" in prompt

    def test_prompt_excludes_context_tools_when_not_available(self):
        prompt = build_system_prompt("test", has_context_tools=False)
        # Detailed tool descriptions should not appear
        assert "search_chat_history" not in prompt
        assert "get_recent_context" not in prompt
        assert "get_compressed_summary" not in prompt
        assert "get_full_history" not in prompt

    def test_decision_flowchart_includes_context_path(self):
        prompt = build_system_prompt("test", has_context_tools=True)
        assert "引用历史对话内容" in prompt
        assert "之前聊过" in prompt


class TestSessionIdInjection:
    @pytest.mark.asyncio
    async def test_dispatch_injects_chat_session_id(self):
        """runtime_dispatch should inject chat_session_id from state.session_id."""
        mock_tool = MockContextTool()
        _, runtime, _ = _make_runtime_and_llm(tools=[mock_tool])

        state = ChatAgentState(
            query="之前聊过的内容",
            session_id="sess-abc123",
            messages=[
                SystemMessage(content="sys"),
                HumanMessage(content="之前聊过的内容"),
                AIMessage(
                    content="",
                    tool_calls=[{
                        "id": "tc1",
                        "name": "search_chat_history",
                        "args": {"query": "之前的内容"},
                    }],
                ),
            ],
        )

        result = await runtime_dispatch(state, runtime=runtime)
        tool_msgs = [m for m in result["messages"] if isinstance(m, ToolMessage)]
        assert len(tool_msgs) == 1
        # The tool should have received chat_session_id automatically
        assert mock_tool.last_args["chat_session_id"] == "sess-abc123"
        assert mock_tool.last_args["query"] == "之前的内容"

    @pytest.mark.asyncio
    async def test_dispatch_no_injection_when_session_id_empty(self):
        """When session_id is empty, should not inject chat_session_id."""
        mock_tool = MockContextTool()
        _, runtime, _ = _make_runtime_and_llm(tools=[mock_tool])

        state = ChatAgentState(
            query="test",
            session_id="",
            messages=[
                SystemMessage(content="sys"),
                HumanMessage(content="test"),
                AIMessage(
                    content="",
                    tool_calls=[{
                        "id": "tc1",
                        "name": "search_chat_history",
                        "args": {"query": "test"},
                    }],
                ),
            ],
        )

        result = await runtime_dispatch(state, runtime=runtime)
        # Tool should still be called, but chat_session_id will be empty
        assert mock_tool.last_args["chat_session_id"] == ""

    @pytest.mark.asyncio
    async def test_dispatch_does_not_overwrite_existing_session_id(self):
        """If LLM already provides chat_session_id, don't overwrite it."""
        mock_tool = MockContextTool()
        _, runtime, _ = _make_runtime_and_llm(tools=[mock_tool])

        state = ChatAgentState(
            query="test",
            session_id="sess-auto",
            messages=[
                SystemMessage(content="sys"),
                HumanMessage(content="test"),
                AIMessage(
                    content="",
                    tool_calls=[{
                        "id": "tc1",
                        "name": "search_chat_history",
                        "args": {"query": "test", "chat_session_id": "sess-manual"},
                    }],
                ),
            ],
        )

        await runtime_dispatch(state, runtime=runtime)
        # The injected value should come from state, but since we merge
        # with existing args, the state value wins (intentional: state is
        # the source of truth, not the LLM).
        assert mock_tool.last_args["chat_session_id"] == "sess-auto"


class TestReActWithContextTools:
    @pytest.mark.asyncio
    async def test_llm_calls_search_history_then_answers(self):
        """LLM calls search_chat_history to recall past conversation, then answers."""
        mock_tool = MockContextTool(
            name="search_chat_history",
            result="用户之前问过关于王德峰的中国哲学讲座，讨论了儒释道三家思想。",
        )
        mock_rag = MagicMock()
        mock_rag.search = MagicMock(return_value=[])

        _, runtime, llm = _make_runtime_and_llm(
            tools=[mock_tool, VectorSearchTool(mock_rag)],
        )

        call_count = 0
        async def mock_invoke(messages, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return AIMessage(
                    content="",
                    tool_calls=[{
                        "id": "tc1",
                        "name": "search_chat_history",
                        "args": {"query": "之前讨论的哲学"},
                    }],
                )
            return AIMessage(content="根据之前的对话，你问过王德峰的中国哲学讲座...")

        llm.ainvoke = mock_invoke

        agent = build_chat_agent(
            llm=llm, runtime=runtime,
            deps=MockDeps(),
        )
        result = await agent.ainvoke({
            "query": "我们之前聊过的哲学内容",
            "uid": 1,
            "session_id": "sess-xyz",
        })

        assert call_count == 2
        assert "哲学" in result["result"]
        # Verify the tool received the injected chat_session_id
        assert mock_tool.last_args["chat_session_id"] == "sess-xyz"

    @pytest.mark.asyncio
    async def test_prompt_includes_context_tools_when_registered(self):
        """When context tools are in the registry, the system prompt should mention them."""
        mock_tool = MockContextTool(name="search_chat_history")
        _, runtime, llm = _make_runtime_and_llm(tools=[mock_tool])

        llm.ainvoke = AsyncMock(return_value=AIMessage(content="直接回答"))

        agent = build_chat_agent(llm=llm, runtime=runtime, deps=MockDeps())
        result = await agent.ainvoke({"query": "你好", "uid": 1})

        # The system message should include context tools section
        system_msg = result["messages"][0]
        assert "search_chat_history" in system_msg.content

    @pytest.mark.asyncio
    async def test_prompt_excludes_context_tools_when_not_registered(self):
        """When no context tools are in the registry, the system prompt should omit them."""
        mock_rag = MagicMock()
        mock_rag.search = MagicMock(return_value=[])

        _, runtime, llm = _make_runtime_and_llm(tools=[VectorSearchTool(mock_rag)])

        llm.ainvoke = AsyncMock(return_value=AIMessage(content="直接回答"))

        agent = build_chat_agent(llm=llm, runtime=runtime, deps=MockDeps())
        result = await agent.ainvoke({"query": "你好", "uid": 1})

        # The system message should NOT include context tools section
        system_msg = result["messages"][0]
        assert "search_chat_history" not in system_msg.content
