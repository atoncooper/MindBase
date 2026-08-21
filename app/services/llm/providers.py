"""LLM provider registry — switch the conversational LLM between DashScope
and OpenRouter.

Both providers speak the OpenAI-compatible protocol, so a switch is just a
different ``(base_url, api_key, model)`` triple plus optional default
headers.  Resolution is centralised here so every chat-style LLM builder
sees the same provider decision.

Selection: ``llm.provider`` in config.yaml / env ``LLM__PROVIDER``
(``dashscope`` | ``openrouter``).  Credentials live in their own config
sections so both providers can stay configured side-by-side::

    llm:        { api_key, base_url, model }   # dashscope (existing keys)
    openrouter: { api_key, base_url, model }   # env: OPENROUTER__*

Scope (deliberate):
    - Switches: conversational LLM calls (chat ``build_llm``, harness LLM).
    - Does NOT switch: embeddings and rerank — DashScope-only models
      (``text-embedding-v4`` / ``gte-rerank-v2`` are not available on
      OpenRouter), so those call sites keep reading ``llm.*`` directly.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
# OpenRouter routes by "vendor/model"; default to the same family the project
# already uses on DashScope so a switch is behaviourally comparable.
OPENROUTER_DEFAULT_MODEL = "qwen/qwen3-max"
# Optional attribution headers OpenRouter uses to rank apps on their leaderboards.
_OPENROUTER_APP_HEADERS = {
    "HTTP-Referer": "https://github.com/atoncooper/MindBase",
    "X-Title": "MindBase",
}


@dataclass(frozen=True)
class ProviderPreset:
    """Static per-provider facts that don't depend on user configuration."""

    name: str
    default_base_url: str
    default_headers: dict[str, str] = field(default_factory=dict)


PROVIDERS: dict[str, ProviderPreset] = {
    "dashscope": ProviderPreset(
        name="dashscope",
        default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    ),
    "openrouter": ProviderPreset(
        name="openrouter",
        default_base_url=OPENROUTER_DEFAULT_BASE_URL,
        default_headers=_OPENROUTER_APP_HEADERS,
    ),
}

DEFAULT_PROVIDER = "dashscope"

# ---------------------------------------------------------------------------
# Model → context-window registry
# ---------------------------------------------------------------------------
# Best-effort mapping of well-known models to their context windows (tokens).
# Values drift as vendors update models — this table is a convenience, not a
# source of truth:
#   - ``llm.context_window`` > 0 (manual pin) always wins
#   - unknown models fall back to a conservative 32k
# Matching is substring-based on the vendor-suffix of the model name, so
# OpenRouter-style names ("anthropic/claude-sonnet-4.5") and version suffixes
# ("qwen-plus-latest") both resolve.

