"""Endpoint-level orchestration for chat.

Encapsulates the full per-turn flow: preloading credentials, dispatching
through ``AgentHarness``, capturing token usage, persisting messages,
and (for streaming endpoints) yielding SSE frames.

Routers should call into these functions and translate the results into
HTTP responses.  Routers must NOT call the harness directly.
"""

import asyncio
import time
from typing import Any, AsyncIterator, Optional

from fastapi import BackgroundTasks, HTTPException
from langchain_core.messages import BaseMessage
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.response import (
    AgenticChatResponse,
    ChatRequest,
    ChatResponse,
)
from app.services.chat.agent_sse import AgentSSEStreamer
from app.services.chat.dispatcher import agent_run, agent_stream_setup
from app.services.chat.lifecycle import (
    TurnContext,
    begin_turn,
    cancel_turn,
    fail_turn,
    finalize_turn,
)
from app.services.chat.llm import build_llm
from app.services.chat.reasoning import extract_reasoning_steps


async def _preload_user_credentials(
    api_key_manager: Any, uid: int, db: AsyncSession
) -> None:
    if api_key_manager and getattr(api_key_manager, "is_enabled", False):
        await api_key_manager.preload_credentials(uid, db)


def _resolve_usage_metadata(
    uid: int,
    api_key_manager: Any,
) -> tuple[Optional[int], str, Optional[str]]:
    """Resolve the credential/provider/model that will actually be used.

    Builds a per-user LLM (reusing the same logic as the chat title generator)
    and reads its metadata.  If no user credential is configured, falls back
    to system defaults.
    """
    try:
        llm = build_llm(uid=uid)
        credential_id = getattr(llm, "_credential_id", None)
        provider = getattr(llm, "_provider", "openai")
        model = getattr(llm, "_model", settings.llm_model)
        return credential_id, provider, model
    except Exception:
        logger.exception("[CHAT_ORCH] failed to resolve usage metadata")
        return None, "openai", settings.llm_model


def _make_usage_callback(
    usage_writer: Any,
    *,
    uid: int,
    credential_id: Optional[int],
    provider: str,
    model: Optional[str],
) -> Any:
    """Build a UsageTrackingCallback attached to the global writer.

    The callback is passed via ``run_config["callbacks"]`` so LangGraph
    propagates it to every LLM call inside the ReAct loop.  ``on_llm_end``
    fires per call and enqueues usage cross-thread to the writer.
    """
    if not usage_writer:
        return None
    from app.services.llm.usage_tracker import UsageTrackingCallback
    return UsageTrackingCallback(
        uid=uid,
        credential_id=credential_id,
        provider=provider,
        model=model,
        writer=usage_writer,
    )


def _enqueue_usage(
    usage_writer: Any,
    *,
    uid: int,
    credential_id: Optional[int],
    provider: str,
    model: Optional[str],
    total_tokens: int,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    api_calls: int = 1,
) -> None:
    if not usage_writer:
        logger.warning("[CHAT_ORCH] _enqueue_usage skipped: no usage_writer")
        return
    if total_tokens <= 0:
        logger.warning(
            f"[CHAT_ORCH] _enqueue_usage skipped: total_tokens={total_tokens} "
            f"(provider={provider} model={model})"
        )
        return
    logger.info(
        f"[CHAT_ORCH] enqueuing usage: uid={uid} provider={provider} model={model} "
        f"tokens={total_tokens} (prompt={prompt_tokens} completion={completion_tokens}) "
        f"calls={api_calls}"
    )
    asyncio.ensure_future(
        usage_writer.enqueue(
            uid=uid,
            credential_id=credential_id,
            provider=provider,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            api_calls=api_calls,
        )
    )


