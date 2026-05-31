"""
Hierarchical YAML config loader with env-var override.

Load order (later overrides earlier):
  1. default.yaml         — always loaded, committed to repo
  2. config.yaml          — optional, committed, team-shared overrides
  3. local.yaml           — optional, gitignored, personal overrides
  4. Environment variables — highest priority, __ delimiter for nesting

Env var convention:
  LLM__API_KEY   → config["llm"]["api_key"]
  RDBMS__URL     → config["rdbms"]["url"]
  SESSION__SECRET → config["session"]["secret"]

Backward-compat env vars (mapped automatically):
  DASHSCOPE_API_KEY → config["llm"]["api_key"]
  OPENAI_API_KEY    → config["llm"]["api_key"]

YAML boolean handling:
  Uses a StrictBoolSafeLoader that only treats true/false as booleans,
  preventing PyYAML's YAML 1.1 behaviour of interpreting yes/no/on/off as bool.
"""

import os
import re
from pathlib import Path
from typing import Any

import yaml

_CONFIG_DIR = Path(__file__).parent

# Old env var names mapped to their new dotted paths.
# Only used when the new-style env var is NOT set.
_LEGACY_ENV_MAP = {
    "DASHSCOPE_API_KEY":   ("llm", "api_key"),
    "OPENAI_API_KEY":      ("llm", "api_key"),
    "OPENAI_BASE_URL":     ("llm", "base_url"),
    "LLM_MODEL":           ("llm", "model"),
    "EMBEDDING_MODEL":     ("embedding", "model"),
    "EVAL_LLM_MODEL":      ("llm", "eval_model"),
    "AGENTIC_RAG_TOP_K":   ("agentic", "top_k"),
    "AGENTIC_RAG_MAX_HOPS": ("agentic", "max_hops"),
    "DASHSCOPE_BASE_URL":  ("asr", "base_url"),
    "ASR_MODEL":           ("asr", "model"),
    "ASR_TIMEOUT":         ("asr", "timeout"),
    "ASR_MODEL_LOCAL":     ("asr", "model_local"),
    "ASR_INPUT_FORMAT":    ("asr", "input_format"),
    "APP_HOST":            ("server", "host"),
    "APP_PORT":            ("server", "port"),
    "DEBUG":               ("app", "debug"),
    "DATABASE_URL":        ("rdbms", "url"),
    "CHROMA_PERSIST_DIRECTORY": ("chroma", "persist_directory"),
    "CHUNK_TARGET_SIZE":   ("chunk", "target_size"),
    "CHUNK_MIN_SIZE":      ("chunk", "min_size"),
    "CHUNK_MAX_SIZE":      ("chunk", "max_size"),
    "CHUNK_OVERLAP":       ("chunk", "overlap"),
    "EMBEDDING_VERSION":   ("embedding", "version"),
    "API_KEY_ENCRYPTION_KEY": ("security", "api_key_encryption_key"),
    "LANGSMITH_API_KEY":   ("langsmith", "api_key"),
    "LANGSMITH_PROJECT":   ("langsmith", "project"),
    "LANGSMITH_ENDPOINT":  ("langsmith", "endpoint"),
    "LANGCHAIN_TRACING_V2": ("langsmith", "tracing_v2"),
    "LANGSMITH_TRACING":   ("langsmith", "tracing"),
}


class _StrictBoolSafeLoader(yaml.SafeLoader):
    """A SafeLoader that does NOT treat yes/no/on/off as booleans.

    PyYAML's default SafeLoader follows the YAML 1.1 spec which interprets
    a wide set of strings as booleans. This loader only recognises 'true'
    and 'false' (case-insensitive), matching the YAML 1.2 behaviour.
    """
    pass


