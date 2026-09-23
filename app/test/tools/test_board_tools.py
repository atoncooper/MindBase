"""Tests for the board MCP proxy tools (app/tools/board/)."""

import json

import pytest

from app.services.board.mcp import BoardMCPError, BoardMCPUnavailableError, _lazy_client
from app.tools.board.board_create import BoardCreateTool
from app.tools.board.board_delete import BoardDeleteTool
from app.tools.board.board_get import BoardGetTool
from app.tools.board.board_list import BoardListTool
from app.tools.board.board_navigate import BoardNavigateTool
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


def _big_mindmap_doc(node_count: int) -> str:
    """A mind-map doc JSON string whose size scales with node_count."""
    children = [
        {"data": {"text": f"节点 {i} 的内容文本"}, "children": []} for i in range(node_count)
    ]
    doc = {"root": {"data": {"text": "根节点"}, "children": children}, "layout": "logicalStructure"}
    return json.dumps(doc, ensure_ascii=False)


class TestOutlinePlainText:
    """Outline texts must be plain (no raw rich-text HTML/entities) and
    whitespace-collapsed — the agent copies them verbatim as anchor/remove
    targets and the frontend matcher normalizes the same way."""

    @pytest.mark.asyncio
    async def test_rich_html_text_stripped_in_outline(self, fake_client):
        doc = json.dumps(
            {
                "root": {
                    "data": {"text": "根"},
                    "children": [
                        {"data": {"text": "<span style=\"color:red\">哲学 &amp; 逻辑</span>"}, "children": []}
                    ],
                }
            },
            ensure_ascii=False,
        )
        fake_client.result = {"uuid": "u-9", "content": doc + " " * 9000}
        result = await BoardGetTool().run(board_uuid="u-9", _uid=UID)
        view = json.loads(result["content"])
        outline = view["content_outline"]
        assert "<span" not in outline
        assert "哲学 & 逻辑" in outline

    def test_plain_text_order_matches_frontend(self):
        from app.tools.board._base import _plain_text

        # strip tags FIRST, then entities — escaped literals (<b>) must
        # survive as literal text, same as the frontend normalizer.
        assert _plain_text("<b>加粗</b> 文本") == "加粗 文本"
        assert _plain_text("a &lt;b&gt; c") == "a <b> c"
        assert _plain_text("多  空格\t制表") == "多 空格 制表"


class TestLLMViewPayloadBudget:
    """board_get/create/update results are embedded verbatim into the next
    LLM request; oversized docs must be replaced by an outline so the turn
    does not die on the gateway request-size limit (413)."""

    @pytest.mark.asyncio
    async def test_small_doc_keeps_full_content(self, fake_client):
        doc = _big_mindmap_doc(3)
        fake_client.result = {"uuid": "u-1", "title": "t", "version": 1, "content": doc}
        result = await BoardGetTool().run(board_uuid="u-1", _uid=UID)
        view = json.loads(result["content"])
        assert view["content"] == doc
        assert "content_full" not in view

    @pytest.mark.asyncio
    async def test_large_doc_replaced_by_outline(self, fake_client):
        doc = _big_mindmap_doc(1200)  # well past the 8k char limit
        assert len(doc) > 8000
        fake_client.result = {"uuid": "u-1", "title": "t", "version": 1, "content": doc}
        result = await BoardGetTool().run(board_uuid="u-1", _uid=UID)

        view = json.loads(result["content"])
        assert "content" not in view
        assert view["content_full"] is False
        assert "节点 0" in view["content_outline"]
        assert "禁止" in view["hint"]
        # Raw doc stays available to programmatic consumers, never to the LLM.
        assert result["data"]["content"] == doc

    @pytest.mark.asyncio
    async def test_large_whiteboard_doc_replaced_by_excerpt(self, fake_client):
        raw = json.dumps({"elements": [{"id": i, "type": "rectangle"} for i in range(1500)]})
        fake_client.result = {"uuid": "u-2", "kind": "whiteboard", "content": raw}
        result = await BoardGetTool().run(board_uuid="u-2", _uid=UID)

        view = json.loads(result["content"])
        assert "content" not in view
        assert "content_outline" not in view
        assert view["content_excerpt"].startswith('{"elements"')
        assert view["content_full"] is False

    @pytest.mark.asyncio
    async def test_payload_without_content_untouched(self, fake_client):
        fake_client.result = {"uuid": "u-3", "deleted": True}
        result = await BoardGetTool().run(board_uuid="u-3", _uid=UID)
        assert json.loads(result["content"]) == {"uuid": "u-3", "deleted": True}

    @pytest.mark.asyncio
    async def test_board_update_large_content_echo_is_also_capped(self, fake_client):
        # update_board echoes the stored doc back; the same budget applies to
        # the LLM-facing view while the outgoing request is unaffected.
        doc = _big_mindmap_doc(1200)
        fake_client.result = {"uuid": "u-1", "version": 2, "content": doc}
        result = await BoardUpdateTool().run(board_uuid="u-1", content={"root": {}}, _uid=UID)

        sent = fake_client.calls[-1][2]
        assert sent["content"] == {"root": {}}
        view = json.loads(result["content"])
        assert view["content_full"] is False
        assert "content" not in view


