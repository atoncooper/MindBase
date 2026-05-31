"""Unified configuration loader.

Loading order (later overrides earlier):
  1. Pydantic field defaults
  2. app/config/default.yaml
  3. app/config/config.yaml          # optional, team-shared override
  4. app/config/local.yaml           # optional, personal override
  5. Environment variables           # highest priority, for secrets

Usage:
    from app.infra.config import config
    print(config.rdbms.url)
    print(config.llm.api_key.get_secret_value())
"""

from __future__ import annotations

import copy
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from loguru import logger
from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)


# ---------------------------------------------------------------------------
# PyYAML SafeLoader — disable YAML 1.1 bool trap
# ---------------------------------------------------------------------------
# PyYAML's default SafeLoader treats yes/no/on/off/y/n as bool.
# We deep-copy SafeLoader and restrict bool to true/True/TRUE/false/False/FALSE.
# ---------------------------------------------------------------------------
class StrictBoolSafeLoader(yaml.SafeLoader):
    """SafeLoader that only accepts true/false (all case variants) as bool."""


StrictBoolSafeLoader.yaml_implicit_resolvers = copy.deepcopy(
    yaml.SafeLoader.yaml_implicit_resolvers
)
for _key in list(StrictBoolSafeLoader.yaml_implicit_resolvers.keys()):
    StrictBoolSafeLoader.yaml_implicit_resolvers[_key] = [
        (_tag, _rx)
        for _tag, _rx in StrictBoolSafeLoader.yaml_implicit_resolvers[_key]
        if _tag != "tag:yaml.org,2002:bool"
    ]
StrictBoolSafeLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$", re.X),
    list("tTfF"),
)


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parents[2]   # app/infra/config.py -> project root
APP_DIR = Path(__file__).resolve().parents[1]        # app/infra/config.py -> app/
CONFIG_DIR = APP_DIR / "config"


# ---------------------------------------------------------------------------
# Utils
# ---------------------------------------------------------------------------


def _config_files() -> list[Path]:
    """Return existing YAML files in load order.

    Prefers .yaml over .yml; warns if both exist.
    """
    def pick(stem: str) -> Path | None:
        yaml_path = CONFIG_DIR / f"{stem}.yaml"
        yml_path = CONFIG_DIR / f"{stem}.yml"
        if yaml_path.is_file() and yml_path.is_file():
            logger.warning(
                "[CONFIG] both %s.yaml and %s.yml exist, using .yaml", stem, stem
            )
            return yaml_path
        if yaml_path.is_file():
            return yaml_path
        if yml_path.is_file():
            return yml_path
        return None

    skip_config = os.getenv("BILIRAG_SKIP_CONFIG")
    candidates = [pick("default")]
    if not skip_config:
        candidates.append(pick("config"))
    candidates.append(pick("local"))
    return [p for p in candidates if p is not None]


# ---------------------------------------------------------------------------
# Custom YAML source (pydantic-settings has no built-in YAML source)
# ---------------------------------------------------------------------------

class YamlConfigSettingsSource(PydanticBaseSettingsSource):
    """Load config from a single YAML file.

    Mirrors the built-in TomlConfigSettingsSource: return a raw dict and let
    BaseSettings handle deep merging.
    """

    def __init__(self, settings_cls: type[BaseSettings], yaml_file: Path) -> None:
        super().__init__(settings_cls)
        self.yaml_file = yaml_file
        self._data: dict[str, Any] = {}
        if yaml_file.is_file():
            with yaml_file.open("r", encoding="utf-8") as f:
                loaded = yaml.load(f, Loader=StrictBoolSafeLoader)
            self._data = loaded or {}

    def get_field_value(self, field, field_name: str) -> tuple[Any, str, bool]:
        value = self._data.get(field_name)
        return value, field_name, False

    def __call__(self) -> dict[str, Any]:
        return self._data


# ---------------------------------------------------------------------------
# Sub-config sections (top-level keys in YAML)
# ---------------------------------------------------------------------------

class _Section(BaseSettings):
    """Base class for nested config sections.

    - populate_by_name=True: accept both field name and alias from env
      (pydantic-settings parses env vars into nested dicts using field names,
       but validation_alias only matches aliases; this switch allows both)
    - protected_namespaces=(): allow model_* field names (e.g. model_local)
    - extra="ignore": silently drop unknown YAML keys for forward compatibility
    """
    model_config = SettingsConfigDict(
        populate_by_name=True,
        protected_namespaces=(),
        extra="ignore",
    )


