"""Tests for the board MCP proxy tools (app/tools/board/)."""

import json

import pytest

from app.services.board.mcp import BoardMCPError, BoardMCPUnavailableError, _lazy_client
from app.tools.board.board_create import BoardCreateTool
from app.tools.board.board_delete import BoardDeleteTool
from app.tools.board.board_get import BoardGetTool
from app.tools.board.board_list import BoardListTool
from app.tools.board.board_update import BoardUpdateTool


class FakeMCPClient:
    """Records calls, returns canned payloads or raises."""

    def __init__(self, result=None, error=None):
        self.calls: list[tuple[int, str, dict]] = []
        self.result = result if result is not None else {"ok": True}
        self.error = error

    async def call(self, uid: int, tool: str, arguments: dict) -> dict:
        self.calls.append((uid, tool, arguments))
        if isinstance(self.error, Exception):
            raise self.error
        return self.result


@pytest.fixture
def fake_client(monkeypatch):
    client = FakeMCPClient()
    monkeypatch.setattr("app.services.board.mcp._lazy_client._instance", client)
    return client


UID = 42


class TestUidHandling:
    @pytest.mark.asyncio
    async def test_missing_uid_never_calls_upstream(self, fake_client):
        result = await BoardGetTool().run(board_uuid="u-1")  # no _uid kwarg
        assert "无法识别用户身份" in result["content"]
        assert fake_client.calls == []

    @pytest.mark.asyncio
    async def test_uid_forwarded_as_service_identity(self, fake_client):
        result = await BoardGetTool().run(board_uuid="u-1", _uid=UID)
        assert fake_client.calls == [(UID, "get_board", {"board_uuid": "u-1"})]
        assert json.loads(result["content"]) == {"ok": True}

    @pytest.mark.asyncio
    async def test_invalid_uid_treated_as_missing(self, fake_client):
        result = await BoardGetTool().run(board_uuid="u-1", _uid="abc")
        assert "无法识别用户身份" in result["content"]
        assert fake_client.calls == []


class TestErrorMapping:
    @pytest.mark.asyncio
    async def test_tool_error_mapped(self, fake_client):
        fake_client.error = BoardMCPError("app-board 返回 404：board not found")
        result = await BoardGetTool().run(board_uuid="u-1", _uid=UID)
        assert "板子操作失败" in result["content"] and "404" in result["content"]

    @pytest.mark.asyncio
    async def test_unavailable_mapped(self, fake_client):
        fake_client.error = BoardMCPUnavailableError("board 服务暂不可达")
        result = await BoardListTool().run(_uid=UID)
        assert "暂不可用" in result["content"]


class TestArgumentPassthrough:
    @pytest.mark.asyncio
    async def test_board_list_defaults(self, fake_client):
        await BoardListTool().run(_uid=UID)
        assert fake_client.calls == [(UID, "list_boards", {})]

    @pytest.mark.asyncio
    async def test_board_list_filters(self, fake_client):
        await BoardListTool().run(kind="mindmap", page=2, page_size=50, _uid=UID)
        assert fake_client.calls == [(UID, "list_boards", {"kind": "mindmap", "page": 2, "page_size": 50})]

    @pytest.mark.asyncio
    async def test_board_create_defaults_to_mindmap(self, fake_client):
        content = {"root": {"data": {"text": "root"}, "children": []}}
        await BoardCreateTool().run(title="树", _uid=UID)
        assert fake_client.calls[-1][2] == {"title": "树", "kind": "mindmap"}

        await BoardCreateTool().run(title="树", content=content, _uid=UID)
        assert fake_client.calls[-1][2]["content"] == content

    @pytest.mark.asyncio
    async def test_board_update_omits_unset_fields(self, fake_client):
        await BoardUpdateTool().run(board_uuid="u-1", expected_version=7, content={"root": {}}, _uid=UID)
        sent = fake_client.calls[-1][2]
        assert sent == {"board_uuid": "u-1", "expected_version": 7, "content": {"root": {}}}
        assert "title" not in sent and "is_pinned" not in sent

    @pytest.mark.asyncio
    async def test_board_delete(self, fake_client):
        await BoardDeleteTool().run(board_uuid="u-1", _uid=UID)
        assert fake_client.calls == [(UID, "delete_board", {"board_uuid": "u-1"})]