def _normalize_agent_result(result: Any) -> tuple[str, list[dict], list[BaseMessage]]:
    """Return ``(answer, sources, messages)`` from a harness dispatch result."""
    answer = ""
    sources: list[dict] = []
    messages: list[BaseMessage] = []

    if isinstance(result, dict):
        if result.get("error"):
            raise HTTPException(status_code=500, detail=str(result["error"]))
        answer = result.get("result") or ""
        sources = result.get("sources") or []
        messages = result.get("messages") or []
        if not answer and messages:
            last_msg = messages[-1]
            answer = getattr(last_msg, "content", "") or str(last_msg)

    if not answer:
        answer = "抱歉，我无法回答这个问题。"
    return answer, [s for s in sources if isinstance(s, dict)], messages


async def _run_agent_turn(
    request: ChatRequest,
    *,
    uid: int,
    db: AsyncSession,
    agent_harness: Any,
    ctx: TurnContext,
    usage_callback: Any = None,
) -> tuple[str, list[dict], list[BaseMessage], int, Any]:
    """Shared body for non-streaming endpoints - dispatch + measure.

    Returns (answer, sources, messages, latency_ms, usage_callback).
    Token totals are read from ``usage_callback`` after the run completes.
    """
    start_time = time.time()
    raw = await agent_run(
        request,
        uid=uid,
        db=db,
        agent_harness=agent_harness,
        session_id=ctx.chat_session_id,
        query=ctx.user_message,
        callbacks=[usage_callback] if usage_callback else None,
    )
    latency_ms = int((time.time() - start_time) * 1000)
    answer, sources, messages = _normalize_agent_result(raw)
    return answer, sources, messages, latency_ms, usage_callback


# ── non-streaming endpoints ─────────────────────────────────────────


async def ask(
    request: ChatRequest,
    *,
    uid: int,
    db: AsyncSession,
    background_tasks: BackgroundTasks,
    agent_harness: Any = None,
    api_key_manager: Any = None,
    usage_writer: Any = None,
) -> ChatResponse:
    """Handle POST /chat/ask (non-streaming)."""
    ctx = await begin_turn(
        db,
        uid=uid,
        chat_session_id=request.chat_session_id,
        question=request.question,
        background_tasks=background_tasks,
    )

    try:
        await _preload_user_credentials(api_key_manager, uid, db)
        credential_id, provider, model = _resolve_usage_metadata(uid, api_key_manager)
        usage_callback = _make_usage_callback(
            usage_writer, uid=uid, credential_id=credential_id,
            provider=provider, model=model,
        )
        answer, sources, _msgs, latency_ms, uc = await _run_agent_turn(
            request, uid=uid, db=db, agent_harness=agent_harness, ctx=ctx,
            usage_callback=usage_callback,
        )
        total_tokens = uc.total_tokens if uc else 0
        logger.info(
            f"[CHAT_ORCH] ask done: tokens={total_tokens} provider={provider} model={model}"
        )
        await finalize_turn(
            db,
            assistant_msg_id=ctx.assistant_msg_id,
            content=answer,
            sources=sources[:5],
            tokens_used=total_tokens or None,
            latency_ms=latency_ms,
        )
        return ChatResponse(answer=answer, sources=sources[:5])
    except HTTPException:
        # Service-level failure (e.g. harness 503) before generation started:
        # remove the placeholder rather than marking it failed, so the
        # history doesn't show an empty "failed" assistant bubble.
        await cancel_turn(db, assistant_msg_id=ctx.assistant_msg_id)
        raise
    except Exception as e:
        logger.exception("Chat ask failed")
        await fail_turn(db, assistant_msg_id=ctx.assistant_msg_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"问答失败: {str(e)}")