MODEL_CONTEXT_WINDOWS: dict[str, int] = {
    # Vendor-documented context windows, verified 2026-08 via web search.
    # 2026 趋势：国产旗舰 1M 标配化（DeepSeek V4 / Kimi K3 / MiniMax M3 /
    # GLM-5.2+ / Qwen3.7+ Max），Claude Opus 4.6 与 GPT-5.4 也到 1M，
    # Gemini 3.1 Pro 达 10M。已停用/退役的旧模型（gpt-4-turbo、claude-3.x、
    # deepseek-chat/reasoner 旧接口名、glm-4、moonshot、qwen2.5 等）不再收录。

    # ── Alibaba Qwen (DashScope) ──
    "qwen3.8-max": 1_000_000,
    "qwen3.7-max": 1_000_000,
    "qwen3-max": 262_144,
    "qwen-plus": 1_000_000,  # 最新快照 1M；钉旧 128k 快照请手填 llm.context_window
    "qwen-turbo": 131_072,
    "qwen-long": 10_000_000,
    "qwen3-vl-plus": 262_144,
    "qwen3": 131_072,

    # ── OpenAI ──
    "gpt-5.4": 1_000_000,
    "gpt-5.4-mini": 1_000_000,
    "gpt-5.1": 400_000,  # 已退役（2026-03），仅为钉旧版的配置保留
    "gpt-5": 400_000,
    "gpt-5-mini": 400_000,
    "gpt-5-nano": 400_000,
    "gpt-4o": 128_000,
    "gpt-4.1": 1_047_576,
    "o3": 200_000,

    # ── Anthropic ──
    "claude-opus-4-6": 1_000_000,  # 首个 1M GA 的 Opus（2026-02）
    "claude-sonnet-4-6": 200_000,
    "claude-sonnet-4-5": 200_000,  # 1M beta 已于 2026-04 退役，按标准 200K
    "claude-opus-4": 200_000,
    "claude-sonnet-4": 200_000,
    "claude-haiku-4": 200_000,

    # ── Google ──
    "gemini-3.1-pro": 10_000_000,  # 当前最大窗口
    "gemini-2.5-pro": 1_048_576,
    "gemini-2.5-flash": 1_048_576,
    "gemini-2.0-flash": 1_048_576,

    # ── DeepSeek ── V4 起 1M 标配；旧接口名 deepseek-chat/reasoner 已停用
    "deepseek-v4": 1_000_000,
    "deepseek-v4-pro": 1_000_000,
    "deepseek-v4-flash": 1_000_000,

    # ── Zhipu GLM ── GLM-5.2/5.3 扩展至 1M
    "glm-5.3": 1_000_000,
    "glm-5.2": 1_000_000,
    "glm-5.1": 200_000,
    "glm-5": 200_000,
    "glm-5-turbo": 200_000,
    "glm-4.6": 200_000,
    "glm-4.5": 131_072,

    # ── Moonshot Kimi ── K3 开源 3T 级、原生 1M
    "kimi-k3": 1_048_576,
    "kimi-k2": 262_144,
    "kimi": 131_072,

    # ── MiniMax ──
    "minimax-m3": 1_000_000,
    "minimax-m2.7": 200_000,
    "minimax-m2.5": 200_000,

    # ── xAI ──
    "grok": 131_072,
}

# Conservative fallback for models not in the registry.
DEFAULT_CONTEXT_WINDOW = 32_768

# ---------------------------------------------------------------------------
# Vendor-provided context windows (dynamic layer)
# ---------------------------------------------------------------------------
# OpenRouter's public ``GET /models`` returns ``context_length`` per model —
# authoritative and always current.  DashScope / OpenAI-compatible ``/models``
# endpoints do NOT expose window metadata, which is why the static table
# above exists at all (same reason LiteLLM ships a static registry).
# Resolution order in ``resolve_context_window``:
#   manual pin > dynamic (vendor) > static table > conservative default.

_DYNAMIC_TTL_SECONDS = 24 * 3600
_dynamic_windows: dict[str, int] = {}
_dynamic_fetched_at: float = 0.0


async def refresh_dynamic_context_windows(
    base_url: str,
    api_key: Optional[str] = None,
    *,
    timeout: float = 10.0,
    force: bool = False,
) -> int:
    """Pull ``context_length`` metadata from an OpenRouter-style /models endpoint.

    Best-effort: network/auth/shape failures leave the cache untouched and
    return 0 (the static table still applies).  Cached for
    :data:`_DYNAMIC_TTL_SECONDS`.  Returns the number of models cached.
    """
    global _dynamic_windows, _dynamic_fetched_at

    if (
        not force
        and _dynamic_windows
        and time.time() - _dynamic_fetched_at < _DYNAMIC_TTL_SECONDS
    ):
        return len(_dynamic_windows)

    url = base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            payload = resp.json()
        windows: dict[str, int] = {}
        for entry in payload.get("data", []):
            mid = entry.get("id")
            cl = entry.get("context_length")
            if mid and isinstance(cl, int) and cl > 0:
                windows[mid.lower()] = cl
        if windows:
            _dynamic_windows = windows
            _dynamic_fetched_at = time.time()
        logger.info(
            "[LLM_PROVIDER] dynamic context windows refreshed: models=%s source=%s",
            len(windows),
            url,
        )
        return len(windows)
    except Exception:
        logger.warning(
            "[LLM_PROVIDER] dynamic context-window fetch failed from %s",
            url,
            exc_info=True,
        )
        return 0


