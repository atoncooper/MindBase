"""Admin-only endpoint exposing AgentHarness runtime status.

``GET /agent/runtime`` returns a snapshot of the harness's in-memory state
(``harness.health()``): circuit breaker, per-tool metrics, scheduler stats,
registered agents, and tool discovery. Intended for the ops/observability
panel - it is a transient snapshot, not a persisted history.

Returns 503 with the root cause when the harness failed to start or was
skipped (e.g. LLM not configured).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from app.routers.auth import require_admin

router = APIRouter(prefix="/agent", tags=["agent-runtime"])


@router.get("/runtime")
async def get_agent_runtime(
    request: Request,
    _uid: int = Depends(require_admin),
) -> dict:
    """Return a snapshot of the AgentHarness runtime state (admin-only)."""
    status = getattr(request.app.state, "agent_harness_status", "unknown")
    error = getattr(request.app.state, "agent_harness_error", None)
    harness = getattr(request.app.state, "agent_harness", None)

    if status != "started" or harness is None:
        if status == "failed" and error:
            raise HTTPException(status_code=503, detail=f"Agent 服务启动失败: {error}")
        if status == "skipped":
            raise HTTPException(
                status_code=503,
                detail=f"Agent 服务未启动: {error or 'LLM 未配置'}",
            )
        raise HTTPException(status_code=503, detail="Agent 服务暂不可用")

    return await harness.health()
