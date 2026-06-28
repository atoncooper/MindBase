"""Detect LLM provider from base_url.

Replaces scattered ``"deepseek" in base_url`` string matching with a
single source of truth. New providers should be added here.
"""

from __future__ import annotations


def detect_provider(base_url: str | None) -> str:
    """Return one of ``openai`` / ``deepseek`` / ``anthropic`` / ``custom``.

    Detection is by substring match on the base_url host. Falls back to
    ``openai`` when base_url is empty (OpenAI-compatible default) and
    ``custom`` when no known provider signature is found.
    """
    if not base_url:
        return "openai"
    lower = base_url.lower()
    if "deepseek" in lower:
        return "deepseek"
    if "anthropic" in lower:
        return "anthropic"
    if "openai" in lower or "api.openai" in lower:
        return "openai"
    return "custom"
