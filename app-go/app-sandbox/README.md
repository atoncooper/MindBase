# app-sandbox — code-execution control plane (Go)

> Plan: [plan/1.0.18-SandboxControlPlane/1.0.18-SandboxControlPlane.md](../../plan/1.0.18-SandboxControlPlane/1.0.18-SandboxControlPlane.md)
> Port: **8017** · Module: `app-sandbox` · Go 1.24

OpenSandbox creates sandboxes; this service turns them into a usable MindBase
capability: **lease reuse, tier quotas, audit, artifact metadata, asynchronous
executions with SSE, cancellation/timeouts, memory-aware admission, paged
stdout/stderr and workspace file tools, artifact reads and orphan reclamation**.

app-ts talks to it over APISIX's internal route with `X-API-Key` + `X-Uid`;
identity is never accepted from a request body.

## What it provides

- **Warm leases** per `(uid, projectId, purpose, specHash)`; `/workspace` survives
  until the lease TTL or an explicit release.
- **Execution lifecycle**: queued → running → succeeded / failed / timeout /
  canceled, with idempotent cancel and SSE status frames.
- **Resource-aware admission**: global/per-uid caps, reserved-memory budget and
  weighted-FIFO (WFQ) queue (VIP/SVIP weights; aging prevents starvation).
- **Daily quotas** by membership tier, resolved from app-pay with a 60s cache
  and fail-open-to-free.
- **Inputs**: inline files, base64 text/binary writes, app-ts cloud-file import.
- **Outputs**: full stdout/stderr (bounded 1 MiB) with offset paging; MinIO
  artifacts with paged text/binary reads.
- **Workspace tools**: paged text read/write, artifact reads, runtime capability
  info, and grep/shell fallbacks.
- **Admin API** for app-admin (read-only views + cancel/release, `X-Admin-Token`).

## Architecture

```
app-ts agent tools
  run_code / sandbox_bash / sandbox_pwsh / sandbox_grep
  sandbox_read_file / sandbox_write_file / sandbox_execution_output
  sandbox_read_artifact / sandbox_import_cloud_files / sandbox_info
   │ internal HTTP + X-API-Key + X-Uid
   ▼
app-sandbox (Gin :8017)
   ├─ ExecutionService ─ admission → queued row → lease → runtime exec → output/artifacts → terminal + SSE
   ├─ LeaseManager     ─ (uid, project, purpose, specHash) reuse, TTL, runtime-expiration renewal
   ├─ QuotaService     ─ tier limits from app-pay (60s cache, fail-open free) + daily ledger
   ├─ Admission        ─ memory budget + weighted-FIFO (global/per-uid caps + bounded queue)
   ├─ Sweeper          ─ expired leases / timed-out executions / stuck creating / missing runtime
   ├─ FileService      ─ paged /workspace read/write through execd
   ├─ ArtifactStore    ─ fake | MinIO (execd file API → PutObject → presigned GET / paged read)
   └─ Audit            ─ create/start/finish/cancel/deny/lease/artifact rows
   │
   ├─ runtime.Runtime  ─ fake (tests/demo) | opensandbox (lifecycle + execd)
   └─ tests/            ─ black-box tests (all test files live here)
   └─ MySQL mind_base   ─ sandbox_lease / sandbox_execution / sandbox_artifact /
                          sandbox_usage_daily / sandbox_audit
```

The runtime is the source of truth for a sandbox; MySQL stores leases,
executions, artifact metadata, usage counters and audit rows. Code bodies are
never stored — only `code_sha256`, stdout/stderr previews and captured output.

## Data model (owned tables, AutoMigrate only)

| table | key columns |
|---|---|
| `sandbox_lease` | id, uid, project_id, purpose, runtime, runtime_id, spec_hash, state, expires_at, last_used_at, created_at |
| `sandbox_execution` | id, lease_id, uid, project_id, purpose, language, code_sha256, status, exit_code, timeout_ms, stdout/stderr bytes+preview+full, artifact_prefix, error_code, started_at, deadline_at, finished_at |
| `sandbox_artifact` | id, execution_id, uid, name, object_key, size_bytes, sha256, content_type |
| `sandbox_usage_daily` | uid, day (PK), executions, cpu_millis, artifact_bytes, leases_created |
| `sandbox_audit` | id, uid, action, execution_id, lease_id, project_id, image, outcome, duration_ms, exit_code, detail, request_id, actor, created_at |

