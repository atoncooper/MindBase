# app-sandbox — code-execution control plane (Go)

> Plan: [plan/1.0.18-SandboxControlPlane/1.0.18-SandboxControlPlane.md](../../plan/1.0.18-SandboxControlPlane/1.0.18-SandboxControlPlane.md)
> Port: **8017** · Module: `app-sandbox` · Go 1.24

OpenSandbox alone can create sandboxes; this service turns it into a usable
MindBase capability: **lease reuse, per-uid quotas by membership tier, audit,
artifact metadata, asynchronous executions with SSE, cancellation/timeouts,
admission queueing and orphan reclamation**. app-ts talks to it over internal
HTTP with `X-API-Key` + `X-Uid` (APISIX internal route).

## Architecture

```
app-ts agent (run_code / academic_evidence)
   │ internal HTTP + X-API-Key + X-Uid
   ▼
app-sandbox (Gin :8017)
   ├─ ExecutionService ─ admission → row(queued) → lease → runtime exec → artifacts → terminal + SSE
   ├─ LeaseManager     ─ (uid, project, purpose, specHash) reuse, TTL, per-uid concurrency
   ├─ QuotaService     ─ tier limits from app-pay (60s cache, fail-open free) + daily ledger
   ├─ Admission        ─ global/per-uid in-flight caps, bounded queue
   ├─ Sweeper          ─ expired leases / timed-out executions / stuck creating / missing runtime
   ├─ ArtifactStore    ─ interface + fake (production: execd file API → MinIO + presign)
   └─ Audit            ─ create/start/finish/cancel/deny/lease/artifact rows
   │
   ├─ runtime.Runtime  ─ fake (tests/demo) | opensandbox (lifecycle + execd, skeleton)
   └─ tests/            ─ 全部测试（black-box：只经导出 API + internal 包，禁止与源码同目录）
   └─ MySQL mind_base  ─ sandbox_lease / sandbox_execution / sandbox_artifact /
                         sandbox_usage_daily / sandbox_audit
```

The runtime is the source of truth for a sandbox; the database stores leases,
executions, artifact metadata, daily usage counters and audit rows only.
Code bodies are **never stored** — only `code_sha256` plus truncated
stdout/stderr previews (config `execution.previewBytes`).

## Data model (owned tables, AutoMigrate only)

| table | key columns |
|---|---|
| `sandbox_lease` | id, uid, project_id, purpose, runtime, runtime_id, spec_hash, state, expires_at, last_used_at, created_at |
| `sandbox_execution` | id, lease_id, uid, project_id, purpose, language, code_sha256, status, exit_code, timeout_ms, stdout/stderr bytes+previews, artifact_prefix, error_code, started_at, deadline_at, finished_at |
| `sandbox_artifact` | id, execution_id, uid, name, object_key, size_bytes, sha256, content_type |
| `sandbox_usage_daily` | uid, day (PK), executions, cpu_millis, artifact_bytes, leases_created |
| `sandbox_audit` | id, uid, action, execution_id, lease_id, project_id, image, outcome, duration_ms, exit_code, detail, request_id, created_at |

`deadline_at` (= started_at + timeout) and the truncated preview columns are
implementation additions to plan §3: they make the sweeper query an index range
scan and let `GET /v1/executions/{id}` keep working after the request that
created it is gone.

## HTTP API

```
POST   /v1/executions            {projectId?, purpose?, language, code, files?, artifacts?, timeoutMs?}
                                 → 202 {executionId, leaseId, state}
GET    /v1/executions/{id}       → {executionId,status,exitCode?,stdoutPreview,stderrPreview,
                                    artifacts:[{name,size,sha256,url}],errorCode,done,...}
GET    /v1/executions/{id}/events  SSE: status / stdout / stderr / artifact / done (+ ": ping")
POST   /v1/executions/{id}/cancel  204 (idempotent)
GET    /internal/leases?uid=&state=&limit=   → {leases:[...]}
DELETE /internal/leases/{id}     204 (force release: cancel in-flight → runtime delete → terminated)
GET    /internal/admin/overview             counts + 24h failures + quota switch   (X-Admin-Token)
GET    /internal/admin/executions           uid/projectId/status/from/to/page/pageSize
GET    /internal/admin/executions/{id}      previews + artifact metadata + audit trail
POST   /internal/admin/executions/{id}/cancel  204 (idempotent, audit actor=admin)
GET    /internal/admin/leases               uid/state/page/pageSize
DELETE /internal/admin/leases/{id}          force release (audit actor=admin)
GET    /internal/admin/quota?uid=&day=      usage + tier + limits
GET    /internal/admin/audit                uid/action/from/to/page/pageSize
GET    /internal/admin/config               runtime/image/resources/leaseTtl/admission/quotaEnabled
GET    /health                   200 liveness
GET    /ready                    200/503 (MySQL ping)
GET    /metrics                  Prometheus text exposition
```

