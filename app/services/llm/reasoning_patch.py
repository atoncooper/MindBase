"""Preserve thinking-model reasoning deltas that langchain-openai drops.

The AI gateway's reasoning models stream thinking text under
``delta.reasoning`` (OpenRouter style; DeepSeek-style providers use
``delta.reasoning_content``). The pinned langchain-openai (0.2.6) delta
converter only keeps ``content`` / ``function_call`` / ``tool_calls`` and
silently discards every other delta field, so reasoning never reaches the
agent SSE streamer and the client's collapsed thinking block stays empty.

Wrapping the module-level converter copies the raw reasoning text into
the chunk's ``additional_kwargs["reasoning_content"]`` (merged across
deltas) — additive only, no other field is touched. Install is idempotent
and applied once at import of ``app.services.llm.factory``.
"""

from __future__ import annotations

import functools
from typing import Any, Mapping, Type

from langchain_core.messages import BaseMessageChunk


def install_reasoning_capture() -> None:
    """Patch ``_convert_delta_to_message_chunk`` to retain reasoning deltas."""
    from langchain_core.messages import AIMessageChunk

    import langchain_openai.chat_models.base as _base

    original = _base._convert_delta_to_message_chunk
    if getattr(original, "_reasoning_capture_installed", False):
        return

    @functools.wraps(original)
    def wrapper(
        _dict: Mapping[str, Any], default_class: Type[BaseMessageChunk]
    ) -> BaseMessageChunk:
        chunk = original(_dict, default_class)
        reasoning = _dict.get("reasoning") or _dict.get("reasoning_content")
        if (
            isinstance(chunk, AIMessageChunk)
            and isinstance(reasoning, str)
            and reasoning
        ):
            existing = chunk.additional_kwargs.get("reasoning_content") or ""
            chunk.additional_kwargs = {
                **chunk.additional_kwargs,
                "reasoning_content": existing + reasoning,
            }
        return chunk

    wrapper._reasoning_capture_installed = True  # type: ignore[attr-defined]
    _base._convert_delta_to_message_chunk = wrapper
