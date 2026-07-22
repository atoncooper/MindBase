"""Stream agent events as SSE frames.

Wraps ``CompiledGraph.astream_events(version="v2")`` so the
orchestrator can yield the SSE protocol the frontend already speaks
(``chunk`` / ``step`` / ``sources`` / ``done`` / ``error``) directly
from the ``AgentHarness`` ReAct chat agent.

The agent emits LangChain v2 events; we translate the relevant ones:

* ``on_chat_model_stream`` → ``chunk`` (content delta)
* ``on_tool_start``        → ``step`` (action=name, query=primary arg)
* ``on_tool_end``          → ``step`` (with content_preview / sources)
* ``on_chain_end`` (root)  → emit collected ``sources`` + ``done``
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Optional

from app.services.chat.sse import sse_event

logger = logging.getLogger(__name__)

_PREVIEW_LIMIT = 200


def _content_preview(value: Any) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(text) > _PREVIEW_LIMIT:
        return text[:_PREVIEW_LIMIT] + "..."
    return text


def _primary_query(args: dict[str, Any] | None) -> str:
    if not args:
        return ""
    for key in ("query", "question", "q", "text"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _parse_tool_output(output: Any) -> tuple[list[dict], str]:
    """Return ``(sources, preview)`` extracted from a tool's output payload."""
    payload = output
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            return [], _content_preview(output)

    sources: list[dict] = []
    if isinstance(payload, dict):
        raw_sources = payload.get("sources") or payload.get("results") or []
        if isinstance(raw_sources, list):
            sources = [s for s in raw_sources if isinstance(s, dict)]

    return sources, _content_preview(output)


class AgentSSEStreamer:
    """Translate ``astream_events`` output into the legacy SSE protocol.

    Token usage is extracted from the root chain's ``on_chain_end`` event
    (which carries the final agent state including all messages).  This is
    the most reliable approach — it works regardless of model type
    (ChatOpenAI vs legacy LLM), call mode (streaming vs non-streaming),
    or LangGraph version (v1 vs v2 events).
    """

    def __init__(self) -> None:
        self.full_content: str = ""
        self.sources: list[dict] = []
        # Token usage accumulated from the final agent state.
        self.total_tokens: int = 0
        self.prompt_tokens: int = 0
        self.completion_tokens: int = 0
        self.llm_calls: int = 0
        self._step_no = 0
        self._tool_runs: dict[str, dict[str, Any]] = {}
        self._root_run_name: str = ""

    async def stream(
        self,
        agent_graph: Any,
        input_state: dict[str, Any],
        run_config: dict[str, Any],
    ) -> AsyncIterator[str]:
        """Yield SSE frames; mutate ``self.full_content`` / ``self.sources``."""
        self._root_run_name = run_config.get("run_name", "LangGraph")
        try:
            async for event in agent_graph.astream_events(
                input_state, config=run_config, version="v2"
            ):
                kind = event.get("event", "")
                frame: Optional[str] = None

                if kind == "on_chat_model_stream":
                    frame = self._handle_token(event)
                elif kind == "on_tool_start":
                    frame = self._handle_tool_start(event)
                elif kind == "on_tool_end":
                    frame = self._handle_tool_end(event)
                elif kind == "on_chain_end" and event.get("name") == self._root_run_name:
                    self._capture_root_output(event)

                if frame is not None:
                    yield frame

            yield sse_event({"type": "sources", "sources": self.sources[:5]})
            yield sse_event({"type": "done"})
        except Exception as exc:
            logger.exception("Agent SSE stream failed")
            yield sse_event({"type": "error", "message": str(exc)})

    def _capture_root_output(self, event: dict[str, Any]) -> None:
        """Extract token usage from the root graph's final state.

        The root ``on_chain_end`` event carries ``data.output`` which is the
        full agent state dict, including the ``messages`` list.  Each AI
        message in this list has ``response_metadata.token_usage`` (from
        non-streaming ``ainvoke`` inside ReAct).
        """
        output = event.get("data", {}).get("output")
        if not isinstance(output, dict):
            return

        messages = output.get("messages")
        if not isinstance(messages, list) or not messages:
            return

        from app.services.chat.token_count import sum_token_usage_from_messages

        counts = sum_token_usage_from_messages(messages)
        self.total_tokens = counts.total_tokens
        self.prompt_tokens = counts.prompt_tokens
        self.completion_tokens = counts.completion_tokens
        self.llm_calls = counts.llm_calls

        if self.total_tokens > 0:
            logger.info(
                "[SSE_STREAMER] root chain end: tokens=%s (prompt=%s, completion=%s, calls=%s)",
                self.total_tokens, self.prompt_tokens,
                self.completion_tokens, self.llm_calls,
            )

    # ── handlers ─────────────────────────────────────────────────────

    def _handle_token(self, event: dict[str, Any]) -> Optional[str]:
        chunk = event.get("data", {}).get("chunk")
        text = getattr(chunk, "content", "") if chunk is not None else ""
        if not text:
            return None
        self.full_content += text
        return sse_event({"type": "chunk", "content": text})

    def _handle_tool_start(self, event: dict[str, Any]) -> Optional[str]:
        run_id = event.get("run_id") or ""
        name = event.get("name", "tool_call")
        args = event.get("data", {}).get("input") or {}
        if not isinstance(args, dict):
            args = {}

        self._step_no += 1
        self._tool_runs[run_id] = {"step": self._step_no, "name": name}

        return sse_event(
            {
                "type": "step",
                "step": {
                    "step": self._step_no,
                    "action": name,
                    "query": _primary_query(args),
                    "reasoning": "",
                    "sources": [],
                    "content_preview": "",
                },
            }
        )

    def _handle_tool_end(self, event: dict[str, Any]) -> Optional[str]:
        run_id = event.get("run_id") or ""
        tracked = self._tool_runs.pop(run_id, None)
        output = event.get("data", {}).get("output")
        sources, preview = _parse_tool_output(output)
        for src in sources:
            if src not in self.sources:
                self.sources.append(src)

        step_no = tracked["step"] if tracked else self._step_no
        action = tracked["name"] if tracked else event.get("name", "tool_call")

        return sse_event(
            {
                "type": "step",
                "step": {
                    "step": step_no,
                    "action": action,
                    "query": "",
                    "reasoning": "",
                    "sources": sources,
                    "content_preview": preview,
                },
            }
        )