Auth: `X-API-Key` (or `apikey`) must equal `auth.apiKey` for every `/v1` and
`/internal` route; `/v1` additionally requires `X-Uid`. Identity is never read
from the request body. An empty configured key fails closed (401). Error bodies
use `{"detail": ...}`; quota rejections add `kind/resetAt/tier/upgradeSku`.

Quota kinds: `academic_run` (executions/day), `sandbox_concurrent` (live leases),
`sandbox_cpu_seconds` (duration × cpu/day), `sandbox_artifact_bytes` (artifacts/day).
Defaults: free 20/1/300/50MB · vip 200/3/3600/500MB · svip 600/5/10800/2GB.

### Internal admin API

`/internal/admin/*` is the read/write surface consumed by app-admin (plan
1.0.19). It uses the **separate** `X-Admin-Token` shared secret — never the
APISIX consumer key, and the token is never sent to browsers:

- `admin.token` unset → every admin request answers **503**
  `{"detail":"admin api disabled"}` (half-configured deployments fail closed);
- missing/wrong token → **401** `{"detail":"未授权"}`;
- pagination `page` (1-based, default 1) / `pageSize` (default 20, clamped to
  1..100) with response `{items,total,page,pageSize}`;
- write operations (`cancel`, lease release) reuse the live
  `ExecutionService`/`LeaseManager` and append audit rows with
  `actor=admin` + the admin `request_id`; they are idempotent on terminal
  rows and return 404 for unknown ids;
- views never include a code body: executions expose `code_sha256`-only rows'
  truncated `stdoutPreview`/`stderrPreview`, artifact metadata (no bytes/URL),
  and the audit timeline. `GET /config` never returns secrets.

### Execution lifecycle

```
400 valid · 429 quota/queue-timeout · 503 queue-full · 202 queued
queued → running ─┬─→ succeeded (exit 0)
                  ├─→ failed    (nonzero_exit/exec_error/runtime_missing/lease_*)
                  ├─→ timeout   (runtime deadline; state also swept by the sweeper)
                  └─→ canceled  (POST cancel, lease release, shutdown)
```

Lease states: `creating → ready → busy → idle → releasing → terminated`, plus
`failed`. Reuse key = `uid|projectId|purpose|specHash`; TTL default 30min.

## Configuration

Embedded `default.yaml` + env overrides (prefix `SANDBOX__`, double-underscore
nesting) + project-root `.env` (best-effort). Shared fallbacks:
`RDBMS__URL`, `APISIX_CONSUMER_KEY`, `APP_PAY_BASE_URL`.