class AppSection(_Section):
    name: str = "bilirag"
    env: str = "dev"
    debug: bool = False
    log_level: str = "INFO"
    timezone: str = "Asia/Shanghai"


class ServerSection(_Section):
    host: str = "0.0.0.0"
    port: int = 8000
    workers: int = 4
    reload: bool = False
    ssl_certfile: str = ""
    ssl_keyfile: str = ""
    proxy_headers: bool = True


class RdbmsSection(_Section):
    url: str = "sqlite+aiosqlite:///./data/bilibili_rag.db"
    echo: bool = False
    pool_size: int = 20
    max_overflow: int = 10
    pool_timeout: int = 30
    pool_recycle: int = 1800


class ChromaSection(_Section):
    enabled: bool = True
    persist_directory: str = "./data/chroma_db"


class MilvusSection(_Section):
    enabled: bool = False
    uri: str = "http://localhost:19530"
    token: str = ""
    db_name: str = "bilirag"
    collection_name: str = "bilibili_videos"
    dimension: int = 1536
    index_type: str = "IVF_FLAT"
    metric_type: str = "COSINE"
    nlist: int = 1024
    nprobe: int = 16


class MongoSection(_Section):
    enabled: bool = False
    uri: str = "mongodb://localhost:27017"
    db_name: str = "bilirag"
    max_pool_size: int = 100
    min_pool_size: int = 10
    server_selection_timeout_ms: int = 5000
    connect_timeout_ms: int = 10000


class RedisSection(_Section):
    enabled: bool = False
    url: str = "redis://localhost:6379/0"
    max_connections: int = 50
    socket_timeout: int = 5
    socket_connect_timeout: int = 5
    health_check_interval: int = 30
    key_prefix: str = "bilirag:"


class MinioSection(_Section):
    enabled: bool = False
    endpoint: str = "http://localhost:9000"
    region: str = "us-east-1"
    bucket: str = "bilirag"
    secure: bool = False
    presign_expire: int = 3600
    access_key: SecretStr = SecretStr("")
    secret_key: SecretStr = SecretStr("")


class MqSection(_Section):
    enabled: bool = False
    broker: str = "redis://localhost:6379/1"
    backend: str = "redis://localhost:6379/2"
    task_time_limit: int = 1800
    task_soft_time_limit: int = 1500
    task_acks_late: bool = True
    worker_prefetch: int = 1
    result_expires: int = 86400
    stream_maxlen: int = 10000
    stream_block_ms: int = 5000
    rabbitmq_url: str = ""


class LlmSection(_Section):
    provider: str = "dashscope"
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    model: str = "qwen3-max"
    eval_model: str = "gpt-4o-mini"
    timeout: int = 60
    max_retries: int = 3
    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices(
            "LLM__API_KEY", "DASHSCOPE_API_KEY", "OPENAI_API_KEY"
        ),
    )


class EmbeddingSection(_Section):
    model: str = "text-embedding-v4"
    batch_size: int = 100
    dimension: int = 1536
    version: str = "v1"


class ChunkSection(_Section):
    target_size: int = 750
    min_size: int = 300
    max_size: int = 900
    overlap: int = 100


class AgenticSection(_Section):
    top_k: int = 5
    max_hops: int = 3


class AsrSection(_Section):
    provider: str = "dashscope"
    base_url: str = "https://dashscope.aliyuncs.com/api/v1"
    model: str = "paraformer-v2"
    model_local: str = "paraformer-realtime-v2"
    input_format: str = "pcm"
    timeout: int = 600
    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("ASR__API_KEY", "DASHSCOPE_API_KEY"),
    )


class LangsmithSection(_Section):
    enabled: bool = True
    project: str = "bilibili-rag"
    endpoint: str = "https://api.smith.langchain.com"
    tracing_v2: bool = True
    tracing: bool = True
    # Align with LangChain SDK convention: single-underscore LANGSMITH_API_KEY
    api_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("LANGSMITH_API_KEY"),
    )


class SessionSection(_Section):
    ttl_days: int = 30
    secret: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("SESSION__SECRET"),
    )


class SecuritySection(_Section):
    encryption_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices(
            "SECURITY__API_KEY_ENCRYPTION_KEY", "API_KEY_ENCRYPTION_KEY"
        ),
    )


class RateLimitSection(_Section):
    chat_per_minute: int = 60
    asr_per_hour: int = 100
    quiz_per_day: int = 50


class SlowSqlSection(_Section):
    enabled: bool = True
    threshold_ms: int = 100
    max_samples_per_fingerprint: int = 3
    retention_days: int = 7
    log_to_console: bool = True
    log_to_storage: bool = True


