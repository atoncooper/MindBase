# Configuration Guide

## Overview

Configuration is loaded from **YAML files** for non-sensitive settings and **environment variables** for secrets (API keys, passwords). The two are merged at startup — YAML defines the structure and defaults; env vars inject sensitive values without touching files that could be committed.

### Load order (later overrides earlier)

```
1. app/config/default.yaml        ← committed, defines every field + default
2. app/config/config.yaml         ← team-shared overrides (committed, optional)
3. app/config/local.yaml          ← optional, gitignored, per-machine tweaks
4. .env file                      ← loaded into os.environ (python-dotenv)
5. Environment variables          ← highest priority (LLM__API_KEY etc.)
```

---

## Quick start

```bash
# 1. Copy the env template
cp .env.example .env

# 2. Edit .env — only fill in the secret fields
#    All non-sensitive settings are already in YAML files.
```

Minimal `.env`:

```env
LLM__API_KEY=sk-your-dashscope-key
```

---

## Environment variable naming

Use **double underscore** (`__`) to express nesting:

| Env var | Maps to YAML path | Example value |
|---------|-------------------|---------------|
| `LLM__API_KEY` | `llm.api_key` | `sk-xxx` |
| `LLM__MODEL` | `llm.model` | `qwen3-max` |
| `RDBMS__URL` | `rdbms.url` | `postgresql+asyncpg://...` |
| `SESSION__SECRET` | `session.secret` | (random string) |
| `SECURITY__API_KEY_ENCRYPTION_KEY` | `security.api_key_encryption_key` | (base64-32) |

Legacy flat env var names (e.g. `DASHSCOPE_API_KEY`, `OPENAI_API_KEY`) are still recognized as fallbacks when the new-style name is not set.

---

## YAML configuration reference

### `app` — Application metadata

```yaml
app:
  name: bilirag
  env: dev
  debug: false
  log_level: INFO         # DEBUG / INFO / WARNING / ERROR / CRITICAL
  timezone: Asia/Shanghai
```

### `server` — HTTP server

```yaml
server:
  host: 0.0.0.0
  port: 8000
  workers: 4              # set 1 in config.yaml if using --reload
  reload: false
```

### `rdbms` — Relational database

```yaml
rdbms:
  url: sqlite+aiosqlite:///./data/bilibili_rag.db
  echo: false
  pool_size: 20
  max_overflow: 10
  pool_timeout: 30
  pool_recycle: 1800
```

To switch to PostgreSQL:

```yaml
# config.yaml
rdbms:
  echo: false
  pool_size: 50
  max_overflow: 30
```

```env
RDBMS__URL=postgresql+asyncpg://user:pass@host:5432/bilirag
```

### `milvus` — Vector database

```yaml
milvus:
  host: localhost
  port: 19530
  collection_name: bilibili_videos
  cloud_collection_name: cloud_drive
```

### `llm` — Language model (OpenAI-compatible)

```yaml
llm:
  provider: dashscope     # dashscope / openai / anthropic / custom
  base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
  model: qwen3-max
  eval_model: gpt-4o-mini
  timeout: 60
  max_retries: 3
```

`api_key` is **never** in YAML — inject via env:

```env
LLM__API_KEY=sk-your-key
```

### `embedding` — Embedding model

```yaml
embedding:
  model: text-embedding-v4    # DashScope 1536-dim
  batch_size: 100
  dimension: 1536
  version: v1                 # bump after changing model or chunk strategy
```

### `chunk` — Text chunking

```yaml
chunk:
  target_size: 750
  min_size: 300
  max_size: 900
  overlap: 100
```

### `agentic` — Agentic RAG

```yaml
agentic:
  top_k: 5
  max_hops: 3
```

### `asr` — Speech-to-text

```yaml
asr:
  provider: dashscope
  base_url: https://dashscope.aliyuncs.com/api/v1
  model: paraformer-v2
  model_local: paraformer-realtime-v2
  input_format: pcm
  timeout: 600
```

