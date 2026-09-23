"""Stream agent events as SSE frames.

Wraps ``CompiledGraph.astream_events(version="v2")`` so the
orchestrator can yield the SSE protocol the frontend already speaks
(``chunk`` / ``reasoning`` / ``step`` / ``sources`` / ``done`` / ``error``)
directly from the ``AgentHarness`` ReAct agents.

The agent emits LangChain v2 events; we translate the relevant ones:

* ``on_chat_model_stream`` → ``chunk`` (content delta) and ``reasoning``
  (reasoning_content delta from thinking models)
* ``on_chat_model_start``  → reset/replay bookkeeping between LLM runs
* ``on_chat_model_end``    → ``step`` frames announcing tool calls the LLM
  just decided on
* ``on_chain_end`` (node)  → ``step`` frames with tool results (the tools
  run inside ``AgentRuntime`` via direct ``tool.run()``, so no
  ``on_tool_*`` events ever fire — node boundaries are the reliable
  completion signal)
* ``on_chain_end`` (root)  → emit collected ``sources`` + ``done``; a
  final-state ``error`` (agent fell back after retries) is surfaced as an
  ``error`` frame instead of being silently dropped.
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


def _tool_calls_of(output: Any) -> list[dict]:
    """Extract ``[{id, name, args}]`` from a model-end output message.

    Handles both aggregated ``AIMessage.tool_calls`` and streamed
    ``tool_call_chunks`` (args arrive as a JSON string there).
    """
    calls = getattr(output, "tool_calls", None) or []
    result: list[dict] = []
    for tc in calls:
        if isinstance(tc, dict) and tc.get("name"):
            result.append({"id": str(tc.get("id") or ""), "name": tc["name"], "args": tc.get("args") or {}})
    if result:
        return result
    for c in getattr(output, "tool_call_chunks", None) or []:
        if not isinstance(c, dict):
            continue
        raw_args = c.get("args")
        args: Any = {}
        if isinstance(raw_args, str):
            try:
                args = json.loads(raw_args) if raw_args else {}
            except ValueError:
                args = {}
        elif isinstance(raw_args, dict):
            args = raw_args
        result.append({"id": str(c.get("id") or c.get("index") or ""), "name": c.get("name") or "tool_call", "args": args})
    return result


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
    preview_override: Optional[str] = None
    if isinstance(output, ToolMessage):
        extras = getattr(output, "additional_kwargs", None) or {}
        content = getattr(output, "content", "")
        payload = {"content": content, **extras}
        # The human-facing preview is the tool's text result, not the
        # re-merged JSON dump.
        preview_override = content if isinstance(content, str) else None
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
    preview_value = preview_override if preview_override is not None else payload
    return sources, _content_preview(preview_value), artifacts


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
        # Reasoning stream (reasoning models emit ``reasoning_content`` on
        # chunk deltas); streamed to the client but NOT part of the answer.
        self.reasoning_content: str = ""
        # Token usage accumulated from the final agent state.
        self.total_tokens: int = 0
        self.prompt_tokens: int = 0
        self.completion_tokens: int = 0
        self.llm_calls: int = 0
        self._step_no = 0
        self._root_run_name: str = ""
        # LLM run lifecycle, used to distinguish a legitimate ReAct
        # continuation (LLM ran → tools ran → LLM runs again) from a retry
        # (error_node re-ran the LLM after a failure).
        self._run_start_content: str = ""
        self._run_start_reasoning: str = ""
        self._run_in_flight: bool = False
        self._run_completed: bool = False
        self._run_had_tool_calls: bool = False
        # Tool calls announced by on_chat_model_end, awaiting completion at
        # the next node boundary. Keyed by tool_call_id.
        self._open_tool_calls: dict[str, dict[str, Any]] = {}
        # Error tracking: when stream() swallows an exception, these let the
        # orchestrator fail_turn instead of finalize_turn (which would persist
        # a partial answer as a successful message). graph_error covers the
        # silent-fallback path: the graph completes normally but its final
        # state carries ``error`` (fallback result) — previously that text
        # was dropped and the client just saw the stream end mid-answer.
        self.had_error: bool = False
        self.error_message: str = ""
        self.graph_error: str = ""

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
                frames: Optional[list[str]] = None

                if kind == "on_chat_model_stream":
                    frames = self._handle_token(event)
                elif kind == "on_chat_model_start":
                    frames = self._handle_model_start(event)
                elif kind == "on_chat_model_end":
                    frames = self._handle_model_end(event)
                elif kind == "on_chain_end":
                    if event.get("name") == self._root_run_name:
                        self._capture_root_output(event)
                    else:
                        frames = self._handle_node_end(event)

                for frame in frames or []:
                    yield frame

            logger.info(
                "[SSE_STREAMER] event_counts={} content_chars={} token_events={} reasoning_chars={}",
                event_counts,
                len(self.full_content),
                event_counts.get("on_chat_model_stream", 0),
                len(self.reasoning_content),
            )
            # Flush artifacts (e.g. images produced by the code agent) before
            # sources/done so the frontend can render them inline with the
            # final answer.
            for art in self.artifacts:
                yield sse_event({"type": "artifact", "artifact": art})
            yield sse_event({"type": "sources", "sources": self.sources[:5]})
            if self.graph_error:
                # The graph completed but ended in a fallback (error_node
                # exhausted retries / circuit breaker). Surface the fallback
                # text to the client instead of letting the stream end as if
                # the answer were done.
                self.had_error = True
                self.error_message = self.graph_error
                yield sse_event({"type": "error", "message": self.graph_error})
            elif not self.full_content.strip():
                # The agent finished "successfully" but produced no answer
                # text (e.g. the model emitted only reasoning). Ending here
                # used to look like a normal done with an empty reply, which
                # was then persisted to history as a successful message.
                self.had_error = True
                self.error_message = "模型未返回有效内容，请重试"
                logger.warning(
                    "[SSE_STREAMER] empty answer: graph completed with no content "
                    "(reasoning_chars={} tokens={})",
                    len(self.reasoning_content),
                    self.total_tokens,
                )
                yield sse_event({"type": "error", "message": self.error_message})
            yield sse_event({"type": "done"})
        except Exception as exc:
            logger.exception("Agent SSE stream failed")
            self.had_error = True
            self.error_message = str(exc)
            yield sse_event({"type": "error", "message": str(exc)})

    def _handle_model_start(self, event: dict[str, Any]) -> Optional[list[str]]:
        """Bookkeeping between consecutive LLM runs of the ReAct loop.

        Two distinct situations produce a new ``on_chat_model_start`` after
        content has been streamed:

        * Normal continuation: the previous run ended by requesting tool
          calls and those tools have run. Its text is a preamble worth
          keeping, so the next run's tokens simply append (with a blank
          line separator).
        * A retry: error_node re-ran the LLM after a failure (or the model
          re-ran after finishing). The failed run's partial text must be
          discarded, otherwise the retry's tokens append to the garbled
          half answer. Emit ``reset`` and replay the content from before
          the failed run so the client keeps earlier preambles.
        """
        frames: list[str] = []
        if self._run_in_flight or (self._run_completed and not self._run_had_tool_calls):
            # Previous run errored mid-stream (no on_chat_model_end), or it
            # completed with a plain answer yet another call follows — both
            # mean a retry with stale partial text in flight.
            prev_start_content = self._run_start_content
            if self.full_content != prev_start_content:
                frames.append(sse_event({"type": "reset"}))
                self.full_content = prev_start_content
                self.reasoning_content = self._run_start_reasoning
                if prev_start_content:
                    frames.append(sse_event({"type": "chunk", "content": prev_start_content}))
        elif self._run_had_tool_calls and self.full_content:
            # Normal continuation after tools: separate the preamble from
            # the next segment with a blank line.
            frames.append(sse_event({"type": "chunk", "content": "\n\n"}))
            self.full_content += "\n\n"

        # Snapshot for the run that is starting.
        self._run_start_content = self.full_content
        self._run_start_reasoning = self.reasoning_content
        self._run_in_flight = True
        self._run_completed = False
        self._run_had_tool_calls = False
        return frames

    def _handle_model_end(self, event: dict[str, Any]) -> Optional[list[str]]:
        """Close out an LLM run; announce tool calls it decided on.

        Tool start frames are derived here (not from ``on_tool_start``,
        which never fires because AgentRuntime invokes tools via direct
        ``tool.run()``), so the client sees what the agent is about to do
        while the tool executes.
        """
        output = event.get("data", {}).get("output")
        self._run_completed = True
        self._run_in_flight = False
        calls = _tool_calls_of(output)
        self._run_had_tool_calls = bool(calls)

        frames: list[str] = []
        for tc in calls:
            if not tc.get("id"):
                continue
            self._step_no += 1
            self._open_tool_calls[tc["id"]] = {
                "step": self._step_no,
                "name": tc["name"],
                "query": _primary_query(tc.get("args") or {}),
            }
            frames.append(
                sse_event(
                    {
                        "type": "step",
                        "step": {
                            "step": self._step_no,
                            "action": tc["name"],
                            "query": self._open_tool_calls[tc["id"]]["query"],
                            "reasoning": "",
                            "sources": [],
                            "content_preview": "",
                        },
                    }
                )
            )
        return frames

    def _handle_node_end(self, event: dict[str, Any]) -> Optional[list[str]]:
        """Emit completion steps for tools whose results arrived at a node
        boundary (``runtime_dispatch`` returns the ToolMessages).

        Any non-root ``on_chain_end`` whose output carries ToolMessages
        matching an announced tool_call_id counts as completion; the
        tool_call_id lookup makes duplicate state snapshots harmless.
        """
        output = event.get("data", {}).get("output")
        if not isinstance(output, dict):
            return None
        messages = output.get("messages")
        if not isinstance(messages, list):
            return None

        frames: list[str] = []
        for msg in messages:
            if not isinstance(msg, ToolMessage):
                continue
            record = self._open_tool_calls.pop(msg.tool_call_id, None)
            if record is None:
                continue
            try:
                srcs, preview, arts = _parse_tool_output(msg)
            except Exception as exc:
                logger.warning("[SSE_STREAMER] skip unparseable ToolMessage: %s", exc)
                srcs, preview, arts = [], "", []
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
            frames.append(
                sse_event(
                    {
                        "type": "step",
                        "step": {
                            "step": record["step"],
                            "action": record["name"],
                            "query": record["query"],
                            "reasoning": "",
                            "sources": srcs,
                            "content_preview": preview,
                        },
                    }
                )
            )
        return frames

    def _capture_root_output(self, event: dict[str, Any]) -> None:
        """Extract token usage + sources + artifacts + fallback error from the
        root graph's final state.

        The root ``on_chain_end`` event carries ``data.output`` which is the
        full agent state dict, including the ``messages`` list.  Each AI
        message in this list has ``response_metadata.token_usage`` (from
        non-streaming ``ainvoke`` inside ReAct).

        Sources and artifacts are recovered here from the final ToolMessages
        as a safety net in case node-boundary events were missed (e.g. an
        agent graph without a ``runtime_dispatch`` node).
        """
        output = event.get("data", {}).get("output")
        if not isinstance(output, dict):
            return

        # A fallback that ran out of retries leaves ``error`` set in the final
        # state with ``result`` = the user-facing fallback text. Previously
        # this text never reached the client — the stream just ended.
        state_error = output.get("error")
        if state_error:
            self.graph_error = str(output.get("result") or "Agent 执行失败，请稍后重试")

        # Defense in depth: terminal nodes used to clear ``error`` (their
        # wrapper setdefaulted it to "") while keeping the fallback
        # ``result``. A final-state result that was never streamed — no LLM
        # token ever reached full_content — must still reach the client as
        # an error frame instead of dying in the state.
        if not self.graph_error and not self.full_content.strip():
            result_text = str(output.get("result") or "").strip()
            if result_text:
                self.graph_error = result_text

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
        # the ONLY reliable extraction path when node-boundary events did
        # not fire; _parse_tool_output handles both direct tools
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

    def _handle_token(self, event: dict[str, Any]) -> Optional[list[str]]:
        """Split a model stream chunk into ``reasoning`` and ``chunk`` frames.

        Reasoning models deliver thinking deltas in
        ``additional_kwargs.reasoning_content``; they stream to the client
        as ``type:reasoning`` frames (rendered in a collapsed block) and
        are never mixed into the answer text.
        """
        chunk = event.get("data", {}).get("chunk")
        if chunk is None:
            return None
        frames: list[str] = []
        kwargs = getattr(chunk, "additional_kwargs", None) or {}
        reasoning = kwargs.get("reasoning_content") or kwargs.get("reasoning") or ""
        if isinstance(reasoning, str) and reasoning:
            self.reasoning_content += reasoning
            frames.append(sse_event({"type": "reasoning", "content": reasoning}))
        text = getattr(chunk, "content", "")
        if text:
            self.full_content += text
            frames.append(sse_event({"type": "chunk", "content": text}))
        return frames or None
