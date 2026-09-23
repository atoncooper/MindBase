"""Tests for the reasoning-delta capture patch (reasoning_patch.py).

The AI gateway's reasoning models stream thinking text as
``delta.reasoning`` (OpenRouter style) or ``delta.reasoning_content``
(DeepSeek style). The pinned langchain-openai (0.2.6) delta converter
drops both; the patched converter must copy the text into
``additional_kwargs["reasoning_content"]`` so the agent SSE streamer can
relay it, without touching any other delta field.
"""

from __future__ import annotations

import langchain_core.messages as lc_messages
import pytest
from langchain_core.messages import AIMessageChunk

import langchain_openai.chat_models.base as openai_base
from app.services.llm.reasoning_patch import install_reasoning_capture


@pytest.fixture(autouse=True)
def _restore_converter():
    """Snapshot the converter around each test so the monkeypatched wrapper
    never leaks into unrelated tests."""
    original = openai_base._convert_delta_to_message_chunk
    yield
    openai_base._convert_delta_to_message_chunk = original


class TestReasoningCapture:
    def test_install_is_idempotent(self) -> None:
        install_reasoning_capture()
        once = openai_base._convert_delta_to_message_chunk
        install_reasoning_capture()
        assert openai_base._convert_delta_to_message_chunk is once

    def test_gateway_style_reasoning_key_captured(self) -> None:
        install_reasoning_capture()
        chunk = openai_base._convert_delta_to_message_chunk(
            {"role": "assistant", "content": "", "reasoning": "The user"},
            lc_messages.AIMessageChunk,
        )
        assert isinstance(chunk, AIMessageChunk)
        assert chunk.additional_kwargs["reasoning_content"] == "The user"
        assert chunk.content == ""

    def test_deepseek_style_reasoning_content_key_captured(self) -> None:
        install_reasoning_capture()
        chunk = openai_base._convert_delta_to_message_chunk(
            {"role": "assistant", "content": "", "reasoning_content": "思考中"},
            lc_messages.AIMessageChunk,
        )
        assert chunk.additional_kwargs["reasoning_content"] == "思考中"

    def test_content_delta_untouched(self) -> None:
        install_reasoning_capture()
        chunk = openai_base._convert_delta_to_message_chunk(
            {"role": "assistant", "content": "答案"},
            lc_messages.AIMessageChunk,
        )
        assert chunk.content == "答案"
        assert "reasoning_content" not in chunk.additional_kwargs

    def test_tool_call_delta_still_converted(self) -> None:
        install_reasoning_capture()
        chunk = openai_base._convert_delta_to_message_chunk(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "board_get", "arguments": "{}"},
                    }
                ],
            },
            lc_messages.AIMessageChunk,
        )
        assert chunk.tool_call_chunks[0]["name"] == "board_get"

    def test_reasoning_merge_across_deltas(self) -> None:
        # Chunks are merged with "+"; additional_kwargs reasoning values
        # concatenate (AIMessageChunk.__add__ handles str values).
        install_reasoning_capture()
        a = openai_base._convert_delta_to_message_chunk(
            {"role": "assistant", "content": "", "reasoning": "第一步"},
            lc_messages.AIMessageChunk,
        )
        b = openai_base._convert_delta_to_message_chunk(
            {"role": "assistant", "content": "", "reasoning": "第二步"},
            lc_messages.AIMessageChunk,
        )
        merged = a + b
        assert merged.additional_kwargs["reasoning_content"] == "第一步第二步"

    def test_non_ai_default_class_skipped(self) -> None:
        install_reasoning_capture()
        chunk = openai_base._convert_delta_to_message_chunk(
            {"role": "tool", "tool_call_id": "t1", "content": "res"},
            lc_messages.ToolMessageChunk,
        )
        assert chunk.content == "res"
        assert "reasoning_content" not in getattr(chunk, "additional_kwargs", {})
