"""
Application configuration.

Config sources (later overrides earlier):
  1. app/config/default.yaml          — base defaults (committed)
  2. app/config/config.yaml           — team-shared overrides (committed, optional)
  3. app/config/local.yaml            — personal overrides (gitignored, optional)
  4. Environment variables            — highest priority (LLM__API_KEY etc.)

To access config throughout the app, use the module-level ``settings`` object:

    from app.config import settings
    print(settings.llm_model)

Sensitive fields (api_key, secret, password) MUST NOT appear in YAML files.
They are injected via environment variables with __ nesting:
    LLM__API_KEY=sk-xxx  →  config["llm"]["api_key"]

Legacy env var names (DASHSCOPE_API_KEY, OPENAI_API_KEY, etc.) are still
supported as fallbacks when the new-style name is not set.
"""

import os
from typing import Optional

from app.config.loader import get_config

# Load once, use everywhere
_config = get_config()


def _get(*path: str, default=None):
    """Walk nested dict by path, return the value or default."""
    node = _config
    for key in path:
        if not isinstance(node, dict):
            return default
        node = node.get(key)
        if node is None:
            return default
    return node


class _Settings:
    """Flat accessor over the nested YAML config for backward compatibility.

    New code should prefer ``_get("llm", "model")`` or access _config directly.
    This class exists so that existing ``settings.llm_model`` references
    continue to work without changes throughout the codebase.
    """

    # ── App ──────────────────────────────────────────────────────

    @property
    def debug(self) -> bool:
        return bool(_get("app", "debug", default=False))

    # ── Server ───────────────────────────────────────────────────

    @property
    def app_host(self) -> str:
        return str(_get("server", "host", default="0.0.0.0"))

    @property
    def app_port(self) -> int:
        return int(_get("server", "port", default=8000))

    # ── RDBMS ────────────────────────────────────────────────────

    @property
    def database_url(self) -> str:
        return str(_get("rdbms", "url", default="sqlite+aiosqlite:///./data/bilibili_rag.db"))

    # ── ChromaDB ─────────────────────────────────────────────────

    @property
    def chroma_persist_directory(self) -> str:
        return str(_get("chroma", "persist_directory", default="./data/chroma_db"))

    # ── LLM ──────────────────────────────────────────────────────

    @property
    def openai_api_key(self) -> str:
        return str(_get("llm", "api_key", default=""))

    @property
    def openai_base_url(self) -> str:
        return str(_get("llm", "base_url", default="https://dashscope.aliyuncs.com/compatible-mode/v1"))

    @property
    def llm_model(self) -> str:
        return str(_get("llm", "model", default="qwen3-max"))

    @property
    def eval_llm_model(self) -> str:
        return str(_get("llm", "eval_model", default="gpt-4o-mini"))

    # ── Embedding ────────────────────────────────────────────────

    @property
    def embedding_model(self) -> str:
        return str(_get("embedding", "model", default="text-embedding-v4"))

    @property
    def embedding_version(self) -> str:
        return str(_get("embedding", "version", default="v1"))

    # ── Chunking ─────────────────────────────────────────────────

    @property
    def chunk_target_size(self) -> int:
        return int(_get("chunk", "target_size", default=750))

    @property
    def chunk_min_size(self) -> int:
        return int(_get("chunk", "min_size", default=300))

    @property
    def chunk_max_size(self) -> int:
        return int(_get("chunk", "max_size", default=900))

    @property
    def chunk_overlap(self) -> int:
        return int(_get("chunk", "overlap", default=100))

    # ── Agentic RAG ──────────────────────────────────────────────

    @property
    def agentic_rag_top_k(self) -> int:
        return int(_get("agentic", "top_k", default=5))

    @property
    def agentic_rag_max_hops(self) -> int:
        return int(_get("agentic", "max_hops", default=3))

    # ── ASR ──────────────────────────────────────────────────────

    @property
    def dashscope_base_url(self) -> str:
        return str(_get("asr", "base_url", default="https://dashscope.aliyuncs.com/api/v1"))

    @property
    def asr_model(self) -> str:
        return str(_get("asr", "model", default="paraformer-v2"))

    @property
    def asr_timeout(self) -> int:
        return int(_get("asr", "timeout", default=600))

    @property
    def asr_model_local(self) -> str:
        return str(_get("asr", "model_local", default="paraformer-realtime-v2"))

    @property
    def asr_input_format(self) -> str:
        return str(_get("asr", "input_format", default="pcm"))

    # ── LangSmith ────────────────────────────────────────────────

    @property
    def langchain_tracing_v2(self) -> bool:
        return bool(_get("langsmith", "tracing_v2", default=False))

    @property
    def langsmith_tracing(self) -> bool:
        return bool(_get("langsmith", "tracing", default=False))

    @property
    def langsmith_api_key(self) -> str:
        return str(_get("langsmith", "api_key", default=""))

    @property
    def langsmith_project(self) -> str:
        return str(_get("langsmith", "project", default="bilibili-rag"))

    @property
    def langsmith_endpoint(self) -> str:
        return str(_get("langsmith", "endpoint", default="https://api.smith.langchain.com"))

    # ── Session ──────────────────────────────────────────────────

    @property
    def session_secret(self) -> str:
        return str(_get("session", "secret", default=""))

    # ── Redis ────────────────────────────────────────────────────

    @property
    def redis_enabled(self) -> bool:
        return bool(_get("redis", "enabled", default=False))

    # ── Security ─────────────────────────────────────────────────

    @property
    def api_key_encryption_key(self) -> str:
        return str(_get("security", "api_key_encryption_key", default=""))


# Module-level singleton — the single config access point
settings = _Settings()


def ensure_directories() -> None:
    """Create required directories on startup."""
    dirs = [
        "data",
        settings.chroma_persist_directory,
        "logs",
    ]
    for d in dirs:
        os.makedirs(d, exist_ok=True)
