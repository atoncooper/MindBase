"""Usage tracking callback — records LLM token usage via LangChain callbacks.

Provides:
- ``UsageTrackingCallback``: a LangChain BaseCallbackHandler that extracts
  token usage from both streaming and non-streaming LLM completions and
  enqueues records to a BufferedUsageWriter.
- ``attach_usage_tracking``: helper to attach the callback to a LangChain
  chat model without mutating the original object.

Data flow:
    on_llm_end -> extract token_usage -> compute cost -> enqueue to writer

Token usage sources:
    - Non-streaming (ainvoke): llm_output["token_usage"]
    - Streaming (astream): generations[0][0].message.usage_metadata
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional, TYPE_CHECKING

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult
from loguru import logger

from app.services.llm.pricing import estimate_cost

if TYPE_CHECKING:
    from app.services.llm.buffered_usage_writer import BufferedUsageWriter


def _extract_token_usage(response: LLMResult) -> tuple[int, int, int, str]:
    """Extract token usage from an LLMResult.

    Returns (prompt_tokens, completion_tokens, total_tokens, source).
    source is one of "llm_output", "usage_metadata", "response_metadata", or "none".
    """
    # Path 1: non-streaming ainvoke - llm_output.token_usage
    if response.llm_output:
        tu = response.llm_output.get("token_usage")
        if isinstance(tu, dict):
            p = int(tu.get("prompt_tokens", 0) or 0)
            c = int(tu.get("completion_tokens", 0) or 0)
            t = int(tu.get("total_tokens", p + c) or 0)
            if t > 0:
                return p, c, t, "llm_output"
        # Some providers put usage directly under llm_output (no token_usage key)
        if "prompt_tokens" in (tu or {}) or response.llm_output.get("prompt_tokens"):
            lo = response.llm_output
            p = int(lo.get("prompt_tokens", 0) or 0)
            c = int(lo.get("completion_tokens", 0) or 0)
            t = int(lo.get("total_tokens", p + c) or 0)
            if t > 0:
                return p, c, t, "llm_output"

    # Path 2 & 3: streaming astream - inspect the final AIMessage
    try:
        gen = response.generations[0][0]
        msg = gen.message

        # Path 2: usage_metadata (LangChain standard for streaming)
        um = getattr(msg, "usage_metadata", None) or {}
        if um:
            p = int(um.get("input_tokens", 0) or 0)
            c = int(um.get("output_tokens", 0) or 0)
            t = int(um.get("total_tokens", p + c) or 0)
            if t > 0:
                return p, c, t, "usage_metadata"

        # Path 3: response_metadata.token_usage (some providers)
        rm = getattr(msg, "response_metadata", None) or {}
        tu = rm.get("token_usage") or rm.get("usage")
        if isinstance(tu, dict):
            p = int(tu.get("prompt_tokens", 0) or tu.get("input_tokens", 0) or 0)
            c = int(tu.get("completion_tokens", 0) or tu.get("output_tokens", 0) or 0)
            t = int(tu.get("total_tokens", p + c) or 0)
            if t > 0:
                return p, c, t, "response_metadata"
    except (IndexError, AttributeError, TypeError):
        pass

    return 0, 0, 0, "none"


class UsageTrackingCallback(BaseCallbackHandler):
    """LangChain callback that records token usage and cost to a buffered writer.

    - Falls back silently when no writer is configured.
    - Fire-and-forget enqueue: does not block the LLM response stream.
    - Captures the running event loop at construction so that sync
      ``on_llm_end`` (often invoked from executor worker threads) can schedule
      async enqueue back onto the main loop safely.
    - Also accumulates token counts in-process so the caller can read them
      after the run (e.g. for ``finalize_turn`` ``tokens_used``).
    """

    def __init__(
        self,
        uid: int,
        credential_id: Optional[int] = None,
        provider: str = "openai",
        model: Optional[str] = None,
        writer: Optional["BufferedUsageWriter"] = None,
    ) -> None:
        self.uid = uid
        self.credential_id = credential_id
        self.provider = provider
        self.model = model
        self._writer = writer
        # In-process accumulator (read by caller after the run completes).
        self.total_tokens: int = 0
        self.prompt_tokens: int = 0
        self.completion_tokens: int = 0
        self.llm_calls: int = 0
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        """Called by LangChain after each LLM completion."""
        try:
            prompt_tokens, completion_tokens, total_tokens, source = _extract_token_usage(
                response
            )

            logger.info(
                f"[USAGE_TRACKER] on_llm_end fired "
                f"prompt={prompt_tokens} completion={completion_tokens} "
                f"total={total_tokens} source={source} "
                f"provider={self.provider} model={self.model}"
            )

            # Accumulate in-process so the caller can read totals after the run.
            self.prompt_tokens += prompt_tokens
            self.completion_tokens += completion_tokens
            self.total_tokens += total_tokens
            self.llm_calls += 1

            # Even if token metadata is missing, the API call itself happened.
            # Record it with zero tokens so per-call billing is not silently lost.
            api_calls = 1

            if total_tokens == 0:
                llm_output_keys = (
                    list(response.llm_output.keys()) if response.llm_output else "None"
                )
                logger.warning(
                    f"[USAGE_TRACKER] total_tokens=0, recording call only "
                    f"(llm_output={llm_output_keys}, source={source})"
                )

            cost_estimate = estimate_cost(
                self.provider, self.model, prompt_tokens, completion_tokens
            )

            if self._writer is not None and self._loop is not None:
                asyncio.run_coroutine_threadsafe(
                    self._writer.enqueue(
                        uid=self.uid,
                        credential_id=self.credential_id,
                        provider=self.provider,
                        model=self.model,
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        total_tokens=total_tokens,
                        api_calls=api_calls,
                        cost_estimate=cost_estimate,
                    ),
                    self._loop,
                )
            else:
                logger.warning(
                    f"[USAGE_TRACKER] no writer/loop available, "
                    f"usage not recorded: {total_tokens} tokens"
                )

            logger.info(
                f"[USAGE_TRACKER] enqueued {total_tokens} tokens "
                f"cost={cost_estimate} provider={self.provider} model={self.model}"
            )
        except Exception as e:
            logger.error(f"[USAGE_TRACKER] failed to enqueue usage: {e}")


def attach_usage_tracking(
    llm: Any,
    *,
    uid: int,
    credential_id: Optional[int] = None,
    provider: str = "openai",
    model: Optional[str] = None,
    writer: Optional["BufferedUsageWriter"] = None,
) -> Any:
    """Attach a UsageTrackingCallback to a LangChain LLM and return it.

    The original object is not mutated; callbacks are appended to a new list.
    """
    tracker = UsageTrackingCallback(
        uid=uid,
        credential_id=credential_id,
        provider=provider,
        model=model,
        writer=writer,
    )
    callbacks = list(getattr(llm, "callbacks", None) or [])
    callbacks.append(tracker)
    llm.callbacks = callbacks
    return llm