`stdout_full` / `stderr_full` are MySQL `LONGTEXT` columns added for the paged
output API; previews stay as the compact list/detail view. `deadline_at` makes
the sweeper a plain index range scan.

## Lifecycle and lease semantics

```
queued → running ─┬─→ succeeded (exit 0)
                  ├─→ failed    (nonzero_exit / exec_error / runtime_missing / lease_*)
                  ├─→ timeout   (runtime deadline or control-plane deadline)
                  └─→ canceled  (POST cancel / shutdown / lease release)
```

- Lease states: `creating → ready → busy → idle → releasing → terminated`,
  plus `failed`.
- Reuse key: `uid | projectId | purpose | image+resources | networkPolicyHash`.
  Different projects never share a lease; policy changes create a new lease.
- Default TTL: **1800s**. After a successful execution the DB lease is renewed
  **and** OpenSandbox's `expiresAt` is renewed to `now + TTL + 5min`, so a warm
  sandbox does not die while its DB lease is valid.
- Destruction is active but **not immediate after each execution**:
  - TTL expiry → sweeper `Release` → cancel in-flight → `runtime.Delete` →
    `terminated`;
  - explicit `DELETE /internal/leases/{id}` or project cascade
    `DELETE /v1/leases?uid=&projectId=`;
  - worker panic / claim failure / `runtime_missing` → release;
  - daemon shutdown cancels in-flight executions; warm sandboxes expire through
    the runtime TTL (not force-deleted by the control plane).

## HTTP API

All `/v1` and `/internal` routes require the shared `X-API-Key` (or
`apikey`); `/v1` additionally requires `X-Uid`. Empty configured key fails
closed (401). Errors use `{"detail": "..."}`; quota errors add
`kind/resetAt/tier/upgradeSku`.

### Executions

```
POST   /v1/executions
       {projectId?, purpose?, language, code, files?, artifacts?, timeoutMs?}
       → 202 {executionId, leaseId, state}
       Idempotency-Key header supported (in-process 5-min cache)

GET    /v1/executions/{id}
       → execution payload (preview + artifacts + error/done flags)

GET    /v1/executions/{id}/events
       → SSE: status / stdout / stderr / artifact / done (+ ": ping")
         stdout/stderr frames are emitted when the run finishes (not live lines)

POST   /v1/executions/{id}/cancel      204 (idempotent)

GET    /v1/executions/{id}/output?stream=stdout|stderr&offset=&limit=
       → {executionId, stream, content, offset, bytes, totalBytes,
          sourceBytes, truncated, hasMore, nextOffset}
       Terminal executions only; offset/limit are UTF-8 byte boundaries.

GET    /v1/executions/{id}/artifacts/read?name=&offset=&limit=
       → {executionId, name, contentType, encoding, binary, content, offset,
          bytes, totalBytes, hasMore, nextOffset}
       Text = utf8, binary = base64; foreign uid → 404.
```

### Workspace files

```
GET    /v1/files/read?path=&offset=&limit=&projectId=&purpose=
       → {path, content, offset, bytes, totalBytes, hasMore, nextOffset}
       Reads a text file from the reusable sandbox; /workspace only.

POST   /v1/files/write
       {path, content, encoding?: "utf8"|"base64", projectId?, purpose?}
       → {path, bytes}
       Creates parent dirs; overwrites; single write ≤8 MiB.
```

Both file endpoints return **404** when no reusable sandbox exists for the
`(uid, projectId, purpose)` scope. File reads cap at 32 MiB.

### Runtime info and leases

```
GET    /v1/runtime
       → {runtime, image, cpu, memory, networkDefaultAction, egressAllow,
          acceptedLanguages, notes}

DELETE /v1/leases?uid=&projectId=
       → {released, failed}   (used by app-ts project purge)

GET    /internal/leases?uid=&state=&limit=   → {leases:[...]}
DELETE /internal/leases/{id}                 → 204
```

