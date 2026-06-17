"""Chat router — HTTP-only thin layer.

Owns: parameter parsing, dependency injection, and translating
``services.chat.orchestrator`` outputs into HTTP / SSE responses.

Owns NOT: harness construction, scope resolution, history loading,
LLM construction, message persistence, routing rules.  All of those live
in ``app/services/chat/``.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.response import (
    AgenticChatResponse,
    ChatHistoryResponse,
    ChatRequest,
    ChatResponse,
    ChatSessionCreateRequest,
    ChatSessionListResponse,
    ChatSessionResponse,
    ChatSessionUpdateRequest,
)
from app.routers.auth import get_current_uid
from app.routers.knowledge import get_rag_service
from app.services import chat_history as chat_history_service
from app.services.chat import orchestrator as chat_orchestrator

router = APIRouter(prefix="/chat", tags=["对话"])


def _ensure_question(request: ChatRequest) -> None:
    if not request.question or not request.question.strip():
        raise HTTPException(status_code=400, detail="问题不能为空")


@router.post("/ask", response_model=ChatResponse)
async def ask_question(
    request: ChatRequest,
    http_request: Request,
    background_tasks: BackgroundTasks,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
) -> ChatResponse:
    """Non-streaming Q&A; persists chat history."""
    _ensure_question(request)
    return await chat_orchestrator.ask(
        request,
        uid=uid,
        db=db,
        background_tasks=background_tasks,
        agent_harness=getattr(http_request.app.state, "agent_harness", None),
        api_key_manager=getattr(http_request.app.state, "api_key_manager", None),
        usage_writer=getattr(http_request.app.state, "usage_writer", None),
    )


@router.post("/ask/agentic", response_model=AgenticChatResponse)
async def ask_question_agentic(
    request: ChatRequest,
    http_request: Request,
    background_tasks: BackgroundTasks,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
) -> AgenticChatResponse:
    """Agentic RAG Q&A; persists chat history."""
    _ensure_question(request)
    return await chat_orchestrator.ask_agentic(
        request,
        uid=uid,
        db=db,
        background_tasks=background_tasks,
        agent_harness=getattr(http_request.app.state, "agent_harness", None),
        api_key_manager=getattr(http_request.app.state, "api_key_manager", None),
        usage_writer=getattr(http_request.app.state, "usage_writer", None),
    )


@router.post("/ask/stream")
async def ask_question_stream(
    request: ChatRequest,
    http_request: Request,
    background_tasks: BackgroundTasks,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Streaming Q&A (SSE); persists chat history."""
    _ensure_question(request)
    generator = await chat_orchestrator.ask_stream(
        request,
        uid=uid,
        db=db,
        background_tasks=background_tasks,
        agent_harness=getattr(http_request.app.state, "agent_harness", None),
        api_key_manager=getattr(http_request.app.state, "api_key_manager", None),
        usage_writer=getattr(http_request.app.state, "usage_writer", None),
    )
    return StreamingResponse(generator, media_type="text/event-stream")


@router.post("/ask/agent", response_model=ChatResponse)
async def ask_question_agent(
    request: ChatRequest,
    http_request: Request,
    background_tasks: BackgroundTasks,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
) -> ChatResponse:
    """Agent-based RAG Q&A — routes through the AgentHarness Chat Agent."""
    _ensure_question(request)
    return await chat_orchestrator.ask_agent(
        request,
        uid=uid,
        db=db,
        background_tasks=background_tasks,
        agent_harness=getattr(http_request.app.state, "agent_harness", None),
        usage_writer=getattr(http_request.app.state, "usage_writer", None),
    )


@router.post("/ask/agent/stream")
async def ask_question_agent_stream(
    request: ChatRequest,
    http_request: Request,
    background_tasks: BackgroundTasks,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Streaming Agent-based RAG Q&A — SSE with token-level streaming."""
    _ensure_question(request)
    generator = await chat_orchestrator.ask_agent_stream(
        request,
        uid=uid,
        db=db,
        background_tasks=background_tasks,
        agent_harness=getattr(http_request.app.state, "agent_harness", None),
        usage_writer=getattr(http_request.app.state, "usage_writer", None),
    )
    return StreamingResponse(generator, media_type="text/event-stream")


@router.post("/search")
async def search_videos(query: str, k: int = 5):
    """Vector search for related video clips."""
    if not query or not query.strip():
        raise HTTPException(status_code=400, detail="查询不能为空")
    try:
        rag = get_rag_service()
        docs = rag.search(query, k=k)
        results, seen_bvids = [], set()
        for doc in docs:
            bvid = doc.metadata.get("bvid", "")
            if bvid in seen_bvids:
                continue
            seen_bvids.add(bvid)
            results.append(
                {
                    "bvid": bvid,
                    "title": doc.metadata.get("title", ""),
                    "url": doc.metadata.get("url", ""),
                    "content_preview": (
                        doc.page_content[:200] + "..."
                        if len(doc.page_content) > 200
                        else doc.page_content
                    ),
                }
            )
        return {"results": results}
    except Exception as e:
        logger.exception("Search failed")
        raise HTTPException(status_code=500, detail=f"搜索失败: {str(e)}")


# ============================================================================
# Chat session management
# ============================================================================


@router.post("/sessions", response_model=ChatSessionResponse)
async def create_session(
    request: ChatSessionCreateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Create a new chat session."""
    return await chat_history_service.create_chat_session(
        db, uid=uid, title=request.title
    )


@router.get("/sessions", response_model=ChatSessionListResponse)
async def list_sessions(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """List chat sessions for the current user."""
    sessions = await chat_history_service.list_chat_sessions(db, uid)
    return ChatSessionListResponse(sessions=sessions)


@router.get("/sessions/{chat_session_id}", response_model=ChatSessionResponse)
async def get_session(
    chat_session_id: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Get a single chat session."""
    session = await chat_history_service.get_chat_session_for_user(
        db, uid, chat_session_id
    )
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    return session


@router.patch("/sessions/{chat_session_id}", response_model=ChatSessionResponse)
async def update_session(
    chat_session_id: str,
    request: ChatSessionUpdateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Update the chat-session title."""
    title = request.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="标题不能为空")

    updated = await chat_history_service.update_chat_session_title_for_user(
        db, uid, chat_session_id, title
    )
    if not updated:
        raise HTTPException(status_code=404, detail="会话不存在")
    session = await chat_history_service.get_chat_session_for_user(
        db, uid, chat_session_id
    )
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    return session


@router.delete("/sessions/{chat_session_id}")
async def delete_session(
    chat_session_id: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Delete a chat session and all of its messages."""
    deleted = await chat_history_service.delete_chat_session_for_user(
        db, uid, chat_session_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="会话不存在")
    return {"success": True}


# ============================================================================
# Chat history messages
# ============================================================================


@router.get("/history", response_model=ChatHistoryResponse)
async def get_chat_history(
    chat_session_id: str,
    page: int = 1,
    page_size: int = 50,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Paginated chat-history query."""
    history = await chat_history_service.get_history_for_user(
        db, uid, chat_session_id, page=page, page_size=page_size
    )
    if history is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    messages, total = history
    has_more = (page * page_size) < total
    return ChatHistoryResponse(
        messages=messages,
        total=total,
        page=page,
        page_size=page_size,
        has_more=has_more,
    )


@router.delete("/history")
async def clear_chat_history(
    chat_session_id: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Clear all messages of a chat session."""
    cleared = await chat_history_service.clear_history_for_user(
        db, uid, chat_session_id
    )
    if not cleared:
        raise HTTPException(status_code=404, detail="会话不存在")
    return {"success": True}
