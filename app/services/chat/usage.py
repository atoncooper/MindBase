"""Token-usage callback handler.

The agent's ReAct loop may invoke the LLM multiple times.  We need a
single accumulated token count per turn so we can write it to the
``api_usage`` table and surface it on the assistant message.

Attaching this handler via ``run_config['callbacks']`` keeps token
accounting orthogonal to the graph definition.
"""

from __future__ import annotations

from threading import Lock
from typing import Any, Optional

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult


class TokenUsageHandler(BaseCallbackHandler):
    """Sum ``token_usage.total_tokens`` across all LLM completions in a run."""

    def __init__(self) -> None:
        super().__init__()
        self._lock = Lock()
        self._total_tokens = 0
        self._prompt_tokens = 0
        self._completion_tokens = 0
        self._calls = 0

    @property
    def total_tokens(self) -> int:
        return self._total_tokens

    @property
    def prompt_tokens(self) -> int:
        return self._prompt_tokens

    @property
    def completion_tokens(self) -> int:
        return self._completion_tokens

    @property
    def llm_calls(self) -> int:
        return self._calls

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:  # noqa: D401
        usage = self._extract_usage(response)
        if usage is None:
            return
        with self._lock:
            self._calls += 1
            self._total_tokens += int(usage.get("total_tokens") or 0)
            self._prompt_tokens += int(usage.get("prompt_tokens") or 0)
            self._completion_tokens += int(usage.get("completion_tokens") or 0)

    @staticmethod
    def _extract_usage(response: LLMResult) -> Optional[dict[str, Any]]:
        llm_output = getattr(response, "llm_output", None) or {}
        usage = llm_output.get("token_usage") or llm_output.get("usage")
        if isinstance(usage, dict) and usage:
            return usage

        for gen_list in getattr(response, "generations", []) or []:
            for gen in gen_list or []:
                msg = getattr(gen, "message", None)
                if msg is None:
                    continue
                meta = getattr(msg, "usage_metadata", None)
                if isinstance(meta, dict) and meta:
                    return {
                        "total_tokens": meta.get("total_tokens"),
                        "prompt_tokens": meta.get("input_tokens"),
                        "completion_tokens": meta.get("output_tokens"),
                    }
        return None
