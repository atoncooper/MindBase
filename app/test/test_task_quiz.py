"""Tests for /task-quiz/register (forwards to app-task via APISIX key-auth)."""

import pytest
from fastapi import HTTPException

from app.routers import task_quiz
from app.routers.task_quiz import TaskRegisterRequest, register


class FakeRequest:
    """Minimal stand-in for starlette.Request (only .headers used)."""

    def __init__(self, headers=None):
        self.headers = headers or {}


class FakeResponse:
    def __init__(self, status_code, json_data, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    def json(self):
        return self._json


class FakeClient:
    """Stand-in for httpx.AsyncClient used by register()."""

    def __init__(self, *args, **kwargs):
        self.captured_url = None
        self.captured_json = None
        self.captured_headers = None
        self._response = FakeResponse(200, {"task_id": "t1", "status": "pending"})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, headers=None):
        self.captured_url = url
        self.captured_json = json
        self.captured_headers = headers
        return self._response


@pytest.mark.asyncio
async def test_register_401_without_x_uid():
    with pytest.raises(HTTPException) as exc:
        await register(
            FakeRequest(),
            TaskRegisterRequest(prompt="p", trigger_time="2099-01-01T00:00:00Z"),
        )
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_register_400_when_email_missing(monkeypatch):
    async def fake_resolve(uid):
        return ""

    monkeypatch.setattr(task_quiz, "_resolve_email", fake_resolve)

    with pytest.raises(HTTPException) as exc:
        await register(
            FakeRequest({"X-Uid": "1"}),
            TaskRegisterRequest(prompt="p", trigger_time="2099-01-01T00:00:00Z"),
        )
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_register_forwards_to_app_task(monkeypatch):
    async def fake_resolve(uid):
        return "u@x.com"

    monkeypatch.setattr(task_quiz, "_resolve_email", fake_resolve)

    fake_client = FakeClient()
    monkeypatch.setattr(task_quiz.httpx, "AsyncClient", lambda *a, **kw: fake_client)

    resp = await register(
        FakeRequest({"X-Uid": "7"}),
        TaskRegisterRequest(
            prompt="数学1填空题",
            difficulty="hard",
            trigger_time="2099-01-01T00:00:00Z",
            cc_emails=["a@x.com"],
        ),
    )

    assert resp == {"task_id": "t1", "status": "pending"}
    # payload forwarded to app-task includes uid, email, difficulty
    assert fake_client.captured_json["uid"] == 7
    assert fake_client.captured_json["user_email"] == "u@x.com"
    assert fake_client.captured_json["difficulty"] == "hard"
    assert fake_client.captured_json["cc_emails"] == ["a@x.com"]
    # apikey header set (APISIX key-auth)
    assert "apikey" in fake_client.captured_headers


@pytest.mark.asyncio
async def test_register_502_when_app_task_fails(monkeypatch):
    async def fake_resolve(uid):
        return "u@x.com"

    monkeypatch.setattr(task_quiz, "_resolve_email", fake_resolve)

    fake_client = FakeClient()
    fake_client._response = FakeResponse(500, {})
    monkeypatch.setattr(task_quiz.httpx, "AsyncClient", lambda *a, **kw: fake_client)

    with pytest.raises(HTTPException) as exc:
        await register(
            FakeRequest({"X-Uid": "1"}),
            TaskRegisterRequest(prompt="p", trigger_time="2099-01-01T00:00:00Z"),
        )
    assert exc.value.status_code == 502


@pytest.mark.asyncio
async def test_register_default_difficulty_medium(monkeypatch):
    async def fake_resolve(uid):
        return "u@x.com"

    monkeypatch.setattr(task_quiz, "_resolve_email", fake_resolve)

    fake_client = FakeClient()
    monkeypatch.setattr(task_quiz.httpx, "AsyncClient", lambda *a, **kw: fake_client)

    await register(
        FakeRequest({"X-Uid": "1"}),
        TaskRegisterRequest(prompt="p", trigger_time="2099-01-01T00:00:00Z"),
    )
    assert fake_client.captured_json["difficulty"] == "medium"


@pytest.mark.asyncio
async def test_register_rejects_past_trigger_time(monkeypatch):
    async def fake_resolve(uid):
        return "u@x.com"

    monkeypatch.setattr(task_quiz, "_resolve_email", fake_resolve)

    with pytest.raises(HTTPException) as exc:
        await register(
            FakeRequest({"X-Uid": "1"}),
            TaskRegisterRequest(prompt="p", trigger_time="2020-01-01T00:00:00Z"),
        )
    assert exc.value.status_code == 400
    assert "晚于当前" in exc.value.detail


@pytest.mark.asyncio
async def test_register_rejects_invalid_trigger_time(monkeypatch):
    async def fake_resolve(uid):
        return "u@x.com"

    monkeypatch.setattr(task_quiz, "_resolve_email", fake_resolve)

    with pytest.raises(HTTPException) as exc:
        await register(
            FakeRequest({"X-Uid": "1"}),
            TaskRegisterRequest(prompt="p", trigger_time="not-a-date"),
        )
    assert exc.value.status_code == 400
    assert "invalid trigger_time" in exc.value.detail
