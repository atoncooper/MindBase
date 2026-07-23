"""
MindBase 知识库系统

主应用入口
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from loguru import logger
import sys
import os
import uuid
from typing import Any

from app.config import settings, ensure_directories

# === 将 .env 中的 LangSmith 配置同步到 os.environ ===
# langchain 在首次导入时检查 os.environ 以决定是否注册自动追踪回调。
# pydantic_settings 读取 .env 后不会自动写回 os.environ，因此必须手动同步。
if settings.langchain_tracing_v2:
    os.environ["LANGCHAIN_TRACING_V2"] = "true"
if settings.langsmith_tracing:
    os.environ["LANGSMITH_TRACING"] = "true"
if settings.langsmith_api_key:
    os.environ["LANGSMITH_API_KEY"] = settings.langsmith_api_key
if settings.langsmith_project:
    os.environ["LANGSMITH_PROJECT"] = settings.langsmith_project
if settings.langsmith_endpoint:
    os.environ["LANGSMITH_ENDPOINT"] = settings.langsmith_endpoint

from app.database import init_db
from app.routers import auth, favorites_v2, knowledge, chat, settings as settings_router
from app.routers.asr import router as asr_router
from app.routers.vector_page import router as vector_page_router
from app.routers.credentials import router as credentials_router
from app.routers.billing import router as billing_router
from app.routers.quiz import router as quiz_router
from app.routers.notes import router as notes_router
from app.routers.tasks_ws import router as tasks_ws_router


# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
LOG_FORMAT_CONSOLE = (
    "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
    "<level>{level: <8}</level> | "
    "<yellow>{extra[request_id]}</yellow> | "
    "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - "
    "<level>{message}</level>"
)
LOG_FORMAT_FILE = (
    "{time:YYYY-MM-DD HH:mm:ss.SSS} | "
    "{level: <8} | "
    "{extra[request_id]} | "
    "{name}:{function}:{line} - "
    "{message}"
)

logger.configure(extra={"request_id": "-"})
logger.remove()
logger.add(
    sys.stdout,
    format=LOG_FORMAT_CONSOLE,
    level="DEBUG" if settings.debug else "INFO",
    colorize=True,
)
# Main log: everything at DEBUG, rotated
logger.add(
    "logs/app.log",
    format=LOG_FORMAT_FILE,
    rotation="10 MB",
    retention="7 days",
    level="DEBUG",
)
# Error log: only ERROR+CRITICAL, longer retention, separate file for ops
logger.add(
    "logs/error.log",
    format=LOG_FORMAT_FILE,
    rotation="10 MB",
    retention="30 days",
    level="ERROR",
    backtrace=True,
    diagnose=True,
)


# === LangSmith 追踪诊断（必须在 langchain 首次导入之前执行） ===
# LangSmith 的自动追踪由 langchain 包在首次导入时检查环境变量并注册。
# 不需要也不应该手动 import langsmith 来"注册"追踪器。
def _diagnose_langsmith() -> None:
    tracing_v2 = os.environ.get("LANGCHAIN_TRACING_V2", "").lower()
    langsmith_tracing = os.environ.get("LANGSMITH_TRACING", "").lower()
    api_key = os.environ.get("LANGSMITH_API_KEY", "")
    project = os.environ.get("LANGSMITH_PROJECT", "default")

    is_enabled = tracing_v2 == "true" or langsmith_tracing == "true"

    if not is_enabled:
        logger.info(
            "[LANGSMITH] 追踪未启用。"
            "设置 LANGCHAIN_TRACING_V2=true 或 LANGSMITH_TRACING=true 以启用自动追踪。"
        )
        return

    if not api_key:
        logger.warning(
            "[LANGSMITH] 追踪已启用但 LANGSMITH_API_KEY 未设置。"
            "请在 .env 中配置 API key。"
        )
        return

    logger.info(f"[LANGSMITH] 自动追踪已启用 (project={project})")

    # 检查 langsmith 包是否安装
    try:
        import langsmith as ls

        logger.info(f"[LANGSMITH] langsmith 包已安装 (版本: {ls.__version__})")
    except ImportError:
        logger.error(
            "[LANGSMITH] 追踪已启用但 langsmith 包未安装!"
            "请运行: pip install langsmith"
        )
        return

    # 验证 API key 是否有效
    try:
        from langsmith import Client

        client = Client()
        projects = list(client.list_projects())
        logger.info(f"[LANGSMITH] API key 验证成功 (找到 {len(projects)} 个项目)")
    except Exception as exc:
        logger.warning(f"[LANGSMITH] API key 验证失败: {exc}")


diagnose_langsmith = _diagnose_langsmith


async def _recover_stuck_cloud_tasks():
    """Plan 0023: Reset stuck cloud drive processing tasks (status=processing and timed out)."""
    try:
        from app.infra.config import config as _cfg

        if not _cfg.rdbms.url:
            return

        from app.database import engine as _engine
        from sqlalchemy import text as _text

        async with _engine.begin() as conn:
            result = await conn.execute(
                _text(
                    "UPDATE async_tasks SET status = 'pending', progress = 0, updated_at = NOW() "
                    "WHERE status = 'processing' "
                    "AND task_type IN ('cloud_doc', 'cloud_video') "
                    "AND updated_at < NOW() - INTERVAL 30 MINUTE"
                )
            )
            count = result.rowcount
            if count > 0:
                logger.warning(f"[STARTUP] 恢复 {count} 个卡住的云盘处理任务")
    except Exception as e:
        logger.debug("[STARTUP] cloud task recovery skipped: {}", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时
    logger.info("🚀 MindBase 知识库系统启动中...")
    ensure_directories()
    await init_db()
    logger.info("数据库初始化完成")

    # Init Redis (before cache_manager so L2 can be activated)
    if settings.redis_enabled:
        from app.infra.redis import init as redis_init, ping as redis_ping

        await redis_init()
        result = await redis_ping()
        if not result["ok"]:
            raise RuntimeError(f"Redis connection failed: {result['error']}")
        logger.info("[REDIS] connected (latency={}ms)", result["latency_ms"])

    # Init multi-level cache (L1 local, L2 Redis when connected)
    from app.infra.cache import cache_manager

    await cache_manager.start(redis_enabled=settings.redis_enabled)
    logger.info(
        f"[CACHE] manager started (L1 ready, L2={'redis' if settings.redis_enabled else 'disabled'})"
    )

    # Startup health checks — fails fast if any enabled infra is unreachable
    from app.utils.startup_checks import run_startup_checks

    await run_startup_checks()

    # Start async task cache refresher subprocess (every 30s)
    from app.services.async_task.cache import start_cache_refresher

    start_cache_refresher(settings.database_url)

    # LangSmith 追踪诊断
    diagnose_langsmith()

    # Plan 0021: Cloud drive initialization
    from app.infra.config import config as _cfg

    if _cfg.minio.enabled:
        try:
            from app.infra.minio import init as minio_init

            await minio_init()
            logger.info("[MAIN] MinIO init OK")
        except Exception as e:
            logger.warning(f"[MAIN] MinIO init failed (cloud drive disabled): {e}")

    # 初始化 ApiKeyManager（用户自定义 API Key 加密服务）
    from app.services.llm.api_key_manager import ApiKeyManager

    app.state.api_key_manager = ApiKeyManager(
        encryption_key_b64=settings.api_key_encryption_key or None
    )
    logger.info(
        "[API_KEY_MANAGER] initialized (enabled={})".format(
            app.state.api_key_manager.is_enabled
        )
    )

    # 初始化 BufferedUsageWriter（用量缓冲批量写入器）
    from app.services.llm.buffered_usage_writer import start_buffered_usage_writer

    app.state.usage_writer = await start_buffered_usage_writer()

    # 初始化 QueryRewriter
    from app.services.query import QueryRewriter

    app.state.rewriter = QueryRewriter()
    logger.info("[QUERY_REWRITE] QueryRewriter initialized")

    # === 崩溃恢复：扫描 pending 向量化任务 ===
    import asyncio
    from app.services.async_task.tracker import TaskTracker
    from app.services.vector_page_service import VectorPageService

    tracker = TaskTracker()
    vector_service = VectorPageService(tracker)
    pending = await tracker.list_pending("vec_page")

    if pending:
        logger.info(f"[STARTUP] 发现 {len(pending)} 个未完成的向量化任务，开始恢复...")
        for task in pending:
            asyncio.create_task(
                vector_service.process_page_vectorization(
                    task_id=task["task_id"],
                    bvid=task["target"]["bvid"],
                    cid=task["target"]["cid"],
                    page_index=task["target"]["page_index"],
                    page_title=task["target"].get("page_title"),
                )
            )

    # Plan 0023: Recover stuck cloud drive document processing tasks
    await _recover_stuck_cloud_tasks()

    # === Agent Harness 启动 ===
    # Failure modes (stored on app.state so /health and request-time 503s can
    # surface the real reason instead of a generic "unavailable"):
    #   - LLM not configured → state.agent_harness_status = "skipped"
    #   - start() raised     → state.agent_harness_status = "failed"
    #                         + state.agent_harness_error = "<msg>"
    #   - success            → state.agent_harness_status = "started"
    app.state.agent_harness_status = "skipped"
    app.state.agent_harness_error = None
    try:
        from app.context import init_context_manager
        from app.harness import AgentHarness

        ctx_mgr = init_context_manager()
        _llm_for_harness = _get_harness_llm()
        if _llm_for_harness:
            from app.database import async_session_factory

            _harness = AgentHarness(
                context_manager=ctx_mgr,
                llm=_llm_for_harness,
                session_factory=async_session_factory,
            )
            await _harness.start()
            app.state.agent_harness = _harness
            app.state.agent_harness_status = "started"
            logger.info(
                "[HARNESS] started agents={} tools={}",
                _harness.lifecycle.registered_agents,
                len(_harness.tool_names),
            )
        else:
            logger.warning("[HARNESS] LLM not configured — harness not started")
            app.state.agent_harness_error = "LLM not configured (openai_api_key empty)"
    except Exception as e:
        # ERROR + full traceback: a failed harness makes ALL chat endpoints
        # return 503, so this is a service-impacting condition, not a warning.
        logger.exception(f"[HARNESS] startup failed (agents unavailable): {e}")
        app.state.agent_harness_status = "failed"
        app.state.agent_harness_error = f"{type(e).__name__}: {e}"

    # Register a health provider so the dispatcher's 503 can carry the real
    # root cause (e.g. "ModuleNotFoundError: No module named 'langgraph'")
    # instead of a generic "unavailable".
    from app.services.chat.dispatcher import set_harness_health_provider

    _app_state = app.state

    def _harness_health() -> tuple[str, Any]:
        return (
            getattr(_app_state, "agent_harness_status", "unknown"),
            getattr(_app_state, "agent_harness_error", None),
        )

    set_harness_health_provider(_harness_health)

    yield

    # 关闭时 — 使用 asyncio.shield 防止 Ctrl+C 取消导致缓冲区数据丢失
    import asyncio as _asyncio

    try:
        from app.services.llm.buffered_usage_writer import (
            shutdown_buffered_usage_writer,
        )

        await _asyncio.shield(shutdown_buffered_usage_writer())

        await _asyncio.shield(app.state.rewriter.close())
        logger.info("[QUERY_REWRITE] QueryRewriter shutdown")

        # Agent Harness shutdown
        _harness = getattr(app.state, "agent_harness", None)
        if _harness and _harness.started:
            await _asyncio.shield(_harness.shutdown())
            logger.info("[HARNESS] shutdown complete")

        from app.infra.mongo import close as close_mongo

        await _asyncio.shield(close_mongo())

        from app.infra.milvus import close as close_milvus

        await _asyncio.shield(close_milvus())

        from app.services.async_task.cache import stop_cache_refresher

        stop_cache_refresher()

        logger.info("👋 应用关闭")
    except _asyncio.CancelledError:
        logger.info("👋 应用关闭（interrupted）")
    except Exception:
        logger.exception("Shutdown error")


# 创建 FastAPI 应用
app = FastAPI(
    title="MindBase 知识库系统",
    response_model_by_alias=False,
    description="""
