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
  name: MindBase
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
  url: ""                  # ⚠️ no default — inject via RDBMS__URL env var
  echo: false
  pool_size: 20
  max_overflow: 10
  pool_timeout: 30
  pool_recycle: 1800
```

Docker compose injects MySQL (`mysql+aiomysql://...@mysql:3306/mind_base`) automatically.

To switch to PostgreSQL:

```yaml
# config.yaml
rdbms:
  echo: false
  pool_size: 50
  max_overflow: 30
```

```env
RDBMS__URL=postgresql+asyncpg://user:pass@host:5432/mind_base
```

### `milvus` — Vector database

```yaml
milvus:
  enabled: true
  uri: ""                            # inject via MILVUS__URI env var (e.g. http://localhost:19530)
  token: ""
  db_name: MindBase
  collection_name: bilibili_videos
  cloud_collection_name: cloud_drive
  dimension: 1024
  index_type: IVF_FLAT
```

### `kg` — Knowledge graph (Neo4j, optional; degrades gracefully when unreachable)

```yaml
kg:
  enabled: true
  uri: ""                            # inject via KG__URI env var; docker: bolt://neo4j:7687
  username: neo4j                    # password via env: KG__PASSWORD (share NEO4J_PASSWORD)
  database: neo4j
  entity_collection_name: kg_entities  # Milvus collection for semantic entity linking
  extract_model: qwen-flash
  max_hops: 2
```

### `llm` — Language model (OpenAI-compatible)

```yaml
llm:
  provider: dashscope     # dashscope | openrouter (dialogue LLMs only;
                          # embedding/rerank/ASR always go through DashScope)
  base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
  model: qwen3-max
  context_window: 0       # 0=auto from built-in model table (providers.py)
  eval_model: gpt-4o-mini
  timeout: 60
  max_retries: 3
```

```yaml
# OpenRouter alternative gateway (used when llm.provider: openrouter)
openrouter:
  base_url: https://openrouter.ai/api/v1
  model: z-ai/glm-5.2:free
  # api_key via env: OPENROUTER__API_KEY
```

`api_key` is **never** in YAML — inject via env:

```env
LLM__API_KEY=sk-your-key
```

### `embedding` — Embedding model

```yaml
embedding:
  model: text-embedding-v4    # DashScope, 1024-dim default (v4 supports 1024/1536/2048)
  batch_size: 100
  dimension: 1024
  version: v1                 # bump after changing model or chunk strategy
```

> ⚠️ Changing the embedding model or dimension makes existing Milvus vectors incompatible — rebuild the collections and bump `version`.

### `rerank` — Two-stage retrieval reranking

```yaml
rerank:
  enabled: true               # false -> NullReranker passthrough
  provider: dashscope         # gte-rerank-v2 cross-encoder via DashScope
  model: gte-rerank-v2
  timeout: 30
  top_n: 30                   # over-recall count fed to the reranker
  # api_key via env: RERANK__API_KEY (falls back to LLM__API_KEY)
```

### `chunk` — Text chunking

```yaml
chunk:
  target_size: 750
  min_size: 300
  max_size: 900
  overlap: 100
```

### `asr` — Speech-to-text

```yaml
asr:
  provider: dashscope
  base_url: https://dashscope.aliyuncs.com/api/v1
  model: paraformer-realtime-v2        # sync Recognition API
  transcription_model: paraformer-v2   # async Transcription API (audio >= 60s)
  realtime_max_seconds: 60             # above this, route to async Transcription
  input_format: pcm
  timeout: 600
  # api_key via env: ASR__API_KEY; falls back to LLM__API_KEY
```

### `langsmith` — Tracing

```yaml
langsmith:
  enabled: true
  project: MindBase
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

### `ratelimit` — Rate limiting (Redis-backed middleware)

```yaml
ratelimit:
  chat_per_minute: 60
  asr_per_hour: 100
  quiz_per_day: 50
```

Per-endpoint limits (login/register/captcha…) live under `security.rate_limit`. Redis down = pass-through (fail-open), noted as a known risk.

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

### `mongo` / `redis` / `minio` / `daytona` / `skill_store` / `mq` — Infrastructure

- `minio` — wallpapers, cloud drive files, skill packages, code artifacts (Docker deploy enables it by default)
- `daytona` — code sandbox for the code agent and skill code (`DAYTONA__ENABLED`, `DAYTONA__API_URL`, `DAYTONA__API_KEY`)
- `skill_store` — external skill marketplace (GitHub topic `mindbase-skill`), disabled by default
- `mq` — Celery + Redis Streams queue config (reserved)
- `wechat` / `sms` / `email` — WeChat scan login / Aliyun SMS / Resend email, all disabled by default (endpoints hidden until enabled, surfaced via `GET /auth/features`)

See `app/config/default.yaml` for full field listings.

---

## 独立服务的配置

各微服务有独立的配置入口（均读项目根 `.env`），不在主 `default.yaml` 里：

| 服务 | 配置入口 | 环境前缀 | 文档 |
|------|---------|---------|------|
| app-task | `app-task/default.yaml`（嵌入） | `APPTASK__` | [app-task.md](app-task.md) |
| app-pay | `application.yaml`（+ docker/test profile） | `PAY_*` / `ALIPAY_*` | [app-pay.md](app-pay.md) |
| app-pay-admin | 嵌入 `default.yaml` + 覆盖层 | `PAYADMIN__` | [app-pay-admin.md](app-pay-admin.md) |
| app-board | 嵌入 `default.yaml` | `APPBOARD__` | [app-board.md](app-board.md) |

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
  url: postgresql+asyncpg://me:mypass@localhost:54320/mind_base_local

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
