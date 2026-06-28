# Security Tests

Tests for the rate-limiting and login-attempt subsystem under `app/services/auth/`.

## Scope

Three layers are covered, mirroring the production code structure:

| Layer | File | What it verifies |
|-------|------|------------------|
| Repository | `test_login_attempt_repository.py` | SQL aggregation: `count_recent_failures_by_ip/email/uid`, `has_recent_success_by_email`, singleton getter |
| Service | `test_rate_limit_service.py` | Singleton stability, `check_ip/target/uid`, Redis fail-open policy, DB-backed login cooldown, best-effort `record_login_attempt` |
| Deps (FastAPI integration) | `test_rate_limit_deps.py` | All 6 dep factories + 2 inline helpers translate `RateLimitExceeded` / `LoginCooldown` to HTTP 429 with correct `Retry-After` and detail message |

## Running

```bash
# From project root
PYTHONPATH=. python -m pytest app/test/security/ -v

# Single file
PYTHONPATH=. python -m pytest app/test/security/test_rate_limit_service.py -v

# Single test
PYTHONPATH=. python -m pytest app/test/security/test_rate_limit_service.py::test_login_cooldown_raises_when_failures_exceed_threshold -v
```

No external services required — Redis is mocked, SQLite runs in-memory.

## Fixtures (`conftest.py`)

### `security_db` (function-scoped, async)
Fresh in-memory SQLite (`aiosqlite` + `StaticPool`) with all tables created via `Base.metadata.create_all`. Each test gets an isolated DB; no cross-test leakage.

### Redis mocks
All Redis-mocking fixtures **also** set `redis.is_enabled() → True`. Without this, the service fail-opens and tests that expect blocking silently pass.

- `mock_redis_enabled` — swaps `redis.client` for an `AsyncMock`
- `mock_rate_limit_allow` — `rate_limit()` always returns `True`
- `mock_rate_limit_block` — `rate_limit()` always returns `False`
- `mock_rate_limit_counting` — real counter dict; returns `True` until `count > max_count`, exposes the dict for key assertions

### `cooldown_settings`
Replaces the `settings` reference inside `rate_limit_service` module with a `SimpleNamespace` containing all 17 `rl_*` attributes.

**Why swap the whole reference instead of monkeypatching attributes?**
`_Settings` exposes config via `@property` accessors, which are read-only — `monkeypatch.setattr(settings, "rl_login_cooldown_threshold", 5)` raises `AttributeError: property has no setter`. Swapping the entire module-level `settings` binding is the cleanest workaround.

## Mocking Strategy

| Concern | Approach | Why |
|--------|----------|-----|
| Database | Real in-memory SQLite | Verify actual SQL aggregation, not just that the repo was called |
| Redis | `monkeypatch` on `app.infra.redis` module | Redis is a network dependency; tests must not require it |
| Settings | `SimpleNamespace` swap | `@property` accessors can't be monkeypatched attribute-by-attribute |
| Singleton methods | `monkeypatch.setattr(rate_limit_deps.rate_limit_service, "check_ip", AsyncMock())` | Verify the dep layer translates exceptions correctly without coupling to service internals |

## Key Behaviors Verified

### Fail-open policy
- `check_ip` passes silently when `redis.is_enabled() == False`
- `check_ip` passes silently when `redis.rate_limit()` raises `ConnectionError`
- Rationale: rate limiting is a defense layer, not a hard gate — Redis outage must not lock users out

### Login cooldown
- Triggered when recent failures (within `rl_login_cooldown_seconds`) ≥ `rl_login_cooldown_threshold`
- Old failures excluded by `since` filter in SQL
- Successful logins don't inflate the failure counter
- `LoginCooldown` exception carries `email` + `retry_after`; deps translate to HTTP 429 with `"账号已被临时锁定"` detail

### Best-effort persistence
- `record_login_attempt` swallows repo errors — audit logging must never break the login flow

### Singleton stability
- `rate_limit_service is mod.rate_limit_service` holds across imports
- `rate_limit_service.repo` is a `LoginAttemptRepository` instance
- No per-request instantiation; `db` passed per-call for `AsyncSession` request isolation

## Coverage Gaps (intentional)

- **Real Redis**: not tested — would require a running instance. Covered by `diagnose_rag.py` smoke test indirectly.
- **HTTP-level integration**: deps are tested in isolation, not via `TestClient`. FastAPI's `Depends` plumbing is trusted.
- **Time-based edge cases**: `since` boundary is tested via backdated rows, but timezone arithmetic is assumed correct.