## 项目简介

将你的 B站收藏夹变成可对话的知识库！

### 功能特性

- 🔐 **B站扫码登录** - 安全便捷
- 📁 **收藏夹管理** - 查看和选择收藏夹
- 🤖 **AI 内容提取** - 自动获取视频摘要/字幕
- 💬 **智能问答** - 基于收藏内容回答问题
- 🔍 **语义搜索** - 快速找到相关视频

### 技术栈

- FastAPI + LangChain + Milvus
- B站 API (非官方)
    """,
    version="0.1.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Middleware: request-id + error logging
# ---------------------------------------------------------------------------


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):
    """Attach a unique request_id to every request for log correlation."""
    request_id = request.headers.get("x-request-id", uuid.uuid4().hex[:12])
    request.state.request_id = request_id
    with logger.contextualize(request_id=request_id):
        try:
            response = await call_next(request)
            return response
        except Exception:
            logger.exception(
                "Unhandled exception | method={} path={}",
                request.method,
                request.url.path,
            )
            return JSONResponse(
                status_code=500,
                content={"detail": "Internal server error", "request_id": request_id},
            )


# CORS 中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境应该限制
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Plan 0023: Rate limiting middleware (second line of defense after nginx).
# The middleware lazy-resolves the Redis client at dispatch time, so it is
# always safe to register — if Redis is disabled or not yet initialised it
# simply passes requests through (nginx remains the first line of defense).
try:
    from app.middleware.rate_limit import RateLimitMiddleware

    app.add_middleware(RateLimitMiddleware)
    logger.info("[MAIN] RateLimitMiddleware registered (lazy Redis resolution)")
except Exception as e:
    logger.warning("[MAIN] RateLimitMiddleware failed to init: {}", e)


# 注册路由
app.include_router(auth.router)
app.include_router(favorites_v2.router)
app.include_router(knowledge.router)
app.include_router(chat.router)
app.include_router(settings_router.router)
app.include_router(asr_router)
app.include_router(vector_page_router)
app.include_router(credentials_router)
app.include_router(billing_router)
app.include_router(quiz_router)
app.include_router(notes_router)
app.include_router(tasks_ws_router)

# Plan 0021: Cloud drive router (with graceful degradation)
try:
    from app.routers.cloud import router as cloud_router

    app.include_router(cloud_router)
    logger.info("[MAIN] Cloud drive router registered")
except ImportError as e:
    logger.info(f"[MAIN] Cloud drive router not available: {e}")

# Plan 0023: Workspace router
try:
    from app.routers.workspace import router as workspace_router

    app.include_router(workspace_router)
    logger.info("[MAIN] Workspace router registered")
except ImportError as e:
    logger.info(f"[MAIN] Workspace router not available: {e}")


@app.get("/")
async def root():
    """API 根路径"""
    return {
        "message": "🎬 MindBase 知识库系统",
        "version": "0.1.0",
        "docs": "/docs",
        "status": "running",
    }


@app.get("/health")
async def health_check(request: Request):
    """健康检查 — 包含 Agent Harness 状态。

    harness 是所有 /chat/ask* 端点的前置依赖：它没起来，聊天接口
    一律 503。把它的状态暴露给健康检查，让监控能及早告警，而不是
    等到用户发请求时才发现。

    status 取值：
      - "healthy"  : harness 已启动
      - "degraded" : harness 未启动（LLM 未配置 / 启动失败），
                     非 chat 功能仍可用，chat 会 503
    """
    harness_status = getattr(request.app.state, "agent_harness_status", "unknown")
    harness_error = getattr(request.app.state, "agent_harness_error", None)

    healthy = harness_status == "started"
    payload: dict[str, Any] = {
        "status": "healthy" if healthy else "degraded",
        "agent_harness": {
            "status": harness_status,
            "error": harness_error,
        },
    }
    # 503 让负载均衡/监控把不健康实例摘掉，而不是继续转发 chat 请求过来。
    if not healthy:
        return JSONResponse(status_code=503, content=payload)
    return payload


@app.get("/cache/stats")
async def cache_stats():
    """缓存命中率监控"""
    from app.infra.cache import cache_manager

    return cache_manager.get_stats()


def _get_harness_llm():
    """Create a ChatOpenAI instance for the AgentHarness.

    Uses the system default LLM config.  Returns None if no API key is
    configured so that the harness startup can be skipped gracefully.
    """
    try:
        from langchain_openai import ChatOpenAI

        api_key = settings.openai_api_key
        if not api_key:
            return None

        # streaming=True so that astream_events(version="v2") receives
        # per-token on_chat_model_stream events.  Without it, ChatOpenAI's
        # _agenerate produces the whole answer in one shot, so the SSE
        # streamer emits a single `chunk` frame with the full text and the
        # frontend renders it non-incrementally.  stream_usage=True keeps
        # token usage flowing in stream mode so usage tracking still works.
        return ChatOpenAI(
            api_key=api_key,
            base_url=settings.openai_base_url or None,
            model=settings.llm_model,
            temperature=0,
            streaming=True,
            stream_usage=True,
        )
    except Exception as e:
        logger.warning("[HARNESS] failed to create LLM: {}", e)
        return None


if __name__ == "__main__":
    import uvicorn
    from app.infra.config import config as _cfg

    ssl_kwargs = {}
    if _cfg.server.ssl_certfile and _cfg.server.ssl_keyfile:
        ssl_kwargs = {
            "ssl_certfile": _cfg.server.ssl_certfile,
            "ssl_keyfile": _cfg.server.ssl_keyfile,
        }

    uvicorn.run(
        "app.main:app",
        host=settings.app_host,
        port=settings.app_port,
        reload=settings.debug,
        proxy_headers=_cfg.server.proxy_headers,
        forwarded_allow_ips="*" if _cfg.server.proxy_headers else None,
        **ssl_kwargs,
    )
