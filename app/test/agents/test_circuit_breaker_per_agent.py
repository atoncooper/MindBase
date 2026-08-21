"""Tests for per-agent-type circuit breaker isolation.

Verifies the fix for the "global breaker cascading" problem: a failing
sub-agent (e.g. code) trips only its own breaker, leaving chat (and others)
unaffected. Previously all agents shared one global breaker, so 3 code
failures would take down chat too.
"""

import pytest

from app.agent.lifecycle import AgentLifecycleManager
from app.agent.lifecycle.circuit import CircuitBreaker

pytestmark = pytest.mark.asyncio


class _FailingAgent:
    """Mock agent whose ainvoke always raises."""

    async def ainvoke(self, input, config=None):
        raise RuntimeError("sandbox down")


class _OkAgent:
    """Mock agent that always succeeds."""

    async def ainvoke(self, input, config=None):
        return {"result": "ok"}


class TestGetBreakerIsolation:
    async def test_different_agents_get_different_breakers(self):
        m = AgentLifecycleManager()
        cb_code = m.get_breaker("code")
        cb_chat = m.get_breaker("chat")
        assert cb_code is not cb_chat

    async def test_same_agent_returns_same_instance(self):
        m = AgentLifecycleManager()
        assert m.get_breaker("code") is m.get_breaker("code")

    async def test_tripping_one_does_not_trip_other(self):
        m = AgentLifecycleManager()
        cb_code = m.get_breaker("code")
        cb_chat = m.get_breaker("chat")
        for _ in range(cb_code._failure_threshold):
            cb_code.record_failure()
        assert cb_code.is_tripped
        assert not cb_chat.is_tripped

    async def test_deprecated_circuit_property_returns_chat_breaker(self):
        m = AgentLifecycleManager()
        assert m.circuit is m.get_breaker("chat")


class TestInvokeIsolation:
    async def test_failing_agent_does_not_trip_others(self):
        """3 code failures trip code's breaker but not chat's."""
        m = AgentLifecycleManager()
        m.register("code", lambda **kw: _FailingAgent())
        m.register("chat", lambda **kw: _OkAgent())

        # Trip code's breaker via repeated failed invocations.
        for _ in range(m.get_breaker("code")._failure_threshold):
            await m.invoke("code", session_id="s1", query="x")

        assert m.get_breaker("code").is_tripped
        assert not m.get_breaker("chat").is_tripped

    async def test_tripped_agent_blocked_but_others_run(self):
        """Once code's breaker is open, code is rejected but chat still works."""
        m = AgentLifecycleManager()
        m.register("code", lambda **kw: _FailingAgent())
        m.register("chat", lambda **kw: _OkAgent())

        for _ in range(m.get_breaker("code")._failure_threshold):
            await m.invoke("code", session_id="s1", query="x")

        # code is now blocked by its own breaker.
        code_result = await m.invoke("code", session_id="s1", query="x")
        assert "error" in code_result

        # chat is unaffected.
        chat_result = await m.invoke("chat", session_id="s1", query="x")
        assert "error" not in chat_result
        assert chat_result.get("result") == "ok"


class TestHealth:
    async def test_health_reports_per_agent_breakers(self):
        m = AgentLifecycleManager()
        m.get_breaker("code").record_failure()
        h = await m.health()
        assert "circuit_breakers" in h
        assert "code" in h["circuit_breakers"]
        assert h["circuit_breakers"]["code"]["failures"] == 1
        assert h["circuit_breakers"]["code"]["state"] == "closed"

    async def test_health_shows_tripped_agent(self):
        m = AgentLifecycleManager()
        cb = m.get_breaker("code")
        for _ in range(cb._failure_threshold):
            cb.record_failure()
        h = await m.health()
        assert h["circuit_breakers"]["code"]["state"] == "open"
        # chat breaker not present in health until touched, but code is open.
        assert h["circuit_breakers"]["code"]["failures"] >= cb._failure_threshold
