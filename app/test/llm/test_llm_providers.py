"""Tests for the LLM provider layer (``app/services/llm/providers.py``).

Covers:

- resolve_llm_config: dashscope default (legacy keys), openrouter switch
  (own section + attribution headers), unknown-provider fallback
- infer_provider: openrouter URL classification
- build_llm integration: provider-resolved base_url / model / headers land
  on the ChatOpenAI instance
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.services.llm import providers
from app.services.llm.providers import (
    DEFAULT_CONTEXT_WINDOW,
    OPENROUTER_DEFAULT_MODEL,
    infer_provider,
    resolve_context_window,
    resolve_llm_config,
)


class TestContextWindowRegistry:
    def test_known_qwen_model(self):
        # qwen-plus 最新快照支持 1M（旧快照 128k 需手动钉 llm.context_window）
        assert resolve_context_window("qwen-plus") == 1_000_000

    def test_openrouter_vendor_prefix_stripped(self):
        assert resolve_context_window("anthropic/claude-sonnet-4.5") == 200_000
        assert resolve_context_window("google/gemini-2.5-pro") == 1_048_576

    def test_version_suffix_substring_match(self):
        assert resolve_context_window("qwen-plus-latest") == 1_000_000
        assert resolve_context_window("qwen3-max-2025") == 262_144

    def test_glm5_resolves_via_registry(self):
        # 用户实际配置的模型：GLM-5.2 已收录（1M）
        assert resolve_context_window("z-ai/glm-5.2:free") == 1_000_000

    def test_unknown_model_conservative_default(self):
        assert resolve_context_window("some-startup/super-model-v9") == DEFAULT_CONTEXT_WINDOW
        assert resolve_context_window("") == DEFAULT_CONTEXT_WINDOW

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

    teardown = setup_method

    @pytest.mark.asyncio
    async def test_refresh_populates_and_resolution_uses_it(self, monkeypatch):
        class _Resp:
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


def _use_provider(monkeypatch, name: str):
    monkeypatch.setattr(
        type(settings), "llm_provider", property(lambda self: name)
    )


class TestResolveDashScope:
    def test_default_provider_is_dashscope(self, monkeypatch):
        _use_provider(monkeypatch, "dashscope")
        monkeypatch.setattr(
            type(settings), "openai_api_key", property(lambda self: "sk-dash")
        )
        monkeypatch.setattr(
            type(settings),
            "openai_base_url",
            property(lambda self: "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        )
        monkeypatch.setattr(
            type(settings), "llm_model", property(lambda self: "qwen3-max")
        )

        cfg = resolve_llm_config()
        assert cfg.provider == "dashscope"
        assert cfg.api_key == "sk-dash"
        assert "dashscope" in cfg.base_url
        assert cfg.model == "qwen3-max"
        assert cfg.default_headers == {}

    def test_explicit_overrides_win(self):
        cfg = resolve_llm_config(
            provider="dashscope", api_key="sk-x", base_url="https://x/v1", model="m1"
        )
        assert (cfg.api_key, cfg.base_url, cfg.model) == ("sk-x", "https://x/v1", "m1")


class TestResolveOpenRouter:
    def test_openrouter_uses_own_section_and_headers(self, monkeypatch):
        _use_provider(monkeypatch, "openrouter")
        monkeypatch.setattr(
            type(settings), "openrouter_api_key", property(lambda self: "sk-or-1")
        )
        monkeypatch.setattr(
            type(settings),
            "openrouter_base_url",
            property(lambda self: "https://openrouter.ai/api/v1"),
        )
        monkeypatch.setattr(
            type(settings),
            "openrouter_model",
            property(lambda self: "anthropic/claude-sonnet-4.5"),
        )

        cfg = resolve_llm_config()
        assert cfg.provider == "openrouter"
        assert cfg.api_key == "sk-or-1"
        assert cfg.base_url == "https://openrouter.ai/api/v1"
        assert cfg.model == "anthropic/claude-sonnet-4.5"
        assert cfg.default_headers["X-Title"] == "MindBase"
        assert "HTTP-Referer" in cfg.default_headers

    def test_openrouter_model_defaults_when_unset(self, monkeypatch):
        _use_provider(monkeypatch, "openrouter")
        monkeypatch.setattr(
            type(settings), "openrouter_api_key", property(lambda self: "sk-or-1")
        )
        monkeypatch.setattr(
            type(settings),
            "openrouter_base_url",
            property(lambda self: "https://openrouter.ai/api/v1"),
        )
        monkeypatch.setattr(
            type(settings), "openrouter_model", property(lambda self: "")
        )

        cfg = resolve_llm_config()
        assert cfg.model == OPENROUTER_DEFAULT_MODEL

    def test_unknown_provider_falls_back_to_dashscope(self, monkeypatch):
        _use_provider(monkeypatch, "vertex-ai")
        monkeypatch.setattr(
            type(settings), "openai_api_key", property(lambda self: "sk-dash")
        )
        monkeypatch.setattr(
            type(settings),
            "openai_base_url",
            property(lambda self: "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        )
        monkeypatch.setattr(
            type(settings), "llm_model", property(lambda self: "qwen3-max")
        )

        cfg = resolve_llm_config()
        assert cfg.provider == "dashscope"
        assert "dashscope" in cfg.base_url


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
    async def test_build_llm_uses_openrouter_when_selected(self, monkeypatch):
        _use_provider(monkeypatch, "openrouter")
        monkeypatch.setattr(
            type(settings), "openrouter_api_key", property(lambda self: "sk-or-9")
        )
        monkeypatch.setattr(
            type(settings),
            "openrouter_base_url",
            property(lambda self: "https://openrouter.ai/api/v1"),
        )
        monkeypatch.setattr(
            type(settings),
            "openrouter_model",
            property(lambda self: "qwen/qwen3-max"),
        )

        from app.services.chat.llm import build_llm

        llm = build_llm()
        try:
            assert llm.openai_api_base == "https://openrouter.ai/api/v1"
            assert llm.model_name == "qwen/qwen3-max"
            assert getattr(llm, "_provider") == "openrouter"
            hdrs = getattr(llm, "default_headers", {}) or {}
            assert hdrs.get("X-Title") == "MindBase"
        finally:
            # Close the httpx client owned by ChatOpenAI (pytest cleanup).
            client = getattr(llm, "client", None)
            inner = getattr(client, "client", None)
            if inner is not None:
                await inner.aclose()

    @pytest.mark.asyncio
    async def test_build_llm_dashscope_unchanged(self, monkeypatch):
        _use_provider(monkeypatch, "dashscope")
        monkeypatch.setattr(
            type(settings), "openai_api_key", property(lambda self: "sk-dash")
        )
        monkeypatch.setattr(
            type(settings),
            "openai_base_url",
            property(lambda self: "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        )
        monkeypatch.setattr(
            type(settings), "llm_model", property(lambda self: "qwen3-max")
        )

        from app.services.chat.llm import build_llm

        llm = build_llm()
        try:
            assert "dashscope" in llm.openai_api_base
            assert getattr(llm, "_provider") == "dashscope"
            assert not (getattr(llm, "default_headers", None) or {})
        finally:
            client = getattr(llm, "client", None)
            inner = getattr(client, "client", None)
            if inner is not None:
                await inner.aclose()
