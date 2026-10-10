# app-pay — Transaction/Membership Service (Spring Boot)

MindBase membership activation: product (SKU) -> order -> payment (M1 mock / M2 WeChat & Alipay) -> membership activation/renewal extension.
Design and implementation plan: [plan/1.0.7-Pay/1.0.7-Pay.md](../plan/1.0.7-Pay/1.0.7-Pay.md)

## Scope and Boundaries

- Standalone service (Java 21 + Spring Boot 3.5), modeled after `app-task/`: dedicated MySQL (`app-pay-mysql`, database `app_pay`), unified APISIX authentication, **single configuration entry point = application.yaml (+ docker/test profile variants; sensitive values reference .env via placeholders)**.
- Does not `import` the main app; the membership ID is the main app's `users.uid` (`X-Uid` is injected by APISIX forward-auth; this service does not verify login itself).
- All data access goes through **MyBatis-Plus** (`mapper/`: BaseMapper's built-in CRUD; hand-written SQL always goes in `resources/mapper/*.xml`); schema is managed by **Flyway** (`db/migration/V*.sql`, applied at startup).
- All amounts are long cents; order state transitions always use conditional updates (`WHERE status=...`), and callbacks are idempotent.

## Startup

> ⚠️ **Server-side HTTPS-only (including local startup)**: `server.ssl` is forced on (`application.yaml`),
> transaction/membership data must not go to production in plaintext. Generate a development certificate before the first startup (gitignored, not committed):

```bash
# 1) Generate a development certificate (either script; produces app-pay/certs/{ca.crt,pay.crt,pay.key})
bash app-pay/scripts/gen-dev-cert.sh      # Git Bash / Linux
powershell app-pay/scripts/gen-dev-cert.ps1

# 2) Docker (recommended, from the project root; the container mounts certs -> /app/certs to match the yaml default relative paths)
docker compose --profile pay up -d --build app-pay-mysql app-pay

# 3) Run locally via IDE/mvn (start app-pay-mysql first, host loopback port 3307; workdir must be app-pay/)
mvn spring-boot:run
```

If the certificate is missing, the startup self-check (`EnvSummaryRunner`) reports a clear error with guidance; the emergency escape hatch
`PAY_TLS_ENABLED=false` falls back to plaintext (local troubleshooting only, forbidden in production). In production, mount the certificate issued by a real CA
and override the paths with `PAY_TLS_CERT` / `PAY_TLS_KEY`.

Tests: `mvn test`. Health check: `GET https://127.0.0.1:8002/health` (for self-signed certificates use
`curl -k` or `--cacert app-pay/certs/ca.crt`).

**After starting locally, open `https://localhost:8002/` in a browser** —— it redirects automatically to the end-to-end test console
(the base yaml is the local development form, no configuration needed; in the production container form the root path returns 404 and the console is not exposed).

## API Overview

| Group | Endpoint | Description |
|------|------|------|
| User | `GET /pay/products` | SKUs on sale |
| User | `GET /pay/channels` | Currently enabled channels (the frontend renders payment methods from this, no hardcoded MOCK) |
| User | `POST /pay/orders` | Create an order (`{skuCode, channel, idempotencyKey?}`; all channels are admitted through the router) |
| User | `GET /pay/orders` | My orders (`?limit=`, default 20, max 50) |
| User | `GET /pay/orders/{orderNo}` | Order details (uid ownership check; 404 if not the owner) |
| User | `POST /pay/orders/{orderNo}/cancel` | Cancel an unpaid order (CREATED only, decided by conditional update) |
| User | `GET /pay/orders/{orderNo}/qr` | Payment QR code PNG for a pending order (Alipay Face-to-Face Payment, precreate idempotent) |
| User | `GET /pay/membership` | Current user's membership status |
| User | `POST /pay/mock/confirm` | **Test/local form only**: simulate a successful payment (guarded by `pay.mock.enabled`) |
| Callback | `POST /pay/callback/alipay` | **M2**: Alipay async notification (signature verification, responds with success/fail text) |
| Internal | `GET /internal/pay/membership/{uid}` | Main app queries membership status (non-member `active:false`) |
| Internal | `POST /internal/pay/grant` | Operations compensation grant (reason required, audited; invalid tier 400) |
| Internal | `POST /internal/pay/orders/{orderNo}/refund` | **M4**: operations refund (channel refund + optional membership revocation; idempotent, replayable) |
| Internal | `POST /internal/pay/timeout/execute` | app-task timeout delegation execution (token enforced once configured; SQL-side `expires_at<=now` guard) |

User endpoints require the `X-Uid` header (injected by the gateway; send it manually for direct debugging). See plan document §5/§6 for the full contract and sequence.

## Configuration

**Single configuration entry point = application.yaml** (base = local development form; `application-docker.yaml` = production container; `application-test.yaml` = test/local container; profile activated by the compose command). All environment differences are baked into each yaml; only sensitive values reference the root `.env` via placeholders:

| Placeholder (.env) | Referenced by | Default |
|----------------|-----------|------|
| `PAY_MYSQL_USER` / `PAY_MYSQL_PASSWORD` | `pay.rdbms.*` (the MySQL container and Java share the same variable names) | `app_pay` / `app-pay` |
| `ALIPAY_ENABLED` / `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` | `pay.alipay.*` | `false` / empty (fails if enabled but missing) |
| `ALIPAY_GATEWAY_URL` / `ALIPAY_NOTIFY_URL` | `pay.alipay.*` | production gateway / empty = query-order-based |
| `PAY_TEST_TOKEN` | test profile test endpoint token | `local-test-token` |
| `APPTASK_BASE_URL` / `APISIX_CONSUMER_KEY` / `PAY_EXECUTOR_BASE_URL` | `pay.apptask.*` timeout delegation | gateway URL, etc. |
| `PAY_MYSQL_PORT` | compose host mapping | `3307` |
| `PAY_TLS_ENABLED` / `PAY_TLS_CERT` / `PAY_TLS_KEY` | `server.ssl.*` (HTTPS-only switch and certificate path overrides) | `true` / `certs/pay.crt` / `certs/pay.key` |
| `PAY_EXECUTOR_TOKEN` | `pay.internal.executor-token` (executor endpoint token, delivered via the registration URL query string) | empty = no check (compatible with older app-task) |
| `PAY_EXECUTOR_CA_FILE` | compose -> app-task `APPTASK__HTTP_EXECUTOR__CA_FILE` (trusts the app-pay development CA) | `/app/pay-certs/ca.crt` |

Non-sensitive configuration (timeout minutes, job parameters, mock switches, etc.) is always changed in the corresponding yaml, not via environment variables.

## Scheduled Jobs

| Job | Frequency | Responsibility |
|-----|------|------|
| **Primary path** | Each order's own `expires_at` | app-task precise timed delegation: a task is registered at order creation (payload carries version) and calls `/internal/pay/timeout/execute` when due (inside the executor, FIFO + worker pool self-limits concurrency; a version mismatch means already paid and the delegation is discarded) |
| OrderTimeoutJob | from 120s, jitter ±30%, idle backoff cap 10min | Timeout closure **fallback** (takes over when the primary path fails; eventually consistent) |
| DeliveryRetryJob | from 60s, jitter, backoff cap 5min | Stuck in `PAID` >1min -> retry delivery (idempotent) |
| ChannelQueryJob | 60s, jitter, no backoff | Actively query the channel for lost orders (M2 primary path) |
| ReconciliationJob | 3600s, fixed interval | Reconciliation: re-check channel status/amount for recently paid orders; discrepancies go to `RECON_*` audit + metrics |

> **Multi-instance mutual exclusion**: all four jobs first acquire a `pay_job_lock` lease (`JobLease`, TTL configurable via `pay.job.lease-ttl-seconds`),
> so only one instance actually executes at a time; if the lease table fails, this instance is allowed through (correctness is still guaranteed by order conditional updates).
> The scheduler thread pool `pay.job.scheduler-pool-size` defaults to 4, preventing slow jobs (serial outbound channel queries) from blocking order closure/delivery compensation.

## Logging

- Runtime logs: console + `logs/app-pay.log` (30-day rotation), each line includes `[traceId] [uid]`
- **Funds audit**: `logs/pay-audit.jsonl` (separate file, retained **365 days**), one JSON funds fact per line
  (such as `ORDER_PAID` / `ORDER_REOPENED` / `AMOUNT_MISMATCH` / `CALLBACK_REJECTED`), used for reconciliation and customer-complaint forensics
- Each request generates/propagates `X-Trace-Id` (echoed in the response, so user reports can be matched to logs); scheduled jobs assign themselves a `job-*` traceId each round
- Red line: secrets and raw signature payloads never enter logs; Docker mounts the `app_pay_logs` volume for persistence

## Database Migration (Flyway)

All schema changes go through `src/main/resources/db/migration/V*.sql` (replacing the legacy raw `schema.sql`):

- `V1__baseline.sql` = baseline of the legacy 5 tables; `V2__refund_tier_job_lock.sql` = refund fields + explicit tier + `pay_job_lock` + reconciliation indexes;
- `baseline-on-migrate: true` + `baseline-version: 0`: legacy databases (created by the old schema.sql) are automatically baselined and then incrementally migrated,
  while new databases create all tables from V1 —— the two paths converge to the same schema;
- **Released migrations must not be modified**; all schema changes add a new `V3__...sql`.

## Refunds (M4)

`POST /internal/pay/orders/{orderNo}/refund`(key-auth)`{"reason":"...","revokeMembership":true}`:

- State machine `PAID|DELIVERED -> REFUNDING -> REFUNDED`; acceptance uses conditional update (only one concurrent request succeeds);
- The channel refund **HTTP call is outside the transaction**, and `out_request_no=REF-{orderNo}` guarantees channel-side idempotency (repeated calls do not pay out twice);
- On success, within the transaction mark REFUNDED + revoke membership (deduct `duration_days`, never producing a negative membership period, and emit a `REFUND_REVOKE` event);
- On channel failure, roll back to the pre-refund status (`refund_prev_status`), without falsely triggering delivery compensation;
- Orders stuck in REFUNDING (crash/timeout) can resume by calling the endpoint again; repeated calls on refunded orders return immediately (idempotent);
- `pay.refund.max-days-back` limits the refund window.

## Observability

- `GET /health`: **actually probes the database** (`SELECT 1`); returns 503 when the DB is unavailable so the gateway removes the upstream;
- `/actuator/health` (including db details and liveness/readiness probes), `/actuator/metrics`, `/actuator/prometheus`;
- Business metrics: `pay.orders.created|paid|closed`, `pay.delivery.failed`, `pay.callback.rejected`,
  `pay.refund.succeeded|failed`, `pay.channel.query.paid`, `pay.recon.mismatch`.

## Testing

- `mvn test`: offline unit tests (including transaction-boundary reflection guards, no-tier-downgrade, three-phase refund, missing-amount rejection, and SQL guard assertions);
- `PayIntegrationTest`: Testcontainers with real MySQL (conditional updates / transactions / Flyway migrations),
  **automatically skipped when Docker is unavailable locally**; CI with Docker runs it.

## End-to-End Test Console (integration entry point before the M3 frontend is ready)

**Test environment (separate instance, fully isolated database from production)**: `docker compose --profile pay-test up -d app-pay-test-mysql app-pay-test`
—— forces the MOCK channel, enables the test endpoints (default token `local-test-token`), sets order timeout to 2min, and hosts the console at `https://127.0.0.1:18002/test/pay/console.html`. The production instance runs on 8002 with `--profile pay` as usual; both can run simultaneously.

**Console capabilities (v2)**: covers all endpoints (products / create order / sandbox QR code / simulate payment / query order / my recent orders / query membership / health check); **requests pass authentication by default** (when no token is configured); each request shows `X-Trace-Id` + status + duration, and logs/audit records can be copied for tracing; **high-concurrency simulation** uses a server-side burst (a latch starts all requests at once, bypassing browser concurrency limits) —— concurrently paying the same order verifies idempotency (delivered only once), and concurrently creating orders stress-tests writes.

The test instance works out of the box (baked into application-test.yaml). **The production instance does not open the test endpoints** (baked off in the docker profile); to enable them temporarily in production you must edit application-docker.yaml and restart:

- **Browser console**: `https://127.0.0.1:8002/test/pay/console.html` —— enter the token -> pick a product and create an order -> one-click MOCK payment closes the loop, or choose ALIPAY to get a **sandbox QR code** (scan with the sandbox wallet App; ChannelQueryJob confirms the order within ≤60s) -> query membership
- **One-click smoke script**: `PAY_TEST_TOKEN=xxx ./app-pay/scripts/smoke.sh` (create order -> simulate payment -> activate membership; automatically trusts the local `certs/ca.crt`)
- Security: double gate (`pay.test.enabled` defaults to false + token) plus structural isolation (APISIX does not route `/test/*`, port is loopback-only); test actions also enter the funds audit stream (`TEST_MOCK_PAY` event)

## TLS (HTTPS-only)

- **Server side**: Spring Boot `server.ssl` mounts PEM certificates (`application.yaml`), effective uniformly across all three forms (local base / docker / test); the startup self-check prints `tls_enabled/cert/key` and refuses to start when the certificate is missing.
- **Callers**: APISIX `upstream-app-pay` has switched to `scheme: https` (`apisix.yaml` / `apisix.dev.yaml`; during the self-signed phase `tls.verify: false` encrypts only; tighten to `verify: true` after switching to a real CA); the app-task timeout delegation callback (`executor_url=https://app-pay:8002/...`) is strictly verified via `ca_file` (the CA is loaded lazily, so pure scheduling stacks are unaffected).
- **Certificates**: for development/testing, `scripts/gen-dev-cert.sh|.ps1` builds a mini-CA + leaf certificate (SAN: localhost/127.0.0.1/::1/app-pay/app-pay-test/192.168.138.1); importing `ca.crt` into the browser removes the warning; after switching to a real certificate in production, update trust on every caller accordingly.