### Admin and ops

```
GET    /internal/admin/overview                  counts/24h failures/quota switch
GET    /internal/admin/executions                uid/projectId/status/from/to/page/pageSize
GET    /internal/admin/executions/{id}           previews + artifact metadata + audit
POST   /internal/admin/executions/{id}/cancel   204 (idempotent)
GET    /internal/admin/leases                    uid/state/page/pageSize
DELETE /internal/admin/leases/{id}               force release
GET    /internal/admin/quota?uid=&day=           usage + tier + limits
GET    /internal/admin/audit                     uid/action/from/to/page/pageSize
GET    /internal/admin/config                    runtime/image/resources/leaseTtl/admission

GET    /health      liveness
GET    /ready       200/503 (MySQL ping)
GET    /metrics     Prometheus text exposition
```

`/internal/admin/*` uses a separate `X-Admin-Token`: unset → 503, wrong →
401. Pagination is 1-based `page`/`pageSize` (clamped 1..100); views never
return code bodies, artifact bytes or secrets.

## Inputs and outputs

### Inputs

- `run_code` accepts `files: [{path, content}]` — up to 20 text files,
  1 MiB each, written under `/workspace` before the command;
- `sandbox_write_file` accepts `encoding: utf8 | base64` for binary content;
- app-ts `sandbox_import_cloud_files` downloads selected cloud documents via
  app-cloud M2M and writes them to `/workspace/analysis/data/` (≤8 MiB/file);
- no stdin / interactive process support yet.

### Outputs

- `execution.previewBytes` (default 4096) is the compact preview;
- full captured stdout/stderr is stored up to **1 MiB per stream** and served by
  the paged output API. `sourceBytes` is what the program actually wrote;
  `truncated=true` means the capture cap was hit and the rest is not retrievable;
- `hasMore` / `nextOffset` page through the **captured** bytes;
- artifacts are collected from `artifacts.defaultGlobs` (default
  `/workspace/analysis/outputs/**`) or caller-supplied `artifacts` globs
  (max 10, inside the artifact root); limits: 20 MiB/file, 100 MiB/execution;
- artifact bytes live in MinIO; the API returns presigned URLs and also supports
  paged reads (text utf8 / binary base64, max 32 MiB per object);
- timeout/cancel/error keep partial output captured before termination.

## Agent tool surface (app-ts)

| tool | purpose |
|---|---|
| `run_code` | Python/JS code, optional input files and artifact globs |
| `sandbox_bash` | shell command; bash 5.2 in the reference image, POSIX sh fallback |
| `sandbox_pwsh` | PowerShell 7.4 in the reference image; other images may lack it |
| `sandbox_grep` | grep/rg over `/workspace` |
| `sandbox_read_file` | paged UTF-8 file read with `has_more`/`next_offset` |
| `sandbox_write_file` | overwrite text/binary file; creates parents |
| `sandbox_execution_output` | paged full stdout/stderr by execution id |
| `sandbox_read_artifact` | paged artifact content (utf8/base64) |
| `sandbox_import_cloud_files` | import selected cloud documents into the sandbox |
| `sandbox_info` | image, resources, network policy, accepted languages |

Project chats require an approved experiment before the execution/file tools run
(the guard is enforced in app-ts).

## Runtime image

Default config image is `python:3.12`; the reference deployment uses the
optional **bash + PowerShell** image built from
`app-go/app-sandbox/images/pwsh.Dockerfile`:

```bash
docker build -f app-go/app-sandbox/images/pwsh.Dockerfile -t mindbase/sandbox-pwsh:7.4 .
# .env
OPEN_SANDBOX_SANDBOX_IMAGE=mindbase/sandbox-pwsh:7.4
SANDBOX_SANDBOX_MEMORY=512Mi   # PowerShell/.NET needs more headroom
```

That image contains:

