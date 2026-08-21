"""Tests for ChatRequest validation in app/response/chat.py.

Validates:
- workspace_pages and workspace_id are mutually exclusive.
- The deprecated ``mode`` field carries the AgentHarness deprecation hint.
- The validator allows either scope alone (or none).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.response.chat import ChatRequest, WorkspacePage


class TestSearchScopeValidation:
    def test_neither_scope_allowed(self) -> None:
        req = ChatRequest(question="hi")
        assert req.workspace_pages is None
        assert req.workspace_id is None

    def test_only_workspace_pages_allowed(self) -> None:
        req = ChatRequest(
            question="hi",
            workspace_pages=[
                WorkspacePage(bvid="BV1", cid=1, page_index=0),
            ],
        )
        assert req.workspace_id is None
        assert len(req.workspace_pages) == 1

    def test_only_workspace_id_allowed(self) -> None:
        req = ChatRequest(question="hi", workspace_id=42)
        assert req.workspace_id == 42
        assert not req.workspace_pages

    def test_both_scopes_rejected(self) -> None:
        with pytest.raises(ValidationError) as excinfo:
            ChatRequest(
                question="hi",
                workspace_pages=[
                    WorkspacePage(bvid="BV1", cid=1, page_index=0),
                ],
                workspace_id=42,
            )
        assert "不能同时指定" in str(excinfo.value)

    def test_empty_workspace_pages_with_workspace_id_allowed(self) -> None:
        """Empty list should not count as 'has pages' — only workspace_id is set."""
        req = ChatRequest(
            question="hi",
            workspace_pages=[],
            workspace_id=42,
        )
        assert req.workspace_id == 42


class TestModeFieldDeprecation:
    def test_default_mode_is_standard(self) -> None:
        req = ChatRequest(question="hi")
        assert req.mode == "standard"

    def test_mode_field_metadata_mentions_agent_harness(self) -> None:
        field = ChatRequest.model_fields["mode"]
        # Pydantic v2 stores the deprecation message via the deprecated kwarg
        deprecated = getattr(field, "deprecated", None) or getattr(
            field, "deprecation_message", None
        )
        text = str(deprecated)
        assert "AgentHarness" in text
