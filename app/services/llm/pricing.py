"""LLM token pricing model.

Provides per-provider / per-model price entries and cost estimation.
Prices are in CNY per 1M tokens unless otherwise noted.

This module is intentionally small and hand-maintained.  For production
billing, prices should be refreshed periodically from provider docs.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from loguru import logger


@dataclass(frozen=True)
class PricingEntry:
    """Price for a specific provider + model combination.

    Attributes:
        input_price: Cost per 1M input/prompt tokens.
        output_price: Cost per 1M output/completion tokens.
        currency: ISO 4217 currency code.
    """

    input_price: float
    output_price: float
    currency: str = "CNY"


# Provider-model price table (CNY per 1M tokens).
# Prices are approximate and should be updated as providers change them.
_PRICES: dict[str, dict[str, PricingEntry]] = {
    "openai": {
        "gpt-4o": PricingEntry(input_price=5.0, output_price=15.0, currency="CNY"),
        "gpt-4o-mini": PricingEntry(input_price=0.15, output_price=0.6, currency="CNY"),
        "gpt-4-turbo": PricingEntry(input_price=10.0, output_price=30.0, currency="CNY"),
        "gpt-4": PricingEntry(input_price=30.0, output_price=60.0, currency="CNY"),
        "gpt-3.5-turbo": PricingEntry(input_price=0.5, output_price=1.5, currency="CNY"),
    },
    "anthropic": {
        "claude-3-5-sonnet": PricingEntry(input_price=3.0, output_price=15.0, currency="CNY"),
        "claude-3-5-sonnet-20241022": PricingEntry(
            input_price=3.0, output_price=15.0, currency="CNY"
        ),
        "claude-3-opus": PricingEntry(input_price=15.0, output_price=75.0, currency="CNY"),
        "claude-3-haiku": PricingEntry(input_price=0.25, output_price=1.25, currency="CNY"),
    },
    "deepseek": {
        "deepseek-chat": PricingEntry(input_price=1.0, output_price=2.0, currency="CNY"),
        "deepseek-coder": PricingEntry(input_price=1.0, output_price=2.0, currency="CNY"),
        "deepseek-reasoner": PricingEntry(input_price=4.0, output_price=16.0, currency="CNY"),
    },
    "dashscope": {
        "qwen-plus": PricingEntry(input_price=2.0, output_price=6.0, currency="CNY"),
        "qwen-turbo": PricingEntry(input_price=0.5, output_price=2.0, currency="CNY"),
        "qwen-max": PricingEntry(input_price=20.0, output_price=60.0, currency="CNY"),
        "qwen-long": PricingEntry(input_price=0.5, output_price=2.0, currency="CNY"),
        "qwen3-max": PricingEntry(input_price=20.0, output_price=60.0, currency="CNY"),
        "qwen3-plus": PricingEntry(input_price=2.0, output_price=6.0, currency="CNY"),
        "qwen3-turbo": PricingEntry(input_price=0.5, output_price=2.0, currency="CNY"),
        "qwen3-coder-plus": PricingEntry(input_price=2.0, output_price=6.0, currency="CNY"),
        "qwen2.5-max": PricingEntry(input_price=20.0, output_price=60.0, currency="CNY"),
        "qwen2.5-plus": PricingEntry(input_price=2.0, output_price=6.0, currency="CNY"),
        "qwen2.5-turbo": PricingEntry(input_price=0.5, output_price=2.0, currency="CNY"),
        "qwen2.5-coder-plus": PricingEntry(input_price=2.0, output_price=6.0, currency="CNY"),
        "qwen2.5-72b": PricingEntry(input_price=4.0, output_price=12.0, currency="CNY"),
        "text-embedding-v4": PricingEntry(input_price=0.05, output_price=0.0, currency="CNY"),
        "text-embedding-v3": PricingEntry(input_price=0.05, output_price=0.0, currency="CNY"),
    },
    "moonshot": {
        "moonshot-v1-8k": PricingEntry(input_price=12.0, output_price=12.0, currency="CNY"),
        "moonshot-v1-32k": PricingEntry(input_price=24.0, output_price=24.0, currency="CNY"),
        "moonshot-v1-128k": PricingEntry(input_price=60.0, output_price=60.0, currency="CNY"),
        "kimi-latest": PricingEntry(input_price=12.0, output_price=12.0, currency="CNY"),
    },
    "custom": {},
}


def get_pricing_entry(provider: Optional[str], model: Optional[str]) -> Optional[PricingEntry]:
    """Return the pricing entry for a provider/model pair, if known.

    Falls back to a cross-provider model-name search so that a model is
    still priced correctly even when the provider was mis-detected (e.g.
    ``custom`` for a DashScope qwen model behind a proxy URL).
    """
    provider = (provider or "unknown").lower()
    model = (model or "unknown").lower()

    provider_table = _PRICES.get(provider)

    # Exact match in the detected provider's table.
    if provider_table:
        if model in provider_table:
            return provider_table[model]
        for known_model, entry in provider_table.items():
            if model.startswith(known_model):
                return entry

    # Cross-provider fallback: search every provider's table by model name.
    # This handles the common case where the provider is "custom" (proxy)
    # but the model is a well-known one (qwen-*, gpt-*, claude-*, ...).
    for prov_table in _PRICES.values():
        if not prov_table:
            continue
        if model in prov_table:
            return prov_table[model]
        for known_model, entry in prov_table.items():
            if model.startswith(known_model):
                return entry

    return None


def estimate_cost(
    provider: Optional[str],
    model: Optional[str],
    prompt_tokens: int,
    completion_tokens: int,
) -> float:
    """Estimate cost from token usage.

    Returns cost in the currency configured for the model (usually CNY).
    Returns 0.0 when no price is known, and logs a debug message.
    """
    entry = get_pricing_entry(provider, model)
    if entry is None:
        logger.debug(
            f"[PRICING] no price for provider={provider} model={model}, "
            f"cost_estimate=0"
        )
        return 0.0

    prompt_cost = (prompt_tokens / 1_000_000) * entry.input_price
    completion_cost = (completion_tokens / 1_000_000) * entry.output_price
    return round(prompt_cost + completion_cost, 6)


def pricing_currency(provider: Optional[str], model: Optional[str]) -> str:
    """Return the currency for a provider/model pair."""
    entry = get_pricing_entry(provider, model)
    return entry.currency if entry else "CNY"