- bash 5.2 + PowerShell 7.4;
- Python 3.11 + stdlib + pip3 (Debian base), symlinked as `python`;
- coreutils, grep/find/sed/awk, less/zip/unzip;
- **no** node/npm, git, ripgrep or scientific packages.

The old `python:3.12-alpine` image has only Python stdlib + POSIX sh (no bash,
pwsh, node, git, rg). `sandbox_info` reports the configured image but does not
probe installed packages. The image is part of the lease spec hash, so switching
it creates new leases; old warm sandboxes expire by TTL or explicit release.

## Admission: memory budget + weighted FIFO

```yaml
admission:
  maxConcurrent: 8
  maxPerUid: 2
  queueSize: 32
  queueTimeoutMs: 30000
  maxMemoryBytes: 2147483648   # reserved cgroup memory budget
  memoryPerExecutionBytes: 0   # 0 = parse runtime.resources.memory
  weights: { free: 1, vip: 2, svip: 4 }
```

- each execution reserves the sandbox's configured memory limit; when the
  budget is exhausted it queues instead of starting;
- queue full → 503; queue wait timeout → 429;
- queue order is **WFQ virtual finish time**: VIP/SVIP get proportionally more
  service under contention, while virtual-time aging prevents starvation;
  per-uid caps still win;
- reservation uses the cgroup limit, not live RSS. The control-plane's own heap,
  Docker daemon and OpenSandbox server are outside this budget;
- gauges: `sandbox_admission_memory_in_use`, `sandbox_admission_memory_limit`.

## Quotas

Quota kinds:

| kind | meaning |
|---|---|
| `academic_run` | executions/day |
| `sandbox_concurrent` | live leases |
| `sandbox_cpu_seconds` | duration × CPU/day |
| `sandbox_artifact_bytes` | artifact bytes/day |

Defaults: free 20/1/300/50MB · vip 200/3/3600/500MB · svip 600/5/10800/2GB.
Tier resolution goes through app-pay with a 60s cache; unreachable app-pay means
free (fail-open, never oversell a paid tier).

## Network / egress

Default: `network.egressDefaultAction=allow`, `egressAllow=[]` — sandboxes can
reach the internet. To harden a deployment:

```bash
# allowlist only
SANDBOX__NETWORK__EGRESS_DEFAULT_ACTION=deny
SANDBOX__NETWORK__EGRESS_ALLOW=pypi.org,files.pythonhosted.org

# or deny everything
SANDBOX__NETWORK__EGRESS_DEFAULT_ACTION=deny
SANDBOX__NETWORK__EGRESS_ALLOW=
```

Rebuild/restart app-sandbox; old leases keep their old policy hash and expire by
TTL (or release them explicitly).

Current OpenSandbox Docker deployment uses `[egress] mode = "dns"`
(DNS-only). An allowlist blocks domain resolution, but direct IP/CIDR traffic can
still bypass it. For packet-level default-deny, switch
`deploy/docker/opensandbox/config.toml` to `mode = "dns+nft"` and restart
opensandbox-server; this requires an egress sidecar with nftables/NET_ADMIN.

## Server, DB pool and log tuning

```yaml
server:
  readHeaderTimeoutMs: 10000
  readTimeoutMs: 30000
  writeTimeoutMs: 0          # 0 = keep SSE alive
  idleTimeoutMs: 120000
  maxHeaderBytes: 1048576
  shutdownTimeoutMs: 15000
  maxBodyBytes: 16777216     # base64 file uploads; execution create caps itself at 4 MiB
  accessLog:
    enabled: true
    slowMs: 1000
    skipPaths: ["/health", "/ready", "/metrics"]

database:
  max_open_conns: 20
  max_idle_conns: 10
  conn_max_lifetime: 1800
  conn_max_idle_time: 300
  slow_threshold_ms: 200
  prepare_stmt: true
  skip_default_transaction: true

log:
  level: info
  format: json
  output: stdout             # stdout | file | both
  addSource: false
  file:
    path: /app/logs/app-sandbox.log
    max_size: 100
    max_backups: 7
    max_age: 30
    compress: true
```

- env overrides: `SANDBOX__SERVER__*`, `SANDBOX__DATABASE__*`,
  `SANDBOX__LOG__*`;
