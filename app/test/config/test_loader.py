"""Tests for the config loader (``app/config/loader.py``).

Covers:

- ${VAR} / ${VAR:default} placeholder expansion (set / unset / default /
  inline text / nested structures / non-string scalars / bare "$")
- load_config integration: YAML placeholders resolve from the environment
  and unset ones resolve to ""
"""

from __future__ import annotations

from app.config import loader


class TestExpandEnvPlaceholders:
    def test_expands_set_var(self, monkeypatch):
        monkeypatch.setenv("TEST_SECRET_X", "sk-123")
        assert loader._expand_env_placeholders({"k": "${TEST_SECRET_X}"}) == {
            "k": "sk-123"
        }

    def test_unset_without_default_resolves_empty(self, monkeypatch):
        monkeypatch.delenv("TEST_SECRET_X", raising=False)
        assert loader._expand_env_placeholders({"k": "${TEST_SECRET_X}"}) == {"k": ""}

    def test_default_used_when_unset(self, monkeypatch):
        monkeypatch.delenv("TEST_SECRET_X", raising=False)
        assert loader._expand_env_placeholders(
            {"k": "${TEST_SECRET_X:fallback}"}
        ) == {"k": "fallback"}

    def test_env_value_beats_default(self, monkeypatch):
        monkeypatch.setenv("TEST_SECRET_X", "real")
        assert loader._expand_env_placeholders(
            {"k": "${TEST_SECRET_X:fallback}"}
        ) == {"k": "real"}

    def test_inline_mixed_text(self, monkeypatch):
        monkeypatch.setenv("TEST_SECRET_X", "pw")
        assert loader._expand_env_placeholders(
            {"k": "user:${TEST_SECRET_X}@host"}
        ) == {"k": "user:pw@host"}

    def test_nested_structures(self, monkeypatch):
        monkeypatch.setenv("TEST_SECRET_X", "v")
        cfg = {"a": {"b": ["${TEST_SECRET_X}", 1, True]}, "c": "${TEST_SECRET_X}-s"}
        assert loader._expand_env_placeholders(cfg) == {
            "a": {"b": ["v", 1, True]},
            "c": "v-s",
        }

    def test_non_string_scalar_untouched(self):
        cfg = {"n": 5, "b": True, "x": None}
        assert loader._expand_env_placeholders(cfg) == cfg

    def test_dollar_without_brace_untouched(self):
        assert loader._expand_env_placeholders({"k": "US$100 and $VAR"}) == {
            "k": "US$100 and $VAR"
        }


class TestLoadConfigIntegration:
    def test_placeholder_resolves_from_env(self, monkeypatch):
        monkeypatch.setattr(loader, "_load_dotenv", lambda: None)
        monkeypatch.setenv("BILIRAG_SKIP_CONFIG", "1")  # skip team overlay
        monkeypatch.setenv("LLM__API_KEY", "sk-from-env")

        cfg = loader.load_config()
        assert cfg["llm"]["api_key"] == "sk-from-env"

    def test_unset_placeholder_is_empty_string(self, monkeypatch):
        monkeypatch.setattr(loader, "_load_dotenv", lambda: None)
        monkeypatch.setenv("BILIRAG_SKIP_CONFIG", "1")
        monkeypatch.delenv("AI_GATEWAY__API_KEY", raising=False)

        cfg = loader.load_config()
        assert cfg["ai_gateway"]["api_key"] == ""

    def test_env_override_still_wins(self, monkeypatch):
        # The direct env-merge path (段__键) must keep working unchanged.
        monkeypatch.setattr(loader, "_load_dotenv", lambda: None)
        monkeypatch.setenv("BILIRAG_SKIP_CONFIG", "1")
        monkeypatch.setenv("LLM__MODEL", "model-via-env")

        cfg = loader.load_config()
        assert cfg["llm"]["model"] == "model-via-env"