def _nav_doc() -> str:
    """三层示例树：根 > {数学, 物理}；数学 > {极限, 导数}。"""
    doc = {
        "root": {
            "data": {"text": "高数"},
            "children": [
                {
                    "data": {"text": "数学"},
                    "children": [
                        {"data": {"text": "极限"}, "children": []},
                        {"data": {"text": "导数"}, "children": []},
                    ],
                },
                {"data": {"text": "物理"}, "children": []},
            ],
        }
    }
    return json.dumps(doc, ensure_ascii=False)


class TestBoardNavigate:
    @pytest.fixture
    def nav_client(self, monkeypatch):
        client = FakeMCPClient(result={"uuid": "u-nav", "content": _nav_doc()})
        monkeypatch.setattr("app.services.board.mcp._lazy_client._instance", client)
        return client

    @pytest.mark.asyncio
    async def test_children_view(self, nav_client):
        result = await BoardNavigateTool().run(board_uuid="u-nav", view="children", target="数学", _uid=UID)
        view = json.loads(result["content"])
        assert [i["text"] for i in view["items"]] == ["极限", "导数"]
        assert view["child_count"] == 2

    @pytest.mark.asyncio
    async def test_siblings_view_marks_target(self, nav_client):
        result = await BoardNavigateTool().run(board_uuid="u-nav", view="siblings", target="物理", _uid=UID)
        view = json.loads(result["content"])
        assert view["parent"] == "高数"
        assert [i["is_target"] for i in view["items"]] == [False, True]

    @pytest.mark.asyncio
    async def test_parent_view_of_root(self, nav_client):
        result = await BoardNavigateTool().run(board_uuid="u-nav", view="parent", target="高数", _uid=UID)
        view = json.loads(result["content"])
        assert "中心主题" in view["parent"]

    @pytest.mark.asyncio
    async def test_subtree_view(self, nav_client):
        result = await BoardNavigateTool().run(board_uuid="u-nav", view="subtree", target="数学", _uid=UID)
        view = json.loads(result["content"])
        assert "- 数学" in view["subtree_outline"] and "极限" in view["subtree_outline"]

    @pytest.mark.asyncio
    async def test_search_returns_paths(self, nav_client):
        result = await BoardNavigateTool().run(board_uuid="u-nav", view="search", keyword="导数", _uid=UID)
        view = json.loads(result["content"])
        assert len(view["matches"]) == 1
        assert view["matches"][0]["path"] == "高数 > 数学 > 导数"

    @pytest.mark.asyncio
    async def test_duplicate_target_rejected(self, nav_client):
        doc = json.dumps(
            {"root": {"data": {"text": "根"}, "children": [
                {"data": {"text": "同名"}, "children": []},
                {"data": {"text": "同名"}, "children": []},
            ]}},
            ensure_ascii=False,
        )
        nav_client.result = {"uuid": "u-nav", "content": doc}
        result = await BoardNavigateTool().run(board_uuid="u-nav", view="children", target="同名", _uid=UID)
        view = json.loads(result["content"])
        assert "同名节点" in view["error"]

    @pytest.mark.asyncio
    async def test_truncated_prefix_unique_match(self, nav_client):
        result = await BoardNavigateTool().run(board_uuid="u-nav", view="children", target="极限…", _uid=UID)
        view = json.loads(result["content"])
        # 唯一前缀命中 → 正常返回（大纲截断文本可用）
        assert view.get("child_count") == 0

    @pytest.mark.asyncio
    async def test_mcp_failure_passthrough(self, nav_client):
        nav_client.error = BoardMCPUnavailableError("board 服务暂不可达")
        result = await BoardNavigateTool().run(board_uuid="u-nav", view="children", target="数学", _uid=UID)
        assert "暂不可用" in result["content"]