- access log: request id, method, path, status, size, `bytes_in`, latency, ip,
  user agent, errors; 4xx warn, 5xx error, slow request warn; probes skipped;
- panic recovery logs stack; GORM slow queries use
  `database.slow_threshold_ms`; DB pool gauges are exposed on `/metrics`.

## Configuration reference

Embedded `default.yaml` + env overrides (prefix `SANDBOX__`, double underscore
nesting) + project-root `.env` (best effort). Shared fallbacks:
`RDBMS__URL`, `APISIX_CONSUMER_KEY`, `APP_PAY_BASE_URL`.

| env | default | purpose |
|---|---|---|
| `SANDBOX__DATABASE__DSN` / `RDBMS__URL` | — (required) | MySQL DSN (`mysql+aiomysql://…` accepted) |
| `SANDBOX__AUTH__API_KEY` / `APISIX_CONSUMER_KEY` | — | gateway/internal shared key |
| `SANDBOX__ADMIN__TOKEN` | — (empty = disabled) | `/internal/admin/*` secret |
| `SANDBOX__RUNTIME__TYPE` | `fake` | `fake` or `opensandbox` |
| `SANDBOX__RUNTIME__OPENSANDBOX__LIFECYCLE_BASE_URL` | — | lifecycle server |
| `SANDBOX__RUNTIME__OPENSANDBOX__EXECD_BASE_URL` | — | execd base URL |
| `SANDBOX__RUNTIME__IMAGE` | `python:3.12` | sandbox image (compose uses alpine) |
| `SANDBOX__RUNTIME__RESOURCES__CPU` / `__MEMORY` | 500m / 512Mi | per-sandbox limits |
| `SANDBOX__LEASE__TTL_SECONDS` / `__MAX_PER_UID` | 1800 / 3 | lease TTL / hard ceiling |
| `SANDBOX__ADMISSION__MAX_CONCURRENT` / `__MAX_PER_UID` / `__QUEUE_SIZE` / `__QUEUE_TIMEOUT_MS` | 8 / 2 / 32 / 30000 | admission caps |
| `SANDBOX__ADMISSION__MAX_MEMORY_BYTES` | 2 GiB | reserved memory budget (0=off) |
| `SANDBOX__ADMISSION__MEMORY_PER_EXECUTION_BYTES` | 0 | 0 = runtime.resources.memory |
| `SANDBOX__QUOTA__ENABLED` | true | quota enforcement |
| `SANDBOX__QUOTA__APP_PAY__BASE_URL` / `__API_KEY` | `APP_PAY_BASE_URL` / consumer key | membership source |
| `SANDBOX__SWEEPER__INTERVAL_MS` / `__ORPHAN_DRY_RUN` | 15000 / true | sweeper tick / dry-run |
| `SANDBOX__ARTIFACTS__STORE` | `fake` | `fake` or `minio` |
| `SANDBOX__ARTIFACTS__MAX_FILE_BYTES` / `__MAX_TOTAL_BYTES` | 20MB / 100MB | artifact limits |
| `SANDBOX__NETWORK__EGRESS_DEFAULT_ACTION` | `allow` | `allow` / `deny` |
| `SANDBOX__NETWORK__EGRESS_ALLOW` | `` | CSV FQDN allowlist |
| `SANDBOX__MINIO__ENDPOINT` / `__BUCKET` | — / `sandbox-artifacts` | artifact store (shared `MINIO__*` accepted) |
| `SANDBOX__MINIO__ACCESS_KEY` / `__SECRET_KEY` | — | MinIO credentials |
| `SANDBOX__MINIO__PUBLIC_ENDPOINT` | `/minio-proxy` | browser-visible presign prefix |

## Run locally (fake runtime)

```bash
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

curl -s localhost:8017/v1/executions/<id> -H 'X-API-Key: dev-key' -H 'X-Uid: 1'
curl -N localhost:8017/v1/executions/<id>/events -H 'X-API-Key: dev-key' -H 'X-Uid: 1'
curl -s 'localhost:8017/v1/executions/<id>/output?stream=stdout&offset=0&limit=32768' \
  -H 'X-API-Key: dev-key' -H 'X-Uid: 1'
```