| env | default | purpose |
|---|---|---|
| `SANDBOX__DATABASE__DSN` / `RDBMS__URL` | — (required) | MySQL DSN (mysql+aiomysql://… accepted) |
| `SANDBOX__AUTH__API_KEY` / `APISIX_CONSUMER_KEY` | — | gateway consumer key |
| `SANDBOX__ADMIN__TOKEN` | — (empty = admin API disabled) | shared secret for `/internal/admin/*` (app-admin only; independent of the consumer key) |
| `SANDBOX__RUNTIME__TYPE` | `fake` | `fake` or `opensandbox` |
| `SANDBOX__RUNTIME__OPENSANDBOX__LIFECYCLE_BASE_URL` | — | lifecycle server (required for opensandbox) |
| `SANDBOX__RUNTIME__OPENSANDBOX__EXECD_BASE_URL` | — | execd base URL |
| `SANDBOX__RUNTIME__IMAGE` | `python:3.12` | sandbox image |
| `SANDBOX__LEASE__TTL_SECONDS` / `__MAX_PER_UID` | 1800 / 3 | lease TTL, hard concurrency ceiling |
| `SANDBOX__ADMISSION__MAX_CONCURRENT` / `__MAX_PER_UID` / `__QUEUE_SIZE` / `__QUEUE_TIMEOUT_MS` | 8 / 2 / 32 / 30000 | admission caps |
| `SANDBOX__QUOTA__ENABLED` | true | quota enforcement |
| `SANDBOX__QUOTA__APP_PAY__BASE_URL` / `__API_KEY` | `APP_PAY_BASE_URL` / `APISIX_CONSUMER_KEY` | membership source |
| `SANDBOX__QUOTA__LIMITS__<KIND>__<TIER>` | `default.yaml` | per-kind tier limits |
| `SANDBOX__SWEEPER__INTERVAL_MS` / `__ORPHAN_DRY_RUN` | 15000 / true | sweeper tick, dry-run orphans |

## Run locally (fake runtime)

```bash
# .env at repo root provides RDBMS__URL / APISIX_CONSUMER_KEY; or export directly:
export SANDBOX__DATABASE__DSN='mysql+aiomysql://mind_base:mind-base@127.0.0.1:3306/mind_base'
export SANDBOX__AUTH__API_KEY='dev-key'
export SANDBOX__RUNTIME__TYPE=fake
cd app-go/app-sandbox && go run .
```

```bash
curl -s localhost:8017/health

curl -s -X POST localhost:8017/v1/executions \
  -H 'X-API-Key: dev-key' -H 'X-Uid: 1' -H 'Content-Type: application/json' \
  -d '{"language":"python","code":"print(1)","projectId":"p1","purpose":"academic"}'
# → {"executionId":"…","state":"queued"}

curl -s localhost:8017/v1/executions/<id> -H 'X-API-Key: dev-key' -H 'X-Uid: 1'
curl -N localhost:8017/v1/executions/<id>/events -H 'X-API-Key: dev-key' -H 'X-Uid: 1'
```

## Docker / compose snippet (compose is owned by another change — add manually)

```yaml
  app-sandbox:
    build: ./app-go/app-sandbox
    container_name: app-sandbox
    restart: unless-stopped
    profiles: ["sandbox"]
    environment:
      SANDBOX__DATABASE__DSN: "${RDBMS__URL}"
      SANDBOX__AUTH__API_KEY: "${APISIX_CONSUMER_KEY}"
      SANDBOX__RUNTIME__TYPE: "fake"          # opensandbox
      SANDBOX__QUOTA__APP_PAY__BASE_URL: "http://apisix:9080/internal/pay"
      SANDBOX__QUOTA__APP_PAY__API_KEY: "${APISIX_CONSUMER_KEY}"
      SANDBOX__ADMIN__TOKEN: "${SANDBOX_ADMIN_TOKEN}"   # shared with app-admin
    ports:
      - "127.0.0.1:8017:8017"                  # internal only; APISIX routes /internal/sandbox/*
    depends_on:
      - mysql
    # distroless has no shell/curl: probe /health from APISIX or the orchestrator
    # (dependency-level health checks) instead of a container healthcheck.
```

APISIX (external change, for reference): a key-auth internal route
`/internal/sandbox/*` → `app-sandbox:8017` with `proxy-rewrite` stripping
`/internal/sandbox`, plus the `X-Uid` header forwarded by the calling service.

## Tests

```bash
cd app-go/app-sandbox
go test ./...     # 测试全部位于 tests/（black-box 包，导入 internal 包；默认无 DB 依赖）
cd app-go/app-sandbox && go test ./tests/ -v   # 具体用例
go vet ./...
```

MySQL repo cases skip automatically unless `SANDBOX__TEST_DSN` is set.

## Current limitations / follow-ups

- **fake runtime is not a sandbox**: canned output only. Never enable it in prod.
- **OpenSandbox adapter**: covers lifecycle create/get/delete/endpoint and execd
  file upload + `/command` SSE execution with a best-effort interrupt on
  cancellation. Wire shapes follow the published lifecycle/execd specs but have
  not yet been exercised against a live instance; stdout/stderr are collected
  (not streamed to clients) and artifact collection still uses the fake store.
- **Artifacts**: interface + fake only; MinIO upload/presign is not implemented yet, so responses
  currently expose no artifacts.
- **Sweeper**: single-replica (no leader election yet); runtime-side orphans
  (sandbox alive without a DB row) need a runtime List API, so only DB-side
  orphan detection is implemented (`sweeper.orphanDryRun`).
- **Isolation** depends on the runtime (container/gVisor/microVM) + image
  allow-list + egress policy; the control plane cannot substitute for those.
- Idempotency-Key is an in-process 5-minute cache (single replica); move to a
  MySQL row when multi-replica.
