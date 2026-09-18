"""Tests for ASR gateway routing (``app/services/asr.py``).

The AI gateway is the single egress for all AI traffic — ASR included:

- platform path (no explicit credential): consumer key + the gateway's
  native passthrough route (/api/v1 for HTTP, /api-ws for the realtime
  WebSocket), with the gateway injecting the real vendor key
- BYOK credential path (caller-supplied key): straight to the caller's
  endpoint (legacy DashScope native root when no base_url), never through
  the gateway
"""

from __future__ import annotations

from types import SimpleNamespace

import dashscope
import pytest

import app.services.asr as asr_module
from app.services.asr import ASRService


def _fake_settings(**over) -> SimpleNamespace:
    base = dict(
        ai_gateway_api_key="sk-higress",
        ai_gateway_base_url="http://higress:8080/v1",
        asr_model="paraformer-realtime-v2",
        asr_timeout=90,
        asr_model_local="paraformer-realtime-v2",
        asr_input_format="pcm",
        asr_transcription_model="paraformer-v2",
        asr_realtime_max_seconds=60,
        asr_recognition_timeout=90,
        ingest_asr_chunk_concurrency=3,
    )
    base.update(over)
    return SimpleNamespace(**base)


class TestPlatformPathViaGateway:
    def test_uses_consumer_key_and_native_route(self, monkeypatch):
        monkeypatch.setattr(asr_module, "settings", _fake_settings())
        svc = ASRService()
        assert svc.api_key == "sk-higress"
        assert svc.base_url == "http://higress:8080/api/v1"
        assert svc.gateway_ws_url == "ws://higress:8080/api-ws/v1/inference"
        assert svc._via_gateway is True

    def test_configure_sets_http_and_ws_sdk_urls(self, monkeypatch):
        monkeypatch.setattr(asr_module, "settings", _fake_settings())
        svc = ASRService()
        svc._configure()
        assert dashscope.base_http_api_url == "http://higress:8080/api/v1"
        assert dashscope.base_websocket_api_url == "ws://higress:8080/api-ws/v1/inference"
        assert dashscope.api_key == "sk-higress"

    def test_missing_consumer_key_raises_at_configure(self, monkeypatch):
        monkeypatch.setattr(
            asr_module, "settings", _fake_settings(ai_gateway_api_key="")
        )
        svc = ASRService()
        with pytest.raises(ValueError, match="consumer key"):
            svc._configure()


class TestByokPathDirect:
    def test_caller_credential_goes_direct_not_via_gateway(self, monkeypatch):
        monkeypatch.setattr(asr_module, "settings", _fake_settings())
        svc = ASRService(
            api_key="user-dashscope-key",
            base_url="https://dashscope.aliyuncs.com/api/v1",
        )
        assert svc.api_key == "user-dashscope-key"
        assert svc.base_url == "https://dashscope.aliyuncs.com/api/v1"
        assert svc.gateway_ws_url is None
        assert svc._via_gateway is False

    def test_byok_without_base_url_raises(self, monkeypatch):
        # Legacy dashscope fallback is gone — a BYOK credential must carry
        # its own endpoint.
        monkeypatch.setattr(asr_module, "settings", _fake_settings())
        with pytest.raises(ValueError, match="both api_key and base_url"):
            ASRService(api_key="user-dashscope-key")

    def test_byok_without_api_key_raises(self, monkeypatch):
        monkeypatch.setattr(asr_module, "settings", _fake_settings())
        with pytest.raises(ValueError, match="both api_key and base_url"):
            ASRService(base_url="https://dashscope.aliyuncs.com/api/v1")

    def test_configure_byok_keeps_sdk_ws_default(self, monkeypatch):
        monkeypatch.setattr(asr_module, "settings", _fake_settings())
        # Sentinel: _configure must NOT touch the SDK WebSocket endpoint on
        # the BYOK path (module-level attr may carry over between tests).
        dashscope.base_websocket_api_url = "wss://sdk-default.example/api-ws"
        svc = ASRService(
            api_key="user-dashscope-key",
            base_url="https://dashscope.aliyuncs.com/api/v1",
        )
        svc._configure()
        assert dashscope.base_http_api_url == "https://dashscope.aliyuncs.com/api/v1"
        assert dashscope.base_websocket_api_url == "wss://sdk-default.example/api-ws"
