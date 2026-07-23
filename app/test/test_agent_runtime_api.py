"""Tests for GET /agent/runtime - admin-only agent harness status endpoint."""

from __future__ import annotations

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, MagicMock

from app.main import app
from app.routers.auth import require_admin


@pytest_asyncio.fixture
async def client():
    """ASGI test client - no lifespan, so app.state is set manually per test."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


def _set_harness(status: str, health: dict | None = None, error: str | None = None) -> None:
    """Inject a mock harness + status onto app.state."""
    mock_harness = MagicMock()
    mock_harness.started = status == "started"
    mock_harness.health = AsyncMock(return_value=health or {})
    app.state.agent_harness = mock_harness
    app.state.agent_harness_status = status
    app.state.agent_harness_error = error


def _as_admin(uid: int = 1) -> None:
    """Override require_admin so the caller is treated as an admin."""

    async def _override() -> int:
        return uid

    app.dependency_overrides[require_admin] = _override


def _as_non_admin() -> None:
    """Override require_admin to reject (simulates a non-admin caller)."""

    async def _override() -> int:
        raise HTTPException(status_code=403, detail="需要管理员权限")

    app.dependency_overrides[require_admin] = _override


class TestGetAgentRuntime:
    @pytest.mark.asyncio
    async def test_started_returns_health_snapshot(self, client):
        _as_admin()
        _set_harness(
            "started",
            health={
                "status": "running",
                "registered_agents": ["chat", "memory", "quiz"],
                "sessions_active": 2,
                "circuit_breaker": {"state": "closed", "failures": 0},
            },
        )

        resp = await client.get("/agent/runtime")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "running"
        assert "chat" in data["registered_agents"]
        assert data["sessions_active"] == 2

    @pytest.mark.asyncio
    async def test_skipped_returns_503(self, client):
        _as_admin()
        _set_harness("skipped", error="LLM 未配置")

        resp = await client.get("/agent/runtime")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_failed_returns_503_with_cause(self, client):
        _as_admin()
        _set_harness("failed", error="ModuleNotFoundError: No module named 'langgraph'")

        resp = await client.get("/agent/runtime")
        assert resp.status_code == 503
        assert "langgraph" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_non_admin_returns_403(self, client):
        _as_non_admin()
        _set_harness("started", health={"status": "running"})

        resp = await client.get("/agent/runtime")
        assert resp.status_code == 403
