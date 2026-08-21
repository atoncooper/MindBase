"""Tests for LLM pricing estimation."""
from app.services.llm.pricing import (
    estimate_cost,
    get_pricing_entry,
    pricing_currency,
)


class TestGetPricingEntry:
    """Price lookup by provider and model."""

    def test_known_exact_match(self) -> None:
        entry = get_pricing_entry("openai", "gpt-4o")
        assert entry is not None
        assert entry.input_price == 5.0
        assert entry.output_price == 15.0

    def test_known_prefix_match(self) -> None:
        entry = get_pricing_entry("openai", "gpt-4o-2024-08-06")
        assert entry is not None
        assert entry.input_price == 5.0

    def test_unknown_provider(self) -> None:
        assert get_pricing_entry("unknown-provider", "model") is None

    def test_unknown_model(self) -> None:
        assert get_pricing_entry("openai", "unknown-model") is None


class TestEstimateCost:
    """Cost estimation from token counts."""

    def test_openai_gpt4o(self) -> None:
        cost = estimate_cost("openai", "gpt-4o", 1_000_000, 1_000_000)
        assert cost == 20.0  # 5 + 15

    def test_deepseek_chat(self) -> None:
        cost = estimate_cost("deepseek", "deepseek-chat", 2_000_000, 1_000_000)
        assert cost == 4.0  # 2 * 1 + 1 * 2

    def test_embedding_no_output_cost(self) -> None:
        cost = estimate_cost("dashscope", "text-embedding-v4", 1_000_000, 0)
        assert cost == 0.05

    def test_unknown_model_returns_zero(self) -> None:
        assert estimate_cost("unknown", "model", 1_000_000, 1_000_000) == 0.0

    def test_case_insensitive(self) -> None:
        cost = estimate_cost("OpenAI", "GPT-4o", 1_000_000, 0)
        assert cost == 5.0

    def test_zero_tokens(self) -> None:
        assert estimate_cost("openai", "gpt-4o", 0, 0) == 0.0


class TestPricingCurrency:
    """Currency code retrieval."""

    def test_known_currency(self) -> None:
        assert pricing_currency("openai", "gpt-4o") == "CNY"

    def test_unknown_defaults_to_cny(self) -> None:
        assert pricing_currency("unknown", "model") == "CNY"
