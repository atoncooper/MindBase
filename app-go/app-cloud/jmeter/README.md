# app-cloud JMeter load tests

JMeter plans for the Go **app-cloud** (cloud drive) service. These are
performance/acceptance assets, not part of `go test`.

## Layout

```text
app-go/app-cloud/jmeter/
├── app-cloud-read.jmx          # health + quota + folders + videos + trash
├── app-cloud-quota.jmx         # GET /cloud/quota only (membership/tier cache path)
├── app-cloud-search.jmx        # GET /cloud/search only (semantic search capability)
├── app-cloud-upload-init.jmx   # POST /cloud/upload/init (write path; disposable env only)
├── uids.csv                   # X-Uid pool for realistic per-user cache behavior
├── loadtest.properties        # defaults; CLI -J<name>=<value> overrides
├── run.ps1
└── run.sh
```

Results are written under `results/` and are git-ignored.

## Prerequisites

- Apache JMeter **5.6.3** installed and `jmeter` on PATH.
- app-cloud reachable directly, normally:

  ```text
  http://127.0.0.1:8007
  ```

- No APISIX/auth token is needed for direct app-cloud access: the service trusts
  the gateway-injected `X-Uid` header. The plans send `X-Uid` from `uids.csv`.
- Use only the test environment. The plans do not require login, but they do
  write upload sessions for `upload-init`.
- `app-cloud-search.jmx` requires the Search capability; if Milvus/AI wiring is
  disabled the endpoint correctly returns 503 and the plan will fail its 200
  assertion. Run it only in a full-capability test environment.

## Run

From this directory:

```powershell
# Read mix: 20 threads, 10s ramp, 60s
.\run.ps1 -Scenario read

# Quota-cache pressure: 100 threads, 20s ramp, 300s
.\run.ps1 -Scenario quota -Threads 100 -Ramp 20 -Duration 300

# Semantic search read path
.\run.ps1 -Scenario search -Threads 20 -Ramp 10 -Duration 120

# Upload write path: keep concurrency low and reset the environment afterwards
.\run.ps1 -Scenario upload-init -Threads 5 -Ramp 5 -Duration 60
```

Bash (mark executable once if needed: `chmod +x run.sh`):

```bash
./run.sh read 20 10 60
./run.sh quota 100 20 300
./run.sh search 20 10 120
```

Or call JMeter directly:

```bash
jmeter -n -t app-cloud-read.jmx -q loadtest.properties \
  -l results/read.jtl -e -o results/read-html \
  -Jhost=127.0.0.1 -Jport=8007 -Jthreads=20 -Jramp=10 -Jduration=60
```

## What each plan measures

| Plan | Paths | Purpose |
|---|---|---|
| `app-cloud-read.jmx` | `/health`, `/cloud/quota`, `/cloud/folders`, `/cloud/videos`, `/cloud/trash` | Read latency/throughput across the main user-facing read surface |
| `app-cloud-quota.jmx` | `/cloud/quota` | Per-uid quota/tier cache behavior (single-flight/jitter/eviction), high concurrency |
| `app-cloud-search.jmx` | `/cloud/search` | Semantic search read path (requires Search capability; otherwise 503) |
| `app-cloud-upload-init.jmx` | `POST /cloud/upload/init` | Multipart upload initialization and quota reservation path |

Each sampler asserts HTTP **200**. JMeter HTML dashboard reports p50/p90/p95/p99,
errors, throughput and active threads.

## Tuning

Edit `loadtest.properties`, or pass overrides:

```text
-Jhost=... -Jport=... -Jprotocol=http|https
-Jthreads=... -Jramp=... -Jduration=...
-JuidsFile=/absolute/path/uids.csv
-JconnectTimeout=3000 -JresponseTimeout=15000
-Jlimit=20 -JsearchQuery=loadtest
```

`uids.csv` has a header row plus 100 test uids. Replace them with real test
users if quota/membership scenarios matter; app-cloud only validates the uid
format, and app-pay decides the tier.

## Notes / safety

- `upload-init` creates upload sessions and reserves quota. Run it only against
  a disposable environment; the upload sweeper eventually cleans abandoned
  sessions, but the test DB/MinIO should still be reset after a large run.
- Do not run these plans against production.
- For HTTPS set `-Jprotocol=https` and, for a self-signed dev cert, add JMeter
  truststore options (or use a JMeter version/config that trusts the dev CA).
- For Docker-based JMeter, the target must be reachable from the JMeter
  container; `127.0.0.1:8007` on the host is not reachable from a container
  unless host networking is used. Prefer running JMeter on the host for these
  plans, or set `-Jhost=host.docker.internal` / the compose service name and
  publish/allow the port.
