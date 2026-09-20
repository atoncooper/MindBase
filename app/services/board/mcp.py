"""MCP client for app-board-mcp — service mode.

Every operation opens a short-lived streamable-http session:
``initialize -> tools/call -> session DELETE on close``. Service-mode identity
(``apikey`` + per-request ``X-Uid``) rides on every HTTP request of the
session, so the MCP server resolves the acting uid per call. The uid always
originates from the authenticated backend session (injected as ``_uid`` by the
agent graph) — the LLM never sees or chooses it.

Call path: backend -> app-board-mcp:8005 (direct, compose network) ->
APISIX /internal/board/* (key-auth + limit-req) -> app-board.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from app.config import settings

logger = logging.getLogger(__name__)


class BoardMCPError(RuntimeError):
    """A board tool call failed (the MCP tool returned an error result)."""


class BoardMCPUnavailableError(BoardMCPError):
    """The app-board-mcp server could not be reached or the session failed."""


class BoardMCPClient:
    """Thin async client over the app-board-mcp tool surface."""

    def __init__(self, url: str, auth_token: str, service_key: str, timeout: float = 30.0):
        self._url = url
        self._auth_token = auth_token
        self._service_key = service_key
        self._timeout = timeout

    def _headers(self, uid: int) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._auth_token}",
            "apikey": self._service_key,
            "X-Uid": str(uid),
            "X-Request-Id": uuid.uuid4().hex[:16],
        }

    async def call(self, uid: int, tool: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """Call one MCP tool and return its JSON payload.

        Raises BoardMCPUnavailableError on transport/session failures and
        BoardMCPError when the tool itself reports an error.
        """
        started = time.perf_counter()
        timeout = httpx2.Timeout(connect=10.0, read=self._timeout, write=self._timeout, pool=10.0)
        headers = self._headers(uid)
        try:
            async with httpx2.AsyncClient(headers=headers, timeout=timeout, follow_redirects=False) as http:
                async with streamable_http_client(self._url, http_client=http) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool(tool, arguments or {}, read_timeout_seconds=self._timeout)
        except BoardMCPError:
            raise
        except Exception as exc:  # transport, session, timeout, protocol
            logger.error("[BOARD_MCP] call failed tool=%s uid=%s err=%s", tool, uid, exc)
            raise BoardMCPUnavailableError(f"board 服务暂不可达（{tool}）: {exc}") from exc

        elapsed = time.perf_counter() - started
        text = ""
        if result.content:
            first = result.content[0]
            text = getattr(first, "text", "")
        if getattr(result, "isError", False):
            logger.warning("[BOARD_MCP] tool error tool=%s uid=%s detail=%s", tool, uid, text[:200])
            raise BoardMCPError(text or f"{tool} failed")
        logger.info("[BOARD_MCP] tool ok tool=%s uid=%s elapsed=%.2fs", tool, uid, elapsed)

        try:
            return json.loads(text) if text else {}
        except (TypeError, json.JSONDecodeError):
            return {"raw": text}


class _LazyClient:
    """Lazily constructed module-level singleton (tests monkeypatch it)."""

    _instance: BoardMCPClient | None = None

    def get(self) -> BoardMCPClient:
        if self._instance is None:
            self._instance = BoardMCPClient(
                url=settings.board_mcp_url,
                auth_token=settings.board_mcp_auth_token,
                service_key=settings.board_mcp_service_key,
                timeout=settings.board_mcp_timeout,
            )
        return self._instance

    def reset(self, client: BoardMCPClient | None = None) -> None:
        self._instance = client


def get_board_mcp_client() -> BoardMCPClient:
    return _lazy_client.get()


_lazy_client = _LazyClient()