class TransactionSection(_Section):
    max_retries: int = 3
    retry_delay_base: float = 0.1
    readonly_hint: bool = False


# ---------------------------------------------------------------------------
# Top-level aggregator
# ---------------------------------------------------------------------------

class AppConfig(BaseSettings):
    """Aggregator for all sub-sections.

    Usage (global singleton):
        from app.infra.config import config
        print(config.rdbms.url)
        print(config.llm.api_key.get_secret_value())
    """
    app: AppSection = Field(default_factory=AppSection)
    server: ServerSection = Field(default_factory=ServerSection)
    rdbms: RdbmsSection = Field(default_factory=RdbmsSection)
    chroma: ChromaSection = Field(default_factory=ChromaSection)
    milvus: MilvusSection = Field(default_factory=MilvusSection)
    mongo: MongoSection = Field(default_factory=MongoSection)
    redis: RedisSection = Field(default_factory=RedisSection)
    minio: MinioSection = Field(default_factory=MinioSection)
    mq: MqSection = Field(default_factory=MqSection)
    llm: LlmSection = Field(default_factory=LlmSection)
    embedding: EmbeddingSection = Field(default_factory=EmbeddingSection)
    chunk: ChunkSection = Field(default_factory=ChunkSection)
    agentic: AgenticSection = Field(default_factory=AgenticSection)
    asr: AsrSection = Field(default_factory=AsrSection)
    langsmith: LangsmithSection = Field(default_factory=LangsmithSection)
    session: SessionSection = Field(default_factory=SessionSection)
    security: SecuritySection = Field(default_factory=SecuritySection)
    ratelimit: RateLimitSection = Field(default_factory=RateLimitSection)
    slow_sql: SlowSqlSection = Field(default_factory=SlowSqlSection)
    transaction: TransactionSection = Field(default_factory=TransactionSection)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_nested_delimiter="__",
        case_sensitive=False,
        extra="ignore",
    )

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """Override default source order to insert YAML sources.

        Return order (left = highest priority):
          init_settings > env_settings > dotenv_settings >
          local.yaml > {env}.yaml > default.yaml > file_secret_settings
        """
        yaml_sources = [
            YamlConfigSettingsSource(settings_cls, yaml_file=f)
            for f in reversed(_config_files())   # reversed: local pushed first (higher priority)
        ]
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            *yaml_sources,
            file_secret_settings,
        )


# ---------------------------------------------------------------------------
# Singleton + startup validation
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def get_config() -> AppConfig:
    files = _config_files()
    if not files:
        logger.warning(
            "[CONFIG] no yaml files found in %s, using defaults+env only", CONFIG_DIR
        )
    else:
        logger.info(
            "[CONFIG] loading: %s",
            [str(f.relative_to(PROJECT_ROOT)) for f in files],
        )

    cfg = AppConfig()
    _validate(cfg)
    logger.info(
        "[CONFIG] loaded: env=%s debug=%s log=%s",
        cfg.app.env, cfg.app.debug, cfg.app.log_level,
    )
    return cfg


def _validate(cfg: AppConfig) -> None:
    """Startup validation: required secrets must not be empty.

    Raises in prod; warns and continues in dev.
    """
    missing: list[str] = []

    if not cfg.llm.api_key.get_secret_value():
        missing.append("llm.api_key (env: LLM__API_KEY)")
    if not cfg.session.secret.get_secret_value():
        missing.append("session.secret (env: SESSION__SECRET)")
    if not cfg.security.encryption_key.get_secret_value():
        missing.append("security.encryption_key (env: SECURITY__API_KEY_ENCRYPTION_KEY)")
    if cfg.minio.enabled:
        if not cfg.minio.access_key.get_secret_value():
            missing.append("minio.access_key (env: MINIO__ACCESS_KEY)")
        if not cfg.minio.secret_key.get_secret_value():
            missing.append("minio.secret_key (env: MINIO__SECRET_KEY)")
    if cfg.langsmith.enabled and not cfg.langsmith.api_key.get_secret_value():
        missing.append("langsmith.api_key (env: LANGSMITH_API_KEY)")

    if missing:
        if cfg.app.env == "prod":
            raise RuntimeError(f"[CONFIG] missing required secrets: {missing}")
        logger.warning("[CONFIG] missing secrets (dev mode, continuing): %s", missing)


# Module-level alias for convenience:
#   from app.infra.config import config
config = get_config()