Fake runtime returns canned output only; never enable it in production.

## Docker deployment

`app-sandbox` runs under the `sandbox` (or `full`) compose profile. It needs
MySQL, MinIO (for `artifacts.store=minio`), OpenSandbox server and the
`sandbox-tls` sidecar:

```bash
docker compose --profile sandbox up -d app-sandbox sandbox-tls
```

Important operational notes:

- **always recreate `sandbox-tls` after recreating `app-sandbox`** (the
  sidecar shares the netns; otherwise APISIX returns 502);
- app-sandbox binds `0.0.0.0:8017` inside the container but compose publishes it
  only on `127.0.0.1:8017`; APISIX routes `/internal/sandbox/*`;
- Docker socket is root-equivalent: only run OpenSandbox on a trusted
  single-host deployment; execd ports are published on the host by
  OpenSandbox (currently `publish_host=0.0.0.0`, restrict with a firewall);
- MinIO is a hard dependency when `artifacts.store=minio`.

## Tests

```bash
cd app-go/app-sandbox
go test ./...        # all tests live in tests/ (black-box), no DB by default
go test ./tests/ -v
go vet ./...
```

MySQL repo cases skip unless `SANDBOX__TEST_DSN` is set.

## Live validation (2026-11-18, Docker + OpenSandbox)

- Python `print(1+1)` → succeeded, stdout `2`; cold start ~5–40s (image/execd
  cache), warm reuse ~0.3–0.8s.
- Files: input `/workspace/analysis/data/in.txt` → output `out.txt` collected
  as artifact; custom artifact glob worked.
- Output paging: 5001-byte stdout → `offset=0 limit=1000` hasMore=true,
  `offset=5000` hasMore=false.
- Timeout partial output: `print(1001 bytes); sleep(5)` + timeoutMs=1000 →
  status `timeout`, `stdoutBytes=1001`, full partial output readable.
- Artifact read: `out.txt` → `HELLO`; foreign uid → 404.
- File read/write with offset: 104-byte file → page 1 `hasMore=true,
  nextOffset=40`; page 2 `hasMore=false, nextOffset=104`.
- Runtime info: `/v1/runtime` returns image/CPU/memory/egress contract.
- app-ts → APISIX `/internal/sandbox/v1/*` → app-sandbox: 200.

## Known limitations / follow-ups

- **Output is not live-streamed to the agent**: SSE stdout/stderr frames are
  emitted at terminal time; paging is post-hoc. True line streaming requires the
  runtime adapter to forward execd frames into the event hub.
- **Long runs**: the agent tool blocks on status polling (500ms → 3s backoff)
  until the timeout; no background notification yet. `run_code` retries are
  capped at 6 attempts for an unchanged code version (initial + 5 retries).
- **Capture cap**: 1 MiB per stream; beyond that `truncated=true` and
  `sourceBytes` shows the real size. Object-storage-backed unbounded output is
  a follow-up.
- **Image capability**: the reference `mindbase/sandbox-pwsh:7.4` image has
  Python, bash and PowerShell; node/git/rg/scientific packages still require a
  custom image (the old alpine image has only Python stdlib + sh).
  `sandbox_info` is static and does not probe installed packages.
- **No interactive stdin / background jobs**; one foreground command per
  execution.
- **Artifact read cap**: 32 MiB per object; write cap 8 MiB per file.
- **Egress**: default allow; DNS-only enforcement in the reference deployment;
  direct IP/CIDR bypass needs `dns+nft`.
- **Docker socket / execd exposure**: host firewall or stronger runtime
  isolation (gVisor/K8s) is required for untrusted multi-tenant production.
- **Sweeper** is single-replica (no leader election); runtime-side orphans
  need a runtime list API.
- **Idempotency-Key** is an in-process 5-minute cache; move to MySQL for
  multi-replica.
- **No command allow/deny policy**: code execution is intentionally arbitrary;
  rely on approval gates, egress policy, resource isolation and quotas.
