"""Regression tests confirming the agentic_rag.* config keys were fully removed.

The legacy ``services/rag/ChatHarness`` planner used ``agentic.top_k`` and
``agentic.max_hops`` to bound multi-hop reasoning. After the consolidation
to a single ``AgentHarness``, all references to those keys were dropped
from YAML, ``Settings``, ``_LEGACY_ENV_MAP``, and the infra pydantic
config. These tests ensure they don't quietly come back.
"""

from __future__ import annotations

from app.config import settings as flat_settings
from app.config.loader import _LEGACY_ENV_MAP
from app.infra.config import config as infra_config


class TestFlatSettingsHasNoAgenticAttributes:
    def test_no_agentic_rag_top_k(self) -> None:
        assert not hasattr(flat_settings, "agentic_rag_top_k")

    def test_no_agentic_rag_max_hops(self) -> None:
        assert not hasattr(flat_settings, "agentic_rag_max_hops")


class TestLegacyEnvMapPurged:
    def test_no_top_k_legacy_mapping(self) -> None:
        assert "AGENTIC_RAG_TOP_K" not in _LEGACY_ENV_MAP

    def test_no_max_hops_legacy_mapping(self) -> None:
        assert "AGENTIC_RAG_MAX_HOPS" not in _LEGACY_ENV_MAP


class TestInfraConfigHasNoAgenticSection:
    def test_top_level_no_agentic_field(self) -> None:
        assert not hasattr(infra_config, "agentic")
        assert "agentic" not in infra_config.model_fields