### `langsmith` — Tracing

```yaml
langsmith:
  enabled: true
  project: bilibili-rag
  endpoint: https://api.smith.langchain.com
  tracing_v2: true
  tracing: true
```

`api_key` must come from env:

```env
LANGSMITH__API_KEY=lsv2_pt_xxx
```

### `session` — User session

```yaml
session:
  ttl_days: 30
```

`secret` for signing must come from env:

```env
SESSION__SECRET=<random-64-char-string>
```

Generate: `python -c "import secrets; print(secrets.token_urlsafe(48))"`

### `security` — Encryption

Controls AES-256-GCM encryption for stored OAuth tokens and user API keys.

```env
SECURITY__API_KEY_ENCRYPTION_KEY=<base64-encoded-32-bytes>
```

Generate: `python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"`

- If unset: tokens are stored as plaintext (fine for local dev, not for production).
- If set: **do not change after deployment** — existing encrypted data becomes unreadable.

### `ratelimit` — Rate limiting (planned)

```yaml
ratelimit:
  chat_per_minute: 60
  asr_per_hour: 100
  quiz_per_day: 50
```

### `slow_sql` — Slow query logging

```yaml
slow_sql:
  enabled: true
  threshold_ms: 100        # SQLite default; PostgreSQL defaults to 50
  max_samples_per_fingerprint: 3
  retention_days: 7
  log_to_console: true
  log_to_storage: true
```

### `transaction` — Transaction retry

```yaml
transaction:
  max_retries: 3
  retry_delay_base: 0.1    # seconds, exponential backoff
  readonly_hint: false
```

### `mongo` / `redis` / `minio` / `mq` — Infrastructure (planned)

All disabled by default (`enabled: false`). Set `enabled: true` and provide connection details via env vars in production. See `app/config/default.yaml` for full field listings.

---

## config.yaml (team-shared overrides)

Use `config.yaml` to set overrides that apply to all developers on the team:

```yaml
# config.yaml — committed, shared across the team

app:
  debug: true
  log_level: DEBUG

server:
  reload: true
  workers: 1              # required when reload is on

rdbms:
  echo: true              # log all SQL in dev

asr:
  timeout: 300            # fail faster

langsmith:
  enabled: true           # trace for debugging
```

For production, the same file can hold different tuned values. Sensitive fields still come from env vars.

### local.yaml (create from `local.yaml.example`)

Put personal overrides here — different port, local DB, experimental model:

```yaml
rdbms:
  url: postgresql+asyncpg://me:mypass@localhost:54320/bilirag_local

llm:
  model: qwen3-plus
```

This file is gitignored.

---

## Migration from old .env-only config

The old config system used flat env vars in `.env`:

```env
DASHSCOPE_API_KEY=sk-xxx
OPENAI_BASE_URL=https://...
LLM_MODEL=qwen3-max
DATABASE_URL=sqlite+aiosqlite:///...
```

These **still work** as fallbacks. However, the recommended approach is:

1. Move non-sensitive values to YAML (`model`, `base_url`, `timeout`, etc.)
2. Keep only secrets in `.env` using the new `__` naming:

```env
LLM__API_KEY=sk-xxx
SECURITY__API_KEY_ENCRYPTION_KEY=...
SESSION__SECRET=...
```

---

## Programmatic access

```python
from app.config import settings, get_config

# Flat accessor (backward-compatible)
print(settings.llm_model)          # "qwen3-max"
print(settings.database_url)       # "sqlite+aiosqlite:///..."

# Raw nested dict (new code preferred)
cfg = get_config()
print(cfg["llm"]["model"])         # "qwen3-max"
print(cfg["rdbms"]["pool_size"])   # 20
```

The `settings` object maps YAML paths to flat property names for backward compatibility with existing code. New modules can access `get_config()` directly.