# Remove YAML 1.1 boolean implicits; keep only 'true'/'false'
_StrictBoolSafeLoader.yaml_implicit_resolvers = {
    k: [(tag, regexp) for tag, regexp in resolvers if tag != "tag:yaml.org,2002:bool"]
    for k, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_StrictBoolSafeLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|True|false|False)$"),
    list("tTfF"),
)


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge *override* into *base*, mutating base in-place."""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _apply_new_style_env_overrides(config: dict) -> None:
    """Scan os.environ for keys containing '__' and merge them into the config dict.

    Example: LLM__API_KEY=sk-xxx → config["llm"]["api_key"] = "sk-xxx"
    """
    for key, value in os.environ.items():
        if "__" not in key or not value:
            continue
        parts = key.lower().split("__")
        # Walk/create nested dicts
        node = config
        for part in parts[:-1]:
            if part not in node:
                node[part] = {}
            node = node[part]
        node[parts[-1]] = value


def _apply_legacy_env_overrides(config: dict) -> None:
    """Apply old-style flat env vars as fallbacks.

    Only writes when the corresponding new-style path is absent or empty.
    """
    for env_key, path in _LEGACY_ENV_MAP.items():
        value = os.getenv(env_key)
        if not value:
            continue
        # Check if the target path already has a value from new-style env or YAML
        node = config
        for part in path[:-1]:
            node = node.setdefault(part, {})
        existing = node.get(path[-1])
        if existing is None or existing == "":
            node[path[-1]] = value


def _load_dotenv() -> None:
    """Load .env file from project root into os.environ (best-effort).

    Only reads the file; does NOT override env vars already set in the OS.
    This keeps the standard 12-factor behaviour: env vars > .env file.
    """
    try:
        from dotenv import load_dotenv as _load
        root = _CONFIG_DIR.parent.parent  # app/config/ → app/ → project root
        dotenv_path = root / ".env"
        if dotenv_path.exists():
            _load(dotenv_path=dotenv_path, override=False)
    except ImportError:
        pass  # python-dotenv not installed — env vars come from OS/shell only


def load_config() -> dict:
    """Load the full configuration dictionary.

    Returns a nested dict built from:
        0. .env file loaded into os.environ (if python-dotenv is installed)
        1. default.yaml  (always)
        2. config.yaml   (optional, team-shared override)
        3. local.yaml    (optional, gitignored)
        4. New-style env vars  (LLM__API_KEY etc.)
        5. Legacy env vars     (DASHSCOPE_API_KEY etc., fallback only)
    """
    _load_dotenv()

    # 1. default.yaml
    default_path = _CONFIG_DIR / "default.yaml"
    if not default_path.exists():
        raise FileNotFoundError(f"Missing required config file: {default_path}")
    with open(default_path, encoding="utf-8") as f:
        config = yaml.load(f, Loader=_StrictBoolSafeLoader)

    # 2. config.yaml (optional, committed — skip via BILIRAG_SKIP_CONFIG=1)
    if not os.getenv("BILIRAG_SKIP_CONFIG"):
        config_path = _CONFIG_DIR / "config.yaml"
        if config_path.exists():
            with open(config_path, encoding="utf-8") as f:
                config_overlay = yaml.load(f, Loader=_StrictBoolSafeLoader)
                if config_overlay:
                    _deep_merge(config, config_overlay)

    # 3. local.yaml (optional)
    local_path = _CONFIG_DIR / "local.yaml"
    if local_path.exists():
        with open(local_path, encoding="utf-8") as f:
            local_overlay = yaml.load(f, Loader=_StrictBoolSafeLoader)
            if local_overlay:
                _deep_merge(config, local_overlay)

    # 4. New-style env vars (highest priority)
    _apply_new_style_env_overrides(config)

    # 5. Legacy env vars (fallback — won't overwrite existing values)
    _apply_legacy_env_overrides(config)

    return config


# Module-level cache — loaded once on first import
_config: dict | None = None


def get_config() -> dict:
    """Return the parsed config dict (lazy-loaded, cached)."""
    global _config
    if _config is None:
        _config = load_config()
    return _config
