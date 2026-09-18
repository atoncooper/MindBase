"""Tests for the LLM provider layer (``app/services/llm/providers.py``).

Covers:

- resolve_llm_config: gateway-only platform path (key/url from
  ``ai_gateway.*``, model passthrough, missing-key tolerance), explicit
  connection pins bypassing the gateway, ``direct=True`` requiring an
  explicit base_url (legacy fallbacks removed)
- infer_provider: URL classification
- build_llm integration: gateway-resolved base_url / model land on the
  ChatOpenAI instance
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.services.llm import providers
from app.services.llm.providers import (
    DEFAULT_CONTEXT_WINDOW,
    infer_provider,
    resolve_context_window,
    resolve_llm_config,
)


class TestContextWindowRegistry:
    def test_known_qwen_model(self):
        # latest qwen-plus snapshot supports 1M (pin llm.context_window for
        # an older 128k snapshot)
        assert resolve_context_window("qwen-plus") == 1_000_000

    def test_openrouter_vendor_prefix_stripped(self):
        assert resolve_context_window("anthropic/claude-sonnet-4.5") == 200_000
        assert resolve_context_window("google/gemini-2.5-pro") == 1_048_576

    def test_version_suffix_substring_match(self):
        assert resolve_context_window("qwen-plus-latest") == 1_000_000
        assert resolve_context_window("qwen3-max-2025") == 262_144

    def test_glm5_resolves_via_registry(self):
        # the model actually configured by the user: GLM-5.2 is registered (1M)
        assert resolve_context_window("z-ai/glm-5.2:free") == 1_000_000

    def test_unknown_model_conservative_default(self):
        assert resolve_context_window("some-startup/super-model-v9") == DEFAULT_CONTEXT_WINDOW
        assert resolve_context_window("") == DEFAULT_CONTEXT_WINDOW

    def test_unknown_model_warns_once_per_model(self, caplog):
        # The conservative fallback must be visible (platform switches should
        # not degrade silently), but only warn once per model per process.
        import logging

        providers._window_fallback_warned.clear()
        with caplog.at_level(logging.WARNING, logger="app.services.llm.providers"):
            assert resolve_context_window("totally-unknown-model") == DEFAULT_CONTEXT_WINDOW
            assert resolve_context_window("totally-unknown-model") == DEFAULT_CONTEXT_WINDOW
        warned = [r for r in caplog.records if "not in the context-window registry" in r.message]
        assert len(warned) == 1

    def test_manual_pin_wins_over_registry(self):
        assert resolve_context_window("gemini-2.5-pro", 8192) == 8192
        assert resolve_context_window("unknown-model", 4096) == 4096

    def test_longest_key_matches_first(self):
        # "qwen3-max" must not be shadowed by a shorter key like "qwen3".
        assert resolve_context_window("qwen3-max") == 262_144


class TestDynamicContextWindows:
    """Vendor-provided windows (OpenRouter /models context_length)."""

    def setup_method(self):
        providers._dynamic_windows = {}
        providers._dynamic_fetched_at = 0.0

    def teardown_method(self):
        self.setup_method()

    @pytest.mark.asyncio
    async def test_refresh_populates_and_resolution_uses_it(self, monkeypatch):
        class _Resp:
            headers = {"content-type": "application/json"}

            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "data": [
                        {"id": "z-ai/glm-5.2:free", "context_length": 555_000},
                        {"id": "qwen-plus", "context_length": 999},  # beats static
                    ]
                }

        class _Client:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, headers=None):
                return _Resp()

        monkeypatch.setattr(providers.httpx, "AsyncClient", _Client)

        n = await providers.refresh_dynamic_context_windows(
            "https://openrouter.ai/api/v1"
        )
        assert n == 2
        # Unknown-to-static-table model now resolves via vendor metadata.
        assert resolve_context_window("z-ai/glm-5.2:free") == 555_000
        # Dynamic (authoritative, current) beats the static table.
        assert resolve_context_window("qwen-plus") == 999

    @pytest.mark.asyncio
    async def test_refresh_failure_keeps_static_fallback(self, monkeypatch):
        class _Boom:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, headers=None):
                raise RuntimeError("network down")

        monkeypatch.setattr(providers.httpx, "AsyncClient", _Boom)

        n = await providers.refresh_dynamic_context_windows(
            "https://openrouter.ai/api/v1"
        )
        assert n == 0
        # Static table still applies.
        assert resolve_context_window("qwen-plus") == 1_000_000

    def test_manual_pin_wins_over_dynamic(self, monkeypatch):
        providers._dynamic_windows = {"some/model": 999_999}
        providers._dynamic_fetched_at = providers.time.time()
        assert resolve_context_window("some/model", 8192) == 8192


def _patch_gateway(
    monkeypatch,
    *,
    api_key: str = "sk-higress",
    base_url: str = "http://higress:8080/v1",
    model: str = "qwen3-max",
):
    monkeypatch.setattr(
        type(settings), "ai_gateway_api_key", property(lambda self: api_key)
    )
    monkeypatch.setattr(
        type(settings), "ai_gateway_base_url", property(lambda self: base_url)
    )
    monkeypatch.setattr(type(settings), "llm_model", property(lambda self: model))


class TestResolveGateway:
    def test_platform_path_uses_gateway(self, monkeypatch):
        _patch_gateway(monkeypatch)

        cfg = resolve_llm_config()
        assert cfg.provider == "higress"
        assert cfg.api_key == "sk-higress"
        assert cfg.base_url == "http://higress:8080/v1"
        assert cfg.model == "qwen3-max"
        assert cfg.default_headers == {}

    def test_gateway_base_url_builtin_default_when_unset(self, monkeypatch):
        _patch_gateway(monkeypatch, base_url="")

        cfg = resolve_llm_config()
        assert cfg.base_url == providers.DEFAULT_GATEWAY_BASE_URL

    def test_missing_key_yields_empty_without_crash(self, monkeypatch):
        _patch_gateway(monkeypatch, api_key="")

        cfg = resolve_llm_config()
        assert cfg.api_key == ""
        assert cfg.provider == "higress"

    def test_model_override_passes_through(self, monkeypatch):
        _patch_gateway(monkeypatch)

        cfg = resolve_llm_config(model="gpt-4o-mini")
        assert cfg.model == "gpt-4o-mini"

    def test_explicit_connection_pins_bypass_gateway(self, monkeypatch):
        _patch_gateway(monkeypatch)

        cfg = resolve_llm_config(
            api_key="sk-x", base_url="https://x.example.com/v1", model="m1"
        )
        assert (cfg.api_key, cfg.base_url, cfg.model) == (
            "sk-x",
            "https://x.example.com/v1",
            "m1",
        )
        assert cfg.provider == "custom"  # inferred from the pinned URL

    def test_direct_without_base_url_raises(self):
        # Legacy vendor fallbacks are gone: a direct connection requires an
        # explicit endpoint — no silent dashscope fallback any more.
        with pytest.raises(ValueError, match="explicit base_url"):
            resolve_llm_config(direct=True)

    def test_direct_with_explicit_base_url(self):
        cfg = resolve_llm_config(
            direct=True, api_key="sk-user", base_url="https://vendor.example.com/v1"
        )
        assert cfg.base_url == "https://vendor.example.com/v1"
        assert cfg.provider == "custom"
        assert cfg.api_key == "sk-user"


class TestGatewayNativeBaseUrls:
    def test_derives_http_and_ws_roots(self, monkeypatch):
        monkeypatch.setattr(
            type(settings),
            "ai_gateway_base_url",
            property(lambda self: "http://higress:8080/v1"),
        )
        http_base, ws_base = providers.gateway_native_base_urls()
        assert http_base == "http://higress:8080/api/v1"
        assert ws_base == "ws://higress:8080/api-ws/v1/inference"

    def test_https_maps_to_wss(self, monkeypatch):
        monkeypatch.setattr(
            type(settings),
            "ai_gateway_base_url",
            property(lambda self: "https://gw.example.com/v1"),
        )
        _, ws_base = providers.gateway_native_base_urls()
        assert ws_base == "wss://gw.example.com/api-ws/v1/inference"


class TestInferProvider:
    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("https://openrouter.ai/api/v1", "openrouter"),
            (
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "dashscope",
            ),
            ("https://api.deepseek.com/v1", "deepseek"),
            ("https://api.openai.com/v1", "openai"),
            (None, "openai"),
            ("https://example.com/v1", "custom"),
        ],
    )
    def test_classification(self, url, expected):
        assert infer_provider(url) == expected


class TestBuildLLMIntegration:
    @pytest.mark.asyncio
    async def test_build_llm_routes_via_gateway(self, monkeypatch):
        _patch_gateway(monkeypatch, model="qwen3-max")

        from app.services.chat.llm import build_llm

        llm = build_llm()
        try:
            assert llm.openai_api_base == "http://higress:8080/v1"
            assert llm.model_name == "qwen3-max"
            assert getattr(llm, "_provider") == "higress"
            assert not (getattr(llm, "default_headers", None) or {})
        finally:
            # Close the httpx client owned by ChatOpenAI (pytest cleanup).
            client = getattr(llm, "client", None)
            inner = getattr(client, "client", None)
            if inner is not None:
                await inner.aclose()
