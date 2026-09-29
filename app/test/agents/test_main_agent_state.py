"""Tests for MainAgentState and ChatAgentResult."""


from app.agent.main.state import ChatAgentResult, MainAgentState


class TestMainAgentState:
    def test_default_values(self):
        s = MainAgentState(query="hello")
        assert s.query == "hello"
        assert s.session_id == ""
        assert s.uid is None
        assert s.folder_ids == []
        assert s.workspace_pages == []
        assert s.workspace_id is None
        assert s.media_ids == []
        assert s.bvids == []
        assert s.has_data is False
        assert s.cloud_has_data is False
        assert s.messages == []
        assert s.search_results == []
        assert s.result == ""
        assert s.sources == []
        assert s.error == ""
        assert s.step_count == 0
        assert s.max_steps == 10

    def test_with_all_inputs(self):
        s = MainAgentState(
            query="test",
            session_id="sess-1",
            uid=42,
            folder_ids=[100, 200],
        )
        assert s.session_id == "sess-1"
        assert s.uid == 42
        assert s.folder_ids == [100, 200]

    def test_partial_update(self):
        s = MainAgentState(query="q")
        merged = s.model_copy(update={"bvids": ["BV1xx"], "has_data": True})
        assert merged.bvids == ["BV1xx"]
        assert merged.has_data is True
        assert merged.query == "q"


class TestChatAgentResult:
    def test_defaults(self):
        r = ChatAgentResult()
        assert r.result == ""
        assert r.messages == []
        assert r.sources == []
        assert r.error == ""

    def test_with_values(self):
        from langchain_core.messages import HumanMessage, SystemMessage
        msgs = [SystemMessage(content="sys"), HumanMessage(content="hi")]
        r = ChatAgentResult(
            result="answer",
            messages=msgs,
            sources=[{"bvid": "BV1xx", "title": "t"}],
        )
        assert r.result == "answer"
        assert len(r.messages) == 2
        assert len(r.sources) == 1