async def ask_agentic(
    request: ChatRequest,
    *,
    uid: int,
    db: AsyncSession,
    background_tasks: BackgroundTasks,
    agent_harness: Any = None,
    api_key_manager: Any = None,
    usage_writer: Any = None,
) -> AgenticChatResponse:
    """Handle POST /chat/ask/agentic (non-streaming, returns reasoning steps)."""
    ctx = await begin_turn(
        db,
        uid=uid,
        chat_session_id=request.chat_session_id,
        question=request.question,
        background_tasks=background_tasks,
    )

    try:
        await _preload_user_credentials(api_key_manager, uid, db)
        credential_id, provider, model = _resolve_usage_metadata(uid, api_key_manager)
        usage_callback = _make_usage_callback(
            usage_writer, uid=uid, credential_id=credential_id,
            provider=provider, model=model,
        )
        answer, sources, messages, latency_ms, uc = await _run_agent_turn(
            request, uid=uid, db=db, agent_harness=agent_harness, ctx=ctx,
            usage_callback=usage_callback,
        )
        reasoning_payload = extract_reasoning_steps(messages)
        total_tokens = uc.total_tokens if uc else 0
        logger.info(
            f"[CHAT_ORCH] ask_agentic done: tokens={total_tokens} provider={provider} model={model}"
        )

        await finalize_turn(
            db,
            assistant_msg_id=ctx.assistant_msg_id,
            content=answer,
            sources=sources[:5],
            tokens_used=total_tokens or None,
            latency_ms=latency_ms,
        )
        return AgenticChatResponse(
            answer=answer,
            sources=sources[:5],
            reasoning_steps=reasoning_payload,
            synthesis_method="agent_harness",
            hops_used=len(reasoning_payload),
            avg_recall_score=0.0,
        )
    except HTTPException:
        await cancel_turn(db, assistant_msg_id=ctx.assistant_msg_id)
        raise
    except Exception as e:
        logger.exception("Agentic RAG ask failed")
        await fail_turn(db, assistant_msg_id=ctx.assistant_msg_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Agentic RAG 问答失败: {str(e)}")


# ── streaming endpoints ─────────────────────────────────────────────


async def ask_stream(
    request: ChatRequest,
    *,
    uid: int,
    db: AsyncSession,
    background_tasks: BackgroundTasks,
    agent_harness: Any = None,
    api_key_manager: Any = None,
    usage_writer: Any = None,
) -> AsyncIterator[str]:
    """Handle POST /chat/ask/stream — yields SSE frames as strings."""
    ctx = await begin_turn(
        db,
        uid=uid,
        chat_session_id=request.chat_session_id,
        question=request.question,
        background_tasks=background_tasks,
    )

    try:
        await _preload_user_credentials(api_key_manager, uid, db)
        credential_id, provider, model = _resolve_usage_metadata(uid, api_key_manager)
        agent_name, agent_graph, input_state, run_config = await agent_stream_setup(
            request,
            uid=uid,
            db=db,
            agent_harness=agent_harness,
            session_id=ctx.chat_session_id,
            query=ctx.user_message,
        )
    except HTTPException:
        await cancel_turn(db, assistant_msg_id=ctx.assistant_msg_id)
        raise
    except Exception as e:
        logger.exception("Stream ask setup failed")
        await fail_turn(db, assistant_msg_id=ctx.assistant_msg_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"流式问答失败: {str(e)}")

    return _stream_agent_events(
        ctx=ctx,
        agent_name=agent_name,
        agent_graph=agent_graph,
        input_state=input_state,
        run_config=run_config,
        db=db,
        usage_writer=usage_writer,
        uid=uid,
        emit_route=False,
        credential_id=credential_id,
        provider=provider,
        model=model,
    )


async def ask_agent(
    request: ChatRequest,
    *,
    uid: int,
    db: AsyncSession,
    background_tasks: BackgroundTasks,
    agent_harness: Any,
    usage_writer: Any = None,
) -> ChatResponse:
    """Handle POST /chat/ask/agent — alias of ``ask`` kept for compatibility."""
    return await ask(
        request,
        uid=uid,
        db=db,
        background_tasks=background_tasks,
        agent_harness=agent_harness,
        usage_writer=usage_writer,
    )


async def ask_agent_stream(
    request: ChatRequest,
    *,
    uid: int,
    db: AsyncSession,
    background_tasks: BackgroundTasks,
    agent_harness: Any,
    api_key_manager: Any = None,
    usage_writer: Any = None,
) -> AsyncIterator[str]:
    """Handle POST /chat/ask/agent/stream — token-level SSE via AgentHarness."""
    ctx = await begin_turn(
        db,
        uid=uid,
        chat_session_id=request.chat_session_id,
        question=request.question,
        background_tasks=background_tasks,
    )

    try:
        await _preload_user_credentials(api_key_manager, uid, db)
        credential_id, provider, model = _resolve_usage_metadata(uid, api_key_manager)
        agent_name, agent_graph, input_state, run_config = await agent_stream_setup(
            request,
            uid=uid,
            db=db,
            agent_harness=agent_harness,
            session_id=ctx.chat_session_id,
            query=ctx.user_message,
        )
    except HTTPException:
        await cancel_turn(db, assistant_msg_id=ctx.assistant_msg_id)
        raise
    except Exception as e:
        logger.exception("Agent stream dispatch failed")
        await fail_turn(db, assistant_msg_id=ctx.assistant_msg_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Agent 流式问答失败: {str(e)}")

    return _stream_agent_events(
        ctx=ctx,
        agent_name=agent_name,
        agent_graph=agent_graph,
        input_state=input_state,
        run_config=run_config,
        db=db,
        usage_writer=usage_writer,
        uid=uid,
        emit_route=True,
        credential_id=credential_id,
        provider=provider,
        model=model,
    )


async def _stream_agent_events(
    *,
    ctx: TurnContext,
    agent_name: str,
    agent_graph,
    input_state: dict,
    run_config: dict,
    db: AsyncSession,
    usage_writer: Any,
    uid: int,
    emit_route: bool,
    credential_id: Optional[int] = None,
    provider: str = "openai",
    model: Optional[str] = None,
) -> AsyncIterator[str]:
    """Drive the agent stream, persist the result, enqueue usage."""
    from app.services.chat.sse import sse_event
    from app.services.llm.usage_tracker import UsageTrackingCallback

    # Attach a UsageTrackingCallback via run_config.  LangGraph propagates
    # config callbacks to all child runnables (including the LLM), so
    # on_llm_end fires per LLM call and the callback enqueues usage directly
    # to the writer (cross-thread via run_coroutine_threadsafe).
    usage_callback = UsageTrackingCallback(
        uid=uid,
        credential_id=credential_id,
        provider=provider,
        model=model,
        writer=usage_writer,
    )
    callbacks = list(run_config.get("callbacks") or [])
    callbacks.append(usage_callback)
    run_config = {**run_config, "callbacks": callbacks}

    streamer = AgentSSEStreamer()
    start_time = time.time()
    if emit_route:
        yield sse_event({"type": "route", "agent": agent_name})

    try:
        async for frame in streamer.stream(agent_graph, input_state, run_config):
            yield frame
    except Exception as e:
        logger.exception("Agent stream generation failed")
        error_msg = str(e)
        yield sse_event({"type": "error", "message": error_msg})
        await fail_turn(db, assistant_msg_id=ctx.assistant_msg_id, error=error_msg)
        return

    # Post-stream persistence.  By this point the client has already
    # received the ``done`` frame from ``streamer.stream()``, so any
    # failure here MUST NOT emit a second ``error`` event — clients that
    # close on ``done`` would never see it, and those that don't would
    # render a spurious error after a successful answer.
    try:
        latency_ms = int((time.time() - start_time) * 1000)
        if streamer.had_error:
            # The streamer already emitted an `error` frame to the client.
            # Mark the turn failed instead of finalize_turn, which would
            # persist a partial answer as a successful message.
            await fail_turn(
                db,
                assistant_msg_id=ctx.assistant_msg_id,
                error=streamer.error_message or "stream failed",
            )
            return
        total_tokens = usage_callback.total_tokens
        logger.info(
            f"[CHAT_ORCH] stream done: tokens={total_tokens} "
            f"(prompt={usage_callback.prompt_tokens}, "
            f"completion={usage_callback.completion_tokens}, "
            f"calls={usage_callback.llm_calls}) provider={provider} model={model}"
        )
        await finalize_turn(
            db,
            assistant_msg_id=ctx.assistant_msg_id,
            content=streamer.full_content,
            sources=streamer.sources[:5],
            tokens_used=total_tokens or None,
            latency_ms=latency_ms,
        )
    except Exception:
        logger.exception("Post-stream finalize failed; answer already delivered to client")
