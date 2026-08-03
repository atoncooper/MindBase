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
from typing import Any, AsyncIterator, Optional

from langchain_core.messages import ToolMessage
from loguru import logger

from app.services.chat.sse import sse_event

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


def _parse_tool_output(output: Any) -> tuple[list[dict], str, list[dict]]:
    """Return ``(sources, preview, artifacts)`` from a tool's output payload.

    ``artifacts`` are binary outputs (e.g. images) produced by sub-agents
    such as the code agent; they are pulled out of ``sub_steps`` so the
    streamer can emit dedicated ``type:artifact`` frames for the frontend
    to render inline.
    """
    # Tools return dicts; the runtime splits them into ToolMessage.content
    # (LLM-facing string) and ToolMessage.additional_kwargs (structured
    # extras: sub_steps / sources / artifacts). Re-merge so the parsing
    # below works uniformly for ToolMessage and raw dict/str payloads.
    payload: Any = output
    if isinstance(output, ToolMessage):
        extras = getattr(output, "additional_kwargs", None) or {}
        payload = {"content": getattr(output, "content", ""), **extras}
    elif isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            return [], _content_preview(output), []

    sources: list[dict] = []
    artifacts: list[dict] = []
    if isinstance(payload, dict):
        raw_sources = payload.get("sources") or payload.get("results") or []
        if isinstance(raw_sources, list):
            sources = [s for s in raw_sources if isinstance(s, dict)]

        # Surface sub-agent internal steps (e.g. code agent's run_code).
        sub_steps = payload.get("sub_steps")
        if isinstance(sub_steps, list) and sub_steps:
            lines = []
            for ss in sub_steps:
                act = ss.get("action", "unknown")
                preview = ss.get("content_preview", "")
                lines.append(f"  {act}: {preview}")
                # Collect artifacts produced by this sub-step (e.g. images
                # from run_code) so the frontend can render them inline.
                step_artifacts = ss.get("artifacts")
                if isinstance(step_artifacts, list):
                    artifacts.extend(a for a in step_artifacts if isinstance(a, dict))
            return sources, "子agent步骤:\n" + "\n".join(lines), artifacts

        # Top-level artifacts (a tool returning artifacts directly).
        raw_artifacts = payload.get("artifacts")
        if isinstance(raw_artifacts, list):
            artifacts = [a for a in raw_artifacts if isinstance(a, dict)]

    # Use the normalized payload (dict/str), not the raw ``output`` which may
    # be a ToolMessage that isn't JSON-serializable (crashes _content_preview).
    return sources, _content_preview(payload), artifacts


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
        # Binary artifacts (e.g. images) emitted by sub-agents; flushed as
        # ``type:artifact`` frames near the end of the stream.
        self.artifacts: list[dict] = []
        # Token usage accumulated from the final agent state.
        self.total_tokens: int = 0
        self.prompt_tokens: int = 0
        self.completion_tokens: int = 0
        self.llm_calls: int = 0
        self._step_no = 0
        self._tool_runs: dict[str, dict[str, Any]] = {}
        self._root_run_name: str = ""
        # Error tracking: when stream() swallows an exception, these let the
        # orchestrator fail_turn instead of finalize_turn (which would persist
        # a partial answer as a successful message).
        self.had_error: bool = False
        self.error_message: str = ""

    async def stream(
        self,
        agent_graph: Any,
        input_state: dict[str, Any],
        run_config: dict[str, Any],
    ) -> AsyncIterator[str]:
        """Yield SSE frames; mutate ``self.full_content`` / ``self.sources``."""
        self._root_run_name = run_config.get("run_name", "LangGraph")
        event_counts: dict[str, int] = {}
        try:
            async for event in agent_graph.astream_events(
                input_state, config=run_config, version="v2"
            ):
                kind = event.get("event", "")
                event_counts[kind] = event_counts.get(kind, 0) + 1
                frame: Optional[str] = None

                if kind == "on_chat_model_stream":
                    frame = self._handle_token(event)
                elif kind == "on_chat_model_start":
                    frame = self._handle_model_start(event)
                elif kind == "on_tool_start":
                    frame = self._handle_tool_start(event)
                elif kind == "on_tool_end":
                    frame = self._handle_tool_end(event)
                elif kind == "on_chain_end" and event.get("name") == self._root_run_name:
                    self._capture_root_output(event)

                if frame is not None:
                    yield frame

            logger.info(
                "[SSE_STREAMER] event_counts={} content_chars={} token_events={}",
                event_counts,
                len(self.full_content),
                event_counts.get("on_chat_model_stream", 0),
            )
            # Flush artifacts (e.g. images produced by the code agent) before
            # sources/done so the frontend can render them inline with the
            # final answer.
            for art in self.artifacts:
                yield sse_event({"type": "artifact", "artifact": art})
            yield sse_event({"type": "sources", "sources": self.sources[:5]})
            yield sse_event({"type": "done"})
        except Exception as exc:
            logger.exception("Agent SSE stream failed")
            self.had_error = True
            self.error_message = str(exc)
            yield sse_event({"type": "error", "message": str(exc)})

    def _handle_model_start(self, event: dict[str, Any]) -> Optional[str]:
        """Reset accumulated content when a new LLM call begins mid-stream.

        A second ``on_chat_model_start`` after content has already been
        accumulated means the graph is re-running the LLM (e.g. a retryable
        "peer closed connection" error triggered error_node -> agent). Without
        a reset, the retry's tokens append to the partial first attempt,
        producing garbled half+duplicate content both streamed to the client
        and persisted. Emit a ``reset`` frame so the client clears its bubble,
        and zero ``full_content`` so only the retried (complete) answer is
        persisted.
        """
        if self.full_content:
            self.full_content = ""
            return sse_event({"type": "reset"})
        return None

    def _capture_root_output(self, event: dict[str, Any]) -> None:
        """Extract token usage + sources + artifacts from the root graph's final state.

        The root ``on_chain_end`` event carries ``data.output`` which is the
        full agent state dict, including the ``messages`` list.  Each AI
        message in this list has ``response_metadata.token_usage`` (from
        non-streaming ``ainvoke`` inside ReAct).

        Sources and artifacts are recovered here from the final ToolMessages
        because ``AgentRuntime.execute()`` calls ``tool.run()`` directly
        (not via LangChain's callback-aware tool invocation), so ``on_tool_*``
        events are never emitted and ``_handle_tool_end`` never fires.
        Iterating the final ToolMessages - incl. delegated sub-agent
        ``sub_steps`` (parsed by ``_parse_tool_output``) - is the only
        reliable way to surface them to the SSE stream.
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
                "[SSE_STREAMER] root chain end: tokens={} (prompt={}, completion={}, calls={})",
                self.total_tokens, self.prompt_tokens,
                self.completion_tokens, self.llm_calls,
            )

        # Recover sources + artifacts from the final ToolMessages. This is
        # the ONLY reliable extraction path: _handle_tool_end never fires
        # because AgentRuntime executes tools via direct tool.run() (no
        # on_tool_* events). _parse_tool_output handles both direct tools
        # (top-level sources/artifacts) and delegated sub-agents (nested in
        # sub_steps, e.g. code agent's run_code artifacts).
        for msg in messages:
            if not isinstance(msg, ToolMessage):
                continue
            try:
                srcs, _, arts = _parse_tool_output(msg)
            except Exception as exc:
                # One unparseable ToolMessage must not abort the stream
                # (and lose already-streamed tokens). Skip it, keep going.
                logger.warning(
                    "[SSE_STREAMER] skip unparseable ToolMessage: %s", exc
                )
                continue
            for src in srcs:
                if src not in self.sources:
                    self.sources.append(src)
            for art in arts:
                key = art.get("minio_key") or art.get("url") or art.get("name")
                if key and any(
                    (a.get("minio_key") or a.get("url") or a.get("name")) == key
                    for a in self.artifacts
                ):
                    continue
                self.artifacts.append(art)
        if self.artifacts:
            logger.info(
                "[SSE_STREAMER] recovered {} artifact(s) from final state",
                len(self.artifacts),
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
        sources, preview, artifacts = _parse_tool_output(output)
        for src in sources:
            if src not in self.sources:
                self.sources.append(src)
        for art in artifacts:
            # Dedup by minio_key/url/name so a retried run_code doesn't
            # double-render the same artifact.
            key = art.get("minio_key") or art.get("url") or art.get("name")
            if key and any(
                (a.get("minio_key") or a.get("url") or a.get("name")) == key
                for a in self.artifacts
            ):
                continue
            self.artifacts.append(art)

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
