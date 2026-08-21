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

    # ── Security ────────────────────────────────────────────────

    @property
    def cors_allow_origins(self) -> list[str]:
        """CORS allowlist.

        YAML stores a list; env overrides (``SECURITY__CORS__ALLOW_ORIGINS``)
        arrive as a comma-separated string, so normalise both to a list.
        """
        origins = _get("security", "cors", "allow_origins",
                       default=["http://localhost:3000"])
        if isinstance(origins, str):
            origins = [o.strip() for o in origins.split(",") if o.strip()]
        if not origins:
            # Empty env override or empty YAML list -> dev default.
            # Production is same-origin behind nginx so CORS never fires;
            # this only affects local dev (frontend :3000 -> backend :8000).
            origins = ["http://localhost:3000"]
        return list(origins)

    # ── RDBMS ────────────────────────────────────────────────────

    @property
    def database_url(self) -> str:
        return str(_get("rdbms", "url", default="sqlite+aiosqlite:///./data/mind_base.db"))

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
    def llm_provider(self) -> str:
        """Which provider serves conversational LLM calls (see
        ``app/services/llm/providers.py``): ``dashscope`` | ``openrouter``."""
        return str(_get("llm", "provider", default="dashscope"))

    @property
    def llm_context_window(self) -> int:
        """Context window (tokens) of the active chat model.

        0 = auto: resolved from the built-in model registry
        (``app/services/llm/providers.resolve_context_window``).  Set a
        positive value only to pin a model that is not in the registry.
        Drives the conversation-history compression budget (≈ 50%).
        """
        return int(_get("llm", "context_window", default=0))

    # ── OpenRouter (alternative OpenAI-compatible gateway) ──────────

    @property
    def openrouter_api_key(self) -> str:
        return str(_get("openrouter", "api_key", default=""))

    @property
    def openrouter_base_url(self) -> str:
        return str(_get("openrouter", "base_url", default="https://openrouter.ai/api/v1"))

    @property
    def openrouter_model(self) -> str:
        return str(_get("openrouter", "model", default=""))

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

    @property
    def asr_transcription_model(self) -> str:
        return str(_get("asr", "transcription_model", default="paraformer-v2"))

    @property
    def asr_realtime_max_seconds(self) -> int:
        return int(_get("asr", "realtime_max_seconds", default=60))

    @property
    def asr_recognition_timeout(self) -> int:
        return int(_get("asr", "recognition_timeout", default=90))

    @property
    def asr_api_key(self) -> str:
        """ASR key; falls back to LLM key when ASR__API_KEY is unset."""
        key = str(_get("asr", "api_key", default="") or "")
        return key or self.openai_api_key

    # ── Ingest ───────────────────────────────────────────────────

    @property
    def ingest_page_concurrency(self) -> int:
        """收藏夹同步时同 bvid 的分P 并发数（B站 SESSDATA 限流保守值）。"""
        return int(_get("ingest", "page_concurrency", default=3))

    @property
    def ingest_asr_chunk_concurrency(self) -> int:
        """长音频 PCM 切块并行识别数（DashScope 并发限流）。"""
        return int(_get("ingest", "asr_chunk_concurrency", default=3))

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
        return str(_get("langsmith", "project", default="MindBase"))

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

    # ── Email ────────────────────────────────────────────────────

    @property
    def email_enabled(self) -> bool:
        return bool(_get("email", "enabled", default=False))

    @property
    def email_api_key(self) -> str:
        return str(_get("email", "api_key", default=""))

    @property
    def email_from(self) -> str:
        return str(_get("email", "from_email",
                        default="MindBase <onboarding@resend.dev>"))

    @property
    def email_frontend_url(self) -> str:
        return str(_get("email", "frontend_url",
                        default="http://localhost:3000"))

    @property
    def email_code_ttl_seconds(self) -> int:
        return int(_get("email", "code_ttl_seconds", default=300))

    @property
    def email_code_length(self) -> int:
        return int(_get("email", "code_length", default=6))

    @property
    def email_rate_limit_target_seconds(self) -> int:
        return int(_get("email", "rate_limit_target_seconds", default=60))

    @property
    def email_rate_limit_uid_minutes(self) -> int:
        return int(_get("email", "rate_limit_uid_minutes", default=10))

    @property
    def email_rate_limit_uid_max(self) -> int:
        return int(_get("email", "rate_limit_uid_max", default=5))

    @property
    def email_max_verify_attempts(self) -> int:
        return int(_get("email", "max_verify_attempts", default=5))

    # ── WeChat open platform login ───────────────────────────────

    @property
    def wechat_enabled(self) -> bool:
        return bool(_get("wechat", "enabled", default=False))

    @property
    def wechat_app_id(self) -> str:
        return str(_get("wechat", "app_id", default=""))

    @property
    def wechat_app_secret(self) -> str:
        return str(_get("wechat", "app_secret", default=""))

    @property
    def wechat_redirect_uri(self) -> str:
        return str(_get("wechat", "redirect_uri", default=""))

    # ── Security: rate_limit (Plan 0028) ────────────────────────

    def _rl(self, endpoint: str, key: str, default: int) -> int:
        return int(_get("security", "rate_limit", endpoint, key, default=default))

    @property
    def rl_login_ip_max(self) -> int:
        return self._rl("login", "ip_max", 10)

    @property
    def rl_login_ip_window(self) -> int:
        return self._rl("login", "ip_window", 60)

    @property
    def rl_login_email_max(self) -> int:
        return self._rl("login", "email_max", 5)

    @property
    def rl_login_email_window(self) -> int:
        return self._rl("login", "email_window", 300)

    @property
    def rl_login_cooldown_threshold(self) -> int:
        return self._rl("login", "cooldown_threshold", 5)

    @property
    def rl_login_cooldown_seconds(self) -> int:
        return self._rl("login", "cooldown_seconds", 900)

    @property
    def rl_reset_request_ip_max(self) -> int:
        return self._rl("password_reset_request", "ip_max", 5)

    @property
    def rl_reset_request_ip_window(self) -> int:
        return self._rl("password_reset_request", "ip_window", 3600)

    @property
    def rl_reset_request_email_max(self) -> int:
        return self._rl("password_reset_request", "email_max", 3)

    @property
    def rl_reset_request_email_window(self) -> int:
        return self._rl("password_reset_request", "email_window", 3600)

    @property
    def rl_reset_ip_max(self) -> int:
        return self._rl("password_reset", "ip_max", 10)

    @property
    def rl_reset_ip_window(self) -> int:
        return self._rl("password_reset", "ip_window", 3600)

    @property
    def rl_send_code_ip_max(self) -> int:
        return self._rl("email_send_code", "ip_max", 10)

    @property
    def rl_send_code_ip_window(self) -> int:
        return self._rl("email_send_code", "ip_window", 60)

    @property
    def rl_send_code_uid_max(self) -> int:
        return self._rl("email_send_code", "uid_max", 5)

    @property
    def rl_send_code_uid_window(self) -> int:
        return self._rl("email_send_code", "uid_window", 600)

    @property
    def rl_change_password_uid_max(self) -> int:
        return self._rl("change_password", "uid_max", 3)

    @property
    def rl_change_password_uid_window(self) -> int:
        return self._rl("change_password", "uid_window", 3600)

    @property
    def rl_email_verify_ip_max(self) -> int:
        return self._rl("email_verify", "ip_max", 20)

    @property
    def rl_email_verify_ip_window(self) -> int:
        return self._rl("email_verify", "ip_window", 60)

    @property
    def rl_register_send_ip_max(self) -> int:
        return self._rl("register_send", "ip_max", 5)

    @property
    def rl_register_send_ip_window(self) -> int:
        return self._rl("register_send", "ip_window", 3600)

    @property
    def rl_register_send_email_max(self) -> int:
        return self._rl("register_send", "email_max", 3)

    @property
    def rl_register_send_email_window(self) -> int:
        return self._rl("register_send", "email_window", 3600)

    @property
    def rl_register_ip_max(self) -> int:
        return self._rl("register", "ip_max", 10)

    @property
    def rl_register_ip_window(self) -> int:
        return self._rl("register", "ip_window", 3600)

    @property
    def rl_phone_send_ip_max(self) -> int:
        return self._rl("phone_send", "ip_max", 10)

    @property
    def rl_phone_send_ip_window(self) -> int:
        return self._rl("phone_send", "ip_window", 60)

    @property
    def rl_phone_send_phone_max(self) -> int:
        return self._rl("phone_send", "phone_max", 5)

    @property
    def rl_phone_send_phone_window(self) -> int:
        return self._rl("phone_send", "phone_window", 600)

    @property
    def rl_phone_login_ip_max(self) -> int:
        return self._rl("phone_login", "ip_max", 10)

    @property
    def rl_phone_login_ip_window(self) -> int:
        return self._rl("phone_login", "ip_window", 60)

    @property
    def rl_phone_login_phone_max(self) -> int:
        return self._rl("phone_login", "phone_max", 5)

    @property
    def rl_phone_login_phone_window(self) -> int:
        return self._rl("phone_login", "phone_window", 300)

    # ── SMS (aliyun dysmsapi) ─────────────────────────────────────

    @property
    def sms_enabled(self) -> bool:
        return bool(_get("sms", "enabled", default=False))

    @property
    def sms_access_key_id(self) -> str:
        return str(_get("sms", "access_key_id", default=""))

    @property
    def sms_access_key_secret(self) -> str:
        return str(_get("sms", "access_key_secret", default=""))

    @property
    def sms_sign_name(self) -> str:
        return str(_get("sms", "sign_name", default=""))

    @property
    def sms_template_code(self) -> str:
        return str(_get("sms", "template_code", default=""))

    # ── Security: captcha (anti-bot, login etc.) ─────────────────

    @property
    def captcha_enabled(self) -> bool:
        return bool(_get("security", "captcha", "enabled", default=True))

    @property
    def captcha_length(self) -> int:
        return int(_get("security", "captcha", "length", default=4))

    @property
    def captcha_ttl_seconds(self) -> int:
        return int(_get("security", "captcha", "ttl_seconds", default=300))

    @property
    def captcha_image_width(self) -> int:
        return int(_get("security", "captcha", "image_width", default=160))

    @property
    def captcha_image_height(self) -> int:
        return int(_get("security", "captcha", "image_height", default=56))

    # ── Rerank ────────────────────────────────────────────────────

    @property
    def rerank_enabled(self) -> bool:
        return bool(_get("rerank", "enabled", default=False))

    @property
    def rerank_provider(self) -> str:
        # "none" is accepted as an alias for "null" by Reranker.__init__.
        return str(_get("rerank", "provider", default="null"))

    @property
    def rerank_api_key(self) -> str:
        # Leave empty to fall back to the LLM api key (DashScope same-source).
        return str(_get("rerank", "api_key", default=""))

    @property
    def rerank_model(self) -> str:
        return str(_get("rerank", "model", default="gte-rerank-v2"))

    @property
    def rerank_base_url(self) -> str:
        return str(_get("rerank", "base_url",
                        default="https://dashscope.aliyuncs.com/api/v1"))

    @property
    def rerank_timeout(self) -> int:
        return int(_get("rerank", "timeout", default=30))

    @property
    def rerank_top_n(self) -> int:
        # Over-recall count fed to the reranker (embedding recall -> rerank -> top_k).
        return int(_get("rerank", "top_n", default=30))

    @property
    def rerank_alpha(self) -> float:
        return float(_get("rerank", "alpha", default=0.7))

    @property
    def rerank_beta(self) -> float:
        return float(_get("rerank", "beta", default=0.2))

    @property
    def rerank_gamma(self) -> float:
        return float(_get("rerank", "gamma", default=0.1))

    @property
    def rerank_lambda(self) -> float:
        # MMR relevance/diversity trade-off (1.0 = pure relevance).
        return float(_get("rerank", "lambda", default=0.7))


# Module-level singleton — the single config access point
settings = _Settings()


def ensure_directories() -> None:
    """Create required directories on startup."""
    dirs = [
        "data",
        "logs",
    ]
    for d in dirs:
        os.makedirs(d, exist_ok=True)
