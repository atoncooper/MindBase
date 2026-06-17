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
    fail_turn,
    finalize_turn,
)
from app.services.chat.reasoning import extract_reasoning_steps
from app.services.chat.usage import TokenUsageHandler


async def _preload_user_credentials(
    api_key_manager: Any, uid: int, db: AsyncSession
) -> None:
    if api_key_manager and getattr(api_key_manager, "is_enabled", False):
        await api_key_manager.preload_credentials(uid, db)


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
    if not usage_writer or total_tokens <= 0:
        return
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
) -> tuple[str, list[dict], list[BaseMessage], int, TokenUsageHandler]:
    """Shared body for non-streaming endpoints — dispatch + measure."""
    token_handler = TokenUsageHandler()
    start_time = time.time()
    raw = await agent_run(
        request,
        uid=uid,
        db=db,
        agent_harness=agent_harness,
        session_id=ctx.chat_session_id,
        query=ctx.user_message,
        callbacks=[token_handler],
    )
    latency_ms = int((time.time() - start_time) * 1000)
    answer, sources, messages = _normalize_agent_result(raw)
    return answer, sources, messages, latency_ms, token_handler


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
        answer, sources, _msgs, latency_ms, tokens = await _run_agent_turn(
            request, uid=uid, db=db, agent_harness=agent_harness, ctx=ctx
        )
        await finalize_turn(
            db,
            assistant_msg_id=ctx.assistant_msg_id,
            content=answer,
            sources=sources[:5],
            tokens_used=tokens.total_tokens or None,
            latency_ms=latency_ms,
        )
        _enqueue_usage(
            usage_writer,
            uid=uid,
            credential_id=None,
            provider="openai",
            model=settings.llm_model,
            total_tokens=tokens.total_tokens,
            prompt_tokens=tokens.prompt_tokens,
            completion_tokens=tokens.completion_tokens,
            api_calls=tokens.llm_calls or 1,
        )
        return ChatResponse(answer=answer, sources=sources[:5])
    except HTTPException:
        await fail_turn(
            db, assistant_msg_id=ctx.assistant_msg_id, error="HTTPException during ask"
        )
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
        answer, sources, messages, latency_ms, tokens = await _run_agent_turn(
            request, uid=uid, db=db, agent_harness=agent_harness, ctx=ctx
        )
        reasoning_payload = extract_reasoning_steps(messages)

        await finalize_turn(
            db,
            assistant_msg_id=ctx.assistant_msg_id,
            content=answer,
            sources=sources[:5],
            tokens_used=tokens.total_tokens or None,
            latency_ms=latency_ms,
        )
        _enqueue_usage(
            usage_writer,
            uid=uid,
            credential_id=None,
            provider="openai",
            model=settings.llm_model,
            total_tokens=tokens.total_tokens,
            prompt_tokens=tokens.prompt_tokens,
            completion_tokens=tokens.completion_tokens,
            api_calls=tokens.llm_calls or 1,
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
        await fail_turn(
            db,
            assistant_msg_id=ctx.assistant_msg_id,
            error="HTTPException during agentic",
        )
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
        agent_name, agent_graph, input_state, run_config = await agent_stream_setup(
            request,
            uid=uid,
            db=db,
            agent_harness=agent_harness,
            session_id=ctx.chat_session_id,
            query=ctx.user_message,
        )
    except HTTPException:
        await fail_turn(
            db,
            assistant_msg_id=ctx.assistant_msg_id,
            error="HTTPException during stream",
        )
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
        agent_name, agent_graph, input_state, run_config = await agent_stream_setup(
            request,
            uid=uid,
            db=db,
            agent_harness=agent_harness,
            session_id=ctx.chat_session_id,
            query=ctx.user_message,
        )
    except HTTPException:
        await fail_turn(
            db,
            assistant_msg_id=ctx.assistant_msg_id,
            error="HTTPException during agent stream",
        )
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
) -> AsyncIterator[str]:
    """Drive the agent stream, persist the result, enqueue usage."""
    from app.services.chat.sse import sse_event

    token_handler = TokenUsageHandler()
    callbacks = list(run_config.get("callbacks") or [])
    callbacks.append(token_handler)
    run_config = {**run_config, "callbacks": callbacks}

    streamer = AgentSSEStreamer()
    start_time = time.time()
    if emit_route:
        yield sse_event({"type": "route", "agent": agent_name})

    try:
        async for frame in streamer.stream(agent_graph, input_state, run_config):
            yield frame

        latency_ms = int((time.time() - start_time) * 1000)
        await finalize_turn(
            db,
            assistant_msg_id=ctx.assistant_msg_id,
            content=streamer.full_content,
            sources=streamer.sources[:5],
            tokens_used=token_handler.total_tokens or None,
            latency_ms=latency_ms,
        )
        _enqueue_usage(
            usage_writer,
            uid=uid,
            credential_id=None,
            provider="openai",
            model=settings.llm_model,
            total_tokens=token_handler.total_tokens,
            prompt_tokens=token_handler.prompt_tokens,
            completion_tokens=token_handler.completion_tokens,
            api_calls=token_handler.llm_calls or 1,
        )
    except Exception as e:
        logger.exception("Agent stream generation failed")
        error_msg = str(e)
        yield sse_event({"type": "error", "message": error_msg})
        await fail_turn(db, assistant_msg_id=ctx.assistant_msg_id, error=error_msg)
