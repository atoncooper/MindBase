"""LLM connection resolution — the Higress AI gateway is the single entry.

Platform-initiated LLM traffic (chat harness, quiz, KG extraction, query
rewriting, platform embeddings, ...) always exits through the Higress AI
gateway: ``base_url``/``api_key`` are the gateway endpoint and consumer
key, and the model name is passed through untouched — the gateway routes
by model to the upstream provider.  Vendor keys live only in the gateway
console, never in this app's config.

Scope (deliberate):
    - Routes: OpenAI-compatible chat + embeddings traffic.
    - Does NOT route: ASR (paraformer native API) and rerank
      (gte-rerank-v2 native API) — not OpenAI-compatible, keep their own
      ``ASR__*`` / ``RERANK__*`` credentials.
    - BYOK (user-supplied credentials) go directly to the user's own
      endpoint.  A user credential without a base_url is an ERROR: a vendor
      key cannot authenticate against the gateway's consumer key-auth, and
      legacy direct-connection fallbacks have been removed.

Selection used to be a dashscope/openrouter switch (``llm.provider``);
both direct providers are deprecated — the gateway is the only platform
entry and the switch has been removed.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# Default Higress gateway endpoint (compose-internal hostname); override
# with AI_GATEWAY__BASE_URL when debugging from outside the compose network.
DEFAULT_GATEWAY_BASE_URL = "http://higress:8080/v1"


def gateway_native_base_urls() -> tuple[str, str]:
    """``(http_base, ws_base)`` for DashScope-native passthrough via the
    gateway — used by rerank and ASR, which are not OpenAI-compatible.

    The gateway's native route forwards the path as-is and injects the real
    vendor key, so callers authenticate with the gateway consumer key.
    """
    root = (settings.ai_gateway_base_url or DEFAULT_GATEWAY_BASE_URL).removesuffix(
        "/v1"
    )
    ws_root = root.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    return root + "/api/v1", ws_root + "/api-ws/v1/inference"

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

    # TTL gates both successes and failures — an endpoint without metadata
    # (e.g. the gateway's /models) must not be re-probed on every call.
    if not force and time.time() - _dynamic_fetched_at < _DYNAMIC_TTL_SECONDS:
        return len(_dynamic_windows)

    url = base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            if "application/json" not in resp.headers.get("content-type", ""):
                # 2xx with an empty/non-JSON body = the endpoint carries no
                # model metadata (normal for gateway passthrough) — nothing
                # to learn, the static registry applies. Not an error.
                logger.info(
                    "[LLM_PROVIDER] %s serves no model metadata (non-JSON); "
                    "static context-window registry applies",
                    url,
                )
                _dynamic_fetched_at = time.time()
                return 0
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
    except Exception as exc:
        logger.warning(
            "[LLM_PROVIDER] dynamic context-window fetch failed from %s (%s) — "
            "static context-window registry applies",
            url,
            type(exc).__name__,
        )
        _dynamic_fetched_at = time.time()
        return 0


# Models whose conservative-fallback resolution already warned (per process),
# so switching platforms surfaces visibly instead of silently degrading.
_window_fallback_warned: set[str] = set()


def resolve_context_window(model: str, manual_window: int = 0) -> int:
    """Resolve a model's context window (tokens).

    Resolution order:
    1. ``manual_window`` > 0 — explicit pin (``llm.context_window``)
    2. dynamic vendor metadata (exact id or vendor-suffix match)
    3. longest substring match against :data:`MODEL_CONTEXT_WINDOWS`
    4. conservative :data:`DEFAULT_CONTEXT_WINDOW` (warns once per model)
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

    if name not in _window_fallback_warned:
        _window_fallback_warned.add(name)
        logger.warning(
            "[LLM_PROVIDER] model %r is not in the context-window registry — "
            "assuming %dk for the history-compression budget; pin "
            "llm.context_window with the real window",
            model,
            DEFAULT_CONTEXT_WINDOW // 1024,
        )
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
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    direct: bool = False,
) -> ResolvedLLMConfig:
    """Resolve the effective LLM connection settings.

    Platform path (default): the Higress AI gateway is the only entry —
    ``base_url``/``api_key`` come from ``ai_gateway.*`` and the model name
    passes through untouched (the gateway routes by model to the upstream
    provider).  A missing ``AI_GATEWAY__API_KEY`` warns once and yields an
    empty key; builders surface a clear error at call time instead of
    failing startup.

    Explicit ``api_key``/``base_url`` arguments (tests, BYOK builders) and
    ``direct=True`` bypass the gateway: a direct connection requires an
    explicit ``base_url`` — there is no legacy vendor fallback, a missing
    endpoint raises :class:`ValueError`.

    Platform path (default) continues below.
    """
    mdl = model if model is not None else settings.llm_model

    if direct or api_key is not None or base_url is not None:
        if base_url is None:
            raise ValueError(
                "direct LLM connection requires an explicit base_url — "
                "legacy vendor fallbacks have been removed"
            )
        return ResolvedLLMConfig(
            provider=infer_provider(base_url),
            api_key=api_key if api_key is not None else settings.openai_api_key,
            base_url=base_url,
            model=mdl,
        )

    url = settings.ai_gateway_base_url or DEFAULT_GATEWAY_BASE_URL
    key = settings.ai_gateway_api_key
    if not key:
        _warn_gateway_key_missing()
    logger.info("[LLM_PROVIDER] via AI gateway %s model=%s", url, mdl)
    return ResolvedLLMConfig(
        provider="higress",
        api_key=key,
        base_url=url,
        model=mdl,
    )


_gateway_key_warned = False


def _warn_gateway_key_missing() -> None:
    """Warn once (per process) that the gateway has no consumer key."""
    global _gateway_key_warned
    if not _gateway_key_warned:
        _gateway_key_warned = True
        logger.warning(
            "[LLM_PROVIDER] AI_GATEWAY__API_KEY is empty — platform LLM "
            "calls will fail until the Higress consumer key is configured"
        )