def resolve_context_window(model: str, manual_window: int = 0) -> int:
    """Resolve a model's context window (tokens).

    Resolution order:
    1. ``manual_window`` > 0 — explicit pin (``llm.context_window``)
    2. dynamic vendor metadata (exact id or vendor-suffix match)
    3. longest substring match against :data:`MODEL_CONTEXT_WINDOWS`
    4. conservative :data:`DEFAULT_CONTEXT_WINDOW`
    """
    if manual_window and manual_window > 0:
        return manual_window

    name = (model or "").lower()
    if not name:
        return DEFAULT_CONTEXT_WINDOW

    # Layer 2: vendor-provided (dynamic) — exact id first, then suffix.
    if _dynamic_windows:
        if name in _dynamic_windows:
            return _dynamic_windows[name]
        suffix = name.split("/")[-1]
        for dyn_id, window in _dynamic_windows.items():
            if dyn_id.split("/")[-1] == suffix:
                return window

    # Layer 3: static registry — strip vendor prefix, longest substring wins.
    static_name = name.split("/")[-1] if "/" in name else name
    for key in sorted(MODEL_CONTEXT_WINDOWS, key=len, reverse=True):
        if key in static_name:
            return MODEL_CONTEXT_WINDOWS[key]
    return DEFAULT_CONTEXT_WINDOW


@dataclass(frozen=True)
class ResolvedLLMConfig:
    """Effective LLM connection settings after provider resolution."""

    provider: str
    api_key: str
    base_url: str
    model: str
    default_headers: dict[str, str] = field(default_factory=dict)


def infer_provider(base_url: Optional[str]) -> str:
    """Classify a base URL into a usage-tracking provider label.

    Canonical implementation; ``app.services.chat.llm`` re-exports it for
    backward compatibility.
    """
    if not base_url:
        return "openai"
    url = base_url.lower()
    if "openrouter" in url:
        return "openrouter"
    if "anthropic" in url:
        return "anthropic"
    if "deepseek" in url:
        return "deepseek"
    if "dashscope" in url or "aliyun" in url:
        return "dashscope"
    if "moonshot" in url or "kimi" in url:
        return "moonshot"
    if "openai" in url:
        return "openai"
    return "custom"


def resolve_llm_config(
    *,
    provider: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
) -> ResolvedLLMConfig:
    """Resolve the effective LLM settings for the configured provider.

    Explicit arguments override configuration (used by tests); otherwise the
    values come from the provider's own config section:

    - ``dashscope`` → ``llm.api_key / llm.base_url / llm.model`` (unchanged
      legacy behaviour)
    - ``openrouter`` → ``openrouter.api_key / openrouter.base_url /
      openrouter.model`` plus OpenRouter attribution headers

    An unknown provider name falls back to DashScope with a warning rather
    than failing startup — a typo must not take chat down.
    """
    chosen = (provider or settings.llm_provider or DEFAULT_PROVIDER).strip().lower()
    preset = PROVIDERS.get(chosen)
    if preset is None:
        logger.warning(
            "[LLM_PROVIDER] unknown provider=%r, falling back to %s",
            chosen,
            DEFAULT_PROVIDER,
        )
        chosen = DEFAULT_PROVIDER
        preset = PROVIDERS[DEFAULT_PROVIDER]

    if chosen == "openrouter":
        key = api_key if api_key is not None else settings.openrouter_api_key
        url = (
            base_url
            if base_url is not None
            else (settings.openrouter_base_url or preset.default_base_url)
        )
        mdl = (
            model
            if model is not None
            else (settings.openrouter_model or OPENROUTER_DEFAULT_MODEL)
        )
        headers = dict(preset.default_headers)
        if not key:
            logger.warning(
                "[LLM_PROVIDER] provider=openrouter but openrouter.api_key is "
                "empty — set OPENROUTER__API_KEY"
            )
    else:
        key = api_key if api_key is not None else settings.openai_api_key
        url = (
            base_url
            if base_url is not None
            else (settings.openai_base_url or preset.default_base_url)
        )
        mdl = model if model is not None else settings.llm_model
        headers = {}

    return ResolvedLLMConfig(
        provider=chosen,
        api_key=key,
        base_url=url,
        model=mdl,
        default_headers=headers,
    )
